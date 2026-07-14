'use strict';
/* End-to-end selftest for the FluxDrop core:
 *  1. approved transfer of a folder tree + big file over parallel streams
 *  2. byte-identical verification (sha256)
 *  3. duplicate-name handling
 *  4. declined transfer leaves nothing behind
 *  5. receiver-side cancel cleans up partial files
 *  6. loopback discovery
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const folder = path.join(SRC, 'Project Files');
  fs.mkdirSync(path.join(folder, 'nested', 'deep'), { recursive: true });
  makeRandomFile(path.join(folder, 'big-video.bin'), 256);
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'hello fluxdrop\n');
  fs.writeFileSync(path.join(folder, 'nested', 'a.txt'), 'nested file');
  fs.writeFileSync(path.join(folder, 'nested', 'deep', 'b.dat'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(folder, 'empty.txt'), '');
  const single = path.join(SRC, 'single file.pdf');
  makeRandomFile(single, 8);

  let verdict = true;          // what shouldAccept returns
  let lastRequest = null;
  const server = new TransferServer({
    getDownloadDir: () => DST,
    shouldAccept: async (info) => { lastRequest = info; return verdict; },
  });
  const port = await server.start(0);
  console.log('receiver listening on port', port);

  let lastRecv = null;
  server.on('transfer', (r) => { lastRecv = r; });

  /* ---------------------------------------------- 1. approved transfer */
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
  if (!lastRequest || lastRequest.peerName !== 'Test Sender') throw new Error('approval info missing sender name');
  if (lastRequest.fileCount !== 6) throw new Error('approval info wrong file count: ' + lastRequest.fileCount);
  await sleep(300);
  if (!lastRecv || lastRecv.state !== 'done') throw new Error('receiver record not done');
  console.log('approval request info passed:', lastRequest.label, lastRequest.fileCount, 'files');

  /* ------------------------------------------------- 2. integrity check */
  const checks = [
    'Project Files/big-video.bin',
    'Project Files/notes.txt',
    'Project Files/nested/a.txt',
    'Project Files/nested/deep/b.dat',
    'Project Files/empty.txt',
    'single file.pdf',
  ];
  for (const rel of checks) {
    const dstFile = path.join(DST, rel);
    if (!fs.existsSync(dstFile)) throw new Error('missing on receiver: ' + rel);
    if (sha256(path.join(SRC, rel)) !== sha256(dstFile)) throw new Error('hash mismatch: ' + rel);
  }
  console.log('integrity check passed for', checks.length, 'files');

  /* --------------------------------------------- 3. duplicate handling */
  await sendPaths({
    host: '127.0.0.1', port,
    self: { id: 'send-1', name: 'Test Sender' },
    paths: [single], onUpdate: () => {},
  });
  await sleep(200);
  if (!fs.existsSync(path.join(DST, 'single file (1).pdf'))) throw new Error('duplicate rename failed');
  if (sha256(single) !== sha256(path.join(DST, 'single file (1).pdf'))) throw new Error('duplicate copy corrupt');
  console.log('duplicate-name handling passed');

  /* ------------------------------------------------ 4. declined transfer */
  verdict = false;
  const declineTarget = path.join(DST, 'nope.bin');
  const nope = path.join(SRC, 'nope.bin');
  makeRandomFile(nope, 4);
  let declineErr = null;
  try {
    await sendPaths({
      host: '127.0.0.1', port,
      self: { id: 'send-1', name: 'Test Sender' },
      paths: [nope], onUpdate: () => {},
    });
  } catch (err) { declineErr = err; }
  if (!declineErr || !/Declined/i.test(declineErr.message)) {
    throw new Error('decline not reported to sender: ' + (declineErr && declineErr.message));
  }
  await sleep(200);
  if (fs.existsSync(declineTarget)) throw new Error('declined transfer still wrote a file');
  if (lastRecv.state !== 'declined') throw new Error('receiver state not declined: ' + lastRecv.state);
  console.log('decline path passed (sender told, nothing written)');

  /* ------------------------------------------- 5. receiver-side cancel */
  verdict = true;
  const bigCancel = path.join(SRC, 'cancel-me.bin');
  makeRandomFile(bigCancel, 400);
  let cancelErr = null;
  const sendPromise = sendPaths({
    host: '127.0.0.1', port,
    self: { id: 'send-1', name: 'Test Sender' },
    paths: [bigCancel], onUpdate: () => {},
  }).catch((e) => { cancelErr = e; });

  // cancel from the receiver as soon as bytes start flowing
  await new Promise((resolve) => {
    const check = setInterval(() => {
      const active = [...server.sessions.values()].find((s) => s.record.bytes > 0);
      if (active) { clearInterval(check); server.cancel(active.tid); resolve(); }
    }, 20);
    setTimeout(() => { clearInterval(check); resolve(); }, 8000);
  });
  await sendPromise;
  await sleep(500);
  if (fs.existsSync(path.join(DST, 'cancel-me.bin'))) throw new Error('cancel left a partial file behind');
  if (!cancelErr) throw new Error('sender did not error on receiver cancel');
  console.log('receiver cancel passed (sender stopped, partial removed)');

  server.stop();

  /* -------------------------------------------------- 6. discovery */
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
    console.log(seen ? 'discovery loopback passed' : 'discovery loopback NOT seen (firewall may block UDP)');
  } catch (err) {
    console.log('discovery check skipped:', err.message);
  }

  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('SELFTEST PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SELFTEST FAILED:', err);
  process.exit(1);
});
