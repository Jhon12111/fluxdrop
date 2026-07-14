'use strict';
/*
 * FluxDrop core — LAN device discovery (UDP broadcast) and
 * high-speed file transfer (raw TCP stream, length-prefixed JSON control frames).
 * No Electron dependencies: testable with plain Node.
 */
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DISCOVERY_PORT = 52130;
const DEFAULT_TRANSFER_PORT = 52131;
const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 2000;
const DEVICE_TTL_MS = 7000;
const READ_CHUNK = 4 * 1024 * 1024; // 4 MB read chunks for throughput
const SOCKET_TIMEOUT_MS = 45000;

/* ---------------------------------------------------------------- helpers */

function localIPv4Interfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push(info);
      }
    }
  }
  return out;
}

function broadcastAddresses() {
  const addrs = new Set(['255.255.255.255']);
  for (const info of localIPv4Interfaces()) {
    const ip = info.address.split('.').map(Number);
    const mask = info.netmask.split('.').map(Number);
    const bcast = ip.map((oct, i) => (oct & mask[i]) | (~mask[i] & 255));
    addrs.add(bcast.join('.'));
  }
  return [...addrs];
}

function primaryLocalIP() {
  const ifaces = localIPv4Interfaces();
  return ifaces.length ? ifaces[0].address : '127.0.0.1';
}

/** Encode a control frame: 4-byte BE length + JSON. */
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Incremental parser for length-prefixed JSON frames mixed into a stream. */
class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  }
  /** Try to read one frame. Returns object or null. */
  next() {
    if (this.buf.length < 4) return null;
    const len = this.buf.readUInt32BE(0);
    if (len > 16 * 1024 * 1024) throw new Error('control frame too large');
    if (this.buf.length < 4 + len) return null;
    const body = this.buf.subarray(4, 4 + len);
    this.buf = this.buf.subarray(4 + len);
    return JSON.parse(body.toString('utf8'));
  }
  /** Pull up to n raw bytes (for payload phase). */
  takeRaw(n) {
    if (this.buf.length === 0) return null;
    const take = this.buf.subarray(0, Math.min(n, this.buf.length));
    this.buf = this.buf.subarray(take.length);
    return take;
  }
}

