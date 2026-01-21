const Tesseract = require('tesseract.js');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Starting OCR processing (Optimized)...`);

        // OPTIMIZATION: 
        // 1. Use 'eng' only.
        // 2. Whitelist: Digits, separators, and specific headers.
        // 3. PSM 6: Assume a single uniform block of text (improves table row alignment).
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
                tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlışSatış ', // Only allowed chars
                tessedit_pageseg_mode: '6' // Assume single uniform block of text
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
            // Strategy: Finds the LARGEST integer in the row.
            // Why? 
            // 1. "Emir" column is usually small (orders).
            // 2. "Price" column is small decimal.
            // 3. "Lot" column (Ceiling) is usually the largest number.
            // This bypasses issues where an artifact '1' at the start shifts the columns.

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

            // Filter valid numbers
            const validNumbers = [];
            for (const p of mergedParts) {
                // Must contain digits
                if (!/\d/.test(p)) continue;

                // Remove non-digits to get raw value
                const rawVal = p.replace(/\D/g, '');
                const val = parseInt(rawVal);
                if (!isNaN(val)) validNumbers.push(val);
            }

            if (validNumbers.length >= 2) {
                // Heuristic: The largest number in the row is the Lot.
                // Exception: If the row is just noise? We rely on validNumbers >= 2.
                // Usually [Emir, Lot, Price]
                const maxVal = Math.max(...validNumbers);

                // Validation: Lot > 100
                if (maxVal > 100) {
                    // Double check: Is it reasonably larger than others?
                    // Not strictly necessary but safe.

                    console.log(`[OCR] ${symbol} - Match (Max Strategy): ${maxVal}`);
                    return {
                        symbol,
                        topBidLot: maxVal
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
