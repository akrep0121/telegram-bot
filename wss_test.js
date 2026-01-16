const WebSocket = require('ws');

const wsUrl = 'wss://ws.7k2v9x1r0z8t4m3n5p7w.com';

console.log(`Connecting to ${wsUrl}...`);

const ws = new WebSocket(wsUrl);

ws.on('open', function open() {
    console.log('Connected!');

    // Wait to see if we get a welcome message
    // If not, we might need to send something.
    setTimeout(() => {
        console.log('Connection open for 5 seconds.');
        ws.close();
    }, 5000);
});

ws.on('message', function incoming(data) {
    console.log('Received message:', data.toString());
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

ws.on('close', function close() {
    console.log('Disconnected');
});
