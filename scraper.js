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
 * @returns {Promise<number|null>} - The ceiling lot count or null if failed.
 */
async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        // Random user agent
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

        // Random viewport to avoid fingerprinting
        const viewports = [
            { width: 375, height: 812 },
            { width: 414, height: 896 },
            { width: 390, height: 844 }
        ];
        const viewport = viewports[Math.floor(Math.random() * viewports.length)];
        await page.setViewport(viewport);

        // Set extra headers to look more human
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        // Random delay before navigation (1-3 seconds) to appear more human
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

        // console.log(`Navigating to Web App...`); // Quiet logs
        let retries = 3;
        let loaded = false;

        while (retries > 0 && !loaded) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                loaded = true;
            } catch (e) {
                retries--;
                if (retries > 0) {
                    console.log(`Navigation failed, retrying... (${3 - retries}/3)`);
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    throw e;
                }
            }
        }

        // Check redirection
        const title = await page.title();
        if (title.includes("Telegram") || (await page.$('.tgme_page'))) {
            console.log("Session invalid.");
            return null; // Signals to get new URL
        }

        // console.log(`Searching for ${symbol}...`);

        // NAVIGATION
        const searchInputSelector = '#addSymbolInput';
        const fallbackSearchSelector = '#searchInput';

        let searchAttempt = 0;
        let searchSuccess = false;

        while (searchAttempt < 2 && !searchSuccess) {
            try {
                const targetSelector = await page.waitForSelector(`${searchInputSelector}, ${fallbackSearchSelector}`, { timeout: 10000 });

                // Focus and clear input
                await page.click(searchInputSelector).catch(() => page.click(fallbackSearchSelector));
                await page.keyboard.down('Control');
                await page.keyboard.press('A');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');

                // Type with delay
                await page.type(searchInputSelector, symbol, { delay: 100 }).catch(() => page.type(fallbackSearchSelector, symbol, { delay: 100 }));
                await page.keyboard.press('Enter');
                searchSuccess = true;
            } catch (e) {
                searchAttempt++;
                console.log(`Search attempt ${searchAttempt} failed for ${symbol}. Retrying...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!searchSuccess) {
            console.log("CRITICAL: No search input found! Dumping page content...");
            const html = await page.content();
            const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500).replace(/\n/g, ' '));
            console.log("PAGE PREVIEW:", bodyText);
            fs.writeFileSync('error_no_input.html', html);
            throw new Error("No search input found on page.");
        }

        // Wait for search results and specific symbol to exist
        await new Promise(r => setTimeout(r, 3000)); // Patience for UI render

        const found = await page.evaluate((sym) => {
            const resultsBox = document.querySelector('#searchResults');
            if (!resultsBox) return { success: false, reason: "No results box" };

            const allElements = Array.from(resultsBox.querySelectorAll('*'));
            const logs = [];

            // Pattern 1: Find by text content accurately
            const match = allElements.find(el => {
                const text = el.innerText?.trim().toUpperCase() || "";
                // Use regex to find exact symbol word or matching start
                const regex = new RegExp(`(^|\\s)${sym}($|\\s|\\.)`, 'i');
                return regex.test(text);
            });

            if (match) {
                // Determine the best element to click (the element itself or its nearest clickable parent)
                let target = match;
                while (target && target !== resultsBox) {
                    if (target.tagName === 'DIV' || target.tagName === 'BUTTON' || target.classList.contains('search-row')) {
                        target.click(); // Standard click
                        // Also try to dispatch event for assurance
                        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        return { success: true };
                    }
                    target = target.parentElement;
                }
                match.click(); // Final fallback
                return { success: true };
            }

            // If not found, log some info for debugging
            const allText = resultsBox.innerText;
            const children = Array.from(resultsBox.children).map(c => ({
                tag: c.tagName,
                text: c.innerText.substring(0, 50)
            }));

            // Pattern 2: Global Page Search (Last Resort)
            const globalElements = Array.from(document.querySelectorAll('div, span, p, b'));
            const globalMatch = globalElements.find(el => {
                const text = el.innerText?.trim().toUpperCase() || "";
                return text === sym || text.startsWith(sym + " ") || text.startsWith(sym + "\n");
            });

            if (globalMatch) {
                globalMatch.click();
                return { success: true, note: "Found via global search" };
            }

            return { success: false, reason: "Symbol not found anywhere", allText, children };
        }, symbol);

        if (!found.success) {
            console.log(`[SCRAPER] ${symbol} find failed: ${found.reason}`);
            if (found.allText) console.log("Search Results Text:", found.allText.substring(0, 200));

            const bodyPreview = await page.evaluate(() => document.body.innerText.substring(0, 500));
            console.log("Global Page Preview:", bodyPreview);

            const searchHtml = await page.content();
            fs.writeFileSync('search_fail_debug.html', searchHtml);
            await page.screenshot({ path: 'search_fail_debug.png' });

            // Fallback: Click the first item if it exists
            const firstItem = await page.$('#searchResults > div');
            if (firstItem) {
                console.log("Clicking first result as fallback...");
                await firstItem.click();
            } else {
                throw new Error("No search results found.");
            }
        } else {
            console.log(`[SCRAPER] Interaction for ${symbol} initiated successfully.`);
        }

        // Wait for Detail View (Check for multiple possible signs of detail view)
        try {
            await page.waitForFunction(
                () => {
                    const detail = document.querySelector('#detailView');
                    const depthTab = document.querySelector('button[data-tab="derinlik"]');
                    return (detail && detail.classList.contains('active')) || depthTab;
                },
                { timeout: 12000 }
            );
        } catch (e) {
            console.log("Detail view did not appear after click. Last HTML preview:");
            const preview = await page.evaluate(() => document.body.innerText.substring(0, 300));
            console.log("PREVIEW:", preview);
            await page.screenshot({ path: 'detail_fail_debug.png' });
            throw new Error(`Detail view for ${symbol} failed to activate.`);
        }

        // Click "Derinlik" tab
        const depthTabSelector = 'button[data-tab="derinlik"]';
        try {
            await page.waitForSelector(depthTabSelector, { timeout: 5000 });
            await page.click(depthTabSelector);
        } catch (e) {
            console.log("Depth tab not found. Trying to find by text...");
            const clicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, div, span'));
                const depthBtn = buttons.find(b => b.innerText.toLowerCase().includes('derinlik'));
                if (depthBtn) {
                    depthBtn.click();
                    return true;
                }
                return false;
            });
            if (!clicked) throw new Error("Could not find Derinlik tab.");
        }

        // Wait for depth data - INCREASED WAIT FOR SLOW SERVERS
        await new Promise(r => setTimeout(r, 3000));
        try {
            await page.waitForFunction(
                () => {
                    const content = document.querySelector('#depthContent');
                    // Ensure it doesn't have Skeleton or "--"
                    return content && !content.innerHTML.includes('skeleton') && !content.innerText.includes('--');
                },
                { timeout: 10000 }
            );
        } catch (e) { console.log("Depth data loading timeout - proceeding with partial data."); }

        // EXTRACT DATA
        const data = await page.evaluate(() => {
            const getTxt = (id) => document.getElementById(id)?.innerText?.trim() || "";
            const parseNum = (str, isLot = false) => {
                if (!str) return 0;
                let clean = str.trim();
                if (isLot) {
                    // For Lot counts: remove everything that is not a digit
                    return parseInt(clean.replace(/\D/g, ''), 10) || 0;
                }
                // For Prices: 16.171,50 or 16,171.50
                let lastSeparatorIndex = Math.max(clean.lastIndexOf(','), clean.lastIndexOf('.'));
                if (lastSeparatorIndex !== -1 && (clean.length - lastSeparatorIndex <= 3)) {
                    let decimal = clean.substring(lastSeparatorIndex + 1);
                    let integer = clean.substring(0, lastSeparatorIndex).replace(/[,.]/g, '');
                    return parseFloat(integer + "." + decimal) || 0;
                }
                return parseFloat(clean.replace(/[,.]/g, '')) || 0;
            };

            let priceStr = getTxt('lastPrice');
            let ceilingStr = getTxt('infoCeiling');

            // --- SMART FALLBACK FOR PRICE/CEILING ---
            if (!priceStr || priceStr === "--" || priceStr === "") {
                const allDivs = Array.from(document.querySelectorAll('div, span, b, p'));
                const priceLabel = allDivs.find(d => {
                    const t = d.innerText;
                    return t && (t.includes('Son Fiyat') || t.includes('Fiyat:'));
                });
                if (priceLabel && priceLabel.nextElementSibling) priceStr = priceLabel.nextElementSibling.innerText;
            }

            // Refined Depth Row Selection
            let rows = Array.from(document.querySelectorAll('#depthContent .depth-row:not(.skeleton-row)'));

            // --- SMART FALLBACK FOR ROWS ---
            if (rows.length === 0) {
                // Find ANY element that contains "Alış" and "Lot"
                const depthArea = Array.from(document.querySelectorAll('div, table, section')).find(el => {
                    const t = el.innerText;
                    return t && t.includes('Alış') && t.includes('Lot');
                });
                if (depthArea) {
                    rows = Array.from(depthArea.querySelectorAll('div, tr, .row')).filter(r => {
                        const txt = r.innerText;
                        // Looks like a row with 3 segments: [Price] [Lot] [Count]
                        return txt && /\d+.*\d+.*\d+/.test(txt);
                    });
                }
            }

            const firstRow = rows[0];
            const cells = firstRow ? Array.from(firstRow.querySelectorAll('div, td, span')).filter(c => c.innerText.trim() !== "") : [];
            const cellTexts = cells.map(c => c.innerText.trim());

            // In Tavan (Bid Side), usually: [Price] [Lot] [Count]
            const rawLotStr = cellTexts[1] || "0";

            return {
                symbol: getTxt('symbolDisplay'),
                priceStr: priceStr,
                ceilingStr: ceilingStr,
                rawLotStr: rawLotStr,
                allCells: cellTexts,
                price: parseNum(priceStr),
                ceiling: parseNum(ceilingStr),
                topBidLot: parseNum(rawLotStr, true), // Passing true for Lot parsing
                isCeiling: (priceStr !== "" && priceStr === ceilingStr)
            };
        });

        if (data) {
            console.log(`[DEBUG] ${symbol} -> Cells: [${data.allCells.join(' | ')}], Calculated Lot: ${data.topBidLot}`);
            // Safety check: if read lot is suspiciously small (like the price), log a warning
            if (data.topBidLot < 1000) {
                console.log(`[WARN] ${symbol} lot count (${data.topBidLot}) seems too low. Check if columns shifted.`);
            }
        }

        return data;

    } catch (error) {
        console.error(`Puppeteer Error (${symbol}):`, error.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
