const Tesseract = require('tesseract.js');
const sharp = require('sharp');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Pre-processing image (V4 Green ROI)...`);

        // IMAGE PRE-PROCESSING (V4 - Green Channel + ROI)
        // 1. Extract Green Channel: Kills gray watermarks effectively.
        const baseProcessed = await sharp(imageBuffer)
            .extractChannel('green')
            .negate() // Black text on White
            .threshold(160)
            .sharpen()
            .toBuffer();

        // ROI CROP: We focus on the left-side depth table (Emir, Adet, Alış)
        const metadata = await sharp(baseProcessed).metadata();
        const cropWidth = Math.floor(metadata.width * 0.55); // Left half
        const cropHeight = Math.floor(metadata.height * 0.85); // Skip bottom noise

        const processedBuffer = await sharp(baseProcessed)
            .extract({ left: 0, top: 0, width: cropWidth, height: cropHeight })
            .resize({ width: 1000 }) // Upscale
            .toBuffer();

        const result = await Tesseract.recognize(
            processedBuffer,
            'eng',
            {
                logger: m => {
                    if (m.status === 'recognizing text' && (Math.round(m.progress * 100) % 50 === 0)) {
                        console.log(`[OCR] ${symbol} Progress: ${Math.round(m.progress * 100)}%`);
                    }
                },
                tessedit_char_whitelist: '0123456789.,:|-EmirAdetAlışSatış ',
                tessedit_pageseg_mode: '6'
            }
        );

        const text = result.data.text;
        const lines = text.split('\n');
        let tableStarted = false;
        let candidates = [];

        for (const line of lines) {
            const clean = line.trim();
            if (!clean || clean.length < 5) continue;

            if (!tableStarted) {
                const lower = clean.toLowerCase();
                if (lower.includes('emir') || lower.includes('adet') || lower.includes('aliş')) {
                    tableStarted = true;
                }
                continue;
            }

            const parts = clean.split(/\s+/);
            const mergedParts = [];
            let currentNum = "";
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (currentNum === "") {
                    currentNum = part;
                } else {
                    const endsWithSep = /[.,]$/.test(currentNum) || /^[.,]/.test(part);
                    if (endsWithSep || /^\d{3}$/.test(part)) {
                        currentNum += part;
                    } else {
                        mergedParts.push(currentNum);
                        currentNum = part;
                    }
                }
            }
            if (currentNum) mergedParts.push(currentNum);

            const rowStrNums = mergedParts.filter(p => /\d/.test(p));
            if (rowStrNums.length >= 2) {
                candidates.push(rowStrNums);
                if (candidates.length >= 8) break;
            }
        }

        if (candidates.length === 0) return null;

        let maxPrice = -1;
        let bestLot = null;

        for (const row of candidates) {
            const priceRaw = row[row.length - 1].replace(/[^\d.,]/g, '').replace(',', '.');
            const priceVal = parseFloat(priceRaw);
            let lotIdx = row.length === 3 ? 1 : 0;
            const lotRaw = row[lotIdx].replace(/\D/g, '');
            const lotVal = parseInt(lotRaw);

            if (!isNaN(priceVal) && priceVal > maxPrice && priceVal < 50000) {
                maxPrice = priceVal;
                if (!isNaN(lotVal) && lotVal > 100 && lotVal < 5000000000) {
                    bestLot = lotVal;
                }
            }
        }

        if (bestLot !== null) {
            console.log(`[OCR] ${symbol} - V4 Match: Lot=${bestLot} (Price: ${maxPrice})`);
            return { symbol, topBidLot: bestLot };
        }
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
