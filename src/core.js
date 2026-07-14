'use strict';
/*
 * FluxDrop core — LAN device discovery (UDP broadcast) and
 * high-speed file transfer over multiple parallel TCP streams.
 *
 * Transfer protocol (v2):
 *   control socket:  offer -> accept|reject -> (chunk headers + payload) -> done
 *   data sockets:    join  -> (chunk headers + payload)
 *
 * Every file is split into fixed-size chunks that are pulled from one shared
 * work queue by all streams, so a single large file parallelises just as well
 * as many small ones. The receiver writes each chunk at its absolute offset.
 *
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
const READ_CHUNK = 512 * 1024;          // socket/disk read granularity
const CHUNK_SIZE = 8 * 1024 * 1024;     // work-queue chunk size
const STREAMS = 4;                      // parallel TCP connections
const SOCKET_TIMEOUT_MS = 60000;
const APPROVAL_TIMEOUT_MS = 120000;

/* ---------------------------------------------------------------- helpers */

function localIPv4Interfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info);
    }
  }
  return out;
}

function broadcastAddresses() {
  const addrs = new Set(['255.255.255.255']);
  for (const info of localIPv4Interfaces()) {
    const ip = info.address.split('.').map(Number);
    const mask = info.netmask.split('.').map(Number);
    addrs.add(ip.map((oct, i) => (oct & mask[i]) | (~mask[i] & 255)).join('.'));
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

/**
 * Incremental reader over a chunk queue. Never concatenates the whole
 * backlog, so the payload path stays zero-copy even at multi-Gbps.
 */
class FrameReader {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
  _peek(n) {
    if (this.length < n) return null;
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    const buf = Buffer.allocUnsafe(n);
    let off = 0;
    for (const c of this.chunks) {
      const take = Math.min(c.length, n - off);
      c.copy(buf, off, 0, take);
      off += take;
      if (off === n) break;
    }
    return buf;
  }
  _consume(n) {
    let left = n;
    while (left > 0) {
      const c = this.chunks[0];
      if (c.length <= left) {
        this.chunks.shift();
        left -= c.length;
        this.length -= c.length;
      } else {
        this.chunks[0] = c.subarray(left);
        this.length -= left;
        left = 0;
      }
    }
  }
  /** Try to read one JSON frame. Returns object or null. */
  next() {
    const head = this._peek(4);
    if (!head) return null;
    const len = head.readUInt32BE(0);
    if (len > 16 * 1024 * 1024) throw new Error('control frame too large');
    if (this.length < 4 + len) return null;
    this._consume(4);
    const body = this._peek(len);
    this._consume(len);
    return JSON.parse(body.toString('utf8'));
  }
  /** Pull up to n raw bytes without copying. */
  takeRaw(n) {
    if (this.length === 0 || n === 0) return null;
    const c = this.chunks[0];
    if (c.length <= n) {
      this.chunks.shift();
      this.length -= c.length;
      return c;
    }
    const take = c.subarray(0, n);
    this.chunks[0] = c.subarray(n);
    this.length -= n;
    return take;
  }
}

function sanitizeRelPath(rel) {
  const norm = String(rel).replace(/\\/g, '/');
  if (!norm || path.isAbsolute(norm)) return null;
  const parts = norm.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  const cleaned = parts.map((p) => Array.from(p)
    .filter((ch) => ch.codePointAt(0) >= 32)
    .join('')
    .replace(/[<>:"|?*]/g, '_'));
  if (cleaned.some((p) => p === '')) return null;
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

function labelFor(files) {
  return files.length === 1 ? path.basename(files[0].rel) : `${files.length} items`;
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
    this.devices = new Map();
    this.sock = null;
    this.heartbeat = null;
    this.pruner = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;
      sock.on('error', (err) => { this.emit('error', err); reject(err); });
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
    if (!this.sock) return; // already stopped; ignore in-flight datagrams
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
    if (!known) this.sock.send(this._payload('hi'), DISCOVERY_PORT, rinfo.address, () => {});
    this._emitUpdate();
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, dev] of this.devices) {
      if (now - dev.lastSeen > DEVICE_TTL_MS) { this.devices.delete(id); changed = true; }
    }
    if (changed) this._emitUpdate();
  }

  _emitUpdate() { this.emit('update', [...this.devices.values()]); }

  updateSelf(patch) { Object.assign(this.self, patch); this.announce(); }

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
 * Listens for incoming transfers.
 * opts: {
 *   getDownloadDir: () => string,
 *   shouldAccept: async ({ id, peerName, peerId, ip, fileCount, totalBytes, label }) => boolean,
 * }
 * emits: 'transfer' (record snapshot), 'request' (pending info), 'error'
 */
class TransferServer extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.server = null;
    this.port = null;
    this.sessions = new Map(); // tid -> session
  }

  start(preferredPort = DEFAULT_TRANSFER_PORT) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._handle(socket));
      this.server = server;
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && this.port === null) server.listen(0);
        else { this.emit('error', err); reject(err); }
      });
      server.on('listening', () => { this.port = server.address().port; resolve(this.port); });
      server.listen(preferredPort);
    });
  }

  stop() {
    for (const s of this.sessions.values()) s.destroy(new Error('server stopped'));
    if (this.server) { try { this.server.close(); } catch (_) {} }
  }

  /** Cancel an in-flight incoming transfer. */
  cancel(tid) {
    const s = this.sessions.get(tid);
    if (!s) return false;
    s.cancel();
    return true;
  }

  _handle(socket) {
    socket.setNoDelay(true);
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    const reader = new FrameReader();
    let session = null;
    let bound = false;

    const onFail = (err) => {
      if (session) session.socketFailed(socket, err);
      else { try { socket.destroy(); } catch (_) {} }
    };

    socket.on('timeout', () => onFail(new Error('connection timed out')));
    socket.on('error', onFail);
    socket.on('close', () => { if (session) session.socketClosed(socket); });

    const pump = () => {
      if (!session) return;
      session.pump(socket);
    };

    socket.on('data', (chunk) => {
      reader.push(chunk);
      if (bound) { pump(); return; }
      // first frame decides what this socket is
      let first;
      try { first = reader.next(); } catch (err) { return onFail(err); }
      if (!first) return;
      bound = true;
      if (first.type === 'offer') {
        this._startSession(socket, reader, first).then((s) => {
          session = s;
          if (s) s.pump(socket);
        }).catch(onFail);
      } else if (first.type === 'join') {
        const s = this.sessions.get(first.tid);
        if (!s || !s.accepted) return onFail(new Error('unknown transfer'));
        session = s;
        s.attach(socket, reader);
        s.pump(socket);
      } else {
        onFail(new Error('bad handshake'));
      }
    });
  }

  async _startSession(socket, reader, offer) {
    if (!Array.isArray(offer.files)) throw new Error('bad offer');
    const files = [];
    let total = 0;
    for (const f of offer.files) {
      const rel = sanitizeRelPath(f.rel);
      const size = Number(f.size);
      if (rel === null || !Number.isFinite(size) || size < 0) throw new Error('bad manifest entry');
      files.push({ rel, size, received: 0, fh: null, dest: null, opening: null });
      total += size;
    }

    const tid = String(offer.tid || crypto.randomUUID());
    const session = new RecvSession(this, tid, socket, reader, files, total, offer);
    this.sessions.set(tid, session);

    socket.pause();
    const info = {
      id: tid,
      peerName: session.record.peerName,
      peerId: session.record.peerId,
      ip: socket.remoteAddress ? socket.remoteAddress.replace(/^::ffff:/, '') : '',
      fileCount: files.length,
      totalBytes: total,
      label: session.record.label,
    };
    this.emit('request', info);

    let approved = false;
    try {
      approved = await Promise.race([
        Promise.resolve(this.opts.shouldAccept ? this.opts.shouldAccept(info) : true),
        new Promise((res) => setTimeout(() => res(false), APPROVAL_TIMEOUT_MS)),
      ]);
    } catch (_) {
      approved = false;
    }

    if (session.destroyed) return null;
    if (!approved) {
      try { socket.write(frame({ type: 'reject' })); socket.end(); } catch (_) {}
      this.sessions.delete(tid);
      session.record.state = 'declined';
      session.record.error = 'Declined';
      this.emit('transfer', { ...session.record });
      return null;
    }

    await session.prepare();
    if (session.destroyed) return null;
    session.accepted = true;
    socket.write(frame({ type: 'accept', tid, streams: STREAMS }));
    socket.resume();
    this.emit('transfer', { ...session.record });
    return session;
  }
}

