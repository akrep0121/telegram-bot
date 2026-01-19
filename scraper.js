const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', `--user-agent=${userAgent}`]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });

        // Step 1: Navigation
        let navRetries = 2;
        while (navRetries > 0) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                break;
            } catch (e) {
                navRetries--;
                if (navRetries === 0) throw e;
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // Step 2: Search for Symbol
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
        await page.keyboard.type(symbol, { delay: 100 });
        await page.keyboard.press('Enter');

        // Step 3: Click Result
        let resultClicked = false;
        for (let i = 0; i < 20; i++) {
            resultClicked = await page.evaluate((s) => {
                const results = document.querySelector('#searchResults') || document.body;
                const match = Array.from(results.querySelectorAll('*')).find(el => {
                    const t = el.innerText?.trim().toUpperCase() || "";
                    return t === s || t.startsWith(s + " ") || t.includes("\n" + s + "\n");
                });
                if (match) {
                    match.click();
                    match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return true;
                }
                return false;
            }, symbol);
            if (resultClicked) break;
            await new Promise(r => setTimeout(r, 500));
        }

        if (!resultClicked) {
            const firstChild = await page.$('#searchResults > div, .search-row');
            if (firstChild) await firstChild.click();
            else throw new Error(`${symbol} bulunamadı.`);
        }

        // Step 4: Open Depth Tab
        await new Promise(r => setTimeout(r, 3000));
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div, span'));
            const depthBtn = buttons.find(b => b.innerText.toLowerCase().includes('derinlik'));
            if (depthBtn) depthBtn.click();
        });

        // Step 5: Wait for Data & Extract (THE COLOSSUS LOGIC)
        await new Promise(r => setTimeout(r, 4000)); // Initial patience

        const data = await page.evaluate((sym) => {
            const parseNum = (s) => {
                if (!s) return 0;
                // ULTIMATE TIME MASKING: Remove anything like 15:30 or 15.30
                let masked = s.replace(/\d{1,2}[:.]\d{2}/g, ' ');
                // Remove all non-digits
                return parseInt(masked.replace(/\D/g, ''), 10) || 0;
            };

            const getTxt = (id) => document.getElementById(id)?.innerText || "";
            let pStr = getTxt('lastPrice');
            let cStr = getTxt('infoCeiling');

            // Collect all rows and rank them
            const container = document.querySelector('#depthContent') || document.body;
            const rows = container.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 5);

            // Meta-data to skip
            const months = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];
            const isHeader = (l) => /Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa/i.test(l);
            const isDate = (l) => {
                const low = l.toLowerCase();
                return months.some(m => low.includes(m)) || /2025|2026|2027/.test(l);
            };

            // Rank rows by relevance
            // A good depth row:
            // 1. Not header, not date
            // 2. Has at least 3 numeric parts
            // 3. Does not contain time separators like ':'
            const validRows = rows.filter(l => !isHeader(l) && !isDate(l) && !l.includes(':'));

            let topLot = 0;
            let bestRow = "";

            validRows.forEach(row => {
                // Split row into numeric chunks
                // Masking time again just in case a colon was missed
                const maskedRow = row.replace(/\d{1,2}[:.]\d{2}/g, ' ');
                const chunks = maskedRow.split(/\s+/).map(c => parseNum(c)).filter(n => n > 100);

                if (chunks.length >= 2) {
                    // Usually [Price, Lot, Count] or [Lot, Price, Count]
                    // The lot is almost always the LARGEST number (unless it's a very low volume stock, handled by n > 100)
                    const max = Math.max(...chunks);
                    // Specific exclusions for common UI labels that might look like lots
                    if (max === 1800 || max === 900 || max === 1730 || max === 1805) return;

                    if (max > topLot) {
                        topLot = max;
                        bestRow = row;
                    }
                }
            });

            return {
                priceStr: pStr,
                ceilingStr: cStr,
                topBidLot: topLot,
                bestRow: bestRow,
                debugRows: validRows.slice(0, 5)
            };
        }, symbol);

        console.log(`[COLOSSUS] ${symbol} -> Lot: ${data.topBidLot} (Row: "${data.bestRow}")`);

        return {
            symbol,
            priceStr: data.priceStr,
            ceilingStr: data.ceilingStr,
            topBidLot: data.topBidLot,
            isCeiling: data.topBidLot > 0 // Logic in index.js will refine
        };

    } catch (e) {
        console.error(`[COLOSSUS ERROR] ${symbol}: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
