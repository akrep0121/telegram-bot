const Tesseract = require('tesseract.js');
const sharp = require('sharp');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Single-Pass Smart OCR (V4.4)...`);

        const metadata = await sharp(imageBuffer).metadata();

        // 1. HIGH-PRECISION PRE-PROCESSING (V4.5)
        // Ultra-high resolution and contrast to capture every single digit
        const processedBuffer = await sharp(imageBuffer)
            .modulate({ brightness: 1.2, contrast: 1.7 }) // Stronger contrast
            .extractChannel('green')
            .threshold(180) // Lowered slightly to preserve thin digit parts
            .negate() // IMPORTANT: Black text on white background
            .sharpen() // Define edges
            .resize({ width: 2800 }) // Ultra-high resolution for Tesseract
            .toBuffer();

        console.log(`[OCR] ${symbol} - Starting Tesseract Pass...`);
        const result = await Tesseract.recognize(processedBuffer, 'tur+eng', {
            tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlış ',
            tessedit_pageseg_mode: '6' // Sparse text/table mode
        });

        const fullText = result.data.text;
        const lines = fullText.split('\n');

        // --- DATA ANALYSIS ---
        let targetPriceInt = null;
        let tableStarted = false;
        let candidates = [];

        // 1. Find the CEILING PRICE in the top part (Heading)
        for (let i = 0; i < Math.min(lines.length, 12); i++) {
            const line = lines[i].replace(/[^\d. ]/g, '');
            const matches = line.match(/(\d+\.\d{2})/);
            if (matches) {
                targetPriceInt = Math.round(parseFloat(matches[1]) * 100);
                console.log(`[OCR] ${symbol} - Target Price Identified: ${matches[1]}`);
                break;
            }
        }

        // 2. Find and Parse the Table
        for (const line of lines) {
            const clean = line.trim();
            if (clean.length < 5) continue;

            const lower = clean.toLowerCase();
            if (!tableStarted) {
                if (lower.includes('emir') || lower.includes('adet') || lower.includes('ali')) {
                    tableStarted = true;
                }
                continue;
            }

            // Numeric Parsing with Fragment Merging
            const parts = clean.split(/\s+/);
            const rowNums = [];
            for (const p of parts) {
                const raw = p.replace(/[^\d]/g, '');
                if (raw.length > 0) rowNums.push(parseInt(raw));
            }

            if (rowNums.length >= 2) {
                const price = rowNums[rowNums.length - 1]; // Last part is Price
                let lot = 0;

                if (rowNums.length >= 3) {
                    // Middle-Merging: Emir is [0], Price is [last]. Everything else is Lot.
                    const lotParts = rowNums.slice(1, -1);
                    lot = parseInt(lotParts.join(''));
                    console.log(`[OCR] ${symbol} - Merged Lot Fragments: ${lotParts.join(' + ')} = ${lot}`);
                } else {
                    lot = rowNums[0];
                }

                if (lot > 10) {
                    candidates.push({ lot, price });
                }
                if (candidates.length >= 12) break;
            }
        }

        if (candidates.length === 0) {
            console.log(`[OCR] ${symbol} - Failed to detect data rows.`);
            return null;
        }

        // 3. SELECTION LOGIC
        let bestLot = null;
        let minDiff = 888888;

        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];

            // Priority 1: Large first row (Tavan Detection)
            if (i === 0 && c.lot > 250000) {
                console.log(`[OCR] ${symbol} - Match (Dominant First Row): Lot=${c.lot}`);
                return { symbol, topBidLot: c.lot };
            }

            // Priority 2: Price Anchor Match
            if (targetPriceInt) {
                const diff = Math.abs(c.price - targetPriceInt);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestLot = c.lot;
                }
            } else if (i === 0) {
                bestLot = c.lot;
            }
        }

        if (bestLot !== null) {
            console.log(`[OCR] ${symbol} - Match (Final Selection): Lot=${bestLot}`);
            return { symbol, topBidLot: bestLot };
        }
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