/** One incoming transfer, spread over several sockets. */
class RecvSession {
  constructor(server, tid, controlSocket, reader, files, totalBytes, offer) {
    this.server = server;
    this.tid = tid;
    this.controlSocket = controlSocket;
    this.files = files;
    this.totalBytes = totalBytes;
    this.accepted = false;
    this.destroyed = false;
    this.finished = false;
    this.rootMap = new Map();
    this.destBase = null;
    this.lastEmit = 0;
    this.sockets = new Map(); // socket -> { reader, state }
    this.sockets.set(controlSocket, { reader, state: { phase: 'header' } });

    this.record = {
      id: tid,
      direction: 'recv',
      peerName: String(offer.senderName || 'Unknown').slice(0, 64),
      peerId: String(offer.senderId || ''),
      fileCount: files.length,
      totalBytes,
      bytes: 0,
      state: 'active',
      label: labelFor(files),
      startedAt: Date.now(),
    };
  }

  attach(socket, reader) {
    this.sockets.set(socket, { reader, state: { phase: 'header' } });
  }

  _resolveDest(rel) {
    const parts = rel.split('/');
    const top = parts[0];
    if (!this.rootMap.has(top)) this.rootMap.set(top, uniqueName(this.destBase, top));
    parts[0] = this.rootMap.get(top);
    return path.join(this.destBase, ...parts);
  }

