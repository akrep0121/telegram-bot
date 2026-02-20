const Tesseract = require('tesseract.js');
const sharp = require('sharp');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Dual ROI Mode (V5.6)...`);

        const metadata = await sharp(imageBuffer).metadata();
        const w = metadata.width;
        const h = metadata.height;

        // --- DUAL ROI STRATEGY (V5.6) ---
        // ROI 1: Main Table (top 40%) - for reading first rows
        const mainROI = await sharp(imageBuffer)
            .extract({
                left: 0,
                top: 0,
                width: Math.floor(w * 0.55),
                height: Math.floor(h * 0.40)
            })
            .extend({ top: 15, bottom: 15, left: 30, right: 20, background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .resize({ width: 2000 })
            .modulate({ brightness: 1.05, contrast: 2.0 })
            .extractChannel('green')
            .threshold(160)
            .negate()
            .median(3)
            .toBuffer();

        // ROI 2: Total Row (bottom 12%) - for validation ONLY
        const totalROI = await sharp(imageBuffer)
            .extract({
                left: 0,
                top: Math.floor(h * 0.88),
                width: Math.floor(w * 0.55),
                height: Math.floor(h * 0.12)
            })
            .extend({ top: 10, bottom: 10, left: 30, right: 20, background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .resize({ width: 1500 })
            .modulate({ brightness: 1.05, contrast: 2.0 })
            .extractChannel('green')
            .threshold(160)
            .negate()
            .median(3)
            .toBuffer();

        // Helper to wrap promise with timeout
        const withTimeout = (promise, ms, name) => {
            return Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} Timeout after ${ms}ms`)), ms))
            ]);
        };

        // --- OCR PASS 1: Main Table ---
        console.log(`[OCR] ${symbol} - Scanning Main Table...`);
        const mainResult = await withTimeout(
            Tesseract.recognize(mainROI, 'tur+eng', {
                tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlış ',
                tessedit_pageseg_mode: '6'
            }),
            60000,
            "Main OCR"
        );

        // --- OCR PASS 2: Total Row (Quick) ---
        console.log(`[OCR] ${symbol} - Scanning Total Row...`);
        const totalResult = await withTimeout(
            Tesseract.recognize(totalROI, 'tur+eng', {
                tessedit_char_whitelist: '0123456789., ',
                tessedit_pageseg_mode: '7' // Single line mode
            }),
            45000,
            "Total OCR"
        );

        // Extract total lot from bottom row
        let totalLot = null;
        const totalText = totalResult.data.text.replace(/[^\d]/g, ' ').split(/\s+/);
        for (const num of totalText) {
            const val = parseInt(num);
            if (val > 1000000) { // Total is usually large
                totalLot = val;
                console.log(`[OCR] ${symbol} - Total Row Detected: ${totalLot}`);
                break;
            }
        }

        const lines = mainResult.data.text.split('\n');

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
            console.log(`[OCR] ${symbol} - Main ROI failed to detect rows.`);
            return null;
        }

        // totalLot is already extracted from dedicated Total ROI above

        // 4. SELECTION LOGIC WITH VALIDATION
        let bestLot = null;
        let minDiff = 888888;

        for (let i = 0; i < candidates.length - 1; i++) { // Exclude last (total) row
            const c = candidates[i];

            // VALIDATION: Row lot cannot exceed total lot
            if (totalLot && c.lot > totalLot) {
                console.log(`[OCR] ${symbol} - REJECTED Ghost Reading: ${c.lot} > Total (${totalLot})`);
                continue;
            }

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
