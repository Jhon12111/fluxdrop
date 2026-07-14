'use strict';
/* End-to-end selftest for the FluxDrop core:
 *  1. spins up a TransferServer on localhost
 *  2. sends a folder tree (incl. one large random file) via sendPaths
 *  3. verifies every file arrived byte-identical (sha256)
 *  4. reports throughput
 *  5. quick loopback discovery check (non-fatal if firewall blocks UDP)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { TransferServer, sendPaths, Discovery } = require('../src/core');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxdrop-test-'));
const SRC = path.join(TMP, 'src');
const DST = path.join(TMP, 'dst');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeRandomFile(p, sizeMB) {
  const fd = fs.openSync(p, 'w');
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let written = 0;
  const total = sizeMB * 1024 * 1024;
  while (written < total) {
    crypto.randomFillSync(chunk);
    const n = Math.min(chunk.length, total - written);
    fs.writeSync(fd, chunk, 0, n);
    written += n;
  }
  fs.closeSync(fd);
}

async function main() {
  // build source tree
  const folder = path.join(SRC, 'Project Files');
  fs.mkdirSync(path.join(folder, 'nested', 'deep'), { recursive: true });
  makeRandomFile(path.join(folder, 'big-video.bin'), 256);
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'hello fluxdrop\n');
  fs.writeFileSync(path.join(folder, 'nested', 'a.txt'), 'nested file');
  fs.writeFileSync(path.join(folder, 'nested', 'deep', 'b.dat'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(folder, 'empty.txt'), '');
  const single = path.join(SRC, 'single file.pdf');
  makeRandomFile(single, 8);

  // receiver
  const server = new TransferServer({ getDownloadDir: () => DST, selfId: 'recv-1' });
  const port = await server.start(0);
  console.log('receiver listening on port', port);

  let lastRecv = null;
  server.on('transfer', (r) => { lastRecv = r; });

  // send folder + single file in one transfer
  const t0 = Date.now();
  const record = await sendPaths({
    host: '127.0.0.1',
    port,
    self: { id: 'send-1', name: 'Test Sender' },
    paths: [folder, single],
    onUpdate: () => {},
  });
  const secs = (Date.now() - t0) / 1000;
  const mb = record.totalBytes / 1024 / 1024;
  console.log(`sent ${record.fileCount} files, ${mb.toFixed(1)} MB in ${secs.toFixed(2)}s ` +
    `= ${(mb / secs).toFixed(0)} MB/s (${((mb * 8) / 1000 / secs).toFixed(2)} Gbps)`);

  if (record.state !== 'done') throw new Error('sender record not done: ' + record.state);
  // give receiver a beat to flush final event
  await new Promise((r) => setTimeout(r, 300));
  if (!lastRecv || lastRecv.state !== 'done') throw new Error('receiver record not done');

  // verify integrity
  const checks = [
    ['Project Files/big-video.bin'],
    ['Project Files/notes.txt'],
    ['Project Files/nested/a.txt'],
    ['Project Files/nested/deep/b.dat'],
    ['Project Files/empty.txt'],
    ['single file.pdf'],
  ];
  for (const [rel] of checks) {
    const srcFile = path.join(SRC, rel);
    const dstFile = path.join(DST, rel);
    if (!fs.existsSync(dstFile)) throw new Error('missing on receiver: ' + rel);
    const a = sha256(srcFile);
    const b = sha256(dstFile);
    if (a !== b) throw new Error('hash mismatch: ' + rel);
  }
  console.log('integrity check passed for', checks.length, 'files');

  // duplicate-name handling: send the single file again, expect " (1)" copy
  await sendPaths({
    host: '127.0.0.1',
    port,
    self: { id: 'send-1', name: 'Test Sender' },
    paths: [single],
    onUpdate: () => {},
  });
  await new Promise((r) => setTimeout(r, 200));
  if (!fs.existsSync(path.join(DST, 'single file (1).pdf'))) {
    throw new Error('duplicate rename failed');
  }
  console.log('duplicate-name handling passed');

  server.stop();

  // discovery loopback (best-effort)
  try {
    const d1 = new Discovery({ id: 'dev-a', name: 'Alpha', platform: 'windows', transferPort: 1111 });
    const d2 = new Discovery({ id: 'dev-b', name: 'Beta', platform: 'mac', transferPort: 2222 });
    await d1.start();
    await d2.start();
    const seen = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 5000);
      d1.on('update', (devs) => {
        if (devs.some((d) => d.id === 'dev-b')) { clearTimeout(to); resolve(true); }
      });
      d2.announce();
    });
    d1.stop(); d2.stop();
    console.log(seen ? 'discovery loopback passed' : 'discovery loopback NOT seen (firewall may block UDP broadcast — check on real LAN)');
  } catch (err) {
    console.log('discovery check skipped:', err.message);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('SELFTEST PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SELFTEST FAILED:', err);
  process.exit(1);
});