  /** Reserve destination names and create empty files/dirs up front. */
  async prepare() {
    this.destBase = this.server.opts.getDownloadDir();
    await ensureDir(this.destBase);
    for (const f of this.files) {
      f.dest = this._resolveDest(f.rel);
      await ensureDir(path.dirname(f.dest));
      if (f.size === 0) await fs.promises.writeFile(f.dest, Buffer.alloc(0));
    }
  }

  async _fhFor(file) {
    if (file.fh) return file.fh;
    if (!file.opening) {
      file.opening = fs.promises.open(file.dest, 'w').then((fh) => { file.fh = fh; return fh; });
    }
    return file.opening;
  }

  pump(socket) {
    const entry = this.sockets.get(socket);
    if (!entry || entry.pumping) { if (entry) entry.pending = true; return; }
    entry.pumping = true;
    this._drain(socket, entry)
      .catch((err) => this.socketFailed(socket, err))
      .finally(() => {
        entry.pumping = false;
        if (entry.pending) { entry.pending = false; this.pump(socket); }
      });
  }

  async _drain(socket, entry) {
    const { reader, state } = entry;
    for (;;) {
      if (this.destroyed) return;

      if (state.phase === 'header') {
        const f = reader.next();
        if (!f) return;
        if (f.type === 'end') { state.phase = 'ended'; continue; }
        if (f.type !== 'chunk') throw new Error('bad frame: ' + f.type);
        const file = this.files[f.idx];
        if (!file) throw new Error('bad chunk index');
        const len = Number(f.length);
        const off = Number(f.offset);
        if (!Number.isFinite(len) || !Number.isFinite(off) || len < 0
            || off < 0 || off + len > file.size) {
          throw new Error('bad chunk range');
        }
        state.file = file;
        state.pos = off;
        state.remaining = len;
        state.phase = 'payload';
        continue;
      }

      if (state.phase === 'payload') {
        const raw = reader.takeRaw(state.remaining);
        if (!raw) return;
        const fh = await this._fhFor(state.file);
        if (this.destroyed) return;
        socket.pause();
        await fh.write(raw, 0, raw.length, state.pos);
        socket.resume();
        state.pos += raw.length;
        state.remaining -= raw.length;
        state.file.received += raw.length;
        this.record.bytes += raw.length;
        const now = Date.now();
        if (now - this.lastEmit > 150) {
          this.lastEmit = now;
          this.server.emit('transfer', { ...this.record });
        }
        if (state.remaining === 0) state.phase = 'header';
        if (this.record.bytes >= this.totalBytes) { await this._finish(); return; }
        continue;
      }

      return; // 'ended' — nothing more expected on this socket
    }
  }

