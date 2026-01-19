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

        // Step 1: Navigation
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Step 2: Aggressive Search
        const inputSelector = '#addSymbolInput, #searchInput, input[placeholder*="Ara"]';
        await page.waitForSelector(inputSelector, { timeout: 10000 });

        await page.focus(inputSelector);
        await page.click(inputSelector);

        // Clear visually and via JS
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');

        await page.evaluate((sel) => {
            const input = document.querySelector(sel);
            if (input) {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, inputSelector);

        await page.keyboard.type(symbol);
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');

        // Step 3: Fast result detection with Body Dump on Failure
        console.log(`[ORACLE] Searching for ${symbol}...`);
        let matchFound = false;
        try {
            await page.waitForFunction((s) => {
                const results = document.querySelector('#searchResults') || document.body;
                return Array.from(results.querySelectorAll('*')).some(el => {
                    const text = el.innerText?.trim().toUpperCase() || "";
                    return text === s || text.startsWith(s + " ") || text.includes("\n" + s + "\n");
                });
            }, { timeout: 8000 }, symbol);
            matchFound = true;
        } catch (e) {
            console.warn(`[ORACLE WARNING] Search results for ${symbol} NOT found in 8s.`);
            const bodyDump = await page.evaluate(() => document.body.innerText.slice(0, 500));
            console.log(`[ORACLE DIAGNOSTIC] Body Text Start: ${bodyDump.replace(/\s+/g, ' ')}`);
        }

        const clicked = await page.evaluate((s) => {
            const multiClick = (el) => {
                if (!el) return false;
                el.scrollIntoView();
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                el.click();
                return true;
            };

            const results = document.querySelector('#searchResults') || document.body;
            const match = Array.from(results.querySelectorAll('*')).find(el => {
                const text = el.innerText?.trim().toUpperCase() || "";
                return text === s || text.startsWith(s + " ") || text.includes("\n" + s + "\n");
            });

            if (match) return multiClick(match);

            // Second chance: Click first logical item in results
            const firstChild = document.querySelector('#searchResults .search-result-item, #searchResults > div');
            if (firstChild) return multiClick(firstChild);

            return false;
        }, symbol);

        if (!clicked) throw new Error(`${symbol} sonuçlarda bulunamadı veya tıklanamadı.`);

        // Step 4: Open Depth Tab (Multi-Trigger)
        await new Promise(r => setTimeout(r, 2000));
        const depthClicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, a'));
            const dBtn = btns.find(b => b.innerText.toLowerCase().includes('derinlik'));
            if (dBtn) {
                dBtn.click();
                dBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return true;
            }
            return false;
        });

        if (!depthClicked) console.warn(`[ORACLE] Derinlik butonu bulunamadı, bekleniyor...`);

        // Step 5: Surgical Extraction (Titan Engine)
        await new Promise(r => setTimeout(r, 3000));

        const stats = await page.evaluate((sym) => {
            const parseN = (s) => parseInt(s.replace(/\D/g, ''), 10) || 0;
            const maskTime = (s) => s.replace(/\d{1,2}[:.]\d{2}([:.]\d{2})?/g, ' ');

            const bodyContent = document.body.innerText;
            const lines = bodyContent.split('\n').map(l => l.trim()).filter(l => l.length > 3);

            const months = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];
            const isHdr = (l) => /Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa|Saat/i.test(l);
            const isDt = (l) => months.some(m => l.toLowerCase().includes(m)) || /2025|2026|2027/.test(l);

            let topL = 0;
            let bestR = "";
            let ctx = "";

            lines.forEach((line, idx) => {
                if (isHdr(line) || isDt(line)) return;

                const maskedLine = maskTime(line);
                const digits = (maskedLine.match(/\d+/g) || []).map(d => parseN(d));
                const validNums = digits.filter(n => n > 100 && n !== 1800 && n !== 900 && n !== 1805);

                if (validNums.length > 0) {
                    const localMax = Math.max(...validNums);
                    const prevLine = lines[idx - 1] || "";
                    const score = (prevLine.toLowerCase().includes('alis') || prevLine.toLowerCase().includes('tavan')) ? 3 : 1;

                    if (localMax * score > topL) {
                        topL = localMax;
                        bestR = line;
                        ctx = prevLine;
                    }
                }
            });

            return {
                topBidLot: topL,
                bestRow: bestR,
                context: ctx,
                price: document.getElementById('lastPrice')?.innerText || "0",
                ceiling: document.getElementById('infoCeiling')?.innerText || "0"
            };
        }, symbol);

        console.log(`[ORACLE] ${symbol} -> Lot: ${stats.topBidLot} (Row: "${stats.bestRow}")`);

        return {
            symbol,
            priceStr: stats.price,
            ceilingStr: stats.ceiling,
            topBidLot: stats.topBidLot,
            isCeiling: stats.topBidLot > 0
        };

    } catch (e) {
        console.error(`[ORACLE ERROR] ${symbol}: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
