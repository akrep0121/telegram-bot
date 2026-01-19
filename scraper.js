const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');

// Random User Agents to rotate
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

/**
 * Launches a Headless Browser, navigates to the Web App URL,
 * and extracts the "Ceiling Lot" (Tavandaki Lot) data.
 * @param {string} url - The dynamic Web App URL with valid session.
 * @returns {Promise<object|null>} - Market data object or null if failed.
 */
async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                `--user-agent=${userAgent}`
            ]
        });

        const page = await browser.newPage();

        const viewports = [
            { width: 375, height: 812 },
            { width: 414, height: 896 },
            { width: 390, height: 844 }
        ];
        const viewport = viewports[Math.floor(Math.random() * viewports.length)];
        await page.setViewport(viewport);

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

        let retries = 3;
        let loaded = false;
        while (retries > 0 && !loaded) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                loaded = true;
            } catch (e) {
                retries--;
                if (retries > 0) await new Promise(r => setTimeout(r, 2000));
                else throw e;
            }
        }

        const title = await page.title();
        if (title.includes("Telegram") || (await page.$('.tgme_page'))) {
            return null;
        }

        const searchInputSelector = '#addSymbolInput';
        const fallbackSearchSelector = '#searchInput';

        let searchAttempt = 0;
        let searchSuccess = false;

        while (searchAttempt < 2 && !searchSuccess) {
            try {
                const targetSelector = await page.waitForSelector(`${searchInputSelector}, ${fallbackSearchSelector}`, { timeout: 10000 });

                await page.evaluate((sel, sym) => {
                    const input = document.querySelector(sel);
                    if (input) {
                        input.value = '';
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, searchInputSelector, symbol);

                await page.click(searchInputSelector).catch(() => page.click(fallbackSearchSelector));
                await page.keyboard.type(symbol, { delay: 100 });
                await page.keyboard.press('Enter');
                searchSuccess = true;
            } catch (e) {
                searchAttempt++;
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!searchSuccess) throw new Error("Search input failed.");

        await new Promise(r => setTimeout(r, 3000));

        const found = await page.evaluate((sym) => {
            const resultsBox = document.querySelector('#searchResults');
            if (!resultsBox) return { success: false, reason: "No results box" };

            const allElements = Array.from(resultsBox.querySelectorAll('*'));
            const match = allElements.find(el => {
                const text = el.innerText?.trim().toUpperCase() || "";
                const regex = new RegExp(`(^|\\s)${sym}($|\\s|\\.)`, 'i');
                return regex.test(text);
            });

            if (match) {
                let target = match;
                while (target && target !== resultsBox) {
                    if (target.tagName === 'DIV' || target.tagName === 'BUTTON' || target.classList.contains('search-row')) {
                        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        return { success: true };
                    }
                    target = target.parentElement;
                }
                match.click();
                return { success: true };
            }

            const globalElements = Array.from(document.querySelectorAll('div, span, p, b'));
            const globalMatch = globalElements.find(el => {
                const text = el.innerText?.trim().toUpperCase() || "";
                return text === sym || text.startsWith(sym + " ") || text.startsWith(sym + "\n");
            });

            if (globalMatch) {
                globalMatch.click();
                return { success: true };
            }

            return { success: false, reason: "Symbol not found" };
        }, symbol);

        if (!found.success) {
            const firstItem = await page.$('#searchResults > div');
            if (firstItem) await firstItem.click();
            else throw new Error("No search results found.");
        }

        // Wait for Detail View
        await page.waitForFunction(
            () => {
                const detail = document.querySelector('#detailView');
                const depthTab = document.querySelector('button[data-tab="derinlik"]');
                return (detail && detail.classList.contains('active')) || depthTab;
            },
            { timeout: 12000 }
        ).catch(() => { });

        // Click "Derinlik" tab
        const depthTabSelector = 'button[data-tab="derinlik"]';
        try {
            await page.waitForSelector(depthTabSelector, { timeout: 5000 });
            await page.click(depthTabSelector);
        } catch (e) {
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, div, span'));
                const depthBtn = buttons.find(b => b.innerText.toLowerCase().includes('derinlik'));
                if (depthBtn) depthBtn.click();
            });
        }

        // Wait for depth data - ULTRA PRECISION
        await new Promise(r => setTimeout(r, 4000));
        try {
            await page.waitForFunction(
                () => {
                    const content = document.querySelector('#depthContent');
                    if (!content) return false;
                    // Wait for at least ONE digit in the results area (implies data loaded)
                    return /\d/.test(content.innerText) && !content.innerHTML.includes('skeleton');
                },
                { timeout: 15000 }
            );
        } catch (e) { console.log("Depth data loading timeout - proceeding with current view."); }

        // EXTRACT DATA
        const data = await page.evaluate(() => {
            const getTxt = (id) => document.getElementById(id)?.innerText?.trim() || "";
            const parseNum = (str, isLot = false) => {
                if (!str) return 0;
                let clean = str.trim();
                if (isLot) return parseInt(clean.replace(/\D/g, ''), 10) || 0;
                let lastSep = Math.max(clean.lastIndexOf(','), clean.lastIndexOf('.'));
                if (lastSep !== -1 && (clean.length - lastSep <= 3)) {
                    let dec = clean.substring(lastSep + 1);
                    let int = clean.substring(0, lastSep).replace(/[,.]/g, '');
                    return parseFloat(int + "." + dec) || 0;
                }
                return parseFloat(clean.replace(/[,.]/g, '')) || 0;
            };

            let priceStr = getTxt('lastPrice');
            let ceilingStr = getTxt('infoCeiling');

            if (!priceStr || priceStr === "--" || priceStr === "") {
                const tags = Array.from(document.querySelectorAll('div, span, b, p'));
                const pLabel = tags.find(t => t.innerText && t.innerText.includes('Son Fiyat'));
                if (pLabel && pLabel.nextElementSibling) priceStr = pLabel.nextElementSibling.innerText;
            }
            if (!ceilingStr || ceilingStr === "--" || ceilingStr === "") {
                const tags = Array.from(document.querySelectorAll('div, span, b, p'));
                const cLabel = tags.find(t => t.innerText && t.innerText.includes('Tavan'));
                if (cLabel && cLabel.nextElementSibling) ceilingStr = cLabel.nextElementSibling.innerText;
            }

            let rows = Array.from(document.querySelectorAll('#depthContent .depth-row, .depth-table tr, div[role="row"]'))
                .filter(r => {
                    const txt = r.innerText || "";
                    if (/Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa/i.test(txt)) return false;
                    const digits = (txt.match(/\d/g) || []).length;
                    return digits >= 2;
                });

            const firstRow = rows[0];
            const cells = firstRow ? Array.from(firstRow.querySelectorAll('div, td, span')).filter(c => c.innerText.trim() !== "") : [];
            const cellTexts = cells.map(c => c.innerText.trim());

            let topBidLot = 0;
            let rawLotStr = "0";
            if (cellTexts.length >= 2) {
                const nums = cellTexts.map(t => parseNum(t, true));
                topBidLot = Math.max(...nums);
                rawLotStr = cellTexts[nums.indexOf(topBidLot)];
            }

            return {
                symbol: getTxt('symbolDisplay'),
                priceStr: priceStr,
                ceilingStr: ceilingStr,
                rawLotStr: rawLotStr,
                allCells: cellTexts,
                price: parseNum(priceStr),
                ceiling: parseNum(ceilingStr),
                topBidLot: topBidLot,
                isCeiling: (priceStr !== "" && parseNum(priceStr) === parseNum(ceilingStr))
            };
        });

        if (data) {
            console.log(`[DEBUG] ${symbol} -> Cells: [${data.allCells.join(' | ')}], Calculated Lot: ${data.topBidLot}`);
        }

        return data;

    } catch (error) {
        console.error(`Scrape Error (${symbol}):`, error.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
