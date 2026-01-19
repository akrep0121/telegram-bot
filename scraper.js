const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');

// Random User Agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

async function fetchMarketData(url, symbol) {
    let browser = null;
    try {
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', `--user-agent=${userAgent}`]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });

        // Navigation
        let retries = 2;
        while (retries > 0) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                break;
            } catch (e) {
                retries--;
                if (retries === 0) throw e;
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // Search Interaction
        const searchPath = '#addSymbolInput, #searchInput, input[placeholder*="Ara"]';
        const input = await page.waitForSelector(searchPath, { timeout: 10000 });

        await page.evaluate((sel, sym) => {
            const el = document.querySelector(sel);
            if (el) {
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, searchPath, symbol);

        await input.click();
        await page.keyboard.type(symbol, { delay: 100 });
        await page.keyboard.press('Enter');

        // Aggressive Result Search (Wait up to 10s for the item)
        let found = false;
        for (let i = 0; i < 20; i++) {
            found = await page.evaluate((s) => {
                const results = document.querySelector('#searchResults') || document.body;
                const match = Array.from(results.querySelectorAll('*')).find(el => {
                    const t = el.innerText?.trim().toUpperCase() || "";
                    return t === s || t.startsWith(s + " ") || t.includes("\n" + s + "\n");
                });
                if (match) {
                    match.click();
                    match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return true;
                }
                return false;
            }, symbol);
            if (found) break;
            await new Promise(r => setTimeout(r, 500));
        }

        if (!found) {
            // Last resort: Click first child of results
            const first = await page.$('#searchResults > div, .search-row, .result-item');
            if (first) await first.click();
            else throw new Error(`${symbol} arama sonucunda bulunamadı.`);
        }

        // Wait for detail & depth
        await new Promise(r => setTimeout(r, 3000));
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button, div, span')).find(b => b.innerText.toLowerCase().includes('derinlik'));
            if (btn) btn.click();
        });

        // WAIT FOR DIGITS (The data)
        let dataReady = false;
        for (let i = 0; i < 15; i++) {
            dataReady = await page.evaluate(() => {
                const area = document.querySelector('#depthContent, #detailView, .depth-table') || document.body;
                // Look for a row that has multiple digits (Price/Lot)
                const text = area.innerText;
                const rows = text.split('\n').filter(line => (line.match(/\d/g) || []).length >= 5);
                return rows.length > 0;
            });
            if (dataReady) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        const stats = await page.evaluate(() => {
            const parseNum = (s) => parseInt(s.replace(/\D/g, ''), 10) || 0;
            const getPrice = (id) => document.getElementById(id)?.innerText || "";

            let price = getPrice('lastPrice');
            let ceiling = getPrice('infoCeiling');

            const allText = document.body.innerText;
            const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            // Month names to skip
            const months = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
            const monthRegex = new RegExp(months.join('|'), 'i');

            // Find rows that look like depth data
            const dataRows = lines.filter(l => {
                const digitCount = (l.match(/\d/g) || []).length;
                const isHeader = /Hacim|Fiyat|Lot|Alanlar|Satanlar|Piyasa/i.test(l);
                const isDate = monthRegex.test(l) || /2025|2026|2027/.test(l);
                // Row should have digits, not be a header, and not be a date
                return digitCount >= 4 && !isHeader && !isDate;
            });

            let topLot = 0;
            let bestRow = "";
            dataRows.forEach(row => {
                // Split by space and find numbers. Candidates for lot should be large.
                const parts = row.split(/\s+/).map(p => parseNum(p));
                const candidates = parts.filter(p => p > 100 && p !== 2025 && p !== 2026);
                const max = candidates.length > 0 ? Math.max(...candidates) : 0;

                if (max > topLot) {
                    topLot = max;
                    bestRow = row;
                }
            });

            return {
                priceStr: price,
                ceilingStr: ceiling,
                topBidLot: topLot,
                bestRow: bestRow,
                allLines: lines.slice(0, 50)
            };
        });

        console.log(`[DEBUG] ${symbol} Result -> Lot: ${stats.topBidLot}, Row: ${stats.bestRow}`);

        return {
            symbol,
            priceStr: stats.priceStr || "0",
            ceilingStr: stats.ceilingStr || "0",
            topBidLot: stats.topBidLot,
            isCeiling: true // Default true for alerts if lot > 0, logic in index.js will refine
        };

    } catch (e) {
        console.error(`[SCRAPE ERROR] ${symbol}: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { fetchMarketData };
