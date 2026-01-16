const WebSocket = require('ws');

// Cleaned URL from cURL (removing ^ and ensuring correct encoding)
const rawUrl = "wss://ws.7k2v9x1r0z8t4m3n5p7w.com/?init_data=user%3D%257B%2522id%2522%253A6471352967%252C%2522first_name%2522%253A%2522Soner%2522%252C%2522last_name%2522%253A%2522Y%2522%252C%2522username%2522%253A%2522Sonerylmz01%2522%252C%2522language_code%2522%253A%2522tr%2522%252C%2522allows_write_to_pm%2522%253Atrue%252C%2522photo_url%2522%253A%2522https%253A%255C%252F%255C%252Ft.me%255C%252Fi%255C%252Fuserpic%255C%252F320%255C%252FgO1j9csMXWOUC1MpaS90nc1GdNz-MzofgtAMIVZhOMovGvlqpBUmx-kQ9ucvEdb4.svg%2522%257D%26chat_instance%3D-2291918806841962934%26chat_type%3Dsender%26auth_date%3D1768551638%26signature%3D9wZeT6k-z0CBuP5pvVsNE38-F54Q11f6eo-oWg5xpHVvviU6-dxr80pdejQ-h6OoolkXNJLkQ1gNttYYY4saDw%26hash%3D57c59a3e363fbc07e143b42418ce3d242f1befbbfa39672bf15658fa62621a31";

const headers = {
    "Origin": "https://7k2v9x1r0z8t4m3n5p7w.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache"
    // Sec-WebSocket-Extensions is handled by 'ws' library options usually, but we can try to pass it if needed, 
    // though 'ws' negotiates permessage-deflate by default.
};

console.log(`Connecting to ${rawUrl}...`);

const ws = new WebSocket(rawUrl, {
    headers: headers,
    perMessageDeflate: false // Try disabling first to see if simple connection works, or true if server insists. 
    // The cURL said: Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits
    // 'ws' enables perMessageDeflate by default.
});

ws.on('open', function open() {
    console.log('Connected! Waiting for messages...');

    // Keep alive?
    setInterval(() => {
        // ws.ping(); // Some servers need ping
    }, 10000);
});

ws.on('message', function incoming(data) {
    console.log('Received message:', data.toString());
});

ws.on('unexpected-response', (req, res) => {
    console.log('Unexpected server response:');
    console.log('Code:', res.statusCode);
    console.log('Message:', res.statusMessage);
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err.message);
});

ws.on('close', function close(code, reason) {
    console.log(`Disconnected. Code: ${code}, Reason: ${reason}`);
});
