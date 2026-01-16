require('dotenv').config();

module.exports = {
    API_ID: Number(process.env.API_ID),
    API_HASH: process.env.API_HASH,
    BOT_TOKEN: process.env.BOT_TOKEN,
    CHANNEL_ID: process.env.CHANNEL_ID, // Optional: for broadcasting
    TARGET_BOT_USERNAME: "xFinansBeta_bot"
};
