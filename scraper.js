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
        await new Promise(r => setTimeout(r, 3000));

        // Step 2: Check if session is ACTUALLY expired vs just info modal
        console.log(`[SCRAPER] ${symbol} - Checking page state...`);
        const pageState = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const hasExpiredSession = bodyText.includes('Oturum Sona Erdi') || bodyText.includes('Bağlantınız kesildi');
            const hasWarningModal = bodyText.includes('10 dakika boyunca');
            return { hasExpiredSession, hasWarningModal, sample: bodyText.slice(0, 200) };
        });

        console.log(`[DIAGNOSTIC] ${symbol} State: expired=${pageState.hasExpiredSession}, warning=${pageState.hasWarningModal}`);

        // Step 3: Handle based on state
        if (pageState.hasExpiredSession) {
            // Session is expired - click Yeniden Bağlan
            console.log(`[SCRAPER] ${symbol} - Session expired, clicking reconnect...`);
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a, div, span'));
                const reconnect = btns.find(b => (b.innerText || "").toLowerCase().includes('yeniden bağlan'));
                if (reconnect) reconnect.click();
            });
            await new Promise(r => setTimeout(r, 5000));
        } else if (pageState.hasWarningModal) {
            // Just a warning modal - try to dismiss it
            console.log(`[SCRAPER] ${symbol} - Dismissing warning modal...`);

            // Try 1: Press Enter to accept
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 1000));

            // Try 2: Click positive buttons (NOT yeniden)
            const dismissed = await page.evaluate(() => {
                const positiveTexts = ['anladım', 'anladim', 'tamam', 'devam', 'başla', 'basla', 'kabul', 'onayla', 'gir', 'aç'];
                const btns = Array.from(document.querySelectorAll('button, a, div[role="button"], span[role="button"]'));

                for (const btn of btns) {
                    const txt = (btn.innerText || "").toLowerCase().trim();
                    // Skip if contains "yeniden" - that's the reconnect button
                    if (txt.includes('yeniden')) continue;

                    for (const positiveText of positiveTexts) {
                        if (txt === positiveText || txt.includes(positiveText)) {
                            btn.click();
                            return `clicked: ${txt}`;
                        }
                    }
                }
                return "no_positive_button";
            });
            console.log(`[SCRAPER] ${symbol} - Modal dismiss: ${dismissed}`);
            await new Promise(r => setTimeout(r, 2000));

            // Try 3: Press Escape
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 1000));

            // Try 4: Click outside the modal (on overlay)
            await page.mouse.click(10, 10);
            await new Promise(r => setTimeout(r, 1000));
        }

        // Wait for app to stabilize
        await new Promise(r => setTimeout(r, 3000));

        // Check current state
        const afterState = await page.evaluate(() => document.body.innerText.slice(0, 300));
        console.log(`[DIAGNOSTIC] ${symbol} AFTER MODAL: ${afterState.replace(/\s+/g, ' ').slice(0, 150)}`);

        // Step 4: Search for symbol
        console.log(`[SCRAPER] ${symbol} - Searching...`);
        const inputSelector = '#addSymbolInput, #searchInput, input[placeholder*="Ara"], input[type="text"], input[type="search"]';

        try {
            await page.waitForSelector(inputSelector, { timeout: 10000 });
        } catch (e) {
            // Try to find any input
            const anyInput = await page.evaluate(() => {
                const inputs = document.querySelectorAll('input');
                return inputs.length;
            });
            console.log(`[SCRAPER] ${symbol} - Search input not found! Total inputs on page: ${anyInput}`);

            // Dump full page for debugging
            const fullBody = await page.evaluate(() => document.body.innerText);
            console.log(`[DEBUG] ${symbol} - Full body (${fullBody.length} chars): ${fullBody.replace(/\s+/g, ' ').slice(0, 400)}`);
            return null;
        }

        // Click and type
        await page.click(inputSelector);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(symbol, { delay: 50 });
        await new Promise(r => setTimeout(r, 2000));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));

        // Step 5: Click on search result
        console.log(`[SCRAPER] ${symbol} - Clicking result...`);
        const clicked = await page.evaluate((s) => {
            // Look for elements containing the symbol
            const all = Array.from(document.querySelectorAll('*'));
            const match = all.find(el => {
                const text = (el.innerText || "").trim();
                const lines = text.split('\n');
                return lines.some(line => {
                    const upper = line.toUpperCase().trim();
                    return upper === s || upper.startsWith(s + " ") || upper.startsWith(s + "\t");
                });
            });
            if (match) {
                match.click();
                return "clicked";
            }

            // Fallback: click first result-like element
            const result = document.querySelector('#searchResults div, .result, [class*="result"], [class*="item"]');
            if (result) {
                result.click();
                return "fallback";
            }
            return "not_found";
        }, symbol);
        console.log(`[SCRAPER] ${symbol} - Result click: ${clicked}`);
        await new Promise(r => setTimeout(r, 4000));

        // Step 6: Open Depth Tab
        console.log(`[SCRAPER] ${symbol} - Opening depth tab...`);
        await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            const depthBtn = all.find(el => {
                const txt = (el.innerText || "").toLowerCase();
                return txt === 'derinlik' || txt.includes('derinlik');
            });
            if (depthBtn) depthBtn.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // Step 7: Extract data
        console.log(`[SCRAPER] ${symbol} - Extracting...`);
        const data = await page.evaluate(() => {
            const parseNum = (s) => parseInt((s || "").replace(/\D/g, ''), 10) || 0;
            const maskTime = (s) => (s || "").replace(/\d{1,2}[:.]\d{2}/g, ' ');

            const bodyText = document.body.innerText;
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 3);

            const months = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];
            const isSkip = (l) => {
                const low = l.toLowerCase();
                return /Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa|Saat|Toplam|dakika|telegram/i.test(l) ||
                    months.some(m => low.includes(m)) ||
                    /2024|2025|2026|2027/.test(l);
            };

            let maxLot = 0;
            let bestRow = "";

            lines.forEach((line) => {
                if (isSkip(line)) return;

                const maskedLine = maskTime(line);
                const numbers = (maskedLine.match(/\d{3,}/g) || []).map(n => parseNum(n));
                const safeNums = numbers.filter(n => n > 500 && n < 50000000 && n !== 1800 && n !== 900);

                if (safeNums.length > 0) {
                    const localMax = Math.max(...safeNums);
                    if (localMax > maxLot) {
                        maxLot = localMax;
                        bestRow = line;
                    }
                }
            });

            return { topBidLot: maxLot, bestRow, lineCount: lines.length };
        });

        console.log(`[SCRAPER] ${symbol} -> Lot: ${data.topBidLot}, Lines: ${data.lineCount}`);
        if (data.bestRow) console.log(`[SCRAPER] ${symbol} - Best row: "${data.bestRow.slice(0, 50)}"`);

        return {
            symbol,
            priceStr: "0",
            ceilingStr: "0",
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
