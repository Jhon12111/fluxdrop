'use strict';
/* Manual harness: pretends to be another computer on the LAN and sends a file
 * to the running FluxDrop app, so the approval UI can be exercised.
 * Usage: node test/fakepeer.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Discovery, sendPaths } = require('../src/core');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxdrop-peer-'));
const file = path.join(TMP, 'Wedding Highlight 4K.mov');
const fd = fs.openSync(file, 'w');
const buf = Buffer.alloc(8 * 1024 * 1024);
for (let i = 0; i < 15; i++) { crypto.randomFillSync(buf); fs.writeSync(fd, buf); }
fs.closeSync(fd);

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

  try {
    const rec = await sendPaths({
      host: target.ip,
      port: target.port,
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
