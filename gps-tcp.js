import net from "net";

// Railway gives you a TCP proxy. Listen on the "application port" it forwards to:
const PORT = Number(process.env.RAILWAY_TCP_APPLICATION_PORT || process.env.PORT || 7700);

const server = net.createServer((socket) => {
  console.log("📡 Device connected:", socket.remoteAddress, socket.remotePort);

  socket.on("data", (buf) => {
    const msg = buf.toString().trim();
    console.log("📥 Raw:", msg);
    // TODO: parse MV77G packet here
  });

  socket.on("end", () => console.log("❌ Device disconnected"));
  socket.on("error", (e) => console.error("⚠️ Socket error:", e.message));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ TCP server listening on ${PORT}`);
});
