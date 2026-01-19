const { Bot, webhookCallback } = require("grammy");
const auth = require("./auth");
const scraper = require("./scraper");
const config = require("./config");
const fs = require('fs');
const express = require('express');

// Hugging Face Spaces Keep-Alive Server
const app = express();
const port = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send('Bot is healthy and running! 🚀');
});

app.listen(port, () => {
    console.log(`Web server running on port ${port}`);
});

// Initialize Telegram Bot with custom API configuration for Hugging Face
const bot = new Bot(config.BOT_TOKEN, {
    client: {
        apiRoot: "https://api.telegram.org",
        timeoutSeconds: 60,
        canUseWebhookReply: false
    }
});

// State
let watchedStocks = []; // ['SASA', 'THYAO']
let marketCache = {};   // { 'SASA': { lastLot: 5000, history: [...] } }
let isCheckRunning = false;

// Middleware: Admin Check
// To lock the bot to YOU only, we need your Telegram User ID.
// I will add a log to print the ID of anyone who sends a command.
bot.use(async (ctx, next) => {
    const adminId = process.env.ADMIN_ID; // We will set this in Render.com
    const userId = ctx.from?.id;

    // Log the ID of the person communicating with the bot
    console.log(`[USER LOG] User: ${ctx.from?.username || "Unknown"} (ID: ${userId}) tried to use: ${ctx.message?.text}`);

    if (adminId) {
        if (String(userId) !== String(adminId)) {
            // Uncomment the line below if you want the bot to reply to strangers
            // return ctx.reply("Bu bot özeldir, sadece sahibi kullanabilir.");
            return; // Ignore if not admin
        }
    }
    await next();
});

// Commands
bot.command("start", (ctx) => ctx.reply(`Bot çalışıyor! Sizin ID'niz: ${ctx.from.id}\nBu ID'yi Render.com'da ADMIN_ID olarak eklerseniz bot kilitlenir.`));

bot.command("ekle", async (ctx) => {
    const stock = ctx.match.toString().toUpperCase().trim();
    if (!stock) return ctx.reply("Lütfen hisse adı girin. Örn: /ekle SASA");
    if (watchedStocks.includes(stock)) return ctx.reply("Bu hisse zaten takipte.");

    watchedStocks.push(stock);
    // Cloud Save
    await updatePersistence(`${stock} takibe alındı.`, ctx);
});

bot.command("sil", async (ctx) => {
    const stock = ctx.match.toString().toUpperCase().trim();
    if (!watchedStocks.includes(stock)) return ctx.reply("Bu hisse takipte değil.");

    watchedStocks = watchedStocks.filter(s => s !== stock);
    // Cloud Save
    await updatePersistence(`${stock} takipten çıkarıldı.`, ctx);
});

bot.command("liste", (ctx) => {
    if (watchedStocks.length === 0) return ctx.reply("Takip listeniz boş.");
    ctx.reply(`Takip edilenler: ${watchedStocks.join(", ")}`);
});

// Update the cache/persistence whenever it changes
async function updatePersistence(msg, ctx) {
    try {
        await auth.saveWatchedStocks(watchedStocks);
        if (ctx) await ctx.reply(msg);
    } catch (e) {
        console.error("Persistence error:", e);
        if (ctx) await ctx.reply("⚠️ Liste güncellendi ama buluta kaydedilirken hata oluştu.");
    }
}

// Helper for formatting numbers
const fmtNum = (num) => new Intl.NumberFormat('en-US').format(num);

// Turkish Public Holidays 2026 (Format: MM-DD)
// Note: Religious holidays (Ramazan/Kurban) change every year.
const TR_HOLIDAYS_2026 = [
    "01-01", // Yılbaşı
    "03-20", "03-21", "03-22", // Ramazan Bayramı (Approx)
    "04-23", // Ulusal Egemenlik
    "05-01", // Emek ve Dayanışma
    "05-19", // Gençlik ve Spor
    "05-27", "05-28", "05-29", "05-30", // Kurban Bayramı (Approx)
    "07-15", // Demokrasi ve Milli Birlik
    "08-30", // Zafer Bayramı
    "10-29"  // Cumhuriyet Bayramı
];

function getTrTime() {
    // Render servers are usually UTC. Turkey is UTC+3.
    const now = new Date();
    const trTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    return trTime;
}

// Logic state for reports
let lastReportHour = -1;

