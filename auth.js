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

async function getFreshWebAppUrl() {
    if (!client.connected) {
        await startUserbot();
    }

    try {
        const result = await client.invoke(
            new Api.messages.RequestWebView({
                peer: config.TARGET_BOT_USERNAME,
                bot: config.TARGET_BOT_USERNAME,
                platform: "android", // masquerade as Android
                fromBotMenu: false,
                url: "https://7k2v9x1r0z8t4m3n5p7w.com/"
            })
        );

        return result.url;
    } catch (error) {
        console.error("Error getting Web App URL:", error);
        return null;
    }
}

module.exports = { startUserbot, getFreshWebAppUrl };
