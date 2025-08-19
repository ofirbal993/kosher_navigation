// gps-tcp.js
// Simple TCP server for Micodus MV77G (JT808-like protocol) with logging and TLV parsing

import net from "net";

// Environment options
const PORT = process.env.PORT || 7700;
const DEBUG = process.env.DEBUG_JT === "1";
const PRINT_LOC = process.env.PRINT_LOC || "text";

// Utility: convert buffer to hex string
function hex(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, "0")).join(" ");
}

// Utility: convert BCD-encoded timestamp to JS Date in UTC
function bcdTime(buf) {
  if (buf.length < 6) return null;
  const yy = buf[0], MM = buf[1], dd = buf[2],
        hh = buf[3], mm = buf[4], ss = buf[5];
  return new Date(Date.UTC(2000 + yy, MM - 1, dd, hh, mm, ss)).toISOString();
}

// Compute checksum (XOR of all bytes)
function checksum(buf) {
  let cs = 0;
  for (let b of buf) cs ^= b;
  return cs;
}

// Build 0x8001 acknowledgment frame
function buildAck(msg, ok = true) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(msg.seq, 0);  // sequence of original message
  body.writeUInt16BE(msg.msgId, 2); // original messageId
  body.writeUInt8(ok ? 0 : 1, 4);   // result (0=success)

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8001, 0);  // response msgId
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(msg.term, 4);
  header.writeUInt16BE(0, 8);       // new sequence number (set to 0 here)
  // header[10..11] reserved

  const pack = Buffer.concat([header, body]);
  const cs = checksum(pack);
  return Buffer.concat([Buffer.from([0x7e]), pack, Buffer.from([cs]), Buffer.from([0x7e])]);
}

// Parse a single JT808 frame
function parseFrame(buf) {
  if (buf[0] !== 0x7e || buf[buf.length - 1] !== 0x7e) return null;
  const data = buf.slice(1, -1);

  if (data.length < 12 + 1) return null; // too short

  const msgId = data.readUInt16BE(0);
  const bodyLen = data.readUInt16BE(2) & 0x03ff;
  const term = data.readUInt32BE(4);
  const seq = data.readUInt16BE(8);
  const body = data.slice(12, 12 + bodyLen);
  const cs = data[data.length - 1];
  const calc = checksum(data.slice(0, -1));

  const out = { msgId, seq, term, body, raw: buf, csOk: cs === calc };

  // If this is a location report (0x0200)
  if (msgId === 0x0200 && body.length >= 28) {
    let i = 0;
    const alarm = body.readUInt32BE(i); i += 4;
    const status = body.readUInt32BE(i); i += 4;
    const lat = body.readUInt32BE(i); i += 4;
    const lon = body.readUInt32BE(i); i += 4;
    const alt = body.readUInt16BE(i); i += 2;
    const spd = body.readUInt16BE(i); i += 2;
    const course = body.readUInt16BE(i); i += 2;
    const ts = body.slice(i, i + 6); i += 6;

    const loc = {
      time_utc: bcdTime(ts),
      latitude: +(lat / 1e6).toFixed(6),
      longitude: +(lon / 1e6).toFixed(6),
      speed_kmh: +(spd / 10).toFixed(1),
      course_deg: course,
      altitude_m: alt,
      alarm, status
    };

    // TLV extras
    const extras = {};
    while (i + 2 <= body.length) {
      const id = body[i++];
      if (i >= body.length) break;
      const len = body[i++];
      if (i + len > body.length) break;
      const val = body.slice(i, i + len);
      i += len;

      // Common Micodus/JT808 TLVs
      if (id === 0x01 && len === 4) {
        extras.mileage_km = +(val.readUInt32BE(0) / 10).toFixed(1);
      } else if (id === 0x30 && len === 1) {
        extras.gsm_signal = val[0];
      } else if (id === 0x31 && len === 1) {
        extras.gps_signal = val[0];
      } else if (id === 0x32 && len === 1) {
        extras.hdop = val[0];
      } else if (id === 0x33 && len === 1) {
        extras.sats = val[0];
      } else if (id === 0x34 && len === 1) {
        extras.acc = (val[0] & 0x01) === 0x01 ? "ON" : "OFF";
      } else if (id === 0x57 && len === 8) {
        extras.io_57 = '0x' + [...val].map(b=>b.toString(16).padStart(2,'0')).join('');
      } else if (id === 0x82 && len === 2) {
        extras.external_voltage_v = +(val.readUInt16BE(0) / 10).toFixed(1);
      } else {
        extras['tlv_' + id.toString(16).padStart(2,'0')] =
          '0x' + [...val].map(b=>b.toString(16).padStart(2,'0')).join('');
      }
    }

    out.loc = loc;
    out.extras = extras;
  }

  return out;
}

// Create TCP server
const server = net.createServer(socket => {
  console.log(`📡 Connected: ${socket.remoteAddress}:${socket.remotePort}`);

  let buf = Buffer.alloc(0);

  socket.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);

    while (true) {
      const start = buf.indexOf(0x7e);
      if (start < 0) { buf = Buffer.alloc(0); break; }
      const end = buf.indexOf(0x7e, start + 1);
      if (end < 0) {
        buf = buf.slice(start); // keep partial
        break;
      }

      const frame = buf.slice(start, end + 1);
      buf = buf.slice(end + 1);

      const p = parseFrame(frame);
      if (!p) {
        if (DEBUG) console.log("↪ break: parse error");
        continue;
      }

      console.log("\n── Frame ─────────────────────────");
      console.log("RAW HEX:", hex(frame));
      console.log(`msgId=0x${p.msgId.toString(16).padStart(4,"0")} seq=${p.seq} term=${p.term} bodyLen=${p.body.length} cs=${p.csOk ? "OK" : "BAD"}`);

      // Acknowledge required messages
      if (p.msgId === 0x0100 || p.msgId === 0x0102 || p.msgId === 0x0200) {
        const ack = buildAck(p);
        socket.write(ack);
        console.log(`→ send 0x8001 (ack)`);
      }

      // Print location report
      if (p.msgId === 0x0200 && p.loc) {
        if (PRINT_LOC === "json") {
          console.log(JSON.stringify({ ...p.loc, extras: p.extras }, null, 2));
        } else {
          const { time_utc, latitude, longitude, speed_kmh } = p.loc;
          console.log(`${time_utc} lat=${latitude} lon=${longitude} speed=${speed_kmh}km/h`);
          if (DEBUG) {
            const ex = p.extras || {};
            const bits = [];
            if ('acc' in ex) bits.push(`ACC=${ex.acc}`);
            if ('sats' in ex) bits.push(`Sats=${ex.sats}`);
            if ('gps_signal' in ex) bits.push(`GPSsig=${ex.gps_signal}`);
            if ('gsm_signal' in ex) bits.push(`GSM=${ex.gsm_signal}`);
            if ('external_voltage_v' in ex) bits.push(`Vbat=${ex.external_voltage_v}V`);
            if ('mileage_km' in ex) bits.push(`Odo=${ex.mileage_km}km`);
            if (bits.length) console.log('  ↳', bits.join(' | '));
          }
        }
      }
    }
  });

  socket.on("close", () => console.log("❌ Disconnected"));
  socket.on("error", e => console.log("⚠️ Error:", e.message));
});

server.listen(PORT, () => console.log(`✅ TCP server listening on ${PORT}`));
