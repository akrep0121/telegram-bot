const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const fs = require("fs");
const config = require("./config");
const { Api } = require("telegram/tl");

// Save session string to avoid re-login
const SESSION_FILE = "session_string.txt";
let sessionString = process.env.SESSION_STRING || "";

if (!sessionString && fs.existsSync(SESSION_FILE)) {
    sessionString = fs.readFileSync(SESSION_FILE, "utf8");
}
sessionString = sessionString.trim();

const client = new TelegramClient(
    new StringSession(sessionString),
    config.API_ID,
    config.API_HASH,
    { connectionRetries: 5 }
);

async function startUserbot() {
    if (client.connected) return;
    try {
        await client.start({
            phoneNumber: async () => await input.text("Telefon numaranız: "),
            password: async () => await input.text("2FA Şifreniz: "),
            phoneCode: async () => await input.text("Telegram Kodu: "),
            onError: (err) => console.log(err),
        });
        console.log("[USERBOT] Connected!");
        const newSession = client.session.save();
        if (newSession && newSession !== sessionString) {
            fs.writeFileSync(SESSION_FILE, newSession);
        }
    } catch (e) {
        console.error("[USERBOT] Connection failed:", e);
    }
}

// ------ SYSTEM V2 ACTIONS ------

// 1. Send Command: /derinlik [SYMBOL]
async function requestStockDerinlik(symbol) {
    if (!client.connected) await startUserbot();
    try {
        console.log(`[USERBOT] Sending '/derinlik ${symbol}' to ${config.TARGET_BOT_USERNAME}...`);
        await client.sendMessage(config.TARGET_BOT_USERNAME, { message: `/derinlik ${symbol}` });
        return true;
    } catch (e) {
        console.error(`[userbot] Failed to send command for ${symbol}:`, e.message);
        return false;
    }
}

// 2. Wait for Response (Image)
async function waitForBotResponse(timeoutMs = 25000) {
    if (!client.connected) await startUserbot();

    return new Promise((resolve) => {
        let resolved = false;

        const handler = (event) => {
            if (resolved) return;
            const msg = event.message;

            // Check sender
            // Note: peerId might be an object or int depending on library version/context
            // We'll simplistic check: if it has media photo.
            // Ideally check msg.peerId.userId matches target bot ID.

            if (msg && msg.media && msg.media.className === "MessageMediaPhoto") {
                resolved = true;
                client.removeEventHandler(handler, new Api.NewMessage({}));
                resolve(msg);
            }
        };

        // Listen only for incoming messages from the target bot
        client.addEventHandler(handler, new Api.NewMessage({
            incoming: true,
            fromUsers: [config.TARGET_BOT_USERNAME]
        }));

        // Timeout
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                client.removeEventHandler(handler, new Api.NewMessage({}));
                console.log("[USERBOT] Timeout waiting for response.");
                resolve(null);
            }
        }, timeoutMs);
    });
}

// 3. Download Photo
async function downloadBotPhoto(message) {
    if (!client.connected) await startUserbot();
    try {
        console.log("[USERBOT] Downloading photo...");
        const buffer = await client.downloadMedia(message, {});
        return buffer;
    } catch (e) {
        console.error("[USERBOT] Download failed:", e.message);
        return null;
    }
}

// Helper: Cloud Persistence (Saved Messages)
async function saveAppState(state) {
    if (!client.connected) await startUserbot();
    try {
        const dbTag = "#SYSTEM_V3_DB";
        const body = JSON.stringify(state);
        const text = `${dbTag}\n${body}\n\nDO NOT DELETE - BOT MEMORY`;

        const history = await client.getMessages("me", { search: dbTag, limit: 1 });
        if (history && history.length > 0) {
            await client.editMessage("me", { message: history[0].id, text: text });
        } else {
            await client.sendMessage("me", { message: text });
        }
        // console.log("[CLOUD] State saved.");
    } catch (e) {
        console.error("[CLOUD] Save failed:", e.message);
    }
}

async function loadAppState() {
    if (!client.connected) await startUserbot();
    try {
        // Try V3 first
        let dbTag = "#SYSTEM_V3_DB";
        let history = await client.getMessages("me", { search: dbTag, limit: 1 });

        if (history && history.length > 0) {
            const lines = history[0].message.split('\n');
            return JSON.parse(lines[1]);
        }

        // Fallback to V2 (Previous System)
        console.log("[CLOUD] V3 DB not found, trying V2...");
        dbTag = "#DATABASE_V2";
        history = await client.getMessages("me", { search: dbTag, limit: 1 });

        if (history && history.length > 0) {
            const lines = history[0].message.split('\n');
            const data = JSON.parse(lines[1]);
            console.log("[CLOUD] Migrating V2 data:", data);
            // Save immediately as V3 to complete migration
            await saveAppState(data);
            return data;
        }

    } catch (e) {
        console.error("[CLOUD] Load failed (or empty):", e.message);
    }
    return { stocks: [], isBotActive: true };
}

module.exports = {
    startUserbot,
    requestStockDerinlik,
    waitForBotResponse,
    downloadBotPhoto,
    saveAppState,
    loadAppState
};
