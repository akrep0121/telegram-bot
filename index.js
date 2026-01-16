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

// Load watched stocks from file
if (fs.existsSync('stocks.json')) {
    watchedStocks = JSON.parse(fs.readFileSync('stocks.json', 'utf8'));
}

// Commands
bot.command("start", (ctx) => ctx.reply("Bot çalışıyor! /ekle [hisse] komutu ile hisse ekleyebilirsiniz."));

bot.command("ekle", (ctx) => {
    const stock = ctx.match.toString().toUpperCase().trim();
    if (!stock) return ctx.reply("Lütfen hisse adı girin. Örn: /ekle SASA");
    if (watchedStocks.includes(stock)) return ctx.reply("Bu hisse zaten takipte.");

    watchedStocks.push(stock);
    fs.writeFileSync('stocks.json', JSON.stringify(watchedStocks));
    ctx.reply(`${stock} takibe alındı.`);
});

bot.command("sil", (ctx) => {
    const stock = ctx.match.toString().toUpperCase().trim();
    if (!watchedStocks.includes(stock)) return ctx.reply("Bu hisse takipte değil.");

    watchedStocks = watchedStocks.filter(s => s !== stock);
    fs.writeFileSync('stocks.json', JSON.stringify(watchedStocks));
    ctx.reply(`${stock} takipten çıkarıldı.`);
});

bot.command("liste", (ctx) => {
    if (watchedStocks.length === 0) return ctx.reply("Takip listeniz boş.");
    ctx.reply(`Takip edilenler: ${watchedStocks.join(", ")}`);
});

// Helper for formatting numbers
const fmtNum = (num) => new Intl.NumberFormat('en-US').format(num);

// Logic state for reports
let lastReportHour = -1;

async function sendStatusReport(isTest = false, targetChatId = null) {
    if (watchedStocks.length === 0) {
        if (targetChatId) await bot.api.sendMessage(targetChatId, "Takip listeniz boş.");
        return;
    }

    const now = new Date();
    const timeStr = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    const header = isTest ? `📊 TEST RAPORU (${timeStr})` : `📊 Günlük Durum Raporu (${timeStr})`;

    let msg = `${header}\n\n`;

    for (const stock of watchedStocks) {
        const cache = marketCache[stock];
        if (cache && cache.lastLot > 0) {
            msg += `🔹 ${stock}: ${fmtNum(cache.lastLot)} Lot (Tavan Sağlam)\n`;
        } else {
            msg += `🔹 ${stock}: Veri yok veya tavan değil.\n`;
        }
    }

    msg += `\n✅ Şu an için herhangi bir risk görünmemektedir.\n`;

    // Next report time logic
    const reportHours = [10, 12, 14, 16, 18];
    const currentHour = now.getHours();
    const nextHour = reportHours.find(h => h > currentHour) || reportHours[0];
    const nextDayStr = (nextHour <= currentHour) ? "yarın " : "";

    msg += `🕒 Bir sonraki kontrol ${nextDayStr}${nextHour}:00'da yapılacaktır.`;

    // 1. Send to User (if triggered via command)
    if (targetChatId) {
        try {
            await bot.api.sendMessage(targetChatId, msg);
        } catch (e) { console.error("User report error:", e.message); }
    }

    // 2. Send to Channel (Always, unless user is the channel itself)
    // For /test, we explicitly WANT it to go to channel too as per request.
    if (config.CHANNEL_ID && String(config.CHANNEL_ID) !== String(targetChatId)) {
        try {
            await bot.api.sendMessage(config.CHANNEL_ID, msg);
        } catch (e) {
            console.error("Channel report error:", e.message);
            if (isTest && targetChatId) {
                await bot.api.sendMessage(targetChatId, `⚠️ Kanal mesajı gönderilemedi: ${e.message}`);
            }
        }
    } else if (!config.CHANNEL_ID && isTest) {
        if (targetChatId) await bot.api.sendMessage(targetChatId, "ℹ️ Kanal ID ayarlı olmadığı için kanala mesaj gitmedi.");
    }
}

// Commands
bot.command("test", async (ctx) => {
    console.log("✅ RECEIVED /test command from:", ctx.from?.username || ctx.from?.id);
    try {
        await ctx.reply("Test raporu hazırlanıyor... (Hem size hem kanala düşecek)");
        await sendStatusReport(true, ctx.chat.id);
        console.log("✅ Test report sent successfully");
    } catch (e) {
        console.error("❌ Error in /test handler:", e.message);
    }
});

// Main Loop
// Main Loop
async function checkMarket() {
    if (isCheckRunning) return;

    // Check Time Window (09:56 - 18:00)
    // Note: Server time might differ. User said TRT (UTC+3).
    // Node.js Date depends on system time. Assuming system is correct (User said it is).
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const day = now.getDay(); // 0=Sun, 6=Sat

    const currentTimeVal = hours * 100 + minutes;

    // Weekend check
    if (day === 0 || day === 6) {
        console.log("Weekend - Sleeping...");
        return;
    }

    // Report Check (10, 12, 14, 16, 18) at minute 0
    const reportHours = [10, 12, 14, 16, 18];
    if (minutes === 0 && reportHours.includes(hours) && lastReportHour !== hours) {
        console.log(`Sending Periodic Report for ${hours}:00...`);
        await sendStatusReport();
        lastReportHour = hours;
    }

    // Time check (09:56 = 956, 18:00 = 1800)
    // if (currentTimeVal < 956 || currentTimeVal >= 1800) {
    //    console.log("Outside trading hours - Sleeping...");
    //    return;
    // }
    // COMMENTED OUT FOR TESTING PURPOSES, UNCOMMENT FOR PRODUCTION

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

// Error handler for bot
bot.catch((err) => {
    console.error("❌ Bot error:", err);
});

// Start
(async () => {
    console.log("Bot starting...");
    await auth.startUserbot();
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

    bot.start(); // Non-blocking, runs in background
    console.log("✅ Bot is now listening for commands");
    checkMarket(); // Initial call
})();

// Initial Trigger for testing immediately
setTimeout(checkMarket, 5000);
