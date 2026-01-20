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
        const lines = text.split('\n');
        let tableStarted = false;

        for (const line of lines) {
            const clean = line.trim();
            if (!clean || clean.length < 5) continue;

            // CHECK FOR TABLE HEADER
            // The table header line usually contains "Emir" and "Adet"
            if (!tableStarted) {
                // If we see "Emir" and "Adet", we assume the NEXT lines are the data.
                // We use a loose check because OCR might see "Emir" as "Enir" etc. if not perfect,
                // but our whitelist ensures we mostly get these chars.
                const lower = clean.toLowerCase();
                if (lower.includes('emir') || lower.includes('adet')) {
                    console.log(`[OCR] ${symbol} - Table header found. Parsing subsequent lines...`);
                    tableStarted = true;
                }
                // Skip everything before the table header (including the top info row with total volume)
                continue;
            }

            // --- DATA PARSING --- 
            // We are now inside the table.

            // STRATEGY: 
            // 1. Split by spaces.
            // 2. Merge fragmented number parts.
            // 3. Extract columns.

            const parts = clean.split(/\s+/);
            const mergedParts = [];

            // Smart Merge Loop
            let currentNum = "";
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];

                if (currentNum === "") {
                    currentNum = part;
                } else {
                    const endsWithSep = /[.,]$/.test(currentNum);
                    const startsWithSep = /^[.,]/.test(part);
                    const isBlock = /^\d{3}$/.test(part);
                    const isNum = /^\d+$/.test(currentNum);

                    if (endsWithSep || startsWithSep || (isNum && isBlock)) {
                        currentNum += part;
                    } else {
                        mergedParts.push(currentNum);
                        currentNum = part;
                    }
                }
            }
            if (currentNum) mergedParts.push(currentNum);

            // Filter non-numeric noise
            const numericParts = mergedParts.filter(p => /\d/.test(p));

            if (numericParts.length >= 2) {
                // Col 0: Emir (Small integer)
                // Col 1: Lot (Large integer)

                const rawEmir = numericParts[0].replace(/\D/g, '');
                const rawLot = numericParts[1].replace(/[.,]/g, '');

                const emirCount = parseInt(rawEmir);
                const lotCount = parseInt(rawLot);

                // Validation
                if (!isNaN(emirCount) && !isNaN(lotCount) && lotCount > 100) {
                    console.log(`[OCR] ${symbol} - Match: Emir=${emirCount}, Lot=${lotCount}`);
                    return {
                        symbol,
                        topBidLot: lotCount
                    };
                }
            }
        }

        console.log(`[OCR] ${symbol} - No valid Lot data found in text.`);
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