function sanitizeRelPath(rel) {
  const norm = String(rel).replace(/\\/g, '/');
  if (!norm || path.isAbsolute(norm)) return null;
  const parts = norm.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  // strip characters invalid in Windows file names + control chars
  const cleaned = parts.map((p) => Array.from(p).filter((ch) => ch.codePointAt(0) >= 32).join('').replace(/[<>:"|?*]/g, '_'));
  return cleaned.join('/');
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Find a non-existing sibling name: "name", "name (1)", "name (2)" ... */
function uniqueName(baseDir, name) {
  let candidate = name;
  let i = 1;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  while (fs.existsSync(path.join(baseDir, candidate))) {
    candidate = `${stem} (${i})${ext}`;
    i += 1;
  }
  return candidate;
}

/* -------------------------------------------------------------- discovery */

/**
 * Presence on the LAN. Broadcasts a heartbeat and tracks peers.
 * emits: 'update' (devices array), 'error'
 */
class Discovery extends EventEmitter {
  /** self: { id, name, platform, transferPort } */
  constructor(self) {
    super();
    this.self = self;
    this.devices = new Map(); // id -> { id, name, platform, ip, port, lastSeen }
    this.sock = null;
    this.heartbeat = null;
    this.pruner = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;
      sock.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.bind(DISCOVERY_PORT, () => {
        try { sock.setBroadcast(true); } catch (_) {}
        this.heartbeat = setInterval(() => this.announce(), HEARTBEAT_MS);
        this.pruner = setInterval(() => this._prune(), 1500);
        this.announce();
        resolve();
      });
    });
  }

  _payload(type) {
    return Buffer.from(JSON.stringify({
      fluxdrop: PROTOCOL_VERSION,
      t: type,
      id: this.self.id,
      name: this.self.name,
      platform: this.self.platform,
      port: this.self.transferPort,
    }));
  }

  announce() {
    if (!this.sock) return;
    const payload = this._payload('hi');
    for (const addr of broadcastAddresses()) {
      this.sock.send(payload, DISCOVERY_PORT, addr, () => {});
    }
  }

  _onMessage(msg, rinfo) {
    let data;
    try { data = JSON.parse(msg.toString('utf8')); } catch (_) { return; }
    if (!data || data.fluxdrop !== PROTOCOL_VERSION || !data.id) return;
    if (data.id === this.self.id) return;

    if (data.t === 'bye') {
      if (this.devices.delete(data.id)) this._emitUpdate();
      return;
    }
    const known = this.devices.get(data.id);
    this.devices.set(data.id, {
      id: data.id,
      name: String(data.name || 'Unknown').slice(0, 64),
      platform: String(data.platform || 'unknown'),
      ip: rinfo.address,
      port: Number(data.port) || DEFAULT_TRANSFER_PORT,
      lastSeen: Date.now(),
    });
    if (!known) {
      // reply directly so the new peer learns about us immediately
      this.sock.send(this._payload('hi'), DISCOVERY_PORT, rinfo.address, () => {});
    }
    this._emitUpdate();
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, dev] of this.devices) {
      if (now - dev.lastSeen > DEVICE_TTL_MS) {
        this.devices.delete(id);
        changed = true;
      }
    }
    if (changed) this._emitUpdate();
  }

  _emitUpdate() {
    this.emit('update', [...this.devices.values()]);
  }

  updateSelf(patch) {
    Object.assign(this.self, patch);
    this.announce();
  }

  stop() {
    clearInterval(this.heartbeat);
    clearInterval(this.pruner);
    if (this.sock) {
      try {
        const bye = this._payload('bye');
        for (const addr of broadcastAddresses()) {
          this.sock.send(bye, DISCOVERY_PORT, addr, () => {});
        }
      } catch (_) {}
      const sock = this.sock;
      this.sock = null;
      setTimeout(() => { try { sock.close(); } catch (_) {} }, 150);
    }
  }
}

/* --------------------------------------------------------------- receiver */

/**
 * Listens for incoming transfers and writes files into downloadDir.
 * emits: 'transfer' (record snapshot), 'error'
 * Record: { id, direction:'recv', peerName, peerId, fileCount, totalBytes,
 *           bytes, state, label, error }
 */
class TransferServer extends EventEmitter {
  /** opts: { getDownloadDir: () => string, selfId: string } */
  constructor(opts) {
    super();
    this.opts = opts;
    this.server = null;
    this.port = null;
  }

