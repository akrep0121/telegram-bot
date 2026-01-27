const Tesseract = require('tesseract.js');
const sharp = require('sharp');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Single-Pass Smart OCR (V4.3)...`);

        const metadata = await sharp(imageBuffer).metadata();

        // 1. HIGH-PRECISION PRE-PROCESSING (Single Pass)
        // Optimized to make digits pop while killing watermarks
        const processedBuffer = await sharp(imageBuffer)
            .modulate({ brightness: 1.2, contrast: 1.5 })
            .extractChannel('green')
            .threshold(190) // Balanced: high enough to kill grays, low enough to keep thin digits
            .negate()
            .resize({ width: 1400 }) // Upscale for tiny numbers
            .toBuffer();

        console.log(`[OCR] ${symbol} - Starting Tesseract Pass...`);
        const result = await Tesseract.recognize(processedBuffer, 'tur+eng', {
            tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlış ',
            tessedit_pageseg_mode: '1' // Automatic page segmentation (better for whole images)
        });

        const fullText = result.data.text;
        const lines = fullText.split('\n');

        // --- DATA ANALYSIS ---
        let targetPriceInt = null;
        let tableStarted = false;
        let candidates = [];

        // 1. Find the CEILING PRICE in the top part (Heading)
        for (let i = 0; i < Math.min(lines.length, 10); i++) {
            const line = lines[i].replace(/[^\d. ]/g, '');
            const matches = line.match(/(\d+\.\d{2})/);
            if (matches) {
                targetPriceInt = Math.round(parseFloat(matches[1]) * 100);
                console.log(`[OCR] ${symbol} - Target Price Identified: ${matches[1]} (${targetPriceInt})`);
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

            // Numeric Parsing
            const parts = clean.split(/\s+/);
            const rowNums = [];
            for (const p of parts) {
                const raw = p.replace(/[^\d]/g, '');
                if (raw.length > 0) rowNums.push(parseInt(raw));
            }

            if (rowNums.length >= 2) {
                const price = rowNums[rowNums.length - 1];
                const lot = rowNums.length >= 3 ? rowNums[1] : rowNums[0];
                candidates.push({ lot, price });
                if (candidates.length >= 10) break;
            }
        }

        if (candidates.length === 0) {
            console.log(`[OCR] ${symbol} - Failed to detect data rows.`);
            return null;
        }

        // 3. SELECTION LOGIC
        let bestLot = null;
        let minDiff = 99999;

        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];

            // Primary Match: Large first row (Tavan)
            if (i === 0 && c.lot > 200000) {
                console.log(`[OCR] ${symbol} - Match (Dominant First Row): Lot=${c.lot}`);
                return { symbol, topBidLot: c.lot };
            }

            // Secondary Match: Price Anchor
            if (targetPriceInt) {
                const diff = Math.abs(c.price - targetPriceInt);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestLot = c.lot;
                }
            } else if (i === 0) {
                bestLot = c.lot; // Failover
            }
        }

        if (bestLot !== null) {
            console.log(`[OCR] ${symbol} - Match (Anchored): Lot=${bestLot}`);
            return { symbol, topBidLot: bestLot };
        }
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
