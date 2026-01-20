const Tesseract = require('tesseract.js');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Starting OCR processing (Optimized)...`);

        // OPTIMIZATION: 
        // 1. Use 'eng' only (faster than eng+tur).
        // 2. Whitelist characters (0-9, punctuation).
        const result = await Tesseract.recognize(
            imageBuffer,
            'eng',
            {
                logger: m => {
                    // Reduce log frequency
                    if (m.status === 'recognizing text' && (Math.round(m.progress * 100) % 50 === 0)) {
                        console.log(`[OCR] ${symbol} Progress: ${Math.round(m.progress * 100)}%`);
                    }
                },
                tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlışSatış ' // Only allowed chars
            }
        );

        const text = result.data.text;

        // PARSING LOGIC for "Derinlik" Table
        // Goals: 
        // 1. Handle fragmented numbers (e.g. "3 . 444" -> "3444").
        // 2. Identify correct columns (Emir | Lot | Price).

        const lines = text.split('\n');

        for (const line of lines) {
            const clean = line.trim();
            if (!clean || clean.length < 5) continue; // Skip noise

            // Skip headers explicitly
            if (/[a-zA-Z]/.test(clean)) {
                // Any letters? Check if it's the header line
                if (clean.includes("Emir") || clean.includes("Adet")) continue;
            }

            // STRATEGY: 
            // 1. Split by spaces.
            // 2. Merge fragmented number parts (e.g. "3" "." "444").
            // 3. Extract the 3 main numeric columns.

            const parts = clean.split(/\s+/);
            const mergedParts = [];

            // Smart Merge Loop
            let currentNum = "";
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];

                // If part is just a separator or part of a number, append to current
                // Heuristic: If part is digits, check if we should merge with previous?
                // Actually, simplest is to merge everything that looks like it belongs to one number.

                if (currentNum === "") {
                    currentNum = part;
                } else {
                    // Check if we should append `part` to `currentNum`
                    // Connect if:
                    // - currentNum ends with . or ,
                    // - part starts with . or ,
                    // - part is exactly 3 digits (thousands block) and currentNum is digits

                    const endsWithSep = /[.,]$/.test(currentNum);
                    const startsWithSep = /^[.,]/.test(part);
                    const isBlock = /^\d{3}$/.test(part); // e.g. "444"
                    const isNum = /^\d+$/.test(currentNum);

                    if (endsWithSep || startsWithSep || (isNum && isBlock)) {
                        currentNum += part; // Merge
                    } else {
                        // Push current and start new
                        mergedParts.push(currentNum);
                        currentNum = part;
                    }
                }
            }
            if (currentNum) mergedParts.push(currentNum);

            // Now we have mergedParts, e.g. ["4753", "3.444.761", "44.24"]

            // Filter non-numeric noise (keep only things with digits)
            const numericParts = mergedParts.filter(p => /\d/.test(p));

            if (numericParts.length >= 2) {
                // Col 0: Emir
                // Col 1: Lot (Target)
                // Col 2: Price (Optional)

                const rawEmir = numericParts[0].replace(/\D/g, ''); // 4753
                const rawLot = numericParts[1].replace(/[.,]/g, ''); // 3444761

                const emirCount = parseInt(rawEmir);
                const lotCount = parseInt(rawLot);

                // Validation
                // Lot must be significant > 100
                // Emir > 0
                if (!isNaN(emirCount) && !isNaN(lotCount) && lotCount > 100) {
                    // Found a candidate row. 
                    // Usually the first valid row is the "Top Bid" (ceiling).

                    console.log(`[OCR] ${symbol} - Match: Emir=${emirCount}, Lot=${lotCount} (Raw: ${numericParts[1]})`);
                    return {
                        symbol,
                        topBidLot: lotCount
                    };
                }
            }
        }

        console.log(`[OCR] ${symbol} - No valid Lot data found in text.`);
        return null; // Return null if truly failed, loops will skip or retry

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
