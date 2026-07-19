'use strict';
/*
 * FluxDrop signaling — a lightweight always-on TCP channel between LAN devices
 * used for text chat and voice-call setup (WebRTC SDP/ICE exchange).
 *
 * Each device runs one Signaling server. Messages are the same length-prefixed
 * JSON frames as the transfer protocol. The first frame on any connection is a
 * `hello` carrying the sender's device id, so both ends know who they're
 * talking to. A connection is bidirectional: once open (opened by either side)
 * both peers send and receive over it.
 *
 * We keep at most one *send* socket per peer (last one wins), but we still
 * receive on every socket, so even if both sides dial simultaneously and two
 * sockets briefly exist, no message is lost or duplicated: each message is
 * written exactly once, on one socket, and the far end reads it once.
 *
 * No Electron dependencies: testable with plain Node.
 */
const net = require('net');
const { EventEmitter } = require('events');
const { frame, FrameReader, DEFAULT_SIGNAL_PORT } = require('./core');

class Signaling extends EventEmitter {
  /** self: { id } */
  constructor(self) {
    super();
    this.self = self;
    this.server = null;
    this.port = null;
    this.peers = new Map(); // peerId -> socket to send on
  }

  start(preferredPort = DEFAULT_SIGNAL_PORT) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._wire(socket, null));
      this.server = server;
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && this.port === null) server.listen(0);
        else { this.emit('error', err); reject(err); }
      });
      server.on('listening', () => { this.port = server.address().port; resolve(this.port); });
      server.listen(preferredPort);
    });
  }

  /**
   * Attach the protocol to a socket.
   * knownPeerId is set for sockets we dialed; null for inbound ones, whose peer
   * id arrives in the first `hello` frame.
   */
  _wire(socket, knownPeerId) {
    socket.setNoDelay(true);
    const reader = new FrameReader();
    let peerId = knownPeerId;
    if (peerId) this._setSendSocket(peerId, socket);

    socket.on('data', (chunk) => {
      reader.push(chunk);
      try {
        let msg;
        while ((msg = reader.next()) !== null) {
          if (!peerId) {
            // must be the opening hello
            if (msg.type === 'hello' && msg.id) {
              peerId = String(msg.id);
              this._setSendSocket(peerId, socket);
              this.emit('peer', { id: peerId, up: true });
            }
            continue; // never surface hello/pre-hello noise as a message
          }
          if (msg.type === 'hello') continue; // ignore duplicate hellos
          this.emit('message', { peerId, msg });
        }
      } catch (_) {
        try { socket.destroy(); } catch (_) {}
      }
    });
    socket.on('error', () => {}); // handled via 'close'
    socket.on('close', () => {
      if (peerId && this.peers.get(peerId) === socket) {
        this.peers.delete(peerId);
        this.emit('peer', { id: peerId, up: false });
      }
    });
  }

  _setSendSocket(peerId, socket) {
    // Last socket wins as the send path. Any previous socket stays open so its
    // in-flight reads still land; it closes on its own when the far end drops.
    this.peers.set(peerId, socket);
  }

  /** Ensure a live connection to a peer. peer: { id, ip, sport } */
  connect(peer) {
    const cur = this.peers.get(peer.id);
    if (cur && !cur.destroyed && cur.writable) return;
    const socket = net.connect({ host: peer.ip, port: peer.sport || DEFAULT_SIGNAL_PORT });
    socket.on('error', () => {});
    this._wire(socket, peer.id);
    // hello is queued before any later send(), so it always reaches the far end
    // first even though the socket hasn't finished connecting yet.
    try { socket.write(frame({ type: 'hello', id: this.self.id })); } catch (_) {}
  }

  /**
   * Send a message to a peer. `peer` may be a bare id (an existing connection)
   * or a { id, ip, sport } descriptor we can dial if not yet connected.
   * Returns true if the message was handed to a socket.
   */
  send(peer, obj) {
    const id = typeof peer === 'string' ? peer : peer.id;
    let socket = this.peers.get(id);
    if ((!socket || socket.destroyed) && typeof peer === 'object') {
      this.connect(peer);
      socket = this.peers.get(id);
    }
    if (!socket || socket.destroyed) return false;
    try { socket.write(frame(obj)); return true; } catch (_) { return false; }
  }

  stop() {
    for (const socket of this.peers.values()) { try { socket.destroy(); } catch (_) {} }
    this.peers.clear();
    if (this.server) { try { this.server.close(); } catch (_) {} }
  }
}

module.exports = { Signaling };
