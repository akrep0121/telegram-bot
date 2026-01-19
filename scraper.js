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

        // Step 1: Rapid Navigation
        console.log(`[GHOST] Navigating to: ${url.substring(0, 60)}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Step 2: Session Recovery (THE GHOST PROTOCOL)
        console.log(`[GHOST] Checking for session expiration...`);
        const sessionRecovered = await page.evaluate(async () => {
            const multiClick = (el) => {
                if (!el) return false;
                el.scrollIntoView();
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                el.click();
                return true;
            };

            const bodyText = document.body.innerText;
            if (bodyText.includes('Oturum Sona Erdi') || bodyText.includes('Yeniden Bağlan') || bodyText.includes('Bağlantınız kesildi')) {
                // Find reconnect button by various methods
                const allElements = Array.from(document.querySelectorAll('button, div, span, a'));

                // Method 1: Find by text content
                let reconnectBtn = allElements.find(b => {
                    const txt = (b.innerText || "").toLowerCase();
                    return txt.includes('yeniden bağlan') || txt.includes('yeniden baglan');
                });

                // Method 2: Find button-like elements near "Oturum Sona Erdi"
                if (!reconnectBtn) {
                    reconnectBtn = allElements.find(b => {
                        const txt = (b.innerText || "").toLowerCase();
                        return txt === 'bağlan' || txt === 'baglan' || txt === 'reconnect';
                    });
                }

                if (reconnectBtn) {
                    multiClick(reconnectBtn);
                    return "clicked";
                }
                return "not_found";
            }
            return "no_session_issue";
        });

        if (sessionRecovered === "clicked") {
            console.log(`[GHOST] Reconnect button clicked! Reloading page...`);
            await new Promise(r => setTimeout(r, 3000));
            await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
            console.log(`[GHOST] Page reloaded. Checking page state...`);

            // Dump page state after reload
            const postReloadDump = await page.evaluate(() => document.body.innerText.slice(0, 300));
            console.log(`[GHOST POST-RELOAD] Body: ${postReloadDump.replace(/\s+/g, ' ').slice(0, 200)}`);

            // Second session check - if still showing session expired, try clicking again
            const stillExpired = await page.evaluate(() => {
                const bodyText = document.body.innerText;
                return bodyText.includes('Oturum Sona Erdi') || bodyText.includes('Yeniden Bağlan');
            });

            if (stillExpired) {
                console.log(`[GHOST] Session STILL expired after reload! Trying reconnect again...`);
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, div, span, a'));
                    const reconnectBtn = btns.find(b => (b.innerText || "").toLowerCase().includes('yeniden'));
                    if (reconnectBtn) reconnectBtn.click();
                });
                await new Promise(r => setTimeout(r, 5000));
            }

            await new Promise(r => setTimeout(r, 5000));
        } else if (sessionRecovered === "not_found") {
            console.log(`[GHOST] Session issue detected but reconnect button NOT found.`);
        }

        // Step 3: Wait for App Shell Stabilization
        try {
            await page.waitForSelector('#addSymbolInput, #searchInput, input[placeholder*="Ara"]', { timeout: 20000 });
            console.log(`[GHOST] Search input found! Ready to search.`);
        } catch (e) {
            console.warn(`[GHOST WARNING] Search input still not found. Dumping diagnostic...`);
            const dump = await page.evaluate(() => document.body.innerText.slice(0, 500));
            console.log(`[GHOST DIAGNOSTIC] Body: ${dump.replace(/\s+/g, ' ')}`);
            throw new Error(`Uygulama arayüzü yüklenemedi (Arama kutusu bulunamadı).`);
        }

        // Step 4: Aggressive Search
        const inputSelector = '#addSymbolInput, #searchInput, input[placeholder*="Ara"]';
        await page.focus(inputSelector);
        await page.click(inputSelector);

        // Comprehensive clear
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
        await new Promise(r => setTimeout(r, 1000));
        await page.keyboard.press('Enter');

        // Step 5: Symbol Result Clicking
        try {
            await page.waitForFunction((s) => {
                const results = document.querySelector('#searchResults') || document.body;
                return Array.from(results.querySelectorAll('*')).some(el => {
                    const text = el.innerText?.trim().toUpperCase() || "";
                    return text === s || text.startsWith(s + " ") || text.includes("\n" + s + "\n");
                });
            }, { timeout: 10000 }, symbol);
        } catch (e) {
            console.warn(`[GHOST] ${symbol} result not visible in 10s.`);
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
            const matches = Array.from(results.querySelectorAll('*')).filter(el => {
                const text = el.innerText?.trim().toUpperCase() || "";
                return text === s || text.startsWith(s + " ") || text.includes("\n" + s + "\n");
            });

            if (matches.length > 0) return multiClick(matches[0]);

            // Fallback: Pick the first div with text length matching symbol closely
            const items = Array.from(document.querySelectorAll('#searchResults div, .search-row'));
            if (items.length > 0) return multiClick(items[0]);

            return false;
        }, symbol);

        if (!clicked) throw new Error(`${symbol} aramada çıkmadı.`);

        // Step 6: Detail Navigation & Extraction
        await new Promise(r => setTimeout(r, 3000));

        // Open Depth
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, a'));
            const dBtn = btns.find(b => b.innerText.toLowerCase().includes('derinlik'));
            if (dBtn) {
                dBtn.click();
                dBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
        });

        await new Promise(r => setTimeout(r, 4000));

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

            lines.forEach((line, idx) => {
                if (isHdr(line) || isDt(line)) return;

                const maskedLine = maskTime(line);
                const digits = (maskedLine.match(/\d+/g) || []).map(d => parseN(d));
                const validNums = digits.filter(n => n > 100 && n !== 1800 && n !== 900 && n !== 1805);

                if (validNums.length > 0) {
                    const localMax = Math.max(...validNums);
                    const prevLine = lines[idx - 1] || "";
                    const score = (prevLine.toLowerCase().includes('alis') || prevLine.toLowerCase().includes('tavan')) ? 4 : 1;

                    if (localMax * score > topL) {
                        topL = localMax;
                        bestR = line;
                    }
                }
            });

            return {
                topBidLot: topL,
                bestRow: bestR,
                price: document.getElementById('lastPrice')?.innerText || "0",
                ceiling: document.getElementById('infoCeiling')?.innerText || "0"
            };
        }, symbol);

        console.log(`[GHOST] ${symbol} -> Lot: ${stats.topBidLot} (Row: "${stats.bestRow}")`);

        return {
            symbol,
            priceStr: stats.price,
            ceilingStr: stats.ceiling,
            topBidLot: stats.topBidLot,
            isCeiling: stats.topBidLot > 0
        };

    } catch (e) {
        console.error(`[GHOST ERROR] ${symbol}: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