  async _finish() {
    if (this.finished) return;
    this.finished = true;
    for (const f of this.files) {
      if (f.fh) { try { await f.fh.close(); } catch (_) {} f.fh = null; }
    }
    this.record.state = 'done';
    this.record.bytes = this.totalBytes;
    this.server.emit('transfer', { ...this.record });
    try { this.controlSocket.write(frame({ type: 'done', received: this.record.bytes })); } catch (_) {}
    for (const s of this.sockets.keys()) { try { s.end(); } catch (_) {} }
    this.server.sessions.delete(this.tid);
  }

  socketClosed(socket) {
    this.sockets.delete(socket);
    if (!this.finished && !this.destroyed && this.sockets.size === 0) {
      this.destroy(new Error('sender disconnected'));
    }
  }

  socketFailed(socket, err) {
    if (this.finished) return;
    this.destroy(err);
  }

  cancel() { this.destroy(new Error('canceled'), 'canceled'); }

  destroy(err, stateName = 'error') {
    if (this.destroyed || this.finished) return;
    this.destroyed = true;
    this.server.sessions.delete(this.tid);
    for (const s of this.sockets.keys()) { try { s.destroy(); } catch (_) {} }
    this.sockets.clear();
    // close handles, then remove the partial files we created
    (async () => {
      for (const f of this.files) {
        if (f.fh) { try { await f.fh.close(); } catch (_) {} f.fh = null; }
      }
      for (const f of this.files) {
        if (f.dest) { try { await fs.promises.unlink(f.dest); } catch (_) {} }
      }
      for (const top of this.rootMap.values()) {
        try { await fs.promises.rm(path.join(this.destBase, top), { recursive: true, force: true }); } catch (_) {}
      }
    })();
    if (this.record.state === 'active') {
      this.record.state = stateName;
      this.record.error = stateName === 'canceled' ? 'Canceled' : err.message;
      this.server.emit('transfer', { ...this.record });
    }
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
      for (const child of await fs.promises.readdir(abs)) {
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

function connectSocket(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setNoDelay(true);
    s.setTimeout(SOCKET_TIMEOUT_MS);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Read one JSON frame from a socket that is not yet streaming payload. */
function readFrame(socket, reader, types, timeoutMs = APPROVAL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(to);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
    };
    const to = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for response')); }, timeoutMs);
    const onErr = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('connection closed')); };
    const tryParse = () => {
      let f;
      try { f = reader.next(); } catch (e) { cleanup(); reject(e); return; }
      if (!f) return;
      cleanup();
      if (types.includes(f.type)) resolve(f);
      else reject(new Error('unexpected frame: ' + f.type));
    };
    const onData = (chunk) => { reader.push(chunk); tryParse(); };
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
    tryParse(); // data may already be buffered
  });
}

/** Stream a byte range of a file into a socket, honouring backpressure. */
function streamRange(socket, abs, offset, length) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(abs, {
      start: offset,
      end: offset + length - 1,
      highWaterMark: READ_CHUNK,
    });
    let sent = 0;
    const onSockErr = (e) => { rs.destroy(); reject(e); };
    socket.once('error', onSockErr);
    rs.on('error', (e) => { socket.removeListener('error', onSockErr); reject(e); });
    rs.on('data', (chunk) => {
      sent += chunk.length;
      if (!socket.write(chunk)) {
        rs.pause();
        socket.once('drain', () => rs.resume());
      }
    });
    rs.on('end', () => {
      socket.removeListener('error', onSockErr);
      if (sent !== length) reject(new Error('short read on ' + abs));
      else resolve();
    });
  });
}