async function sendStatusReport(isTest = false, targetChatId = null) {
    if (watchedStocks.length === 0) {
        if (targetChatId) await bot.api.sendMessage(targetChatId, "Takip listeniz boş.");
        return;
    }

    const trNow = getTrTime();
    const timeStr = `${trNow.getUTCHours()}:${trNow.getUTCMinutes().toString().padStart(2, '0')}`;
    const header = isTest ? `📊 TEST RAPORU (${timeStr})` : `📊 Bilgilendirme Mesajı (${timeStr})`;

    let msg = `${header}\n\n`;

    for (const stock of watchedStocks) {
        const cache = marketCache[stock];
        if (cache && cache.lastLot > 0) {
            // Check if lot count is below 70% of initial average (30% drop)
            const isWeakening = cache.initialAvg > 0 && cache.lastLot < (cache.initialAvg * 0.70);
            const status = isWeakening ? "⚠️ Lotlar Eriyor!" : "✅ Tavan Sağlam";
            msg += `🔹 ${stock}: ${fmtNum(cache.lastLot)} Lot (${status})\n`;
        } else {
            msg += `🔹 ${stock}: Veri henüz alınamadı. (Sıradaki kontrolde çekilecek)\n`;
        }
    }

    if (!isTest) {
        msg += `\n✅ Takip devam ediyor.`;
    } else {
        msg += `\n✅ Test başarılı.`;
    }

    const reportHours = [10, 12, 14, 16, 18];
    const currentHour = trNow.getUTCHours();
    const nextHour = reportHours.find(h => h > currentHour) || reportHours[0];
    const nextDayStr = (nextHour <= currentHour) ? "yarın " : "";

    msg += `\n🕒 Bir sonraki kontrol ${nextDayStr}${nextHour}:00'da yapılacaktır.`;

    // Send to target or channel
    if (targetChatId) {
        try { await bot.api.sendMessage(targetChatId, msg); } catch (e) { }
    }

    if (config.CHANNEL_ID && String(config.CHANNEL_ID) !== String(targetChatId)) {
        try { await bot.api.sendMessage(config.CHANNEL_ID, msg); } catch (e) { }
    }
}

// Commands
bot.command("test", async (ctx) => {
    console.log("✅ RECEIVED /test command");

    const firstStock = watchedStocks[0];
    const cache = marketCache[firstStock];

    if (!cache || cache.lastLot === 0) {
        if (watchedStocks.length > 0) {
            await ctx.reply(`Takip listesi hazır. ${firstStock} için canlı veriyi şimdi çekiyorum...`);
            const url = await auth.getFreshWebAppUrl();
            if (url) {
                const data = await scraper.fetchMarketData(url, firstStock);
                if (data) {
                    marketCache[firstStock] = {
                        history: [data.topBidLot],
                        initialAvg: data.topBidLot,
                        lastLot: data.topBidLot
                    };
                }
            }
        } else {
            return ctx.reply("Takip listeniz boş. Önce /ekle ile hisse ekleyin.");
        }
    } else {
        await ctx.reply("Sistem aktif, mevcut tavan verileri raporlanıyor...");
    }

    await sendStatusReport(true, ctx.chat.id);
});

