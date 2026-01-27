const Tesseract = require('tesseract.js');
const sharp = require('sharp');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Multi-Stage Coordinate OCR (V4.2)...`);

        const metadata = await sharp(imageBuffer).metadata();
        const w = metadata.width;
        const h = metadata.height;

        // --- STAGE 1: HEADER EXTRACTION (Target Price) ---
        // Crop the top area where Symbol and Current Price are located
        const headerBuffer = await sharp(imageBuffer)
            .extract({ left: 0, top: 0, width: w, height: Math.floor(h * 0.18) })
            .extractChannel('green') // Numbers are green
            .threshold(160)
            .negate()
            .resize({ width: 1000 })
            .toBuffer();

        const headerResult = await Tesseract.recognize(headerBuffer, 'eng', {
            tessedit_char_whitelist: '0123456789.%, '
        });

        const headerText = headerResult.data.text;
        const priceMatches = headerText.match(/(\d+\.\d{2})/);
        const targetPrice = priceMatches ? parseFloat(priceMatches[1]) : null;
        console.log(`[OCR] ${symbol} - Header Target Price Found: ${targetPrice || 'NOT FOUND'}`);

        // --- STAGE 2: TABLE EXTRACTION (ROI) ---
        // ROI: Bids side (Left 58% width, middle 75% height)
        const tableBuffer = await sharp(imageBuffer)
            .extract({
                left: 0,
                top: Math.floor(h * 0.18),
                width: Math.floor(w * 0.58),
                height: Math.floor(h * 0.75)
            })
            .modulate({ brightness: 1.1, contrast: 1.3 }) // Enhance green
            .extractChannel('green')
            .threshold(210) // Aggressive watermark killing (green is brighter than gray)
            .negate()
            .resize({ width: 1400 }) // Extra large for thin dots
            .toBuffer();

        const tableResult = await Tesseract.recognize(tableBuffer, 'tur+eng', {
            tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlış ',
            tessedit_pageseg_mode: '6'
        });

        const lines = tableResult.data.text.split('\n');

        // --- DEBUG LOGS ---
        console.log(`[OCR] ${symbol} - TABLE RAW:`);
        console.log(tableResult.data.text.slice(0, 400).replace(/\n/g, ' [NL] '));

        let tableStarted = false;
        let candidates = [];

        for (const line of lines) {
            const clean = line.trim();
            if (clean.length < 5) continue;

            if (!tableStarted) {
                const lower = clean.toLowerCase();
                if (lower.includes('emir') || lower.includes('adet') || lower.includes('ali')) {
                    tableStarted = true;
                }
                continue;
            }

            // Simple numeric split
            const parts = clean.split(/\s+/);
            const rowNums = [];
            for (const p of parts) {
                const raw = p.replace(/[^\d]/g, '');
                if (raw.length > 0) rowNums.push(parseInt(raw));
            }

            if (rowNums.length >= 2) {
                const price = rowNums[rowNums.length - 1]; // Last is price
                const lot = rowNums.length >= 3 ? rowNums[1] : rowNums[0];
                candidates.push({ lot, price });
                if (candidates.length >= 6) break;
            }
        }

        if (candidates.length === 0) {
            console.log(`[OCR] ${symbol} - Stage 2 Failed. Table not detected.`);
            return null;
        }

        // --- STAGE 3: DECISION (Anchoring) ---
        let bestLot = null;
        let minPriceDiff = 999999;
        const normalizedTarget = targetPrice ? Math.round(targetPrice * 100) : null;

        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];

            // Priority 1: Dominant Tavan Lot
            if (i === 0 && c.lot > 300000) {
                console.log(`[OCR] ${symbol} - Dominant Tavan Match (Row 1): Lot=${c.lot}`);
                return { symbol, topBidLot: c.lot };
            }

            // Priority 2: Price Match to Header
            if (normalizedTarget) {
                const diff = Math.abs(c.price - normalizedTarget);
                // Check for OCR misreading common suffixes (e.g. 26.32 read as 26 or 263 or 2632)
                if (diff < minPriceDiff) {
                    minPriceDiff = diff;
                    bestLot = c.lot;
                }
            } else if (i === 0) {
                // Fail-safe: trust row 1 if no header found
                bestLot = c.lot;
            }
        }

        if (bestLot !== null) {
            console.log(`[OCR] ${symbol} - V4.2 Anchored Result: Lot=${bestLot}`);
            return { symbol, topBidLot: bestLot };
        }
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
