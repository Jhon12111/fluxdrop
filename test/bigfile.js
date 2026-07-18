'use strict';
/* Reproduction harness: transfer one large file through the real core and
 * report result + peak memory. Usage: node test/bigfile.js [sizeGB] */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { TransferServer, sendPaths } = require('../src/core');

const SIZE_GB = Number(process.argv[2] || 3);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxdrop-big-'));
const SRC = path.join(TMP, 'src');
const DST = path.join(TMP, 'dst');
fs.mkdirSync(SRC, { recursive: true });

const file = path.join(SRC, 'Big Project.mov');

function makeFile(p, gb) {
  const fd = fs.openSync(p, 'w');
  const chunk = Buffer.alloc(16 * 1024 * 1024);
  crypto.randomFillSync(chunk);
  const total = Math.round(gb * 1024 * 1024 * 1024);
  let w = 0;
  while (w < total) {
    // vary the first bytes so blocks are not identical
    chunk.writeDoubleLE(w, 0);
    const n = Math.min(chunk.length, total - w);
    fs.writeSync(fd, chunk, 0, n);
    w += n;
  }
  fs.closeSync(fd);
  return total;
}

function hashFile(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p, { highWaterMark: 8 * 1024 * 1024 })
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

async function main() {
  console.log(`creating ${SIZE_GB} GB test file...`);
  const total = makeFile(file, SIZE_GB);
  console.log('source size:', total, 'bytes');

  let peakRss = 0;
  const mem = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 200);

  const server = new TransferServer({
    getDownloadDir: () => DST,
    shouldAccept: async () => true,
  });
  const port = await server.start(0);

  let recvState = null;
  server.on('transfer', (r) => { recvState = r; });

  const t0 = Date.now();
  let result;
  try {
    result = await sendPaths({
      host: '127.0.0.1', port,
      self: { id: 'big-sender', name: 'Mac Sender' },
      paths: [file],
      onUpdate: () => {},
    });
  } catch (err) {
    clearInterval(mem);
    console.error('TRANSFER FAILED:', err.message);
    console.error('receiver last state:', recvState && recvState.state, recvState && recvState.error);
    process.exit(1);
  }
  clearInterval(mem);

  const secs = (Date.now() - t0) / 1000;
  const mb = total / 1024 / 1024;
  console.log(`state=${result.state} ${mb.toFixed(0)} MB in ${secs.toFixed(1)}s = ${(mb / secs).toFixed(0)} MB/s`);
  console.log('peak RSS:', (peakRss / 1024 / 1024).toFixed(0), 'MB');

  const dst = path.join(DST, 'Big Project.mov');
  if (!fs.existsSync(dst)) throw new Error('destination file missing');
  const dstSize = fs.statSync(dst).size;
  console.log('dest size:', dstSize, dstSize === total ? '(match)' : '(MISMATCH!)');
  if (dstSize !== total) throw new Error('size mismatch');

  console.log('hashing both files...');
  const [a, b] = await Promise.all([hashFile(file), hashFile(dst)]);
  if (a !== b) throw new Error('HASH MISMATCH — data corrupted');
  console.log('sha256 match — file intact');

  server.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('BIGFILE TEST PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('BIGFILE TEST FAILED:', err.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
