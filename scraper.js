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
        await new Promise(r => setTimeout(r, 5000));

        // DIAGNOSTIC: What does the page look like after navigation?
        const afterNavBody = await page.evaluate(() => document.body.innerText.slice(0, 400));
        console.log(`[DIAGNOSTIC] ${symbol} AFTER NAV: ${afterNavBody.replace(/\s+/g, ' ').slice(0, 200)}`);

        // Try to dismiss any overlay/modal
        try {
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { }

        // Click any close/ok buttons
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, a'));
            const closeBtn = btns.find(b => {
                const txt = (b.innerText || "").toLowerCase().trim();
                return txt === 'kapat' || txt === 'tamam' || txt === 'ok' || txt === 'anladım' || txt === 'x';
            });
            if (closeBtn) {
                closeBtn.click();
                return "clicked";
            }
            return "none";
        });
        await new Promise(r => setTimeout(r, 2000));

        // Step 2: Find and use search input
        console.log(`[SCRAPER] ${symbol} - Searching...`);
        const inputSelector = '#addSymbolInput, #searchInput, input[placeholder*="Ara"], input[type="text"]';

        let inputFound = false;
        try {
            await page.waitForSelector(inputSelector, { timeout: 10000 });
            inputFound = true;
        } catch (e) {
            console.log(`[SCRAPER] ${symbol} - Search input NOT found!`);
        }

        if (!inputFound) {
            const bodyDump = await page.evaluate(() => document.body.innerText.slice(0, 500));
            console.log(`[DIAGNOSTIC] ${symbol} NO INPUT - Body: ${bodyDump.replace(/\s+/g, ' ').slice(0, 250)}`);
            return null;
        }

        await page.focus(inputSelector);
        await page.click(inputSelector);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(symbol, { delay: 50 });
        await new Promise(r => setTimeout(r, 2000));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));

        // DIAGNOSTIC: What does the page look like after search?
        const afterSearchBody = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log(`[DIAGNOSTIC] ${symbol} AFTER SEARCH: ${afterSearchBody.replace(/\s+/g, ' ').slice(0, 200)}`);

        // Step 3: Click on symbol result
        const clicked = await page.evaluate((s) => {
            const allElements = Array.from(document.querySelectorAll('div, span, a, li'));
            const match = allElements.find(el => {
                const text = (el.innerText || "").trim().toUpperCase();
                // More flexible matching
                return text === s || text.includes(s + " ") || text.includes(s + "\n") || text.startsWith(s);
            });
            if (match) {
                match.click();
                return "found_" + match.innerText.slice(0, 20);
            }
            return "not_found";
        }, symbol);

        console.log(`[SCRAPER] ${symbol} - Click result: ${clicked}`);

        if (clicked === "not_found") {
            // Try clicking first search result
            await page.evaluate(() => {
                const first = document.querySelector('#searchResults div, .search-row, .result-item');
                if (first) first.click();
            });
        }

        await new Promise(r => setTimeout(r, 4000));

        // Step 4: Open Depth Tab
        console.log(`[SCRAPER] ${symbol} - Opening depth tab...`);
        const depthClicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, a, tab'));
            const depthBtn = btns.find(b => {
                const txt = (b.innerText || "").toLowerCase();
                return txt.includes('derinlik') || txt.includes('depth');
            });
            if (depthBtn) {
                depthBtn.click();
                return "clicked";
            }
            return "not_found";
        });
        console.log(`[SCRAPER] ${symbol} - Depth tab: ${depthClicked}`);
        await new Promise(r => setTimeout(r, 4000));

        // DIAGNOSTIC: What does the page look like after depth?
        const afterDepthBody = await page.evaluate(() => document.body.innerText.slice(0, 600));
        console.log(`[DIAGNOSTIC] ${symbol} AFTER DEPTH: ${afterDepthBody.replace(/\s+/g, ' ').slice(0, 250)}`);

        // Step 5: Extract data
        const data = await page.evaluate((sym) => {
            const parseNum = (s) => parseInt((s || "").replace(/\D/g, ''), 10) || 0;
            const maskTime = (s) => (s || "").replace(/\d{1,2}[:.]\d{2}/g, ' ');

            const bodyText = document.body.innerText;
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 3);

            const months = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];
            const isHeader = (l) => /Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa|Saat|Toplam/i.test(l);
            const isDate = (l) => months.some(m => l.toLowerCase().includes(m)) || /2024|2025|2026|2027/.test(l);

            let maxLot = 0;
            let bestRow = "";

            lines.forEach((line) => {
                if (isHeader(line) || isDate(line)) return;

                const maskedLine = maskTime(line);
                const numbers = (maskedLine.match(/\d+/g) || []).map(n => parseNum(n));
                const validNums = numbers.filter(n => n > 100 && n < 50000000);
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
                ceiling: document.getElementById('infoCeiling')?.innerText || "0",
                lineCount: lines.length
            };
        }, symbol);

        console.log(`[SCRAPER] ${symbol} -> Lot: ${data.topBidLot}, Lines: ${data.lineCount} (Row: "${data.bestRow.slice(0, 40)}")`);

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
