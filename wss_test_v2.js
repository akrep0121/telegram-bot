const WebSocket = require('ws');

// The raw initData provided by the user
const initData = "user=%7B%22id%22%3A6471352967%2C%22first_name%22%3A%22Soner%22%2C%22last_name%22%3A%22Y%22%2C%22username%22%3A%22Sonerylmz01%22%2C%22language_code%22%3A%22tr%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2FgO1j9csMXWOUC1MpaS90nc1GdNz-MzofgtAMIVZhOMovGvlqpBUmx-kQ9ucvEdb4.svg%22%7D&chat_instance=7535012040927381335&chat_type=private&auth_date=1768492557&signature=eCo-_35KDNjtgpYCKAf1zBESizS8UW34JnAor11a6YQaY6Q-z35ZoF8UNe8guAXIO2lnZFYpjNK-eyOhAMBrDA&hash=25ed78163a5f1878aa8daf8e77fb1360ae1626d1b5057e488b4774222a550011";

// Construct URL with query parameters
// Trying simply appending it as query string
const wsUrl = `wss://ws.7k2v9x1r0z8t4m3n5p7w.com/?${initData}`;

console.log(`Connecting to ${wsUrl}...`);

const ws = new WebSocket(wsUrl);

ws.on('open', function open() {
    console.log('Connected!');

    // Send a test subscription message if the server expects one
    // Typically, trading bots use standard formats, let's listen first.

    setTimeout(() => {
        console.log('Connection still open...');
    }, 3000);
});

ws.on('message', function incoming(data) {
    console.log('Received message:', data.toString());
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err.message);
});

ws.on('close', function close(code, reason) {
    console.log(`Disconnected. Code: ${code}, Reason: ${reason}`);
});
