/**
 * Minecraft Java Edition server status pinger.
 * Uses the Server List Ping (SLP) protocol — no external dependencies.
 */
const net = require('net');

function writeVarInt(val) {
  const buf = [];
  while (true) {
    let b = val & 0x7f;
    val >>>= 7;
    if (val !== 0) b |= 0x80;
    buf.push(b);
    if (val === 0) break;
  }
  return Buffer.from(buf);
}

function readVarInt(buf, offset) {
  let result = 0, shift = 0, cursor = offset;
  while (cursor < buf.length) {
    const b = buf[cursor++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value: result, newOffset: cursor };
}

function buildHandshake(host, port) {
  const hostBuf = Buffer.from(host, 'utf8');
  const hostLen = writeVarInt(hostBuf.length);

  const payload = Buffer.concat([
    writeVarInt(0x00),          // packet id: handshake
    writeVarInt(754),           // protocol version (1.16.5 — broadly compatible)
    hostLen, hostBuf,
    Buffer.from([port >> 8, port & 0xff]),
    writeVarInt(1)              // next state: status
  ]);
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

function buildStatusRequest() {
  const payload = writeVarInt(0x00);
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

function pingServer(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const fail = () => resolve(null);
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    let buf = Buffer.alloc(0);
    let jsonStr = null;

    socket.on('timeout', () => { socket.destroy(); fail(); });
    socket.on('error', () => { socket.destroy(); fail(); });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      // Try to parse packet once we have enough data
      if (buf.length < 2) return;
      try {
        let offset = 0;
        const lenResult = readVarInt(buf, offset);
        offset = lenResult.newOffset;
        const packetLen = lenResult.value;
        if (buf.length < offset + packetLen) return; // not yet complete

        const pidResult = readVarInt(buf, offset);
        offset = pidResult.newOffset;
        // packet id 0x00 = status response

        const strLenResult = readVarInt(buf, offset);
        offset = strLenResult.newOffset;
        const strLen = strLenResult.value;

        jsonStr = buf.slice(offset, offset + strLen).toString('utf8');
        socket.destroy();

        const data = JSON.parse(jsonStr);
        resolve({
          online: true,
          players: data.players?.online ?? 0,
          maxPlayers: data.players?.max ?? 0,
          motd: typeof data.description === 'string'
            ? data.description
            : (data.description?.text ?? ''),
          version: data.version?.name ?? ''
        });
      } catch (_) {
        // partial data, wait for more
      }
    });

    socket.on('close', () => {
      if (!jsonStr) fail();
    });

    socket.connect(port, host, () => {
      socket.write(buildHandshake(host, port));
      socket.write(buildStatusRequest());
    });
  });
}

/**
 * Poll all approved servers and update their status in the DB.
 * Runs concurrently in batches to avoid overwhelming the event loop.
 */
async function pollAllServers(db) {
  const servers = db.prepare(`SELECT id, ip, port FROM servers WHERE status = 'approved'`).all();
  const updateStmt = db.prepare(`
    UPDATE servers SET
      online = ?,
      player_count = ?,
      max_player_count = CASE WHEN ? > 0 THEN ? ELSE max_player_count END,
      last_checked = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const BATCH = 10;
  for (let i = 0; i < servers.length; i += BATCH) {
    const batch = servers.slice(i, i + BATCH);
    await Promise.all(batch.map(async (s) => {
      const result = await pingServer(s.ip, s.port || 25565);
      if (result) {
        updateStmt.run(1, result.players, result.maxPlayers, result.maxPlayers, s.id);
      } else {
        updateStmt.run(0, 0, 0, 0, s.id);
      }
    }));
  }
  console.log(`[pinger] Polled ${servers.length} server(s)`);
}

module.exports = { pingServer, pollAllServers };