// Main Loop
async function checkMarket() {
    if (isCheckRunning) return;

    const trNow = getTrTime();
    const hours = trNow.getUTCHours();
    const minutes = trNow.getUTCMinutes();
    const day = trNow.getUTCDay(); // 0=Sun, 6=Sat
    const dateStr = `${(trNow.getUTCMonth() + 1).toString().padStart(2, '0')}-${trNow.getUTCDate().toString().padStart(2, '0')}`;

    const currentTimeVal = hours * 100 + minutes;

    // Weekend and Holiday Check
    const isWeekend = (day === 0 || day === 6);
    const isHoliday = TR_HOLIDAYS_2026.includes(dateStr);

    if (isWeekend || isHoliday) {
        // Express server above handle keep-alive, we just skip market logic
        if (minutes % 60 === 0 && hours === 10) console.log("Borsa kapalı (Haftasonu/Tatil).");
        return;
    }

    // Report Scheduling (Every 2 hours: 10, 12, 14, 16, 18)
    const reportHours = [10, 12, 14, 16, 18];
    if (minutes === 0 && reportHours.includes(hours) && lastReportHour !== hours) {
        console.log(`TR Saati: ${hours}:00 - Rapor gönderiliyor...`);
        await sendStatusReport();
        lastReportHour = hours;
    }

    // Market Hours Check (09:58 - 18:00)
    if (currentTimeVal < 958 || currentTimeVal >= 1800) {
        return;
    }

    isCheckRunning = true;

    try {
        console.log(`Starting checks for ${watchedStocks.length} stocks...`);

        // Get Fresh Auth URL (Once per cycle, or per stock? URL is valid for 10 mins)
        // We can reuse it for all stocks in this burst.
        const url = await auth.getFreshWebAppUrl();

        if (!url) {
            console.error("Failed to generate Web App URL.");
            isCheckRunning = false;
            return;
        }

        for (const stock of watchedStocks) {
            console.log(`Checking ${stock}...`);
            const data = await scraper.fetchMarketData(url, stock);

            if (!data) {
                console.log(`Skipping ${stock} due to scrape error.`);
                continue;
            }

            // --- LOGIC ---
            // "tavandaki lot sayısı"
            // We only care if it's at ceiling (or very close)

            const currentLot = data.topBidLot;

            // Initialize cache
            if (!marketCache[stock]) {
                marketCache[stock] = {
                    history: [],
                    initialAvg: 0,
                    lastLot: currentLot
                };
            }

            const cache = marketCache[stock];

            // Update History (For initial 10 checks)
            if (cache.history.length < 10 && currentLot > 0) {
                cache.history.push(currentLot);
                // logic: if length hits 10, calc average
                if (cache.history.length === 10) {
                    const sum = cache.history.reduce((a, b) => a + b, 0);
                    cache.initialAvg = Math.floor(sum / 10);
                    console.log(`[${stock}] Initial Average: ${fmtNum(cache.initialAvg)}`);
                }
            }

            // ALERT CONDITIONS
            // Only alert if we are functionally at ceiling (isCeiling=true)
            // Or maybe the user wants to know if the lot count drops even if not technically at ceiling?
            // "tavandaki lot sayısı" implies we assume it IS at ceiling.
            // But if it breaks ceiling (price drops), data.isCeiling will be false.
            // If data.isCeiling became false, that ITSELF is a "Tavan bozdu" event.

            let alertMsg = "";
            let reason = "";
            let dropRate = 0;

            if (data.isCeiling) {
                // Condition 1: 20% drop from previous
                if (cache.lastLot > 0) {
                    const drop = (cache.lastLot - currentLot) / cache.lastLot;
                    if (drop >= 0.20) {
                        dropRate = (drop * 100).toFixed(1);
                        reason = `Ani düşüş! %${dropRate} (Önceki: ${fmtNum(cache.lastLot)})`;

                        alertMsg = `🚨🚨🚨 TAVAN BOZABİLİR ALARMI 🚨🚨🚨\n\n` +
                            `📈 Hisse: ${stock}\n` +
                            `🔴 Mevcut Lot: ${fmtNum(currentLot)}\n` +
                            `📊 Önceki Lot: ${fmtNum(cache.lastLot)}\n` +
                            `📉 Düşüş Oranı: %${dropRate}\n` +
                            `🔍 Sebep: ${reason}\n` +
                            `🔄 Önceki: ${fmtNum(cache.lastLot)} → Şimdiki: ${fmtNum(currentLot)}\n\n` +
                            `Risk sevmeyenler için vedalaşma vaktidir. YTD.`;
                    }
                }

                // Condition 2: 50% drop from initial 10-check average
                if (!alertMsg && cache.initialAvg > 0) { // If not already alerted
                    if (currentLot < (cache.initialAvg * 0.50)) {
                        const drop = (cache.initialAvg - currentLot) / cache.initialAvg;
                        dropRate = (drop * 100).toFixed(1);
                        reason = `Başlangıç eşiği (${fmtNum(cache.initialAvg)}) aşıldı! %${dropRate} düşüş`;

                        alertMsg = `🚨🚨🚨 TAVAN BOZABİLİR ALARMI 🚨🚨🚨\n\n` +
                            `📈 Hisse: ${stock}\n` +
                            `🔴 Mevcut Lot: ${fmtNum(currentLot)}\n` +
                            `📊 Başlangıç Eşiği: ${fmtNum(cache.initialAvg)}\n` +
                            `📉 Düşüş Oranı: %${dropRate}\n` +
                            `🔍 Sebep: ${reason}\n` +
                            `🔄 Önceki: ${fmtNum(cache.lastLot)} → Şimdiki: ${fmtNum(currentLot)}\n\n` +
                            `Risk sevmeyenler için vedalaşma vaktidir. YTD.`;
                    }
                }
            } else {
                // Not at ceiling
                // If it WAS at ceiling recently, maybe alert?
                // For now, simple logging.
                // console.log(`${stock} is not at ceiling.`);
            }

            // Send Alert
            if (alertMsg) {
                console.log(`ALERT for ${stock}: ${reason}`);
                // Broadcast to channel? Or just log? User said "kendi kanalıma mesaj atsın"
                // We need CHANNEL_ID in .env or config.
                // For now sending to Saved Messages (me) or the channel if configured.
                if (config.CHANNEL_ID) {
                    try {
                        await bot.api.sendMessage(config.CHANNEL_ID, alertMsg);
                    } catch (e) { console.error("Send error:", e.message); }
                } else {
                    // Start user?
                }
            }

            // Update Cache
            cache.lastLot = currentLot;
        }

    } catch (e) {
        console.error("Loop Error:", e);
    } finally {
        isCheckRunning = false;
    }
}

