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

        // Step 2: CRITICAL - Dismiss the "10 dakika" warning modal
        console.log(`[SCRAPER] ${symbol} - Dismissing warning modal...`);

        // Try multiple dismiss methods
        for (let attempt = 0; attempt < 3; attempt++) {
            const dismissed = await page.evaluate(() => {
                // Common Turkish button texts for dismissing modals
                const dismissTexts = [
                    'anladım', 'anladim', 'tamam', 'devam', 'başla', 'basla',
                    'kabul', 'uygula', 'giriş', 'giris', 'onayla',
                    'ok', 'continue', 'start', 'accept', 'başlat', 'baslat',
                    'kapat', 'gir', 'aç', 'ac', 'giriş yap', 'bağlan', 'baglan'
                ];

                const allClickable = Array.from(document.querySelectorAll('button, a, div[role="button"], span[role="button"], .btn, .button'));

                for (const btn of allClickable) {
                    const txt = (btn.innerText || "").toLowerCase().trim();
                    for (const dismissText of dismissTexts) {
                        if (txt === dismissText || txt.includes(dismissText)) {
                            btn.click();
                            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                            return `clicked: ${txt}`;
                        }
                    }
                }

                // If no text match, try clicking visible buttons
                const visibleButtons = allClickable.filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 50 && rect.height > 20 && rect.top > 0;
                });

                if (visibleButtons.length > 0) {
                    visibleButtons[0].click();
                    return `clicked first visible button`;
                }

                return "no_button_found";
            });

            console.log(`[SCRAPER] ${symbol} - Modal dismiss attempt ${attempt + 1}: ${dismissed}`);

            if (dismissed.includes("clicked")) {
                await new Promise(r => setTimeout(r, 3000));
                break;
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        // Check if modal is gone
        const afterDismiss = await page.evaluate(() => document.body.innerText.slice(0, 200));
        console.log(`[DIAGNOSTIC] ${symbol} AFTER DISMISS: ${afterDismiss.replace(/\s+/g, ' ').slice(0, 150)}`);

        // Step 3: Find and use search input
        console.log(`[SCRAPER] ${symbol} - Searching...`);
        const inputSelector = '#addSymbolInput, #searchInput, input[placeholder*="Ara"], input[type="text"], input[type="search"]';

        let inputFound = false;
        try {
            await page.waitForSelector(inputSelector, { timeout: 10000 });
            inputFound = true;
        } catch (e) {
            console.log(`[SCRAPER] ${symbol} - Search input NOT found!`);
        }

        if (!inputFound) {
            const bodyDump = await page.evaluate(() => document.body.innerText.slice(0, 400));
            console.log(`[DIAGNOSTIC] ${symbol} NO INPUT - Body: ${bodyDump.replace(/\s+/g, ' ').slice(0, 200)}`);
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

        // Step 4: Click on symbol result
        console.log(`[SCRAPER] ${symbol} - Clicking result...`);
        const clicked = await page.evaluate((s) => {
            const allElements = Array.from(document.querySelectorAll('div, span, a, li'));
            const match = allElements.find(el => {
                const text = (el.innerText || "").trim().toUpperCase();
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
            await page.evaluate(() => {
                const first = document.querySelector('#searchResults div, .search-row, .result-item');
                if (first) first.click();
            });
        }

        await new Promise(r => setTimeout(r, 4000));

        // Step 5: Open Depth Tab
        console.log(`[SCRAPER] ${symbol} - Opening depth tab...`);
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, a, [role="tab"]'));
            const depthBtn = btns.find(b => {
                const txt = (b.innerText || "").toLowerCase();
                return txt.includes('derinlik') || txt.includes('depth');
            });
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
                ceiling: document.getElementById('infoCeiling')?.innerText || "0"
            };
        }, symbol);

        console.log(`[SCRAPER] ${symbol} -> Lot: ${data.topBidLot} (Row: "${data.bestRow.slice(0, 40)}")`);

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