/**
 * Send files/folders to a peer over parallel streams.
 * opts: { host, port, self:{id,name}, paths, onUpdate(record),
 *         registry?:Map, peerName?, peerId?, streams? }
 */
async function sendPaths(opts) {
  const { host, port, self, paths, onUpdate } = opts;
  const { entries, totalBytes } = await collectEntries(paths);
  if (entries.length === 0) throw new Error('Nothing to send (empty selection)');

  const tid = crypto.randomUUID();
  const record = {
    id: tid,
    direction: 'send',
    peerName: opts.peerName || host,
    peerId: opts.peerId || '',
    fileCount: entries.length,
    totalBytes,
    bytes: 0,
    state: 'pending',
    label: labelFor(entries),
    startedAt: Date.now(),
  };
  const update = () => { if (onUpdate) onUpdate({ ...record }); };
  update();

  const sockets = [];
  let canceled = false;
  const closeAll = () => { for (const s of sockets) { try { s.destroy(); } catch (_) {} } };

  if (opts.registry) {
    opts.registry.set(tid, { cancel() { canceled = true; closeAll(); } });
  }

  try {
    const control = await connectSocket(host, port);
    sockets.push(control);
    const reader = new FrameReader();

    control.write(frame({
      type: 'offer',
      tid,
      senderId: self.id,
      senderName: self.name,
      files: entries.map((e) => ({ rel: e.rel, size: e.size })),
      totalBytes,
    }));

    const resp = await readFrame(control, reader, ['accept', 'reject']);
    if (resp.type === 'reject') throw new Error('Declined by the other device');

    record.state = 'active';
    record.startedAt = Date.now();
    update();

    // build the shared chunk work queue
    const queue = [];
    entries.forEach((e, idx) => {
      if (e.size === 0) return;
      for (let off = 0; off < e.size; off += CHUNK_SIZE) {
        queue.push({ idx, offset: off, length: Math.min(CHUNK_SIZE, e.size - off) });
      }
    });

    const wanted = Math.max(1, Math.min(opts.streams || STREAMS, queue.length));
    for (let i = 1; i < wanted; i++) {
      const s = await connectSocket(host, port);
      s.write(frame({ type: 'join', tid }));
      sockets.push(s);
    }

    let lastEmit = 0;
    const worker = async (socket) => {
      for (;;) {
        if (canceled) return;
        const task = queue.shift();
        if (!task) break;
        socket.write(frame({ type: 'chunk', idx: task.idx, offset: task.offset, length: task.length }));
        await streamRange(socket, entries[task.idx].abs, task.offset, task.length);
        record.bytes += task.length;
        const now = Date.now();
        if (now - lastEmit > 150) { lastEmit = now; update(); }
      }
      socket.write(frame({ type: 'end' }));
    };

    await Promise.all(sockets.map(worker));
    if (canceled) throw new Error('canceled');

    await readFrame(control, reader, ['done'], SOCKET_TIMEOUT_MS);
    record.state = 'done';
    record.bytes = totalBytes;
    update();
    closeAll();
    return record;
  } catch (err) {
    closeAll();
    record.state = canceled ? 'canceled' : 'error';
    record.error = canceled ? 'Canceled' : err.message;
    update();
    if (canceled) return record;
    throw err;
  } finally {
    if (opts.registry) opts.registry.delete(tid);
  }
}

module.exports = {
  DISCOVERY_PORT,
  DEFAULT_TRANSFER_PORT,
  STREAMS,
  Discovery,
  TransferServer,
  sendPaths,
  collectEntries,
  primaryLocalIP,
};
