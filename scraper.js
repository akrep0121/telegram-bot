const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');

// Telegram WebApp API Mock - Essential for bypassing environment checks
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
            viewportHeight: 800,
            viewportStableHeight: 800,
            headerColor: "#ffffff",
            backgroundColor: "#ffffff",
            isClosingConfirmationEnabled: false,
            ready: function() { console.log("Telegram.WebApp.ready()"); },
            expand: function() {},
            close: function() {},
            enableClosingConfirmation: function() {},
            disableClosingConfirmation: function() {},
            onEvent: function() {},
            offEvent: function() {},
            sendData: function() {},
            openLink: function() {},
            openTelegramLink: function() {},
            showPopup: function() {},
            showAlert: function() {},
            showConfirm: function() {},
            MainButton: {
                text: "", 
                color: "#2481cc", 
                textColor: "#ffffff", 
                isVisible: false, 
                isActive: true,
                show: function() { this.isVisible = true; },
                hide: function() { this.isVisible = false; },
                enable: function() { this.isActive = true; },
                disable: function() { this.isActive = false; },
                setText: function(t) { this.text = t; },
                onClick: function() {},
                offClick: function() {},
                showProgress: function() {},
                hideProgress: function() {}
            },
            BackButton: {
                isVisible: false,
                onClick: function() {},
                offClick: function() {},
                show: function() { this.isVisible = true; },
                hide: function() { this.isVisible = false; }
            },
            HapticFeedback: {
                impactOccurred: function() {},
                notificationOccurred: function() {},
                selectionChanged: function() {}
            }
        }
    };
