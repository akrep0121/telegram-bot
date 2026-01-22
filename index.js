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
    if (currentTimeVal < 956 || currentTimeVal > 1800) return;

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
                // We check two conditions. If either triggers, we formulate the message.
                // Priority: Check Average Drop first, then Sudden Drop.

                let isAlert = false;
                let baseline = 0;
                let dropRatio = 0;
                let reason = "";

                // Condition 1: Drop 50% from Daily Average
                if (data.dailyAvg > 0 && currentLot < data.dailyAvg * 0.5) {
                    isAlert = true;
                    baseline = data.dailyAvg;
                    dropRatio = ((data.dailyAvg - currentLot) / data.dailyAvg) * 100;
                    reason = `Başlangıç eşiği (${fmt(baseline)}) aşıldı! %${dropRatio.toFixed(1)} düşüş`;
                }
                // Condition 2: Drop 30% from Previous Read (Sudden Crash)
                else if (data.prevLot > 0 && currentLot < data.prevLot * 0.7) {
                    isAlert = true;
                    baseline = data.prevLot;
                    dropRatio = ((data.prevLot - currentLot) / data.prevLot) * 100;
                    reason = `Ani çöküş! Önceki okumadan %${dropRatio.toFixed(1)} düşüş`;
                }

                if (isAlert) {
                    console.log(`[ALERT] Potential alert for ${stock}. Verifying...`);

                    // VERIFICATION RETRY
                    // Wait 5s and re-check to confirm it's not a glitch
                    await delay(5000);
                    const verifyLot = await performStockCheck(stock);

                    if (verifyLot !== null) {
                        // Check conditions again with NEW data
                        // Does it still fail?
                        // We use the SAME baseline as before for consistency
                        let confirmed = false;

                        if (reason.includes("Başlangıç")) {
                            // Avg Check
                            if (verifyLot < data.dailyAvg * 0.5) confirmed = true;
                        } else {
                            // Sudden Check
                            // Need to check against the SAME prevLot we used
                            if (verifyLot < data.prevLot * 0.7) confirmed = true;
                        }

                        if (confirmed) {
                            // Valid Alert
                            const finalRatio = ((baseline - verifyLot) / baseline) * 100;

                            const alertMsg = `🚨🚨🚨 TAVAN BOZABİLİR ALARMI 🚨🚨🚨\n\n` +
                                `📈 Hisse: ${stock}\n` +
                                `🔴 Mevcut Lot: ${fmt(verifyLot)}\n` +
                                `📊 Başlangıç Eşiği: ${fmt(baseline)}\n` +
                                `📉 Düşüş Oranı: %${finalRatio.toFixed(1)}\n` +
                                `🔍 Sebep: ${reason}\n` +
                                `🔄 Önceki: ${fmt(data.prevLot)} → Şimdiki: ${fmt(verifyLot)}\n\n` +
                                `Risk sevmeyenler için vedalaşma vaktidir. YTD`;

                            await broadcast(alertMsg);
                            console.log(`[ALERT] Confirmed and Sent for ${stock}`);
                        } else {
                            console.log(`[ALERT] False alarm detected for ${stock}. Verification (${verifyLot}) passed.`);
                            // Update currentLot to the verification one so we don't trigger again immediately on next loop
                            // actually, code below updates prevLot to 'currentLot' (the first low one).
                            // We should update it to 'verifyLot' (the corrected one).
                            currentLot = verifyLot;
                        }
                    } else {
                        console.log(`[ALERT] Verification failed (timeout/null) for ${stock}. Skipping alert.`);
                    }
                }

                // Update Previous
                // If it was a false alarm, we updated currentLot to verifyLot above.
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
    const holidays = ["1-1", "23-4", "1-5", "19-5", "15-7", "30-8", "29-10"];
    return holidays.includes(`${day}-${month}`);
}

async function sendGeneralReport(hour) {
    if (watchedStocks.length === 0) return;

    let report = `📊 Günlük Durum Raporu (${hour}:00)\n\n`;

    for (const stock of watchedStocks) {
        const data = stockData[stock];
        if (data && data.prevLot) {
            report += `🔹 ${stock}: ${fmt(data.prevLot)} Lot\n`;
        } else {
            report += `🔹 ${stock}: Veri bekleniyor...\n`;
        }
    }

    report += `\n✅ Şu an için herhangi bir risk görünmemektedir.\n`;

    // Next control time
    let nextHour = hour + 2;
    if (nextHour <= 18) {
        report += `🕒 Bir sonraki kontrol ${nextHour}:00'da yapılacaktır.`;
    } else {
        report += `🕒 Borsa günü tamamlandı.`;
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
