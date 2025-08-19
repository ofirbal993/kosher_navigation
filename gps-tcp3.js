// simple-gps-server.js  (ESM)
// Env: RAILWAY_TCP_APPLICATION_PORT or PORT or 7700
import net from "net";

const PORT = Number(process.env.RAILWAY_TCP_APPLICATION_PORT || process.env.PORT || 7700);

const server = net.createServer((socket) => {
  console.log(`📡 Connected: ${socket.remoteAddress}:${socket.remotePort}`);
  let buf = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    console.log('>>> data', chunk.toString('hex'))
    buf = Buffer.concat([buf, chunk]);

    while (true) {
      const s = buf.indexOf(0x7e);
      if (s === -1) break;
      const e = buf.indexOf(0x7e, s + 1);
      if (e === -1) break;

      const frame = buf.slice(s, e + 1);
      buf = buf.slice(e + 1);

      try {
        const p = parseFrame(frame);
        if (!p) continue;

        // ACKs (שומרים על חיבור יציב)
        if (p.msgId === 0x0100) {
          // Register/Login → 0x8100
          socket.write(build8100(p.terminal, p.seq, 0x00, "OK"));
        } else if (p.msgId === 0x0002 || p.msgId === 0x0200) {
          // Heartbeat/Location → 0x8001
          socket.write(build8001(p.terminal, p.seq, p.msgId, 0x00));
        }

        // הדפסת מיקום פשוטה
        if (p.msgId === 0x0200 && p.loc) {
          const { time_utc, latitude, longitude, speed_kmh } = p.loc;
          console.log(`${time_utc} lat=${latitude} lon=${longitude} speed=${speed_kmh}km/h`);
        }

      } catch {
        // מתעלמים משגיאות פרסינג כדי לא להפיל חיבור
      }
    }

    if (buf.length > 65536) buf = buf.slice(-4096);
  });

  socket.on("end", () => console.log("❌ Disconnected"));
  socket.on("error", (e) => console.error("⚠️", e.message));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ TCP server listening on ${PORT}`);
});

/* ----------------- Minimal JT808 ----------------- */

function parseFrame(frame) {
  if (frame[0] !== 0x7e || frame[frame.length - 1] !== 0x7e) return null;
  let b = unescape(frame.slice(1, -1));
  if (b.length < 13) return null;

  // checksum
  const cs = b[b.length - 1];
  const data = b.slice(0, -1);
  let x = 0; for (const v of data) x ^= v;
  if (x !== cs) return null;

  // header
  const msgId = (data[0] << 8) | data[1];
  const props = (data[2] << 8) | data[3];
  const bodyLen = props & 0x03ff;
  const terminal = bcdToString(data.slice(4, 10)); // 6B BCD (מס' מסוף/טלפון)
  const seq = (data[10] << 8) | data[11];

  let off = 12;
  if (props & 0x2000) { // subpackaged
    off = 16; // מתעלמים מפרטי תת-חלוקה בגרסה הפשוטה
  }
  const body = data.slice(off, off + bodyLen);

  const out = { msgId, terminal, seq };

  // 0x0200 – Location report (שדות חובה בלבד)
  if (msgId === 0x0200 && body.length >= 28) {
    let i = 0;
    /* alarm */ i += 4;
    /* status */ i += 4;
    const lat = body.readUInt32BE(i); i += 4;
    const lon = body.readUInt32BE(i); i += 4;
    /* alt  */ i += 2;
    const spd = body.readUInt16BE(i); i += 2;      // 0.1 km/h
    /* course */ i += 2;
    const ts = body.slice(i, i + 6);

    out.loc = {
      latitude: +(lat / 1e6).toFixed(6),
      longitude: +(lon / 1e6).toFixed(6),
      speed_kmh: +(spd / 10).toFixed(1),
      time_utc: bcdTime(ts)
    };
  }

  return out;
}

/* ----------------- ACK builders ----------------- */

let seqCounter = 1;
function nextSeq() { seqCounter = (seqCounter + 1) & 0xffff; return seqCounter || 1; }

function build8001(terminal, origSeq, origMsgId, result /*0=success*/) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(origSeq, 0);
  body.writeUInt16BE(origMsgId, 2);
  body.writeUInt8(result, 4);
  return buildFrame(0x8001, terminal, nextSeq(), body);
}

function build8100(terminal, origSeq, result /*0=success*/, auth = "") {
  const token = Buffer.from(auth, "utf8");
  const body = Buffer.alloc(3 + token.length);
  body.writeUInt16BE(origSeq, 0);
  body.writeUInt8(result, 2);
  token.copy(body, 3);
  return buildFrame(0x8100, terminal, nextSeq(), body);
}

function buildFrame(msgId, terminalStr, seq, body) {
  const phoneBcd = strToBcd((terminalStr || "").padStart(12, "0").slice(-12));
  const props = body.length & 0x03ff; // no encryption/subpack
  const head = Buffer.alloc(12);
  head.writeUInt16BE(msgId, 0);
  head.writeUInt16BE(props, 2);
  phoneBcd.copy(head, 4);
  head.writeUInt16BE(seq, 10);
  const data = Buffer.concat([head, body]);

  // checksum
  let cs = 0x00; for (const b of data) cs ^= b;
  const withCs = Buffer.concat([data, Buffer.from([cs])]);

  // escape & wrap
  const escaped = escape(withCs);
  return Buffer.concat([Buffer.from([0x7e]), escaped, Buffer.from([0x7e])]);
}

/* ----------------- Utils ----------------- */

function unescape(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x7d && i + 1 < buf.length) {
      const n = buf[i + 1];
      if (n === 0x01) { out.push(0x7d); i++; continue; }
      if (n === 0x02) { out.push(0x7e); i++; continue; }
    }
    out.push(b);
  }
  return Buffer.from(out);
}

function escape(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x7e) { out.push(0x7d, 0x02); continue; }
    if (b === 0x7d) { out.push(0x7d, 0x01); continue; }
    out.push(b);
  }
  return Buffer.from(out);
}

function bcdToString(buf) {
  let s = "";
  for (const b of buf) {
    const hi = (b >> 4) & 0x0f, lo = b & 0x0f;
    if (hi <= 9) s += hi;
    if (lo <= 9) s += lo;
  }
  return s.replace(/^0+/, "");
}

function strToBcd(str) {
  const out = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    const hi = parseInt(str[i * 2] ?? "0", 10);
    const lo = parseInt(str[i * 2 + 1] ?? "0", 10);
    out[i] = ((hi & 0x0f) << 4) | (lo & 0x0f);
  }
  return out;
}

function bcdTime(buf6) {
  if (!buf6 || buf6.length < 6) return "";
  const yy = ((buf6[0] >> 4) & 0x0f) * 10 + (buf6[0] & 0x0f);
  const mm = ((buf6[1] >> 4) & 0x0f) * 10 + (buf6[1] & 0x0f);
  const dd = ((buf6[2] >> 4) & 0x0f) * 10 + (buf6[2] & 0x0f);
  const hh = ((buf6[3] >> 4) & 0x0f) * 10 + (buf6[3] & 0x0f);
  const mi = ((buf6[4] >> 4) & 0x0f) * 10 + (buf6[4] & 0x0f);
  const ss = ((buf6[5] >> 4) & 0x0f) * 10 + (buf6[5] & 0x0f);
  const fullY = yy < 80 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(fullY, mm - 1, dd, hh, mi, ss)).toISOString();
}
