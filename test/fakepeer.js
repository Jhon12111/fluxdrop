'use strict';
/* Manual harness: pretends to be another computer on the LAN and sends a file
 * to the running FluxDrop app, so the approval UI can be exercised.
 * Usage: node test/fakepeer.js */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { Discovery, sendPaths } = require('../src/core');

const SLOW = process.env.SLOW === '1';       // throttle so a transfer lasts a while
const SIZE_MB = Number(process.env.SIZE_MB || (SLOW ? 400 : 120));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxdrop-peer-'));
const file = path.join(TMP, 'Wedding Highlight 4K.mov');
const fd = fs.openSync(file, 'w');
const buf = Buffer.alloc(8 * 1024 * 1024);
for (let i = 0; i < SIZE_MB / 8; i++) { crypto.randomFillSync(buf); fs.writeSync(fd, buf); }
fs.closeSync(fd);

/** Optional throttling proxy so the receive stays active long enough to click. */
function startThrottle(targetHost, targetPort) {
  const RATE = 8 * 1024 * 1024; // 8 MB/s
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const up = net.connect({ host: targetHost, port: targetPort });
      const pipe = (from, to) => {
        let budget = 0, last = Date.now();
        from.on('data', (c) => {
          from.pause();
          const now = Date.now(); budget += ((now - last) / 1000) * RATE; last = now;
          const wait = budget >= c.length ? 0 : ((c.length - budget) / RATE) * 1000;
          setTimeout(() => { budget -= c.length; if (!to.destroyed) to.write(c); from.resume(); }, 20 + wait);
        });
        from.on('end', () => setTimeout(() => { try { to.end(); } catch (_) {} }, 30));
        from.on('error', () => { try { to.destroy(); } catch (_) {} });
      };
      up.on('connect', () => { pipe(client, up); pipe(up, client); });
      up.on('error', () => { try { client.destroy(); } catch (_) {} });
      client.on('error', () => { try { up.destroy(); } catch (_) {} });
    });
    server.listen(0, () => resolve(server));
  });
}

const self = { id: 'fake-macbook-001', name: "Ashik's MacBook Pro", platform: 'mac', transferPort: 52999 };
const d = new Discovery(self);

async function main() {
  await d.start();
  console.log('fake peer announcing as', self.name);

  const target = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 15000);
    d.on('update', (devs) => {
      const real = devs.find((x) => x.id !== self.id);
      if (real) { clearTimeout(to); resolve(real); }
    });
  });

  if (!target) { console.log('no FluxDrop app found'); d.stop(); process.exit(1); }
  console.log('found app:', target.name, target.ip + ':' + target.port);

  let host = target.ip;
  let port = target.port;
  if (SLOW) {
    const throttle = await startThrottle(target.ip, target.port);
    host = '127.0.0.1';
    port = throttle.address().port;
    console.log('throttling through proxy :' + port + ' (' + SIZE_MB + ' MB @ 8 MB/s)');
  }

  try {
    const rec = await sendPaths({
      host,
      port,
      self,
      paths: [file],
      peerName: target.name,
      peerId: target.id,
      onUpdate: (r) => {
        if (r.state !== 'active') console.log('  state:', r.state, r.error || '');
      },
    });
    console.log('RESULT:', rec.state, `${(rec.totalBytes / 1024 / 1024).toFixed(0)} MB`);
  } catch (err) {
    console.log('RESULT: rejected/failed —', err.message);
  }
  d.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 300);
}

main();