  start(preferredPort = DEFAULT_TRANSFER_PORT) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._handle(socket));
      this.server = server;
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && this.port === null) {
          server.listen(0); // fall back to an ephemeral port
        } else {
          this.emit('error', err);
          reject(err);
        }
      });
      server.on('listening', () => {
        this.port = server.address().port;
        resolve(this.port);
      });
      server.listen(preferredPort);
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch (_) {} }
  }

  _handle(socket) {
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    const reader = new FrameReader();
    const state = {
      phase: 'offer',
      record: null,
      manifest: null,
      fileIdx: -1,
      fileRemaining: 0,
      ws: null,
      rootMap: new Map(), // original top-level segment -> resolved unique name
      destBase: null,
      lastEmit: 0,
      currentPartial: null,
      pumping: false,
    };

    const fail = (err) => {
      if (state.ws) { try { state.ws.destroy(); } catch (_) {} }
      if (state.currentPartial) { fs.promises.unlink(state.currentPartial).catch(() => {}); }
      if (state.record && state.record.state === 'active') {
        state.record.state = 'error';
        state.record.error = err.message;
        this.emit('transfer', { ...state.record });
      }
      try { socket.destroy(); } catch (_) {}
    };

    socket.on('timeout', () => fail(new Error('connection timed out')));
    socket.on('error', (err) => fail(err));

    socket.on('data', (chunk) => {
      reader.push(chunk);
      if (state.pumping) return; // async pump already running; it will see new data
      state.pumping = true;
      this._drain(socket, reader, state)
        .catch(fail)
        .finally(() => { state.pumping = false; });
    });
  }

  /** Resolve destination absolute path for a manifest rel path. */
  _resolveDest(state, rel) {
    const parts = rel.split('/');
    const top = parts[0];
    if (!state.rootMap.has(top)) {
      state.rootMap.set(top, uniqueName(state.destBase, top));
    }
    parts[0] = state.rootMap.get(top);
    return path.join(state.destBase, ...parts);
  }

  async _openNextFile(state) {
    // advance past zero-byte files, creating them as we go
    for (;;) {
      state.fileIdx += 1;
      if (state.fileIdx >= state.manifest.files.length) {
        return false; // all files done
      }
      const f = state.manifest.files[state.fileIdx];
      const dest = this._resolveDest(state, f.rel);
      await ensureDir(path.dirname(dest));
      if (f.size === 0) {
        await fs.promises.writeFile(dest, Buffer.alloc(0));
        continue;
      }
      state.ws = fs.createWriteStream(dest, { highWaterMark: READ_CHUNK });
      state.currentPartial = dest;
      state.fileRemaining = f.size;
      return true;
    }
  }

  async _drain(socket, reader, state) {
    for (;;) {
      if (state.phase === 'offer') {
        const offer = reader.next();
        if (!offer) return;
        if (offer.type !== 'offer' || !Array.isArray(offer.files)) {
          throw new Error('bad offer');
        }
        // validate manifest
        const files = [];
        let total = 0;
        for (const f of offer.files) {
          const rel = sanitizeRelPath(f.rel);
          const size = Number(f.size);
          if (rel === null || !Number.isFinite(size) || size < 0) {
            throw new Error('bad manifest entry');
          }
          files.push({ rel, size });
          total += size;
        }
        state.manifest = { files };
        state.destBase = this.opts.getDownloadDir();
        await ensureDir(state.destBase);
        state.record = {
          id: crypto.randomUUID(),
          direction: 'recv',
          peerName: String(offer.senderName || 'Unknown').slice(0, 64),
          peerId: String(offer.senderId || ''),
          fileCount: files.length,
          totalBytes: total,
          bytes: 0,
          state: 'active',
          label: files.length === 1
            ? path.basename(files[0].rel)
            : `${files.length} items`,
          startedAt: Date.now(),
        };
        this.emit('transfer', { ...state.record });
        socket.write(frame({ type: 'accept' }));
        const hasData = await this._openNextFile(state);
        state.phase = 'payload';
        if (!hasData) {
          await this._finish(socket, state);
          return;
        }
        continue;
      }

      if (state.phase === 'payload') {
        const raw = reader.takeRaw(state.fileRemaining);
        if (!raw) return;
        state.fileRemaining -= raw.length;
        state.record.bytes += raw.length;
        const ok = state.ws.write(raw);
        const now = Date.now();
        if (now - state.lastEmit > 150) {
          state.lastEmit = now;
          this.emit('transfer', { ...state.record });
        }
        if (state.fileRemaining === 0) {
          await new Promise((res, rej) => state.ws.end((e) => (e ? rej(e) : res())));
          state.ws = null;
          state.currentPartial = null;
          const more = await this._openNextFile(state);
          if (!more) {
            await this._finish(socket, state);
            return;
          }
        } else if (!ok) {
          socket.pause();
          await new Promise((res) => state.ws.once('drain', res));
          socket.resume();
        }
        continue;
      }

      return; // done phase: ignore anything else
    }
  }

  async _finish(socket, state) {
    state.phase = 'done';
    state.record.state = 'done';
    state.record.bytes = state.record.totalBytes;
    this.emit('transfer', { ...state.record });
    socket.write(frame({ type: 'done', received: state.record.bytes }));
    socket.end();
  }
}

/* ----------------------------------------------------------------- sender */

