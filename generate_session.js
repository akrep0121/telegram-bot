const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const fs = require("fs");
const config = require("./config");

// Ensure we don't start the main bot loop
async function generate() {
    console.log("Generating fresh session string...");

    // Start with empty session to force new login
    const client = new TelegramClient(
        new StringSession(""),
        config.API_ID,
        config.API_HASH,
        { connectionRetries: 5 }
    );

    await client.start({
        phoneNumber: async () => await input.text("Telefon Numaranız (+90...): "),
        password: async () => await input.text("2FA Şifreniz (varsa): "),
        phoneCode: async () => await input.text("Telegram'a gelen kod: "),
        onError: (err) => console.log(err),
    });

    const session = client.session.save();
    console.log("\n✅ YENI OTURUM KODUNUZ (Aşağıdakini kopyalayın):\n");
    console.log(session);
    console.log("\n");

    // Save to file just in case
    fs.writeFileSync("session_string.txt", session);

    console.log("Oturum kodu 'session_string.txt' dosyasına da kaydedildi.");
    process.exit(0);
}

generate();
