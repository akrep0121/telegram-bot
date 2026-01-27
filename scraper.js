const Tesseract = require('tesseract.js');
const sharp = require('sharp');

async function extractLotFromImage(imageBuffer, symbol) {
    try {
        console.log(`[OCR] ${symbol} - Pre-processing (V4.1: Corrected Green Filter)...`);

        // IMAGE PRE-PROCESSING (V4.1)
        // Correct Order: 1. Extract Green 2. Threshold (High) 3. Negate
        const processedBuffer = await sharp(imageBuffer)
            .extractChannel('green')
            .threshold(200) // Keep ONLY the bright green text parts
            .negate() // Flip to Black text on White background
            .resize({ width: 1200 }) // High upscale for better digits
            .toBuffer();

        // ROI CROP: Focusing on the primary data region
        const metadata = await sharp(processedBuffer).metadata();
        const cropWidth = Math.floor(metadata.width * 0.58); // Capture Emir, Adet, Alış
        const cropHeight = Math.floor(metadata.height * 0.88);

        const finalBuffer = await sharp(processedBuffer)
            .extract({ left: 0, top: 0, width: cropWidth, height: cropHeight })
            .toBuffer();

        console.log(`[OCR] ${symbol} - Starting Multi-Lang OCR (tur+eng)...`);

        const result = await Tesseract.recognize(
            finalBuffer,
            'tur+eng', // Better support for Alış, Satış, Adet
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

        // --- DEBUG LOGGING ---
        console.log(`[OCR] ${symbol} - RAW TEXT START (First 300 chars):`);
        console.log(text.slice(0, 300).replace(/\n/g, ' [NL] '));

        let tableStarted = false;
        let candidates = [];

        for (const line of lines) {
            const clean = line.trim();
            if (!clean || clean.length < 5) continue;

            if (!tableStarted) {
                const lower = clean.toLowerCase();
                // Loose matching for headers
                if (lower.includes('emir') || lower.includes('adet') || lower.includes('ali') || lower.includes('aliş')) {
                    tableStarted = true;
                    console.log(`[OCR] ${symbol} - Table detected!`);
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
                    const isBlock = /^\d{3}$/.test(part);
                    if (endsWithSep || isBlock) {
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

        if (candidates.length === 0) {
            console.log(`[OCR] ${symbol} - No candidates found. Check RAW TEXT above.`);
            return null;
        }

        let maxPrice = -1;
        let bestLot = null;

        for (const row of candidates) {
            const priceRaw = row[row.length - 1].replace(/[^\d.,]/g, '').replace(',', '.');
            const priceVal = parseFloat(priceRaw);
            let lotIdx = row.length >= 3 ? 1 : 0;
            const lotRaw = row[lotIdx].replace(/\D/g, '');
            const lotVal = parseInt(lotRaw);

            if (!isNaN(priceVal) && priceVal > maxPrice && priceVal < 100000) {
                maxPrice = priceVal;
                if (!isNaN(lotVal) && lotVal > 100 && lotVal < 5000000000) {
                    bestLot = lotVal;
                }
            }
        }

        if (bestLot !== null) {
            console.log(`[OCR] ${symbol} - V4.1 Match: Lot=${bestLot} (Price: ${maxPrice})`);
            return { symbol, topBidLot: bestLot };
        }

        console.log(`[OCR] ${symbol} - Decision Logic failed to anchor to a price.`);
        return null;

    } catch (e) {
        console.error(`[OCR] Error processing image for ${symbol}:`, e.message);
        return null;
    }
}

module.exports = { extractLotFromImage };