`;

/**
 * Launches a Headless Browser with Telegram Mock and Mobile UA.
 */
async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const page = await browser.newPage();

        // Mobile Viewport
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

        // Mobile User Agent (Android)
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36');

        // Inject Telegram Mock BEFORE navigation
        await page.evaluateOnNewDocument(TELEGRAM_MOCK);

        console.log(`[SCRAPER] ${symbol} - Navigating...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for page load
        await new Promise(r => setTimeout(r, 4000));

        // DEBUG: Check page state
        const pageState = await page.evaluate(() => {
            const body = document.body.innerText;
            return {
                expired: body.includes('Oturum Sona Erdi') || body.includes('Bağlantınız kesildi'),
                warning: body.includes('10 dakika'),
                telegramPresent: !!window.Telegram.WebApp,
                preview: body.slice(0, 200).replace(/\n/g, ' ')
            };
        });
        console.log(`[DEBUG] ${symbol} State: Expired=${pageState.expired}, Warning=${pageState.warning}, Mock=${pageState.telegramPresent}`);

        // HANDLE MODALS AND RECONNECT
        if (pageState.expired) {
            console.log(`[SCRAPER] ${symbol} - Clicking Reconnect...`);
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a, div, span'));
                const reconnect = btns.find(b => (b.innerText || "").toLowerCase().includes('yeniden bağlan'));
                if (reconnect) reconnect.click();
            });
            await new Promise(r => setTimeout(r, 4000));
        }

        // Dismiss warning modal (Always try this)
        console.log(`[SCRAPER] ${symbol} - Dismissing modals...`);
        // 1. Try Enter
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 500));

        // 2. Try clicking coordinates (Bottom center - often 'Tamam'/'Anladim')
        await page.mouse.click(195, 750);
        await new Promise(r => setTimeout(r, 500));
        await page.mouse.click(195, 700);

        // 3. Try clicking "Anladım" / "Tamam" buttons
        await page.evaluate(() => {
            const texts = ['anladım', 'tamam', 'devam', 'kapat', 'ok', 'close'];
            const all = Array.from(document.querySelectorAll('button, div[role="button"], a, span'));
            for (const el of all) {
                const txt = (el.innerText || "").toLowerCase().trim();
                if (texts.some(t => txt === t || txt.includes(t)) && !txt.includes('yeniden')) {
                    el.click();
                }
            }
        });
        await new Promise(r => setTimeout(r, 2000));

        // SEARCH
        console.log(`[SCRAPER] ${symbol} - Searching...`);

        // Try multiple selectors for input
        const inputSelectors = ['#addSymbolInput', '#searchInput', 'input[type="text"]', 'input[type="search"]'];
        let inputFound = false;

        for (const sel of inputSelectors) {
            if (await page.$(sel)) {
                console.log(`[SCRAPER] Found input: ${sel}`);
                await page.click(sel);
                // Select all and delete
                await page.evaluate((s) => { document.querySelector(s).value = ''; }, sel);
                await page.type(sel, symbol, { delay: 100 });
                inputFound = true;
                break;
            }
        }

        if (!inputFound) {
            console.log(`[SCRAPER] No input found! Dumping body...`);
            const bodyDump = await page.evaluate(() => document.body.innerText.slice(0, 300));
            console.log(`[DUMP] ${bodyDump}`);
            return null;
        }

        await new Promise(r => setTimeout(r, 1000));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 4000));

        // CLICK RESULT
        console.log(`[SCRAPER] ${symbol} - Clicking result...`);
        // Use the robust finding logic from older working code but adapted
        const clicked = await page.evaluate((sym) => {
            // Try specific container first
            const container = document.getElementById('searchResults');
            if (container) {
                const rows = Array.from(container.querySelectorAll('.search-row, div, li'));
                const match = rows.find(r => r.innerText.toUpperCase().includes(sym));
                if (match) { match.click(); return "clicked_container"; }
            }

            // Fallback to global search
            const all = Array.from(document.querySelectorAll('div, span, li'));
            const match = all.find(el => {
                const t = el.innerText.toUpperCase();
                return t === sym || t.startsWith(sym + " ") || t.startsWith(sym + "\n");
            });
            if (match) { match.click(); return "clicked_global"; }

            return "not_found";
        }, symbol);

        if (clicked === "not_found") {
            // Fallback: Click first generic result
            console.log(`[SCRAPER] ${symbol} - Not found specific, clicking first valid result...`);
            await page.evaluate(() => {
                const first = document.querySelector('#searchResults > div, .search-row');
                if (first) first.click();
            });
        }

        await new Promise(r => setTimeout(r, 4000));

        // CLICK DEPTH TAB
        console.log(`[SCRAPER] ${symbol} - Opening Depth Loop...`);
        let depthSuccess = false;

        // Retry clicking depth tab distinct times
        for (let i = 0; i < 3; i++) {
            const clickResult = await page.evaluate(() => {
                const tabs = Array.from(document.querySelectorAll('button, div, span, a, li'));
                const depth = tabs.find(t => {
                    const txt = (t.innerText || "").toLowerCase().trim();
                    return txt === 'derinlik' || txt.includes('derinlik');
                });

                if (depth) {
                    depth.click();
                    return `clicked: "${depth.innerText}" tag:${depth.tagName}`;
                }
                return "not_found";
            });

            console.log(`[SCRAPER] ${symbol} - Depth click attempt ${i + 1}: ${clickResult}`);

            if (clickResult !== "not_found") {
                depthSuccess = true;
                break;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        await new Promise(r => setTimeout(r, 4000));

        // DEBUG: Check if we are actually on the depth tab
        const depthCheck = await page.evaluate(() => {
            const body = document.body.innerText;
            return {
                hasLotHeader: body.includes('Lot') || body.includes('Alış'),
                sample: body.slice(0, 300).replace(/\n/g, ' ')
            };
        });
        console.log(`[DEBUG] ${symbol} After Depth Click: HasLotHeader=${depthCheck.hasLotHeader}, Content=${depthCheck.sample}`);

        // EXTRACT LOOP (Wait for data)
        console.log(`[SCRAPER] ${symbol} - Extracting...`);
        const data = await page.evaluate(() => {
            const getPrice = () => {
                const el = document.getElementById('lastPrice') || document.querySelector('.price-main');
                return el ? el.innerText.trim() : "0";
            };
            const price = getPrice();

            const lines = document.body.innerText.split('\n');
            let maxLot = 0;
            const currentYear = new Date().getFullYear();

            // Collect all candidate numbers for debugging inside evaluate if needed
            // identifying lots: integers, large, not years
            lines.forEach(line => {
                // Heuristics to skip non-lot lines
                if (line.includes(':') || line.length > 50) return;

                // Remove thousands separators
                const cleanLine = line.replace(/\./g, '').replace(/,/g, '');

                const nums = cleanLine.match(/\d+/g);
                if (!nums) return;

                nums.forEach(nStr => {
                    const n = parseInt(nStr, 10);

                    // Filter:
                    // 1. Must be > 100
                    // 2. Must be < 100M
                    // 3. Must NOT be a year (2024, 2025, 2026, 2027 ± 1)
                    // 4. Must NOT be commonly found static numbers (like 1800, 900 if those are persistent UI elements)

                    if (n > 100 && n < 50000000) {
                        // Strict Year Filter
                        if (n >= currentYear - 1 && n <= currentYear + 2) return;

                        if (n > maxLot) maxLot = n;
                    }
                });
            });

            return {
                priceStr: price,
                topBidLot: maxLot,
                isCeiling: false
            };
        });

        console.log(`[SCRAPER] ${symbol} -> Lot: ${data.topBidLot}`);

        return {
            symbol,
            priceStr: data.priceStr,
            ceilingStr: data.priceStr, // Assume ceiling for now
            topBidLot: data.topBidLot,
            isCeiling: data.topBidLot > 0
        };

    } catch (e) {
        console.error(`Puppeteer Error (${symbol}):`, e.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
