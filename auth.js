const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input"); // npm install input
const fs = require("fs");
const config = require("./config");
const { Api } = require("telegram/tl");

// Save session string to avoid re-login
const SESSION_FILE = "session_string.txt";
let sessionString = process.env.SESSION_STRING || "";

if (!sessionString && fs.existsSync(SESSION_FILE)) {
    sessionString = fs.readFileSync(SESSION_FILE, "utf8");
}

// FIX: Trim whitespace issues from copy-paste
sessionString = sessionString.trim();

if (sessionString) {
    console.log(`[DEBUG] Session String loaded. Length: ${sessionString.length}`);
} else {
    console.log("[DEBUG] No Session String found. Will attempt interactive login.");
}

const client = new TelegramClient(
    new StringSession(sessionString),
    config.API_ID,
    config.API_HASH,
    {
        connectionRetries: 5,
    }
);

async function startUserbot() {
    console.log("Starting Userbot...");

    // Custom Logger to detect if it's asking for input (which means session failed)
    const phoneCallback = async () => {
        console.error("❌ CRITICAL ERROR: Session Invalid! Bot is asking for phone number.");
        console.error("The SESSION_STRING on Hugging Face is likely invalid or expired.");
        throw new Error("Interactive login not supported in Cloud mode. Please regenerate SESSION_STRING.");
    };

    await client.start({
        phoneNumber: phoneCallback,
        password: async () => await input.text("İki faktörlü doğrulama şifreniz (varsa): "),
        phoneCode: async () => await input.text("Telegram'a gelen kodu girin: "),
        onError: (err) => console.log(err),
    });

    console.log("Userbot Connected!");

    // Save session (only if locally running and interactive)
    const newSessionCursor = client.session.save();
    if (newSessionCursor && newSessionCursor !== sessionString) {
        fs.writeFileSync(SESSION_FILE, newSessionCursor);
    }
}

async function sendStartToBot() {
    if (!client.connected) {
        await startUserbot();
    }

    try {
        console.log(`[AUTH] Sending /start to ${config.TARGET_BOT_USERNAME}...`);
        await client.sendMessage(config.TARGET_BOT_USERNAME, { message: '/start' });
        console.log(`[AUTH] /start sent successfully!`);
        // Wait for bot to process
        await new Promise(r => setTimeout(r, 2000));
        return true;
    } catch (error) {
        console.error("[AUTH] Error sending /start:", error.message);
        return false;
    }
}

async function getFreshWebAppUrl() {
    if (!client.connected) {
        await startUserbot();
    }

    try {
        // STEP 1: Send /start to warm up the session
        await sendStartToBot();

        // STEP 2: Request WebView URL
        console.log(`[AUTH] Requesting WebApp URL...`);
        const result = await client.invoke(
            new Api.messages.RequestWebView({
                peer: config.TARGET_BOT_USERNAME,
                bot: config.TARGET_BOT_USERNAME,
                platform: "android",
                fromBotMenu: false,
                url: "https://7k2v9x1r0z8t4m3n5p7w.com/"
            })
        );

        console.log(`[AUTH] Got WebApp URL: ${result.url.substring(0, 100)}...`);
        return result.url;
    } catch (error) {
        console.error("[AUTH] Error getting WebApp URL:", error.message);
        return null;
    }
}

// --- CLOUD PERSISTENCE (Saved Messages) ---
// We use the Userbot's "Saved Messages" (peer: "me") to store the database.
// This prevents cluttering the public channel.

async function saveAppState(state) {
    if (!client.connected) await startUserbot();
    try {
        // state = { stocks: [], isBotActive: true/false }
        const jsonStr = JSON.stringify(state);
        const dbTag = "#DATABASE_V2"; // Version bump
        const messageText = `${dbTag}\n${jsonStr}\n\nDO NOT DELETE THIS MESSAGE (Bot Memory V2)`;

        // Search for existing DB message in Saved Messages
        const history = await client.getMessages("me", { search: dbTag, limit: 1 });

        if (history && history.length > 0) {
            await client.editMessage("me", { message: history[0].id, text: messageText });
            console.log("Database V2 updated in Saved Messages.");
        } else {
            await client.sendMessage("me", { message: messageText });
            console.log("New Database V2 created in Saved Messages.");
        }
    } catch (e) {
        console.error("Cloud Save Error:", e);
    }
}

async function loadAppState() {
    if (!client.connected) await startUserbot();
    try {
        const dbTag = "#DATABASE_V2";
        const history = await client.getMessages("me", { search: dbTag, limit: 1 });

        if (history && history.length > 0) {
            const lines = history[0].message.split('\n');
            const jsonStr = lines[1];
            const state = JSON.parse(jsonStr);
            console.log(`Loaded Cloud DB V2: ${state.stocks.length} stocks, Active: ${state.isBotActive}`);
            return state;
        } else {
            // Try loading V1 (Legacy migration)
            const v1 = await loadWatchedStocksV1();
            if (v1.length > 0) {
                console.log("Migrating V1 DB to V2...");
                return { stocks: v1, isBotActive: true };
            }
        }
        return { stocks: [], isBotActive: true };
    } catch (e) {
        console.error("Cloud Load Error:", e);
        return { stocks: [], isBotActive: true };
    }
}

// Legacy V1 loader
async function loadWatchedStocksV1() {
    try {
        const dbTag = "#DATABASE_V1";
        const history = await client.getMessages("me", { search: dbTag, limit: 1 });
        if (history && history.length > 0) {
            const lines = history[0].message.split('\n');
            return JSON.parse(lines[1]);
        }
        return [];
    } catch (e) { return []; }
}

module.exports = {
    startUserbot,
    getFreshWebAppUrl,
    saveAppState,
    loadAppState,
    sendStartToBot
};
