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

                // --- 1. SURGE PROTECTION (Baseline Poisoning Prevention) ---
                // If the new reading is massively higher than our established daily average,
                // it's likely an OCR error that escaped the scraper's hard limit. 
                // We refuse to update 'prevLot' or 'dailyAvg' with this "poisoned" data.
                if (data.dailyAvg > 0 && currentLot > data.dailyAvg * 2) {
                    console.log(`[LOGIC] ${stock} - REJECTED surge anomaly. New: ${currentLot} vs Avg: ${data.dailyAvg}. Baseline preserved.`);
                    // Skip updating history with this glitch
                    continue;
                }

                // DAILY RESET LOGIC
                if (data.day !== dayOfMonth) {
                    console.log(`[LOGIC] New day for ${stock}. Resetting stats.`);
                    data.day = dayOfMonth;
                    data.samples = [];
                    data.dailyAvg = 0;
                    data.prevLot = 0;
                }

                // AVERAGE CALCULATION (First 10 samples)
                if (data.samples.length < 10) {
                    data.samples.push(currentLot);
                    const sum = data.samples.reduce((a, b) => a + b, 0);
                    data.dailyAvg = Math.floor(sum / data.samples.length);
                }

                // --- 2. ALERT LOGIC (Triple Verification) ---
                let isAlert = false;
                let baseline = 0;
                let reason = "";

                // Average Check (50%)
                if (data.dailyAvg > 0 && currentLot < data.dailyAvg * 0.5) {
                    isAlert = true;
                    baseline = data.dailyAvg;
                    reason = `Başlangıç eşiği (${fmt(baseline)}) aşıldı!`;
                }
                // Sudden Check (30%)
                else if (data.prevLot > 0 && currentLot < data.prevLot * 0.7) {
                    isAlert = true;
                    baseline = data.prevLot;
                    reason = `Ani çöküş! Önceki okumadan ciddi düşüş.`;
                }

                if (isAlert) {
                    console.log(`[ALERT] Potential drop for ${stock}. Starting Triple-Verification...`);

                    let failCount = 1; // The current scan already failed
                    const CHECK_INTERVAL = 7000; // 7s between retries
                    const NEEDED_FAILS = 3;

                    for (let attempt = 1; attempt < NEEDED_FAILS; attempt++) {
                        await delay(CHECK_INTERVAL);
                        const verifyLot = await performStockCheck(stock);

                        // Verification logic
                        if (verifyLot !== null) {
                            // Does it still meet alert criteria?
                            const stillFailsAvg = baseline === data.dailyAvg && verifyLot < baseline * 0.5;
                            const stillFailsSudden = baseline === data.prevLot && verifyLot < baseline * 0.7;

                            if (stillFailsAvg || stillFailsSudden) {
                                failCount++;
                                console.log(`[ALERT] Verification ${attempt + 1}/${NEEDED_FAILS} CONFIRMED drop for ${stock}. (${fmt(verifyLot)})`);
                            } else {
                                console.log(`[ALERT] Verification ${attempt + 1}/${NEEDED_FAILS} REJECTED drop for ${stock}. Clean reading: ${fmt(verifyLot)}`);
                                break;
                            }
                        }
                    }

                    if (failCount >= NEEDED_FAILS) {
                        // TRIPLE CONFIRMED!
                        // Fetch the final lot for the message
                        const finalLot = await performStockCheck(stock) || currentLot;
                        const finalRatio = ((baseline - finalLot) / baseline) * 100;

                        const alertMsg = `🚨🚨🚨 TAVAN BOZABİLİR ALARMI 🚨🚨🚨\n\n` +
                            `📈 Hisse: ${stock}\n` +
                            `🔴 Mevcut Lot: ${fmt(finalLot)}\n` +
                            `📊 Başlangıç Eşiği: ${fmt(baseline)}\n` +
                            `📉 Düşüş Oranı: %${finalRatio.toFixed(1)}\n` +
                            `🔍 Sebep: ${reason}\n` +
                            `🔄 Önceki: ${fmt(data.prevLot)} → Şimdiki: ${fmt(finalLot)}\n\n` +
                            `Risk sevmeyenler için vedalaşma vaktidir. YTD`;

                        await broadcast(alertMsg);
                        console.log(`[ALERT] Triple-Confirmed and Broadcast for ${stock}`);
                    }
                }

                // Update Previous only if it wasn't a rejected surge
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
