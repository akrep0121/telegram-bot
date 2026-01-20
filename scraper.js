const Tesseract = require('tesseract.js');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Starting OCR processing...`);

        // Recognize text from image buffer
        // using Turkish language for better accuracy with "Emir", "Adet", "Alış"
        // Page Segmentation Mode 6 (Assume a single uniform block of text) helps with tables sometimes
        const result = await Tesseract.recognize(
            imageBuffer,
            'eng+tur',
            {
                logger: m => {
                    if (m.status === 'recognizing text' && (Math.round(m.progress * 100) % 50 === 0)) {
                        console.log(`[OCR] ${symbol} Progress: ${Math.round(m.progress * 100)}%`);
                    }
                }
            }
        );

        const text = result.data.text;
        // console.log(`[OCR] ${symbol} Text Preview:\n${text.substring(0, 200)}...`);

        // PARSING LOGIC for "Derinlik" Table
        // Structure typically: 
        // Emir | Adet (Lot) | Alış ...
        // 4753 | 3.444.761  | 44.24 ...

        // We look for the first valid data row.
        // A valid row usually starts with a numeric "Emir" count, followed by a large "Lot" number.

        const lines = text.split('\n');

        for (const line of lines) {
            const clean = line.trim();
            if (!clean) continue;

            // Simple cleaning: 
            // 1. Replace common OCR errors if needed (e.g. 'l' to '1') - Tesseract 5 is usually okay.
            // 2. Split by whitespace.
            const parts = clean.split(/\s+/);

            // We need at least 2 parts (Emir, Lot)
            if (parts.length < 2) continue;

            // Part 1: Emir Count (Integer)
            // Remove non-digits just in case
            const p1Str = parts[0].replace(/\D/g, '');
            const emirCount = parseInt(p1Str);

            // Part 2: Lot Count
            // Might look like "3.444.761" or "3,444,761" or "3444761"
            let p2Str = parts[1];

            // If p2Str is short (like '...'), it might be noise, check p3?
            // Usually Lot is the second column.

            // Clean punctuation from Lot string to parse it as integer
            // We assume Turkish locale often uses dots for thousands separators.
            const lotClean = p2Str.replace(/[.,]/g, '');
            const lotCount = parseInt(lotClean);

            // VALIDATION
            // 1. Emir count > 0
            // 2. Lot count > 100 (Arbitrary low filter to avoid headers/noise)
            // 3. (Optional) Check Part 3 for price if needed, but Lot is priority.

            if (!isNaN(emirCount) && !isNaN(lotCount)) {
                // Heuristic: Emir count usually smaller than Lot count in major stocks, but not always.
                // Emir count usually not huge (e.g. < 1,000,000), Lot can be huge.

                if (emirCount > 0 && lotCount > 0) {
                    // Check if this looks like a header line "Emir Adet..."
                    if (clean.toLowerCase().includes("emir") || clean.toLowerCase().includes("adet")) {
                        continue;
                    }

                    console.log(`[OCR] ${symbol} - Match Found: Emir=${emirCount}, Lot=${lotCount}`);
                    return {
                        symbol,
                        topBidLot: lotCount
                    };
                }
            }
        }

        console.log(`[OCR] ${symbol} - No valid Lot data found.`);
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
