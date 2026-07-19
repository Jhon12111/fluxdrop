'use strict';
/*
 * Regression test for the "Cancel does nothing" bug.
 *
 * A receiver that stops reading mid-transfer makes the sender back-pressure and
 * park its file read stream waiting for a 'drain'. Cancelling then destroys the
 * socket, which emits 'close' (not 'error'). Before the fix, streamRange only
 * listened for 'error'/'end', so the send promise hung forever and Cancel had
 * no visible effect. This test asserts sendPaths settles promptly after cancel.
 */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendPaths, frame, FrameReader } = require('../src/core');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxdrop-cancel-'));
const file = path.join(TMP, 'big.bin');
const fd = fs.openSync(file, 'w');
const buf = Buffer.alloc(8 * 1024 * 1024);
for (let i = 0; i < 20; i++) fs.writeSync(fd, buf); // 160 MB, plenty to back up
fs.closeSync(fd);

// Fake receiver: accepts the offer, then goes silent (never reads payload),
// forcing the sender into back-pressure.
const server = net.createServer((socket) => {
  const reader = new FrameReader();
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    reader.push(chunk);
    let f;
    try { f = reader.next(); } catch (_) { return; }
    if (f && f.type === 'offer') {
      socket.write(frame({ type: 'accept', tid: f.tid, streams: 1 }));
      socket.pause(); // stop consuming -> sender back-pressures and parks
    }
  });
});

async function main() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const registry = new Map();
  let settled = false;

  const sendP = sendPaths({
    host: '127.0.0.1',
    port,
    self: { id: 'sender', name: 'Sender' },
    paths: [file],
    registry,
    streams: 1,
    onUpdate: () => {},
  }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }))
    .then((res) => { settled = true; return res; });

  // let the transfer start and fill the socket buffer, then cancel
  await new Promise((r) => setTimeout(r, 600));
  const entry = [...registry.values()][0];
  if (!entry) throw new Error('registry entry missing — transfer never started');
  entry.cancel();

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('HANG: sendPaths did not settle within 3s of cancel')), 3000));
  const res = await Promise.race([sendP, timeout]);

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  if (!settled) throw new Error('sendPaths did not settle');
  if (res.r && res.r.state !== 'canceled') throw new Error('expected canceled state, got ' + res.r.state);
  console.log('cancel-hang test passed (settled promptly, state=' + (res.r ? res.r.state : 'rejected') + ')');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
