const WebSocket = require('ws');

const domain = "ws.7k2v9x1r0z8t4m3n5p7w.com";
const initData = "user=%7B%22id%22%3A6471352967%2C%22first_name%22%3A%22Soner%22%2C%22last_name%22%3A%22Y%22%2C%22username%22%3A%22Sonerylmz01%22%2C%22language_code%22%3A%22tr%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2FgO1j9csMXWOUC1MpaS90nc1GdNz-MzofgtAMIVZhOMovGvlqpBUmx-kQ9ucvEdb4.svg%22%7D&chat_instance=7535012040927381335&chat_type=private&auth_date=1768492557&signature=eCo-_35KDNjtgpYCKAf1zBESizS8UW34JnAor11a6YQaY6Q-z35ZoF8UNe8guAXIO2lnZFYpjNK-eyOhAMBrDA&hash=25ed78163a5f1878aa8daf8e77fb1360ae1626d1b5057e488b4774222a550011";

const candidates = [
    { name: "Direct", url: `wss://${domain}/?${initData}` },
    { name: "SocketIO", url: `wss://${domain}/socket.io/?EIO=4&transport=websocket&${initData}` },
    { name: "WS Path", url: `wss://${domain}/ws/?${initData}` },
    { name: "Api Path", url: `wss://${domain}/api/ws/?${initData}` }
];

async function testCandidate(candidate) {
    return new Promise((resolve) => {
        console.log(`Testing ${candidate.name}: ${candidate.url.substring(0, 50)}...`);
        const ws = new WebSocket(candidate.url, {
            headers: {
                'Origin': `https://${domain}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 5000
        });

        ws.on('open', () => {
            console.log(`[SUCCESS] Connected to ${candidate.name}!`);
            ws.close();
            resolve(true);
        });

        ws.on('error', (err) => {
            console.log(`[FAILED] ${candidate.name}: ${err.message}`);
            resolve(false);
        });

        ws.on('unexpected-response', (req, res) => {
            console.log(`[FAILED] ${candidate.name}: Unexpected response ${res.statusCode}`);
            resolve(false);
        });
    });
}

(async () => {
    for (const candidate of candidates) {
        await testCandidate(candidate);
    }
})();
