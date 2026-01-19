const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Telegram WebApp API Mock
const TELEGRAM_MOCK = `
    window.Telegram = {
        WebApp: {
            initData: "",
            initDataUnsafe: {},
            version: "6.0",
            platform: "android",
            colorScheme: "light",
            themeParams: {},
            isExpanded: true,
            viewportHeight: 844,
            viewportStableHeight: 844,
            ready: function() {},
            expand: function() {},
            close: function() {},
            onEvent: function() {},
            offEvent: function() {},
            sendData: function() {},
            MainButton: { isVisible: false, show: function(){}, hide: function(){} },
            BackButton: { isVisible: false, show: function(){}, hide: function(){} },
            HapticFeedback: { impactOccurred: function(){}, notificationOccurred: function(){}, selectionChanged: function(){} }
        }
    };
`;

async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
        await page.evaluateOnNewDocument(TELEGRAM_MOCK);

        console.log(`[SCRAPER] ${symbol} - Loading...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // AGGRESSIVE RECONNECT LOOP - Try up to 5 times
        for (let attempt = 1; attempt <= 5; attempt++) {
            await new Promise(r => setTimeout(r, 2000));

            const state = await page.evaluate(() => {
                const text = document.body.innerText;
                return {
                    hasExpired: text.includes('Oturum Sona Erdi') || text.includes('Bağlantınız kesildi'),
                    hasWarning: text.includes('10 dakika'),
                    hasSearch: !!document.querySelector('input[type="text"], input[type="search"], #addSymbolInput, #searchInput'),
                    sample: text.slice(0, 150).replace(/\s+/g, ' ')
                };
            });

            console.log(`[SCRAPER] ${symbol} - Attempt ${attempt}: expired=${state.hasExpired}, search=${state.hasSearch}`);

            // If we have search input and no expiration, we're good!
            if (state.hasSearch && !state.hasExpired) {
                console.log(`[SCRAPER] ${symbol} - Ready to search!`);
                break;
            }

            // Click reconnect if expired
            if (state.hasExpired) {
                console.log(`[SCRAPER] ${symbol} - Clicking reconnect (attempt ${attempt})...`);
                await page.evaluate(() => {
                    const all = Array.from(document.querySelectorAll('*'));
                    const btn = all.find(el => {
                        const txt = (el.innerText || "").toLowerCase();
                        return txt.includes('yeniden bağlan') || txt === 'bağlan';
                    });
                    if (btn) {
                        btn.click();
                        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    }
                });
                await new Promise(r => setTimeout(r, 4000));
            }

            // Also try pressing Enter and Escape to dismiss modals
            await page.keyboard.press('Enter');
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 1000));
        }

        // Final state check
        const finalState = await page.evaluate(() => {
            const text = document.body.innerText;
            return {
                hasSearch: !!document.querySelector('input[type="text"], input[type="search"], #addSymbolInput, #searchInput'),
                text: text.slice(0, 300).replace(/\s+/g, ' ')
            };
        });

        console.log(`[DIAGNOSTIC] ${symbol} - Final: search=${finalState.hasSearch}, text=${finalState.text.slice(0, 150)}`);

        if (!finalState.hasSearch) {
            console.log(`[SCRAPER] ${symbol} - No search input after all attempts!`);
            return null;
        }

        // SEARCH
        console.log(`[SCRAPER] ${symbol} - Typing symbol...`);
        const inputSel = 'input[type="text"], input[type="search"], #addSymbolInput, #searchInput';
        await page.click(inputSel);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(symbol, { delay: 30 });
        await new Promise(r => setTimeout(r, 2000));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));

        // CLICK RESULT
        console.log(`[SCRAPER] ${symbol} - Clicking result...`);
        const clicked = await page.evaluate((s) => {
            const all = Array.from(document.querySelectorAll('div, span, a, li'));
            const match = all.find(el => {
                const txt = (el.innerText || "").trim().toUpperCase();
                return txt === s || txt.startsWith(s + " ") || txt.startsWith(s + "\n");
            });
            if (match) {
                match.click();
                return "found";
            }
            // Fallback
            const first = document.querySelector('#searchResults div, .search-result');
            if (first) {
                first.click();
                return "fallback";
            }
            return "none";
        }, symbol);
        console.log(`[SCRAPER] ${symbol} - Result: ${clicked}`);
        await new Promise(r => setTimeout(r, 4000));

        // DEPTH TAB
        console.log(`[SCRAPER] ${symbol} - Opening depth...`);
        await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            const depth = all.find(el => (el.innerText || "").toLowerCase() === 'derinlik');
            if (depth) depth.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // EXTRACT
        console.log(`[SCRAPER] ${symbol} - Extracting...`);
        const data = await page.evaluate(() => {
            const parseNum = (s) => parseInt((s || "").replace(/\D/g, ''), 10) || 0;
            const lines = document.body.innerText.split('\n').filter(l => l.trim().length > 3);

            let maxLot = 0;
            let bestRow = "";

            lines.forEach(line => {
                // Skip noise
                const low = line.toLowerCase();
                if (/dakika|telegram|hacim|fiyat|ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık|2025|2026|saat|toplam/i.test(low)) return;
                if (line.includes(':')) return; // Skip time-like patterns

                const nums = (line.match(/\d{4,}/g) || []).map(n => parseNum(n));
                const safe = nums.filter(n => n > 1000 && n < 50000000);

                if (safe.length > 0) {
                    const max = Math.max(...safe);
                    if (max > maxLot) {
                        maxLot = max;
                        bestRow = line.trim();
                    }
                }
            });

            return { topBidLot: maxLot, bestRow, lineCount: lines.length };
        });

        console.log(`[SCRAPER] ${symbol} -> Lot: ${data.topBidLot}, Lines: ${data.lineCount}`);
        if (data.bestRow) console.log(`[SCRAPER] ${symbol} - Row: "${data.bestRow.slice(0, 60)}"`);

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