// Scheduler: Run every 20 seconds
setInterval(checkMarket, 20_000);

// Heartbeat Log (Every 5 minutes)
setInterval(() => {
    console.log(`[HEARTBEAT] Bot is alive. Time: ${getTrTime().toISOString()}, Stocks: ${watchedStocks.length}`);
}, 5 * 60 * 1000);

// Error handler for bot
bot.catch((err) => {
    console.error("❌ Bot error:", err);
});

// Start
(async () => {
    console.log("Bot starting...");
    await auth.startUserbot();

    // Load Stocks from Cloud (Telegram Saved Messages)
    console.log("☁️ Loading stocks from cloud...");
    const cloudStocks = await auth.loadWatchedStocks();
    if (cloudStocks.length > 0) {
        watchedStocks = cloudStocks;
        console.log(`✅ Loaded ${watchedStocks.length} stocks from cloud: ${watchedStocks.join(", ")}`);
    } else {
        console.log("ℹ️ No stocks found in cloud (or empty). Using defaults or empty list.");
    }

    console.log("🤖 Starting Telegram Bot...");

    // Retry logic for bot authentication (Hugging Face network can be flaky)
    let retries = 3;
    let authenticated = false;

    while (retries > 0 && !authenticated) {
        try {
            const me = await bot.api.getMe();
            console.log(`✅ Bot authenticated as @${me.username} (${me.first_name})`);
            authenticated = true;
        } catch (e) {
            retries--;
            console.error(`❌ Bot authentication failed (${3 - retries}/3): ${e.message}`);
            if (retries > 0) {
                console.log(`⏳ Retrying in 3 seconds...`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    if (!authenticated) {
        console.error("❌ CRITICAL: Could not authenticate bot after 3 attempts!");
        console.error("Please check BOT_TOKEN in Hugging Face secrets.");
    }

    // 409 Conflict & Startup Logic
    const startBotWithRetry = async (retryCount = 0) => {
        const delays = [20000, 30000, 40000, 60000]; // Increased to 20s, 30s, 40s, 60s
        const delay = delays[retryCount] || 60000;

        console.log(`⏳ Waiting ${delay / 1000} seconds before starting bot (Instance conflict prevention - Attempt ${retryCount + 1})...`);
        await new Promise(r => setTimeout(r, delay));

        try {
            // bot.start() is non-blocking in Grammy, but we wrap it carefully
            await bot.start({
                onStart: (info) => console.log(`✅ Bot is now listening as @${info.username}`),
                drop_pending_updates: true
            });
        } catch (err) {
            if (err.description?.includes("Conflict") || err.code === 409) {
                console.warn(`⚠️ Bot conflict detected! (Attempt ${retryCount + 1}/5). Retrying in next cycle...`);
                if (retryCount < 5) {
                    return startBotWithRetry(retryCount + 1);
                }
            } else {
                console.error("❌ Bot encountered an error during start:", err.message);
                // Don't crash the whole process, try to wait and restart
                setTimeout(() => startBotWithRetry(0), 10000);
            }
        }
    };

    await startBotWithRetry();

    if (!isCheckRunning) {
        console.log("🚀 Launching initial market check...");
        checkMarket();
    }
})();
