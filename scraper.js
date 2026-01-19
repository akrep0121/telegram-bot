const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Step 1: Navigate
        console.log(`[SCRAPER] ${symbol} - Navigating...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Step 2: Wait for page to fully load and dismiss any modals
        console.log(`[SCRAPER] ${symbol} - Waiting for page stability...`);
        await new Promise(r => setTimeout(r, 5000));

        // Try to dismiss any overlay/modal by clicking anywhere or pressing Escape
        try {
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { }

        // Click any "Kapat", "Tamam", "OK" or close buttons if they exist
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, a'));
            const closeBtn = btns.find(b => {
                const txt = (b.innerText || "").toLowerCase();
                return txt === 'kapat' || txt === 'tamam' || txt === 'ok' || txt === 'x' || txt === '×';
            });
            if (closeBtn) closeBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        // Step 3: Find search input and type symbol
        console.log(`[SCRAPER] ${symbol} - Searching...`);
        const inputSelector = '#addSymbolInput, #searchInput, input[placeholder*="Ara"], input[type="text"]';

        try {
            await page.waitForSelector(inputSelector, { timeout: 15000 });
        } catch (e) {
            // Dump page state for debugging
            const bodyDump = await page.evaluate(() => document.body.innerText.slice(0, 500));
            console.log(`[SCRAPER] ${symbol} - Search input NOT found. Body: ${bodyDump.replace(/\s+/g, ' ').slice(0, 200)}`);
            return null;
        }

        await page.focus(inputSelector);
        await page.click(inputSelector);

        // Clear and type
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(symbol, { delay: 50 });
        await new Promise(r => setTimeout(r, 1500));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 2000));

        // Step 4: Click on symbol result
        console.log(`[SCRAPER] ${symbol} - Clicking result...`);
        const clicked = await page.evaluate((s) => {
            const allElements = Array.from(document.querySelectorAll('*'));
            const match = allElements.find(el => {
                const text = (el.innerText || "").trim().toUpperCase();
                return text === s || text.startsWith(s + " ") || text.startsWith(s + "\n");
            });
            if (match) {
                match.click();
                return true;
            }
            return false;
        }, symbol);

        if (!clicked) {
            console.log(`[SCRAPER] ${symbol} - Result not found, trying first item...`);
            await page.evaluate(() => {
                const firstResult = document.querySelector('#searchResults div, .search-result-item');
                if (firstResult) firstResult.click();
            });
        }

        await new Promise(r => setTimeout(r, 3000));

        // Step 5: Open Depth Tab
        console.log(`[SCRAPER] ${symbol} - Opening depth tab...`);
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, a'));
            const depthBtn = btns.find(b => (b.innerText || "").toLowerCase().includes('derinlik'));
            if (depthBtn) depthBtn.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // Step 6: Extract data
        console.log(`[SCRAPER] ${symbol} - Extracting data...`);
        const data = await page.evaluate((sym) => {
            const parseNum = (s) => parseInt((s || "").replace(/\D/g, ''), 10) || 0;
            const maskTime = (s) => (s || "").replace(/\d{1,2}[:.]\d{2}/g, ' ');

            const bodyText = document.body.innerText;
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 3);

            // Filters to skip headers, dates, times
            const months = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];
            const isHeader = (l) => /Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa|Saat/i.test(l);
            const isDate = (l) => months.some(m => l.toLowerCase().includes(m)) || /2024|2025|2026|2027/.test(l);

            let maxLot = 0;
            let bestRow = "";

            lines.forEach((line) => {
                if (isHeader(line) || isDate(line)) return;

                const maskedLine = maskTime(line);
                const numbers = (maskedLine.match(/\d+/g) || []).map(n => parseNum(n));
                const validNums = numbers.filter(n => n > 100 && n < 50000000);

                // Exclude suspicious numbers that look like times or years
                const safeNums = validNums.filter(n => n !== 1800 && n !== 900 && n !== 1730 && n !== 930);

                if (safeNums.length > 0) {
                    const localMax = Math.max(...safeNums);
                    if (localMax > maxLot) {
                        maxLot = localMax;
                        bestRow = line;
                    }
                }
            });

            return {
                topBidLot: maxLot,
                bestRow: bestRow,
                price: document.getElementById('lastPrice')?.innerText || "0",
                ceiling: document.getElementById('infoCeiling')?.innerText || "0"
            };
        }, symbol);

        console.log(`[SCRAPER] ${symbol} -> Lot: ${data.topBidLot} (Row: "${data.bestRow.slice(0, 50)}")`);

        return {
            symbol,
            priceStr: data.price,
            ceilingStr: data.ceiling,
            topBidLot: data.topBidLot,
            isCeiling: data.topBidLot > 0
        };

    } catch (e) {
        console.error(`[SCRAPER ERROR] ${symbol}: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
