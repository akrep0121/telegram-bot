const Tesseract = require('tesseract.js');
const sharp = require('sharp');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Precision Mode (V5.4)...`);

        const metadata = await sharp(imageBuffer).metadata();
        const w = metadata.width;
        const h = metadata.height;

        // --- STAGE 1: TURBO ROI PRE-PROCESSING (V5.4 Precision Mode) ---
        // Optimized for character accuracy: wider ROI, higher res, lower threshold
        const processedBuffer = await sharp(imageBuffer)
            .extract({
                left: 0,
                top: 0,
                width: Math.floor(w * 0.75), // Wider ROI (was 0.72)
                height: Math.floor(h * 0.38)  // Taller ROI (was 0.35)
            })
            .extend({ // Extra padding on left for first digit safety
                top: 15, bottom: 15, left: 30, right: 20,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            })
            .resize({ width: 2500 }) // Higher resolution (was 2200)
            .modulate({ brightness: 1.05, contrast: 2.0 }) // Higher contrast
            .extractChannel('green')
            .threshold(160) // Lower threshold = more character detail (was 170)
            .negate()
            .median(3)
            .toBuffer();

        console.log(`[OCR] ${symbol} - Starting Fast Tesseract Pass...`);
        const result = await Tesseract.recognize(processedBuffer, 'tur+eng', {
            tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlışUCAYM ', // Added symbol bias
            tessedit_pageseg_mode: '6' // Sparse table mode
        });

        const lines = result.data.text.split('\n');

        // --- DATA ANALYSIS ---
        let targetPriceInt = null;
        let tableStarted = false;
        let candidates = [];

        // 1. Identify Target Price from Heading
        for (let i = 0; i < Math.min(lines.length, 6); i++) {
            const line = lines[i].replace(/[^\d. ]/g, '');
            const matches = line.match(/(\d+\.\d{2})/);
            if (matches) {
                targetPriceInt = Math.round(parseFloat(matches[1]) * 100);
                console.log(`[OCR] ${symbol} - Target: ${matches[1]}`);
                break;
            }
        }

        // 2. Parse Rows (Only first few rows in our mini-crop)
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

            // Numeric Parsing with Fragment Merging (From V4.4)
            const parts = clean.split(/\s+/);
            const rowNums = [];
            for (const p of parts) {
                const raw = p.replace(/[^\d]/g, '');
                if (raw.length > 0) rowNums.push(parseInt(raw));
            }

            if (rowNums.length >= 2) {
                const price = rowNums[rowNums.length - 1];
                let lot = 0;
                if (rowNums.length >= 3) {
                    const lotParts = rowNums.slice(1, -1);
                    lot = parseInt(lotParts.join(''));
                } else {
                    lot = rowNums[0];
                }

                if (lot > 10) {
                    candidates.push({ lot, price });
                }
            }
        }

        if (candidates.length === 0) {
            console.log(`[OCR] ${symbol} - Mini-ROI failed to detect rows.`);
            return null;
        }

        // 3. SELECTION LOGIC
        let bestLot = null;
        let minDiff = 888888;

        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];

            // Priority 1: Large top row
            if (i === 0 && c.lot > 100000) {
                console.log(`[OCR] ${symbol} - Turbo Match (Row 1): Lot=${c.lot}`);
                return { symbol, topBidLot: c.lot };
            }

            // Priority 2: Price Matching
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
            console.log(`[OCR] ${symbol} - Turbo Match (Anchored): Lot=${bestLot}`);
            return { symbol, topBidLot: bestLot };
        }
        return null;

    } catch (e) {
        console.error(`[OCR] Turbo Error for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
