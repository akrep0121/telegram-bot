import asyncio
import websockets
import json

WSS_URL = "wss://ws.7k2v9x1r0z8t4m3n5p7w.com"

async def test_connection():
    print(f"Connecting to {WSS_URL}...")
    try:
        async with websockets.connect(WSS_URL) as websocket:
            print("Connected!")
            
            # Wait for initial message
            try:
                msg = await asyncio.wait_for(websocket.recv(), timeout=10)
                print(f"Received message: {msg}")
            except asyncio.TimeoutError:
                print("No message received in 10 seconds.")
            
            # Try sending a subscribe message if no welcome message
            # This is a guess; usually we need to subscribe to a symbol
            # subscribe_msg = {"action": "subscribe", "symbol": "THYAO"}
            # await websocket.send(json.dumps(subscribe_msg))
            
    except Exception as e:
        print(f"Connection failed: {e}")

if __name__ == "__main__":
    # Install websockets if not present: pip install websockets
    asyncio.run(test_connection())
