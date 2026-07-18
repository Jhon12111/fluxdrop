'use strict';
/* Verifies the completion path over a SLOW, LATENT link — the condition that
 * exposed `write ECONNRESET` on real Wi-Fi but not on loopback.
 *
 * A local TCP proxy sits between sender and receiver, adding latency and a
 * bandwidth cap, and (crucially) staggering when each parallel stream drains —
 * which widens the finish-race window. The transfer must still complete with a
 * byte-identical file and no unhandled error.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { TransferServer, sendPaths } = require('../src/core');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxdrop-slow-'));
const SRC = path.join(TMP, 'src');
const DST = path.join(TMP, 'dst');
fs.mkdirSync(SRC, { recursive: true });

const LATENCY_MS = 25;         // one-way delay per direction
const RATE_BPS = 12 * 1024 * 1024; // ~12 MB/s, like a 100 Mbit link

let unhandled = null;
process.on('uncaughtException', (e) => { unhandled = e; });
process.on('unhandledRejection', (e) => { unhandled = e; });

function makeFile(p, mb) {
  const fd = fs.openSync(p, 'w');
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  const total = mb * 1024 * 1024;
  let w = 0;
  while (w < total) {
    crypto.randomFillSync(chunk);
    const n = Math.min(chunk.length, total - w);
    fs.writeSync(fd, chunk, 0, n);
    w += n;
  }
  fs.closeSync(fd);
  return total;
}

/** A throttled, delayed pipe. Random per-connection jitter staggers streams. */
function throttledPipe(from, to) {
  let budget = 0;
  let last = Date.now();
  const jitter = Math.random() * 20;
  from.on('data', (chunk) => {
    from.pause();
    const now = Date.now();
    budget += ((now - last) / 1000) * RATE_BPS;
    last = now;
    const need = chunk.length;
    const waitForBudget = budget >= need ? 0 : ((need - budget) / RATE_BPS) * 1000;
    setTimeout(() => {
      budget -= need;
      if (!to.destroyed) to.write(chunk);
      from.resume();
    }, LATENCY_MS + waitForBudget + jitter);
  });
  from.on('end', () => setTimeout(() => { try { to.end(); } catch (_) {} }, LATENCY_MS + 5));
  from.on('error', () => { try { to.destroy(); } catch (_) {} });
}

function startProxy(targetPort) {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
      upstream.on('connect', () => { throttledPipe(client, upstream); throttledPipe(upstream, client); });
      upstream.on('error', () => { try { client.destroy(); } catch (_) {} });
      client.on('error', () => { try { upstream.destroy(); } catch (_) {} });
    });
    server.listen(0, () => resolve(server));
  });
}

function hashFile(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

async function main() {
  const file = path.join(SRC, 'Wedding 4K.mov');
  const total = makeFile(file, 200); // 200 MB is plenty to spread the finish

  const server = new TransferServer({ getDownloadDir: () => DST, shouldAccept: async () => true });
  const realPort = await server.start(0);
  const proxy = await startProxy(realPort);
  const proxyPort = proxy.address().port;
  console.log(`slow link: ${(RATE_BPS / 1024 / 1024).toFixed(0)} MB/s, ${LATENCY_MS}ms latency, via proxy :${proxyPort}`);

  const t0 = Date.now();
  const rec = await sendPaths({
    host: '127.0.0.1', port: proxyPort,
    self: { id: 'mac-1', name: 'MacBook' },
    paths: [file], onUpdate: () => {},
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`state=${rec.state}, ${(total / 1024 / 1024).toFixed(0)} MB in ${secs.toFixed(1)}s = ${(total / 1024 / 1024 / secs).toFixed(0)} MB/s`);

  if (rec.state !== 'done') throw new Error('transfer did not complete: ' + rec.state + ' ' + (rec.error || ''));

  await new Promise((r) => setTimeout(r, 500));
  const dst = path.join(DST, 'Wedding 4K.mov');
  if (fs.statSync(dst).size !== total) throw new Error('size mismatch');
  if ((await hashFile(file)) !== (await hashFile(dst))) throw new Error('hash mismatch');
  if (unhandled) throw new Error('unhandled error during transfer: ' + unhandled.message);

  server.stop();
  proxy.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('SLOWLINK TEST PASSED — completion clean over a throttled, latent link');
  process.exit(0);
}

main().catch((err) => {
  console.error('SLOWLINK TEST FAILED:', err.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
