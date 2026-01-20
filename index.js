const { Bot } = require("grammy");
const auth = require("./auth");
const scraper = require("./scraper");
const config = require("./config");
const fs = require('fs');
const express = require('express');

// --- KEEP-ALIVE SERVER (For Render/HuggingFace) ---
const app = express();
const port = process.env.PORT || 7860;
app.get('/', (req, res) => res.send('System V3 Running 🚀'));
app.listen(port, () => console.log(`Server on port ${port}`));

// --- TELEGRAM BOT SETUP ---
const bot = new Bot(config.BOT_TOKEN, {
    client: { apiRoot: "https://api.telegram.org" }
});

// Access Control
bot.use(async (ctx, next) => {
    const adminId = process.env.ADMIN_ID;
    if (adminId && String(ctx.from?.id) !== String(adminId)) {
        console.log(`Unauthorized access attempt: ${ctx.from?.id}`);
        return;
    }
    await next();
});

// --- STATE ---
let watchedStocks = []; // List of symbols
let stockData = {};     // { 'SASA': { initialLot: 50000, lastLot: 45000 } }
let isBotActive = true;
let isCheckRunning = false;
let lastReportHour = -1;

// --- COMMANDS ---

bot.command("start", async (ctx) => {
    ctx.reply(`🤖 Bot Hazır!\nID: ${ctx.from.id}\n\nKomutlar:\n/ekle [HİSSE]\n/sil [HİSSE]\n/liste\n/test\n/aktif\n/pasif`);
});

bot.command("ekle", async (ctx) => {
    const symbol = ctx.match.toString().toUpperCase().trim();
    if (!symbol) return ctx.reply("❌ Hatalı kullanım: /ekle SASA");
    if (watchedStocks.includes(symbol)) return ctx.reply("ℹ️ Zaten listede.");

    watchedStocks.push(symbol);
    await syncStateToCloud(`✅ ${symbol} eklendi.`);
});

bot.command("sil", async (ctx) => {
    const symbol = ctx.match.toString().toUpperCase().trim();
    if (!watchedStocks.includes(symbol)) return ctx.reply("ℹ️ Listede yok.");

    watchedStocks = watchedStocks.filter(s => s !== symbol);
    delete stockData[symbol]; // Clear cache
    await syncStateToCloud(`🗑️ ${symbol} silindi.`);
});

bot.command("liste", (ctx) => {
    if (watchedStocks.length === 0) return ctx.reply("📭 Liste boş.");

    let msg = "📋 **Takip Listesi**\n";
    watchedStocks.forEach(s => {
        const data = stockData[s];
        if (data) {
            msg += `- ${s}: ${fmt(data.lastLot)} Lot (Başlangıç: ${fmt(data.initialLot)})\n`;
        } else {
            msg += `- ${s}: Veri bekleniyor...\n`;
        }
    });
    ctx.reply(msg);
});

bot.command("pasif", async (ctx) => {
    isBotActive = false;
    await syncStateToCloud("⏸️ Sistem pasife alındı.");
});

bot.command("aktif", async (ctx) => {
    isBotActive = true;
    await syncStateToCloud("▶️ Sistem aktif edildi.");
});

// --- CRITICAL: /TEST COMMAND ---
bot.command("test", async (ctx) => {
    // 1. Only for Admin (Already handled by middleware, but double check)
    // 2. Output ONLY to ctx (User), NEVER to Channel.

    if (watchedStocks.length === 0) return ctx.reply("Liste boş, test edilemez.");

    await ctx.reply(`🧪 Test Başlatılıyor (${watchedStocks.length} hisse)...`);

    for (const stock of watchedStocks) {
        await ctx.reply(`🔍 ${stock} kontrol ediliyor...`);

        // Manual standard check cycle
        const lot = await performStockCheck(stock, ctx); // Pass ctx for verbose logs to USER

        if (lot !== null) {
            await ctx.reply(`✅ ${stock} Başarılı! Okunan Lot: ${fmt(lot)}`);
        } else {
            await ctx.reply(`❌ ${stock} Başarısız! (OCR/Timeout)`);
        }

        // Wait a bit
        await delay(3000);
    }
    await ctx.reply("🏁 Test Tamamlandı.");
});


// --- MAIN LOOP ---

