// gps-tcp.js  (ESM)
// Env:
//  - RAILWAY_TCP_APPLICATION_PORT or PORT (listen)
//  - PRINT_MODE=line|json|table (default: line)
//  - JT808_LOG_HEX=true (optional: also print full HEX frames)

import net from "net";

const PORT = Number(process.env.RAILWAY_TCP_APPLICATION_PORT || process.env.PORT || 7700);
const PRINT_MODE = (process.env.PRINT_MODE || "line").toLowerCase();
const LOG_HEX = String(process.env.JT808_LOG_HEX || "").toLowerCase() === "true";

const server = net.createServer((socket) => {
  console.log(`📡 Connected: ${socket.remoteAddress}:${socket.remotePort}`);
  let acc = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    acc = Buffer.concat([acc, chunk]);

    // extract frames delimited by 0x7E ... 0x7E
    while (true) {
      const start = acc.indexOf(0x7e);
      if (start === -1) break;
      const end = acc.indexOf(0x7e, start + 1);
      if (end === -1) break;

      const frame = acc.slice(start, end + 1);
      acc = acc.slice(end + 1);

      try {
        const p = parseJT808Frame(frame);
        if (LOG_HEX) console.log("HEX:", p.rawHex);
        printParsed(p);
        sendAckIfNeeded(socket, p);
      } catch (e) {
        console.error("❌ Parse error:", e.message, "| HEX:", hex(frame));
      }
    }

    if (acc.length > 65536) acc = acc.slice(-4096);
  });

  socket.on("end", () => console.log("❌ Disconnected"));
  socket.on("error", (e) => console.error("⚠️ Socket error:", e.message));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ TCP server listening on ${PORT} (PRINT_MODE=${PRINT_MODE}${LOG_HEX ? ", HEX" : ""})`);
});

/* ─────────── JT808 parsing ─────────── */

function parseJT808Frame(frame) {
  if (frame[0] !== 0x7e || frame[frame.length - 1] !== 0x7e) {
    throw new Error("Bad delimiters");
  }
  let body = frame.slice(1, frame.length - 1);
  body = unescapeJT808(body);

  if (body.length < 13) throw new Error("Too short");

  // checksum
  const checksum = body[body.length - 1];
  const data = body.slice(0, body.length - 1);
  let calc = 0x00;
  for (const b of data) calc ^= b;
  const ok = (calc === checksum);

  // header
  const msgId = (data[0] << 8) | data[1];
  const props = (data[2] << 8) | data[3];
  const bodyLen = props & 0x03ff;
  const subpack = !!(props & 0x2000);

  // terminal id (6 bytes BCD)
  const terminalBcd = data.slice(4, 10);
  const terminal = bcdToString(terminalBcd);

  const seq = (data[10] << 8) | data[11];

  let offset = 12;
  let pkg = null;
  if (subpack) {
    const total = (data[12] << 8) | data[13];
    const idx = (data[14] << 8) | data[15];
    pkg = { total, idx };
    offset = 16;
  }

  const bodyBytes = data.slice(offset, offset + bodyLen);

  let decoded = null;
  if (msgId === 0x0200) decoded = decode0200(bodyBytes);

  const asciiHint = extractAscii(bodyBytes);

  return {
    ok, msgId, props, bodyLen, subpack,
    terminal, seq, pkg,
    bodyBytes, decoded,
    asciiHint,
    rawHex: hex(frame)
  };
}

function decode0200(buf) {
  // 0x0200 mandatory fields: alarm(4)|status(4)|lat(4)|lon(4)|alt(2)|speed(2)|course(2)|time(6)
  if (buf.length < 28) return null;
  let o = 0;
  const alarm = buf.readUInt32BE(o); o += 4;
  const status = buf.readUInt32BE(o); o += 4;

  const latRaw = buf.readUInt32BE(o); o += 4;   // in 1e-6 deg
  const lonRaw = buf.readUInt32BE(o); o += 4;
  const latitude = +(latRaw / 1e6).toFixed(6);
  const longitude = +(lonRaw / 1e6).toFixed(6);

  const altitude_m = buf.readUInt16BE(o); o += 2; // meters
  const speed_tenth = buf.readUInt16BE(o); o += 2; // 0.1 km/h
  const speed_kmh = +(speed_tenth / 10).toFixed(1);
  const course_deg = buf.readUInt16BE(o); o += 2;

  const time_utc = bcdDateTime(buf.slice(o, o + 6)); // YYMMDDhhmmss
  o += 6;

  // Optional TLVs may follow; not decoded here
  return { alarm, status, latitude, longitude, altitude_m, speed_kmh, course_deg, time_utc };
}

/* ─────────── ACK builders ─────────── */

function sendAckIfNeeded(socket, p) {
  if (!p) return;
  // Heartbeat (0x0002) or Location (0x0200) → 0x8001 (platform general response)
  if (p.msgId === 0x0002 || p.msgId === 0x0200) {
    const ack = build8001(p.terminal, p.seq, p.msgId, 0x00);
    socket.write(ack);
  }
  // Register (0x0100) or Auth (0x0102) → 0x8100 (terminal register response)
  else if (p.msgId === 0x0100 || p.msgId === 0x0102) {
    const ack = build8100(p.terminal, p.seq, 0x00, "OK");
    socket.write(ack);
  }
}

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
  const phoneBcd = strToBcd(terminalStr.padStart(12, "0").slice(-12));
  const props = body.length & 0x03ff; // no encryption, no subpack
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
  const escaped = escapeJT808(withCs);
  return Buffer.concat([Buffer.from([0x7e]), escaped, Buffer.from([0x7e])]);
}

/* ─────────── Utils ─────────── */

function unescapeJT808(buf) {
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
function escapeJT808(buf) {
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
    s += (hi <= 9 ? hi : "");
    s += (lo <= 9 ? lo : "");
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
function bcdDateTime(buf6) {
  // YY MM DD hh mm ss (BCD)
  if (!buf6 || buf6.length < 6) return null;
  const yy = ((buf6[0] >> 4) & 0x0f) * 10 + (buf6[0] & 0x0f);
  const mm = ((buf6[1] >> 4) & 0x0f) * 10 + (buf6[1] & 0x0f);
  const dd = ((buf6[2] >> 4) & 0x0f) * 10 + (buf6[2] & 0x0f);
  const hh = ((buf6[3] >> 4) & 0x0f) * 10 + (buf6[3] & 0x0f);
  const mi = ((buf6[4] >> 4) & 0x0f) * 10 + (buf6[4] & 0x0f);
  const ss = ((buf6[5] >> 4) & 0x0f) * 10 + (buf6[5] & 0x0f);
  const fullY = yy < 80 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(fullY, mm - 1, dd, hh, mi, ss)).toISOString();
}
function extractAscii(buf) {
  const txt = buf.toString("latin1");
  const spans = [];
  let cur = "";
  for (let i = 0; i < txt.length; i++) {
    const ch = txt.charCodeAt(i);
    if (ch >= 32 && ch <= 126) cur += txt[i];
    else { if (cur.length >= 5) spans.push(cur); cur = ""; }
  }
  if (cur.length >= 5) spans.push(cur);
  return spans;
}
function hex(buf) { return [...buf].map(b => b.toString(16).padStart(2, "0")).join(" "); }

/* ─────────── Printing ─────────── */

function printParsed(p) {
  // minimal header line
  if (PRINT_MODE === "line") {
    const base = `[${p.terminal || "?"}] msgId=0x${p.msgId.toString(16).padStart(4,"0")} seq=${p.seq} cs=${p.ok?"OK":"BAD"}`;
    if (p.decoded && p.msgId === 0x0200) {
      const d = p.decoded;
      console.log(`${base} | ${d.time_utc} lat=${d.latitude} lon=${d.longitude} speed=${d.speed_kmh}km/h course=${d.course_deg}`);
    } else {
      console.log(base + (p.asciiHint?.length ? ` | ASCII: ${p.asciiHint.join(" | ")}` : ""));
    }
    return;
  }

  if (PRINT_MODE === "json") {
    const out = {
      terminal: p.terminal,
      msgId: `0x${p.msgId.toString(16).padStart(4,"0")}`,
      seq: p.seq,
      checksum_ok: p.ok,
      asciiHint: p.asciiHint?.length ? p.asciiHint : undefined,
      decoded: p.decoded || undefined
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // table
  if (p.decoded && p.msgId === 0x0200) {
    const d = p.decoded;
    console.table([{
      Terminal: p.terminal,
      MsgId: `0x${p.msgId.toString(16).padStart(4,"0")}`,
      Seq: p.seq,
      Checksum: p.ok ? "OK" : "BAD",
      Time: d.time_utc,
      Lat: d.latitude,
      Lon: d.longitude,
      "Speed(km/h)": d.speed_kmh,
      Course: d.course_deg,
      "Alt(m)": d.altitude_m
    }]);
  } else {
    console.table([{
      Terminal: p.terminal,
      MsgId: `0x${p.msgId.toString(16).padStart(4,"0")}`,
      Seq: p.seq,
      Checksum: p.ok ? "OK" : "BAD",
      ASCII: p.asciiHint?.join(" | ") || ""
    }]);
  }
}
