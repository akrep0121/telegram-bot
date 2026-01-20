const Tesseract = require('tesseract.js');
const fs = require('fs');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Starting OCR processing...`);

        // Recognize text from image buffer
        // using Turkish language for better accuracy with "Emir", "Adet", "Alış"
        const result = await Tesseract.recognize(
            imageBuffer,
            'eng+tur',
            {
                logger: m => {
                    // Only log progress every 20-30% to avoid clutter
                    if (m.status === 'recognizing text' && (Math.round(m.progress * 100) % 25 === 0)) {
                        console.log(`[OCR] ${symbol} Progress: ${Math.round(m.progress * 100)}%`);
                    }
                }
            }
        );

        const text = result.data.text;
        console.log(`[OCR] ${symbol} Raw Text Preview:\n${text.substring(0, 300)}...`);

        // PARSING LOGIC
        // We are looking for the "Adet" column in the "Alış" section (Left side typically).
        // Structure:
        // Emir | Adet | Alış | Satış | Adet | Emir
        // 4753 | 3.444.761 | 44.24 | ...

        // We want the first number under "Adet" (or the largest on the left)
        // Let's split by lines
        const lines = text.split('\n');

        for (const line of lines) {
            // Clean line
            const clean = line.trim();
            if (!clean) continue;

            // Regex to match the pattern: Number Space Number(with dots) Space Number(decimal)
            // Example: 4753 3.444.761 44.24

            // Heuristic: Look for lines that have 3 or more distinct numbers separated by space
            // And the middle one is large (Lot)

            // Remove dots/commas to simplify regex for structure check
            // BUT keep them for extraction

            // Try to identify the "data row" pattern
            // A typical data row starts with an integer (Emir count)
            // Followed by a large integer (Lot)
            // Followed by a float (Price)

            const parts = clean.split(/\s+/);

            // We need at least 3 parts for the left side of the table
            if (parts.length >= 3) {
                // Check 1st part (Emir count): Integer
                const p1 = parseInt(parts[0].replace(/\D/g, ''));

                // Check 2nd part (Lot): Integer, likely large (has dots)
                const p2Raw = parts[1];
                const p2 = parseInt(p2Raw.replace(/\./g, '').replace(/,/g, ''));

                // Check 3rd part (Price): Float
                const p3Raw = parts[2];
                // Price usually has decimal point or comma
                const p3 = parseFloat(p3Raw.replace(',', '.'));

                // VALIDATING THE DATA ROW
                // 1. Emir count should be > 0
                // 2. Lot should be > 100 (assume)
                // 3. Price should be reasonable (e.g. > 0 and < 10000)

                if (!isNaN(p1) && !isNaN(p2) && !isNaN(p3)) {
                    if (p2 > 100 && p3 > 0 && p3 < 100000) {
                        console.log(`[OCR] ${symbol} - MATCH FOUND: ${clean}`);
                        console.log(`[OCR] ${symbol} - Extracted Lot: ${p2}`);
                        return {
                            symbol,
                            topBidLot: p2,
                            price: p3,
                            isCeiling: true // Assume ceiling if we are asking for depth
                        };
                    }
                }
            }
        }

        console.log(`[OCR] ${symbol} - No valid data row found.`);
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
