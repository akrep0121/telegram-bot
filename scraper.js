const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });
        await page.setUserAgent(USER_AGENTS[0]);

        // Step 1: Rapid Navigation
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Step 2: Intelligent Input
        const inputSelector = '#addSymbolInput, #searchInput, input[placeholder*="Ara"]';
        await page.waitForSelector(inputSelector, { timeout: 10000 });

        await page.evaluate((sel, sym) => {
            const input = document.querySelector(sel);
            if (input) {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, inputSelector, symbol);

        await page.click(inputSelector);
        await page.keyboard.type(symbol, { delay: 50 });

        // Step 3: Fast result detection
        console.log(`[TITAN] Waiting for ${symbol} results...`);
        try {
            await page.waitForFunction((s) => {
                const results = document.querySelector('#searchResults') || document.body;
                return Array.from(results.querySelectorAll('*')).some(el => {
                    const text = el.innerText?.trim().toUpperCase() || "";
                    return text === s || text.startsWith(s + " ") || text.includes("\n" + s + "\n");
                });
            }, { timeout: 8000 }, symbol);
        } catch (e) {
            console.log(`[TITAN] Symbol result timeout for ${symbol}, trying aggressive click.`);
        }

        const clicked = await page.evaluate((s) => {
            const results = document.querySelector('#searchResults') || document.body;
            const match = Array.from(results.querySelectorAll('*')).find(el => {
                const text = el.innerText?.trim().toUpperCase() || "";
                return text === s || text.startsWith(s + " ") || text.includes("\n" + s + "\n");
            });
            if (match) {
                match.click();
                match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return true;
            }
            return false;
        }, symbol);

        if (!clicked) {
            // Fallback: Click the first item in search results if exact match fails
            await page.evaluate(() => {
                const first = document.querySelector('#searchResults div, .search-row');
                if (first) first.click();
            });
        }

        // Step 4: Open Depth Tab (Fast Switch)
        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span'));
            const dBtn = btns.find(b => b.innerText.toLowerCase().includes('derinlik'));
            if (dBtn) dBtn.click();
        });

        // Step 5: Surgical Extraction (THE TITAN LOGIC)
        // Wait for data presence (at least one large number)
        try {
            await page.waitForFunction(() => {
                const text = document.body.innerText;
                // Look for any string of 4+ digits that isn't a date
                const numbers = text.match(/\d{4,}/g) || [];
                return numbers.some(n => !n.startsWith('202'));
            }, { timeout: 6000 });
        } catch (e) { }

        const stats = await page.evaluate((sym) => {
            const parseN = (s) => parseInt(s.replace(/\D/g, ''), 10) || 0;

            // 1. SURGICAL TIME MASKING
            const maskTime = (s) => s.replace(/\d{1,2}[:.]\d{2}([:.]\d{2})?/g, ' ');

            const bodyContent = document.body.innerText;
            const lines = bodyContent.split('\n').map(l => l.trim()).filter(l => l.length > 3);

            // Filters
            const months = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];
            const isHdr = (l) => /Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa|Saat/i.test(l);
            const isDt = (l) => months.some(m => l.toLowerCase().includes(m)) || /2025|2026|2027/.test(l);

            // FIND BEST ROW
            let topL = 0;
            let bestR = "";
            let context = "";

            lines.forEach((line, idx) => {
                if (isHdr(line) || isDt(line)) return;

                const maskedLine = maskTime(line);
                const digits = (maskedLine.match(/\d+/g) || []).map(d => parseN(d));

                // A valid depth row usually has Price and Lot. Lot is typically the candidate.
                const validNums = digits.filter(n => n > 100 && n !== 1800 && n !== 900 && n !== 1805);

                if (validNums.length > 0) {
                    const localMax = Math.max(...validNums);

                    // HEURISTIC: Does previous line mention "Alış" or "Tavan"?
                    const prevLine = lines[idx - 1] || "";
                    const score = (prevLine.toLowerCase().includes('alis') || prevLine.toLowerCase().includes('tavan')) ? 2 : 1;

                    if (localMax * score > topL) {
                        topL = localMax;
                        bestR = line;
                        context = prevLine;
                    }
                }
            });

            return {
                topBidLot: topL,
                bestRow: bestR,
                context: context,
                price: document.getElementById('lastPrice')?.innerText || "0",
                ceiling: document.getElementById('infoCeiling')?.innerText || "0"
            };
        }, symbol);

        console.log(`[TITAN] ${symbol} -> Lot: ${stats.topBidLot} (Context: ${stats.context})`);

        return {
            symbol,
            priceStr: stats.price,
            ceilingStr: stats.ceiling,
            topBidLot: stats.topBidLot,
            isCeiling: stats.topBidLot > 0
        };

    } catch (e) {
        console.error(`[TITAN ERROR] ${symbol}: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
