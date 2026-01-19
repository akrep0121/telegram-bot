const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Telegram WebApp API Mock - Makes the page think it's running in Telegram
const TELEGRAM_WEBAPP_MOCK = `
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
            headerColor: "#ffffff",
            backgroundColor: "#ffffff",
            isClosingConfirmationEnabled: false,
            ready: function() { console.log("WebApp.ready called"); },
            expand: function() {},
            close: function() {},
            enableClosingConfirmation: function() {},
            disableClosingConfirmation: function() {},
            onEvent: function(eventType, callback) {},
            offEvent: function(eventType, callback) {},
            sendData: function(data) {},
            openLink: function(url) {},
            openTelegramLink: function(url) {},
            showPopup: function(params, callback) {},
            showAlert: function(message, callback) { if(callback) callback(); },
            showConfirm: function(message, callback) { if(callback) callback(true); },
            MainButton: {
                text: "",
                color: "#2481cc",
                textColor: "#ffffff",
                isVisible: false,
                isActive: true,
                isProgressVisible: false,
                setText: function(text) { this.text = text; },
                onClick: function(callback) {},
                offClick: function(callback) {},
                show: function() { this.isVisible = true; },
                hide: function() { this.isVisible = false; },
                enable: function() { this.isActive = true; },
                disable: function() { this.isActive = false; },
                showProgress: function() { this.isProgressVisible = true; },
                hideProgress: function() { this.isProgressVisible = false; }
            },
            BackButton: {
                isVisible: false,
                onClick: function(callback) {},
                offClick: function(callback) {},
                show: function() { this.isVisible = true; },
                hide: function() { this.isVisible = false; }
            },
            HapticFeedback: {
                impactOccurred: function(style) {},
                notificationOccurred: function(type) {},
                selectionChanged: function() {}
            }
        }
    };
    console.log("Telegram WebApp API Mock injected!");
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
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');

        // Inject Telegram WebApp API BEFORE page loads
        await page.evaluateOnNewDocument(TELEGRAM_WEBAPP_MOCK);

        console.log(`[SCRAPER] ${symbol} - Navigating with Telegram mock...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

        // Check if mock was applied
        const hasTelegram = await page.evaluate(() => !!window.Telegram?.WebApp);
        console.log(`[SCRAPER] ${symbol} - Telegram API present: ${hasTelegram}`);

        // Check page state
        const pageState = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return {
                hasExpired: bodyText.includes('Oturum Sona Erdi') || bodyText.includes('Bağlantınız kesildi'),
                hasWarning: bodyText.includes('10 dakika boyunca'),
                sample: bodyText.slice(0, 300).replace(/\s+/g, ' ')
            };
        });

        console.log(`[DIAGNOSTIC] ${symbol} - expired=${pageState.hasExpired}, warning=${pageState.hasWarning}`);
        console.log(`[DIAGNOSTIC] ${symbol} - Page: ${pageState.sample.slice(0, 150)}`);

        // If session expired, try clicking reconnect
        if (pageState.hasExpired) {
            console.log(`[SCRAPER] ${symbol} - Clicking reconnect...`);
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('*'));
                const reconnect = btns.find(b => (b.innerText || "").toLowerCase().includes('yeniden bağlan'));
                if (reconnect) reconnect.click();
            });
            await new Promise(r => setTimeout(r, 5000));
        }

        // Try to dismiss any modal
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 2000));

        // Find search input
        console.log(`[SCRAPER] ${symbol} - Searching...`);
        const inputSelector = 'input[type="text"], input[type="search"], input[placeholder*="Ara"], #addSymbolInput, #searchInput';

        try {
            await page.waitForSelector(inputSelector, { timeout: 10000 });
        } catch (e) {
            console.log(`[SCRAPER] ${symbol} - No search input found!`);
            const fullDump = await page.evaluate(() => document.body.innerText);
            console.log(`[DEBUG] ${symbol} - Full page (${fullDump.length} chars): ${fullDump.replace(/\s+/g, ' ').slice(0, 400)}`);
            return null;
        }

        // Type symbol
        await page.click(inputSelector);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(symbol, { delay: 30 });
        await new Promise(r => setTimeout(r, 1500));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));

        // Click result
        console.log(`[SCRAPER] ${symbol} - Clicking result...`);
        await page.evaluate((s) => {
            const all = Array.from(document.querySelectorAll('*'));
            const match = all.find(el => (el.innerText || "").toUpperCase().includes(s));
            if (match) match.click();
        }, symbol);
        await new Promise(r => setTimeout(r, 4000));

        // Click depth tab
        console.log(`[SCRAPER] ${symbol} - Opening depth...`);
        await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            const depth = all.find(el => (el.innerText || "").toLowerCase().includes('derinlik'));
            if (depth) depth.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // Extract data
        console.log(`[SCRAPER] ${symbol} - Extracting...`);
        const data = await page.evaluate(() => {
            const parseNum = (s) => parseInt((s || "").replace(/\D/g, ''), 10) || 0;
            const maskTime = (s) => (s || "").replace(/\d{1,2}[:.]\d{2}/g, ' ');
            const lines = document.body.innerText.split('\n').filter(l => l.trim().length > 3);

            let maxLot = 0;
            let bestRow = "";

            lines.forEach(line => {
                if (/dakika|telegram|hacim|fiyat|ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık|2025|2026/i.test(line)) return;

                const masked = maskTime(line);
                const nums = (masked.match(/\d{3,}/g) || []).map(n => parseNum(n));
                const safe = nums.filter(n => n > 500 && n < 50000000 && ![1800, 900, 1730, 930].includes(n));

                if (safe.length > 0) {
                    const max = Math.max(...safe);
                    if (max > maxLot) {
                        maxLot = max;
                        bestRow = line;
                    }
                }
            });

            return { topBidLot: maxLot, bestRow, lineCount: lines.length };
        });

        console.log(`[SCRAPER] ${symbol} -> Lot: ${data.topBidLot}, Lines: ${data.lineCount}`);
        if (data.bestRow) console.log(`[SCRAPER] ${symbol} - Row: "${data.bestRow.slice(0, 50)}"`);

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