async function mainLoop() {
    if (!isBotActive || isCheckRunning) return;

    const now = new Date();
    // Adjust to Turkey Time (UTC+3)
    const trTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const hour = trTime.getUTCHours();
    const minute = trTime.getUTCMinutes();
    const day = trTime.getUTCDay(); // 0=Sun, 6=Sat

    // 1. Time Rules
    // Market Hours: 10:00 - 18:00 (approx)
    if (day === 0 || day === 6) return; // Weekend
    if (hour < 9 || hour >= 18) return; // Night

    isCheckRunning = true;

    try {
        // 2. Reporting Schedule (10, 12, 14, 16, 18)
        const reportHours = [10, 12, 14, 16, 18];
        if (minute === 0 && reportHours.includes(hour) && lastReportHour !== hour) {
            await sendGeneralReport(hour);
            lastReportHour = hour;
        }

        // 3. Stock Checks
        console.log(`[LOOP] Starting check cycle for ${watchedStocks.length} stocks.`);

        for (const stock of watchedStocks) {
            if (!isBotActive) break;

            const currentLot = await performStockCheck(stock);

            if (currentLot !== null) {
                // Update Cache
                if (!stockData[stock]) {
                    stockData[stock] = { initialLot: currentLot, lastLot: currentLot };
                }

                const data = stockData[stock];

                // Alert Logic: Drop check
                // If initialLot is 0/undefined, set it now
                if (!data.initialLot) data.initialLot = currentLot;

                // Check Threshold (e.g. 70%)
                const threshold = data.initialLot * 0.7;
                data.lastLot = currentLot;

                if (currentLot < threshold) {
                    // ALERT!
                    const dropMsg = `⚠️ **TAVAN BOZMA RİSKİ!**\n\n` +
                        `📉 Hisse: #${stock}\n` +
                        `🔻 Mevcut Lot: ${fmt(currentLot)}\n` +
                        `📊 Başlangıç: ${fmt(data.initialLot)}\n` +
                        `⚠️ Kritik seviyenin altına indi!`;

                    await broadcast(dropMsg);

                    // Reset initial logic? Or keep alerting? 
                    // To avoid spam, maybe update initialLot to current so we don't spam?
                    // For now, valid alert.
                }
            }

            // Wait between stocks to avoid spamming the target bot
            // Reduced to 4s for faster cycle
            await delay(4000);
        }

    } catch (e) {
        console.error("[LOOP] Error:", e);
    } finally {
        isCheckRunning = false;
    }
}

// Single Stock Check
async function performStockCheck(symbol, verboseCtx = null) {
    // 1. Send Command
    const sent = await auth.requestStockDerinlik(symbol);
    if (!sent) {
        if (verboseCtx) await verboseCtx.reply(`❌ ${symbol}: Komut gönderilemedi.`);
        return null;
    }

    // 2. Wait Response
    const msg = await auth.waitForBotResponse(25000);
    if (!msg) {
        if (verboseCtx) await verboseCtx.reply(`⚠️ ${symbol}: Yanıt gelmedi (Timeout).`);
        return null;
    }

    // 3. Download
    const buffer = await auth.downloadBotPhoto(msg);
    if (!buffer) {
        if (verboseCtx) await verboseCtx.reply(`⚠️ ${symbol}: Fotoğraf indirilemedi.`);
        return null;
    }

    // 4. OCR
    const result = await scraper.extractLotFromImage(buffer, symbol);
    if (result && result.topBidLot) {
        return result.topBidLot;
    } else {
        return null;
    }
}


// --- HELPERS ---

async function sendGeneralReport(hour) {
    if (watchedStocks.length === 0) return;

    let report = `📊 **Piyasa Durum Raporu (${hour}:00)**\n\n`;

    for (const stock of watchedStocks) {
        const data = stockData[stock];
        if (data) {
            const emoji = (data.lastLot < data.initialLot) ? '📉' : '✅';
            report += `${emoji} #${stock}: ${fmt(data.lastLot)} Lot\n`;
        } else {
            report += `⏳ #${stock}: Veri yok\n`;
        }
    }

    report += `\n🤖 Takip Devam Ediyor...`;
    await broadcast(report);
}

async function broadcast(text) {
    // 1. Send to Admin
    if (process.env.ADMIN_ID) {
        try { await bot.api.sendMessage(process.env.ADMIN_ID, text); } catch (e) { }
    }
    // 2. Send to Channel (if configured)
    if (config.CHANNEL_ID) {
        try { await bot.api.sendMessage(config.CHANNEL_ID, text); } catch (e) { }
    }
}

async function syncStateToCloud(replyMsg) {
    await auth.saveAppState({ stocks: watchedStocks, isBotActive });
    // Note: We don't save 'stockData' fully to keep message short, 
    // or we could save it if needed. For now, restarting resets 'initialLot' reference 
    // which might be wanted (reset baseline on restart) or unwanted.
    // If we want persistence of baselines, we should add stockData to cloud save.

    // Let's add partial persistence for robustness
    // await auth.saveAppState({ stocks: watchedStocks, isBotActive, data: stockData });
}

function fmt(num) {
    return new Intl.NumberFormat('tr-TR').format(num);
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));


// --- INITIALIZATION ---

(async () => {
    console.log("🚀 System Starting...");
    await auth.startUserbot();

    const state = await auth.loadAppState();
    if (state.stocks) watchedStocks = state.stocks;
    if (state.isBotActive !== undefined) isBotActive = state.isBotActive;

    console.log(`Loaded: ${watchedStocks.length} stocks. Active: ${isBotActive}`);

    // Start Bot
    bot.start({ onStart: (info) => console.log(`@${info.username} started!`) });

    // Scheduler (Every 30s)
    setInterval(mainLoop, 30000);
})();
