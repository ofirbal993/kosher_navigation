// server.js
const net = require('net');

// Choose a port (this must match the one you set in SERVER command)
const PORT = 10000; 

// Create TCP server
const server = net.createServer((socket) => {
  console.log('📡 New device connected:', socket.remoteAddress, socket.remotePort);

  socket.on('data', (data) => {
    const message = data.toString().trim();
    console.log('📥 Received:', message);

    // You can parse GPS data here based on MV77G protocol
    // Example: save to DB or log to file
  });

  socket.on('end', () => {
    console.log('❌ Device disconnected');
  });

  socket.on('error', (err) => {
    console.error('⚠️ Socket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`✅ TCP Server running on port ${PORT}`);
});
