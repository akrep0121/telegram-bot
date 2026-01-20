const { Bot } = require("grammy");
const auth = require("./auth");
const scraper = require("./scraper");
const config = require("./config");
const fs = require('fs');
const express = require('express');

// --- KEEP-ALIVE SERVER ---
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
let watchedStocks = [];
let stockData = {}; // { 'SASA': { day: 20, samples: [], dailyAvg: 0, prevLot: 0 } }
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
    ctx.reply(`✅ ${symbol} takibe alındı.`);
});

bot.command("sil", async (ctx) => {
    const symbol = ctx.match.toString().toUpperCase().trim();
    if (!watchedStocks.includes(symbol)) return ctx.reply("ℹ️ Listede yok.");

    watchedStocks = watchedStocks.filter(s => s !== symbol);
    delete stockData[symbol]; // Clear cache
    await syncStateToCloud(`🗑️ ${symbol} silindi.`);
    ctx.reply(`🗑️ ${symbol} silindi.`);
});

bot.command("liste", (ctx) => {
    if (watchedStocks.length === 0) return ctx.reply("📭 Liste boş.");

    let msg = "📋 **Takip Listesi**\n";
    watchedStocks.forEach(s => {
        const data = stockData[s];
        if (data && data.prevLot > 0) {
            msg += `- ${s}: ${fmt(data.prevLot)} Lot (Ort: ${fmt(data.dailyAvg || 0)})\n`;
        } else {
            msg += `- ${s}: Veri bekleniyor...\n`;
        }
    });
    ctx.reply(msg);
});

bot.command("pasif", async (ctx) => {
    isBotActive = false;
    await syncStateToCloud("⏸️ Sistem pasife alındı.");
    ctx.reply("⏸️ Bot PASİF moduna geçti. Sorgulama yapılmayacak.");
});

bot.command("aktif", async (ctx) => {
    isBotActive = true;
    await syncStateToCloud("▶️ Sistem aktif edildi.");
    ctx.reply("▶️ Bot AKTİF moduna geçti. İşlemlere devam ediliyor.");
});

// --- TEST COMMAND ---
bot.command("test", async (ctx) => {
    if (watchedStocks.length === 0) return ctx.reply("Liste boş, test edilemez.");
    await ctx.reply(`🧪 Test Başlatılıyor (${watchedStocks.length} hisse)...`);

    for (const stock of watchedStocks) {
        await ctx.reply(`🔍 ${stock} kontrol ediliyor...`);
        const lot = await performStockCheck(stock, ctx);
        if (lot !== null) {
            await ctx.reply(`✅ ${stock} Başarılı! Okunan Lot: ${fmt(lot)}`);
        } else {
            await ctx.reply(`❌ ${stock} Başarısız!`);
        }
        await delay(3000);
    }
    await ctx.reply("🏁 Test Tamamlandı.");
});


// --- MAIN LOOP ---

