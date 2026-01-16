const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');

/**
 * Launches a Headless Browser, navigates to the Web App URL,
 * and extracts the "Ceiling Lot" (Tavandaki Lot) data.
 * @param {string} url - The dynamic Web App URL with valid session.
 * @returns {Promise<number|null>} - The ceiling lot count or null if failed.
 */
async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled' // Extra stealth
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 375, height: 812 });

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
        try {
            await page.waitForSelector(searchInputSelector, { timeout: 10000 });
            await page.type(searchInputSelector, symbol, { delay: 100 });
            await page.keyboard.press('Enter');
        } catch (e) {
            // First fallback
            try {
                await page.waitForSelector('#searchInput', { timeout: 5000 });
                await page.type('#searchInput', symbol, { delay: 100 });
                await page.keyboard.press('Enter');
            } catch (err2) {
                console.log("CRITICAL: No search input found! Dumping page content...");
                const html = await page.content();
                // Print first 500 chars of body to log for immediate visibility in HF logs
                const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500).replace(/\n/g, ' '));
                console.log("PAGE PREVIEW:", bodyText);

                // Also save to file (though user might not see it easily in HF, helpful if they download)
                fs.writeFileSync('error_no_input.html', html);
                throw new Error("No search input found on page.");
            }
        }

        // Wait for search results
        // Results might take a moment to refresh after Enter
        await page.waitForSelector('#searchResults', { visible: true, timeout: 5000 }).catch(() => console.log("Results container wait timeout, assuming open."));
        await new Promise(r => setTimeout(r, 2000));

        // Find specific stock in results
        const found = await page.evaluate((sym) => {
            // Selector updated to find deeper rows, avoiding the container div
            const rows = Array.from(document.querySelectorAll('#searchResults .search-row'));

            // Exact match on data-symbol attribute if available, else fuzzy text
            const match = rows.find(row => {
                const rowSym = row.getAttribute('data-symbol');
                if (rowSym && rowSym === sym) return true;
                return row.innerText.toUpperCase().includes(sym);
            });

            if (match) {
                match.click();
                return true;
            }
            return false;
        }, symbol);

        if (!found) {
            console.log(`Symbol ${symbol} not found in results. Dumping search HTML...`);
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
            console.log(`Clicked result for ${symbol}.`);
        }

        // Wait for Detail View
        try {
            await page.waitForSelector('#detailView.view.active', { timeout: 10000 });
        } catch (e) {
            console.log("Detail view did not appear. Dumping state...");
            await page.screenshot({ path: 'detail_fail_debug.png' });
            throw e;
        }

        // Click "Derinlik" tab
        const depthTabSelector = 'button[data-tab="derinlik"]';
        await page.waitForSelector(depthTabSelector);
        await page.click(depthTabSelector);

        // Wait for depth data
        await new Promise(r => setTimeout(r, 1500));
        try {
            await page.waitForFunction(
                () => {
                    const content = document.querySelector('#depthContent');
                    return content && !content.innerText.includes('--') && content.innerText.length > 20;
                },
                { timeout: 5000 }
            );
        } catch (e) { } // Proceed anyway to grab what we can

        // EXTRACT DATA
        const data = await page.evaluate(() => {
            const getTxt = (id) => document.getElementById(id)?.innerText?.trim() || "";
            const parseNum = (str) => {
                if (!str) return 0;
                // "4,75" -> 4.75; "176.703" -> 176703
                // Remove dots (thousands/millions) then replace comma with dot
                // Wait, 176.703 is 176 thousand. So remove dots.
                // Price 4,75.
                // Logic: remove '.' (thousands sep), replace ',' with '.'
                let clean = str.replace(/\./g, '').replace(',', '.');
                return parseFloat(clean) || 0;
            };

            const priceStr = getTxt('lastPrice');
            const ceilingStr = getTxt('infoCeiling');

            // Depth Table Top Row (First Bid) => div:nth-child(2) is Lot
            const topBidLotStr = document.querySelector('#depthContent .depth-row:not(.skeleton-row) > div:nth-child(2)')?.innerText || "0";

            return {
                symbol: getTxt('symbolDisplay'),
                price: parseNum(priceStr),
                ceiling: parseNum(ceilingStr),
                topBidLot: parseNum(topBidLotStr),
                isCeiling: (priceStr === ceilingStr && priceStr !== "") // Exact string match covers float issues
            };
        });

        return data;

    } catch (error) {
        console.error(`Puppeteer Error (${symbol}):`, error.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
