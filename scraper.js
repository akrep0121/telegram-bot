const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Simple Telegram mock
const TELEGRAM_MOCK = `
    window.Telegram = {
        WebApp: {
            initData: "",
            version: "6.0",
            platform: "android",
            ready: function() {},
            expand: function() {},
            close: function() {},
            MainButton: { show: function(){}, hide: function(){} }
        }
    };
`;

async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36');
        await page.evaluateOnNewDocument(TELEGRAM_MOCK);

        // STEP 1: Navigate - don't overthink it
        console.log(`[S] ${symbol} - Navigate`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 4000));

        // STEP 2: Find search input - we know it exists based on logs
        console.log(`[S] ${symbol} - Find input`);
        const inputSel = 'input';
        let input;
        try {
            await page.waitForSelector(inputSel, { timeout: 10000 });
            input = await page.$(inputSel);
        } catch (e) {
            console.log(`[S] ${symbol} - No input!`);
            return null;
        }

        // STEP 3: Click on input to make sure it's focused
        console.log(`[S] ${symbol} - Click & Type`);
        await input.click({ clickCount: 3 }); // Triple click to select all
        await page.keyboard.press('Backspace');
        await page.keyboard.type(symbol, { delay: 50 });
        await new Promise(r => setTimeout(r, 2000));

        // Check what's in the input
        const inputValue = await page.evaluate(() => {
            const inp = document.querySelector('input');
            return inp ? inp.value : "no input";
        });
        console.log(`[S] ${symbol} - Input value: "${inputValue}"`);

        // Press Enter to search
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));

        // Dump page to see search results
        const afterSearch = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log(`[S] ${symbol} - After search: ${afterSearch.replace(/\s+/g, ' ').slice(0, 200)}`);

        // STEP 4: Try to click on the symbol in results
        console.log(`[S] ${symbol} - Click result`);
        const clickResult = await page.evaluate((sym) => {
            const all = Array.from(document.querySelectorAll('*'));
            // Find element that contains EXACTLY our symbol
            for (const el of all) {
                const txt = el.innerText || "";
                const lines = txt.split('\n');
                for (const line of lines) {
                    const clean = line.trim().toUpperCase();
                    if (clean === sym || clean.startsWith(sym + ' ') || clean.startsWith(sym + '\t')) {
                        el.click();
                        return `clicked: ${line.slice(0, 30)}`;
                    }
                }
            }
            return "not found";
        }, symbol);
        console.log(`[S] ${symbol} - Result: ${clickResult}`);
        await new Promise(r => setTimeout(r, 4000));

        // STEP 5: Click Derinlik tab
        console.log(`[S] ${symbol} - Depth tab`);
        await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            for (const el of all) {
                if ((el.innerText || "").toLowerCase().trim() === 'derinlik') {
                    el.click();
                    break;
                }
            }
        });
        await new Promise(r => setTimeout(r, 4000));

        // STEP 6: Extract - look for numbers that could be lots
        console.log(`[S] ${symbol} - Extract`);
        const data = await page.evaluate(() => {
            const body = document.body.innerText;
            const lines = body.split('\n').filter(l => l.trim().length > 0);

            let maxNum = 0;
            let bestLine = "";

            lines.forEach(line => {
                // Skip obvious non-data lines
                const low = line.toLowerCase();
                if (low.includes('dakika') || low.includes('telegram') || low.includes('oturum') ||
                    low.includes('bağlan') || low.includes(':') || low.includes('ocak') ||
                    low.includes('2026') || low.includes('2025')) return;

                // Find large numbers (potential lots)
                const nums = line.match(/\d{4,}/g);
                if (nums) {
                    nums.forEach(n => {
                        const val = parseInt(n, 10);
                        if (val > 5000 && val < 100000000 && val > maxNum) {
                            maxNum = val;
                            bestLine = line;
                        }
                    });
                }
            });

            return { lot: maxNum, row: bestLine, totalLines: lines.length };
        });

        console.log(`[S] ${symbol} -> Lot: ${data.lot}, Lines: ${data.totalLines}`);
        if (data.row) console.log(`[S] ${symbol} - Row: "${data.row.slice(0, 50)}"`);

        return {
            symbol,
            priceStr: "0",
            ceilingStr: "0",
            topBidLot: data.lot,
            isCeiling: data.lot > 0
        };

    } catch (e) {
        console.error(`[S ERROR] ${symbol}: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