async function mainLoop() {
    // 1. Activity Gate
    if (!isBotActive) return;
    if (isCheckRunning) return;

    const now = new Date();
    // Adjust to Turkey Time (UTC+3)
    const trTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));

    // Time Components
    const hour = trTime.getUTCHours();
    const minute = trTime.getUTCMinutes();
    const dayOfWeek = trTime.getUTCDay(); // 0=Sun, 6=Sat
    const dayOfMonth = trTime.getUTCDate();
    const month = trTime.getUTCMonth() + 1; // 1-12

    // 2. Schedule Logic (09:56 - 18:00)

    // Weekend Check
    if (dayOfWeek === 0 || dayOfWeek === 6) return;

    // Time Interval Check
    const currentTimeVal = hour * 100 + minute; // e.g. 956 for 09:56
    if (currentTimeVal < 956 || currentTimeVal >= 1800) return;

    // Holiday Check
    if (isHoliday(dayOfMonth, month)) return;


    isCheckRunning = true;

    try {
        // 3. Reporting Schedule (10, 12, 14, 16, 18)
        const reportHours = [10, 12, 14, 16, 18];
        if (minute === 0 && reportHours.includes(hour) && lastReportHour !== hour) {
            await sendGeneralReport(hour);
            lastReportHour = hour;
        }

        // 4. Stock Checks
        console.log(`[LOOP] Cycle starting... Time: ${hour}:${minute}`);

        for (const stock of watchedStocks) {
            if (!isBotActive) break;

            const currentLot = await performStockCheck(stock);

            if (currentLot !== null) {
                // Initialize Data Structure if missing
                if (!stockData[stock]) {
                    stockData[stock] = { day: dayOfMonth, samples: [], dailyAvg: 0, prevLot: 0 };
                }

                const data = stockData[stock];

                // DAILY RESET LOGIC
                if (data.day !== dayOfMonth) {
                    // New Day! Reset stats
                    console.log(`[LOGIC] New day for ${stock}. Resetting stats.`);
                    data.day = dayOfMonth;
                    data.samples = [];
                    data.dailyAvg = 0;
                    data.prevLot = 0; // Reset prev so we don't alert on first read
                }

                // AVERAGE CALCULATION (First 10 samples)
                if (data.samples.length < 10) {
                    data.samples.push(currentLot);
                    // Recalculate Avg
                    const sum = data.samples.reduce((a, b) => a + b, 0);
                    data.dailyAvg = Math.floor(sum / data.samples.length);
                    console.log(`[LOGIC] ${stock} Build Avg: ${data.dailyAvg} (Count: ${data.samples.length})`);
                }

                // ALERT LOGIC
                let alertMsg = "";

                // Condition 1: Drop 50% from Daily Average
                // Only if we calculate an average (have data)
                if (data.dailyAvg > 0) {
                    const avgThreshold = data.dailyAvg * 0.5; // 50% drop
                    if (currentLot < avgThreshold) {
                        alertMsg += `⚠️ **KRİTİK DÜŞÜŞ (ORTALAMA)!**\n` +
                            `📉 ${fmt(currentLot)} < ${fmt(data.dailyAvg)} (Ort)\n` +
                            `Durum: %50'den fazla düşüş.\n`;
                    }
                }

                // Condition 2: Drop 30% from Previous Read (Sudden Crash)
                if (data.prevLot > 0) {
                    const suddenThreshold = data.prevLot * 0.7; // 30% drop (70% remaining)
                    if (currentLot < suddenThreshold) {
                        alertMsg += `⚠️ **ANİ ÇÖKÜŞ!**\n` +
                            `📉 ${fmt(currentLot)} < ${fmt(data.prevLot)} (Önceki)\n` +
                            `Durum: %30'dan fazla ani kayıp.\n`;
                    }
                }

                // Send Alert if triggered
                if (alertMsg) {
                    const fullMsg = `🚨 **TAVAN BOZMA ALARMI** 🚨\n\n` +
                        `Hisse: #${stock}\n${alertMsg}`;
                    await broadcast(fullMsg);

                    // Prevent spam? Updates data.prevLot below, so next loop 
                    // won't trigger sudden drop again unless it drops FURTHER.
                    // But Avg drop will trigger continuously if it stays low.
                    // Implementation choice: Keep alerting or flag as 'alerted'?
                    // User requested "alarm message atmalı", implies continuous or once per incident.
                    // We'll keep it simple: it alerts every cycle if condition met.
                }

                // Update Previous
                data.prevLot = currentLot;
            }

            // Wait 4s
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
    const sent = await auth.requestStockDerinlik(symbol);
    if (!sent) {
        if (verboseCtx) await verboseCtx.reply(`❌ ${symbol}: Komut gönderilemedi.`);
        return null;
    }

    const msg = await auth.waitForBotResponse(25000);
    if (!msg) {
        if (verboseCtx) await verboseCtx.reply(`⚠️ ${symbol}: Yanıt gelmedi (Timeout).`);
        return null;
    }

    const buffer = await auth.downloadBotPhoto(msg);
    if (!buffer) {
        if (verboseCtx) await verboseCtx.reply(`⚠️ ${symbol}: Fotoğraf indirilemedi.`);
        return null;
    }

    const result = await scraper.extractLotFromImage(buffer, symbol);
    if (result && result.topBidLot) {
        return result.topBidLot;
    } else {
        return null;
    }
}


// --- HELPERS ---

function isHoliday(day, month) {
    // Simple TR Holiday List (Fixed Dates)
    const holidays = [
        "1-1",   // New Year
        "23-4",  // Children's Day
        "1-5",   // Labor Day
        "19-5",  // Youth Day
        "15-7",  // Democracy Day
        "30-8",  // Victory Day
        "29-10"  // Republic Day
    ];
    const key = `${day}-${month}`;
    return holidays.includes(key);
}

async function sendGeneralReport(hour) {
    if (watchedStocks.length === 0) return;

    let report = `📊 **Piyasa Durum Raporu (${hour}:00)**\n\n`;

    for (const stock of watchedStocks) {
        const data = stockData[stock];
        if (data && data.prevLot) {
            // Compare to Daily Avg if available
            const trend = (data.dailyAvg > 0 && data.prevLot < data.dailyAvg) ? '📉' : '✅';
            report += `${trend} #${stock}: ${fmt(data.prevLot)} Lot (Ort: ${fmt(data.dailyAvg)})\n`;
        } else {
            report += `⏳ #${stock}: Veri yok\n`;
        }
    }
    await broadcast(report);
}

async function broadcast(text) {
    if (process.env.ADMIN_ID) {
        try { await bot.api.sendMessage(process.env.ADMIN_ID, text); } catch (e) { }
    }
    if (config.CHANNEL_ID) {
        try { await bot.api.sendMessage(config.CHANNEL_ID, text); } catch (e) { }
    }
}

async function syncStateToCloud(replyMsg) {
    await auth.saveAppState({ stocks: watchedStocks, isBotActive });
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
