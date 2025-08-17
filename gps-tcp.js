// server.js  (ESM)
import net from "net";

const PORT = Number(process.env.RAILWAY_TCP_APPLICATION_PORT || process.env.PORT || 7700);
const PRINT_MODE = (process.env.PRINT_MODE || "line").toLowerCase(); // line | json | table

// ---- Parsing helpers ----
function dmToDec(dm, dir) {
  // coord string like "3245.6789" -> 32 + 45.6789/60
  if (!dm) return null;
  const i = dm.indexOf(".");
  const degLen = i - 2;
  const deg = parseInt(dm.slice(0, degLen), 10);
  const min = parseFloat(dm.slice(degLen));
  if (isNaN(deg) || isNaN(min)) return null;
  let dec = deg + min / 60;
  if (dir === "S" || dir === "W") dec *= -1;
  return +dec.toFixed(6);
}

function toIso(dateDDMMYY, timeHHMMSS) {
  // DDMMYY + HHMMSS -> ISO (UTC). If missing, return null
  if (!dateDDMMYY || !timeHHMMSS) return null;
  const dd = dateDDMMYY.slice(0, 2);
  const mm = dateDDMMYY.slice(2, 4);
  const yy = dateDDMMYY.slice(4, 6);
  const hh = timeHHMMSS.slice(0, 2);
  const mi = timeHHMMSS.slice(2, 4);
  const ss = timeHHMMSS.slice(4, 6);
  // Years 00-79 => 2000-2079, 80-99 => 1980-1999 (שכיח ב־GPS מודרני - 20xx)
  const fullYear = Number(yy) < 80 ? 2000 + Number(yy) : 1900 + Number(yy);
  const iso = new Date(Date.UTC(fullYear, Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)));
  return iso.toISOString();
}

function parsePacket(raw) {
  // Expected ASCII like: *HQ,IMEI,V1,HHMMSS,A,lat,NS,lon,EW,speed,course,DDMMYY,state,...#
  const s = raw.trim().replace(/^\*/, "").replace(/#$/, "");
  const p = s.split(",");

  const obj = {
    raw,
    type: p[0] || null,               // HQ / others
    imei: p[1] || null,
    command: p[2] || null,            // V1 / LK / ...
    time_raw: p[3] || null,
    valid: p[4] === "A",
    lat_dm: p[5] || null,
    lat_dir: p[6] || null,
    lon_dm: p[7] || null,
    lon_dir: p[8] || null,
    speed_knots: p[9] ? Number(p[9]) : null, // לעיתים זה בקשר (knots) ולעיתים בקמ״ש – תלוי דגם/פירמוט
    course: p[10] || null,
    date_raw: p[11] || null,
    state: p[12] || null,
  };

  // המרות ידידותיות
  obj.latitude = dmToDec(obj.lat_dm, obj.lat_dir);
  obj.longitude = dmToDec(obj.lon_dm, obj.lon_dir);

  // אם המהירות בקשר, המרה לקמ״ש (1 knot ≈ 1.852 km/h). אם כבר בקמ״ש – אפשר להתאים.
  if (obj.speed_knots != null && !isNaN(obj.speed_knots)) {
    obj.speed_kmh = +(obj.speed_knots * 1.852).toFixed(1);
  }

  obj.timestamp = toIso(obj.date_raw, obj.time_raw);

  return obj;
}

function printPacket(pkt) {
  switch (PRINT_MODE) {
    case "json":
      console.log(JSON.stringify({
        imei: pkt.imei,
        ts: pkt.timestamp,
        lat: pkt.latitude,
        lon: pkt.longitude,
        speed_kmh: pkt.speed_kmh ?? null,
        course: pkt.course ?? null,
        valid: pkt.valid,
        type: pkt.type,
        cmd: pkt.command
      }, null, 2));
      break;

    case "table":
      console.table([{
        IMEI: pkt.imei || "",
        Timestamp: pkt.timestamp || "",
        Latitude: pkt.latitude ?? "",
        Longitude: pkt.longitude ?? "",
        "Speed (km/h)": pkt.speed_kmh ?? "",
        Course: pkt.course ?? "",
        Valid: pkt.valid,
        Type: pkt.type || "",
        Cmd: pkt.command || ""
      }]);
      break;

    case "line":
    default:
      console.log(
        `[${pkt.imei || "?"}] ${pkt.timestamp || "no-time"} ` +
        `lat=${pkt.latitude ?? "?"} lon=${pkt.longitude ?? "?"} ` +
        (pkt.speed_kmh != null ? `speed=${pkt.speed_kmh}km/h ` : "") +
        (pkt.course != null ? `course=${pkt.course} ` : "") +
        `valid=${pkt.valid ? "A" : "V"}`
      );
      break;
  }
}

// ---- Server with robust framing ----
const server = net.createServer((socket) => {
  console.log(`📡 Connected: ${socket.remoteAddress}:${socket.remotePort} | v1`);
  let buffer = ""; // accumulate between chunks

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    console.log("📥 Raw:", chunk);

    // messages framed by '*' ... '#'
    while (true) {
      const start = buffer.indexOf("*");
      const end = buffer.indexOf("#", start + 1);
      if (start === -1 || end === -1) break;

      const rawMsg = buffer.slice(start, end + 1);
      buffer = buffer.slice(end + 1);

      try {
        const pkt = parsePacket(rawMsg);
        printPacket(pkt);
      } catch (e) {
        console.error("❌ Parse error:", e.message, "Raw:", rawMsg);
      }
    }

    // avoid unbounded growth if tracker sends noise without framing
    if (buffer.length > 10_000) buffer = buffer.slice(-1_000);
  });

  socket.on("end", () => console.log("❌ Disconnected"));
  socket.on("error", (e) => console.error("⚠️ Socket error:", e.message));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ TCP server listening on ${PORT} (PRINT_MODE=${PRINT_MODE})`);
});