/** Recursively collect files under the given paths. */
async function collectEntries(paths) {
  const entries = [];
  let totalBytes = 0;

  async function walk(abs, rel) {
    const st = await fs.promises.stat(abs);
    if (st.isDirectory()) {
      const children = await fs.promises.readdir(abs);
      for (const child of children) {
        await walk(path.join(abs, child), `${rel}/${child}`);
      }
    } else if (st.isFile()) {
      entries.push({ abs, rel, size: st.size });
      totalBytes += st.size;
    }
  }

  for (const p of paths) {
    const abs = path.resolve(p);
    await walk(abs, path.basename(abs));
  }
  return { entries, totalBytes };
}

/**
 * Send files/folders to a peer.
 * opts: { host, port, self:{id,name}, paths, onUpdate(record),
 *         registry?:Map, transferId?, peerName?, peerId? }
 * Resolves with the final record; rejects on failure.
 */
async function sendPaths(opts) {
  const { host, port, self, paths, onUpdate } = opts;
  const { entries, totalBytes } = await collectEntries(paths);
  if (entries.length === 0) throw new Error('Nothing to send (empty selection)');

  const record = {
    id: opts.transferId || crypto.randomUUID(),
    direction: 'send',
    peerName: opts.peerName || host,
    peerId: opts.peerId || '',
    fileCount: entries.length,
    totalBytes,
    bytes: 0,
    state: 'active',
    label: entries.length === 1 && paths.length === 1
      ? path.basename(entries[0].rel)
      : `${entries.length} items`,
    startedAt: Date.now(),
  };
  const update = () => { if (onUpdate) onUpdate({ ...record }); };
  update();

  const socket = net.connect({ host, port, noDelay: false });
  socket.setTimeout(SOCKET_TIMEOUT_MS);

  let canceled = false;
  if (opts.registry) {
    opts.registry.set(record.id, {
      cancel() {
        canceled = true;
        socket.destroy(new Error('canceled'));
      },
    });
  }

  const reader = new FrameReader();
  let onFrame = null;
  socket.on('data', (chunk) => {
    reader.push(chunk);
    try {
      let f;
      while ((f = reader.next())) {
        if (onFrame) onFrame(f);
      }
    } catch (err) {
      socket.destroy(err);
    }
  });

  const waitFrame = (type) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), SOCKET_TIMEOUT_MS);
    onFrame = (f) => {
      if (f.type === type) { clearTimeout(to); onFrame = null; resolve(f); }
      else if (f.type === 'reject') { clearTimeout(to); reject(new Error('receiver rejected the transfer')); }
    };
    socket.once('error', (e) => { clearTimeout(to); reject(e); });
    socket.once('timeout', () => { clearTimeout(to); reject(new Error('connection timed out')); });
  });

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    socket.write(frame({
      type: 'offer',
      senderId: self.id,
      senderName: self.name,
      files: entries.map((e) => ({ rel: e.rel, size: e.size })),
      totalBytes,
    }));
    await waitFrame('accept');

    let lastEmit = 0;
    for (const entry of entries) {
      if (entry.size === 0) continue;
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(entry.abs, { highWaterMark: READ_CHUNK });
        const onErr = (e) => { rs.destroy(); reject(e); };
        socket.once('error', onErr);
        rs.on('error', onErr);
        rs.on('data', (chunk) => {
          record.bytes += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 150) { lastEmit = now; update(); }
          if (!socket.write(chunk)) {
            rs.pause();
            socket.once('drain', () => rs.resume());
          }
        });
        rs.on('end', () => { socket.removeListener('error', onErr); resolve(); });
      });
    }

    await waitFrame('done');
    record.state = 'done';
    record.bytes = totalBytes;
    update();
    socket.end();
    return record;
  } catch (err) {
    record.state = canceled ? 'canceled' : 'error';
    record.error = canceled ? 'Canceled' : err.message;
    update();
    try { socket.destroy(); } catch (_) {}
    if (canceled) return record;
    throw err;
  } finally {
    if (opts.registry) opts.registry.delete(record.id);
  }
}

module.exports = {
  DISCOVERY_PORT,
  DEFAULT_TRANSFER_PORT,
  Discovery,
  TransferServer,
  sendPaths,
  collectEntries,
  primaryLocalIP,
};
