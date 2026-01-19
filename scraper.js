const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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

        console.log(`[S] ${symbol} - Navigate`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

        // TRY TO DISMISS MODAL BY CLICKING AT VARIOUS COORDINATES
        console.log(`[S] ${symbol} - Trying to dismiss modal...`);

        // Try clicking in different areas
        const clickPoints = [
            { x: 195, y: 750 },  // Bottom center (likely OK button location)
            { x: 195, y: 700 },  // Above that
            { x: 195, y: 650 },  // Above that
            { x: 195, y: 420 },  // Middle of screen
            { x: 350, y: 50 },   // Top right (close X button)
            { x: 40, y: 50 },    // Top left
        ];

        for (let i = 0; i < clickPoints.length; i++) {
            const pt = clickPoints[i];
            await page.mouse.click(pt.x, pt.y);
            await new Promise(r => setTimeout(r, 500));
        }

        // Also try keyboard
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Space');
        await new Promise(r => setTimeout(r, 2000));

        // Check if modal is gone
        const afterClicks = await page.evaluate(() => document.body.innerText.slice(0, 200));
        console.log(`[S] ${symbol} - After clicks: ${afterClicks.replace(/\s+/g, ' ').slice(0, 100)}`);

        // Find and use search input
        console.log(`[S] ${symbol} - Search`);
        const inputSel = 'input';
        try {
            await page.waitForSelector(inputSel, { timeout: 5000 });
        } catch (e) {
            console.log(`[S] ${symbol} - No input!`);
            return null;
        }

        // Clear and type
        const input = await page.$(inputSel);
        await input.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.keyboard.type(symbol, { delay: 30 });

        // Verify input
        const inputVal = await page.evaluate(() => document.querySelector('input')?.value || "");
        console.log(`[S] ${symbol} - Input: "${inputVal}"`);

        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 5000)); // Longer wait

        // Dump page content to see if search worked
        const afterSearch = await page.evaluate(() => {
            const text = document.body.innerText;
            return {
                full: text,
                hasSymbol: text.toUpperCase().includes('FRMPL') || text.toUpperCase().includes('ZGYO'),
                length: text.length
            };
        });

        console.log(`[S] ${symbol} - Page has symbol: ${afterSearch.hasSymbol}, length: ${afterSearch.length}`);
        console.log(`[S] ${symbol} - Sample: ${afterSearch.full.replace(/\s+/g, ' ').slice(0, 200)}`);

        // Try to click on symbol
        const clicked = await page.evaluate((sym) => {
            const elements = Array.from(document.querySelectorAll('*'));
            for (const el of elements) {
                const txt = (el.innerText || "").toUpperCase();
                if (txt.includes(sym) && txt.length < 100) {
                    el.click();
                    return "clicked: " + txt.slice(0, 30);
                }
            }
            return "not found";
        }, symbol);
        console.log(`[S] ${symbol} - Click: ${clicked}`);
        await new Promise(r => setTimeout(r, 4000));

        // Click depth tab
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

        // Extract data
        console.log(`[S] ${symbol} - Extract`);
        const data = await page.evaluate(() => {
            const body = document.body.innerText;
            const lines = body.split('\n').filter(l => l.trim());

            let maxNum = 0;
            let bestLine = "";

            lines.forEach(line => {
                const low = line.toLowerCase();
                if (low.includes('dakika') || low.includes('telegram') || low.includes('oturum') ||
                    low.includes('bağlan') || low.includes(':') || /ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık|2025|2026/i.test(low)) return;

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

            return { lot: maxNum, row: bestLine, lines: lines.length };
        });

        console.log(`[S] ${symbol} -> Lot: ${data.lot}, Lines: ${data.lines}`);
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
