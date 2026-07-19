'use strict';
/* global flux */
/*
 * FluxDrop comms — device-to-device text chat and voice calling.
 *
 * All signaling (chat text, call setup, WebRTC SDP/ICE) rides the main-process
 * signaling channel via flux.signalSend / flux.onSignal. Audio itself flows
 * peer-to-peer over WebRTC; since both devices are on the same LAN, host ICE
 * candidates connect directly with no STUN/TURN server.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const RTC_CONFIG = { iceServers: [] }; // LAN only — direct host candidates

  let getDevice = () => null;
  let onUnread = () => {};

  const threads = new Map(); // peerId -> [{ mine, text, ts }]
  const unread = new Map();  // peerId -> count
  let activeChat = null;     // peerId whose drawer is open

  // Single active call at a time.
  let call = null; // { peerId, callId, role, phase, pc, stream, pendingIce, startedAt, timer, muted }

  /* ------------------------------------------------------------- utilities */

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function nameOf(peerId) {
    const d = getDevice(peerId);
    return d ? d.name : 'Unknown device';
  }

  // RTCSessionDescription / RTCIceCandidate are platform objects that throw
  // DataCloneError when passed through Electron's IPC (structured clone). Always
  // send plain objects over the signaling channel.
  function plainSdp(d) { return { type: d.type, sdp: d.sdp }; }
  function plainCandidate(c) {
    return c && typeof c.toJSON === 'function' ? c.toJSON() : {
      candidate: c.candidate, sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment,
    };
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0] ? p[0].toUpperCase() : '').join('') || '?';
  }

  function fmtClock(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* -------------------------------------------------------------- ring tone */

  let ringCtx = null;
  let ringOsc = null;
  let ringTimer = null;
  function startRing(outgoing) {
    stopRing();
    try {
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        if (!ringCtx) return;
        if (ringCtx.state === 'suspended') { try { ringCtx.resume(); } catch (_) {} }
        const o = ringCtx.createOscillator();
        const g = ringCtx.createGain();
        o.frequency.value = outgoing ? 440 : 520;
        g.gain.value = 0.0001;
        o.connect(g); g.connect(ringCtx.destination);
        const t = ringCtx.currentTime;
        g.gain.exponentialRampToValueAtTime(0.15, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.start(t); o.stop(t + 0.55);
        ringOsc = o;
      };
      beep();
      ringTimer = setInterval(beep, outgoing ? 3000 : 1500);
    } catch (_) { /* audio may be unavailable — silent ring is fine */ }
  }
  function stopRing() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    if (ringOsc) { try { ringOsc.stop(); } catch (_) {} ringOsc = null; }
    if (ringCtx) { try { ringCtx.close(); } catch (_) {} ringCtx = null; }
  }

  // Short UI sounds (message received, etc.). Autoplay is allowed via the app's
  // autoplay-policy switch, so this plays even while minimized to the tray.
  let sfxCtx = null;
  function sfx(notes) {
    try {
      if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      let t = sfxCtx.currentTime;
      for (const f of notes) {
        const o = sfxCtx.createOscillator();
        const g = sfxCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g); g.connect(sfxCtx.destination);
        o.start(t); o.stop(t + 0.18);
        t += 0.13;
      }
    } catch (_) { /* audio unavailable — ignore */ }
  }
  function messageSound() { sfx([784, 1047]); } // two-note "pop"

  /* ------------------------------------------------------------------ chat */

  function pushMsg(peerId, mine, text) {
    if (!threads.has(peerId)) threads.set(peerId, []);
    const arr = threads.get(peerId);
    arr.push({ mine, text, ts: Date.now(), seen: false });
    if (arr.length > 500) arr.splice(0, arr.length - 500);
  }

  // Window truly in the foreground with this chat open = the user is reading it.
  function chatIsVisible(peerId) {
    return activeChat === peerId && !$('chatDrawer').hidden && document.hasFocus();
  }

  // Tell the peer we've read their messages (drives their "Seen" receipt).
  function markSeen(peerId) {
    const arr = threads.get(peerId) || [];
    if (arr.some((m) => !m.mine)) flux.signalSend(peerId, { type: 'chat-seen' });
  }

  function onChatSeen(peerId) {
    const arr = threads.get(peerId);
    if (!arr) return;
    let changed = false;
    for (const m of arr) { if (m.mine && !m.seen) { m.seen = true; changed = true; } }
    if (changed && activeChat === peerId) renderChat();
  }

  function renderChat() {
    const log = $('chatLog');
    log.innerHTML = '';
    const arr = threads.get(activeChat) || [];
    if (arr.length === 0) {
      const e = document.createElement('div');
      e.className = 'chat-empty';
      e.textContent = 'No messages yet. Say hello 👋';
      log.appendChild(e);
    }
    for (const m of arr) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (m.mine ? 'mine' : 'theirs');
      const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      bubble.innerHTML = `<span class="b-text">${esc(m.text)}</span><span class="b-time">${time}</span>`;
      log.appendChild(bubble);
    }
    // Read receipt under the thread when your latest message is the last one.
    if (arr.length && arr[arr.length - 1].mine) {
      const r = document.createElement('div');
      const seen = arr[arr.length - 1].seen;
      r.className = 'chat-receipt' + (seen ? ' seen' : '');
      r.textContent = seen ? '✓✓ Seen' : '✓ Sent';
      log.appendChild(r);
    }
    log.scrollTop = log.scrollHeight;
  }

  function openChat(peerId) {
    activeChat = peerId;
    unread.set(peerId, 0);
    onUnread();
    const dev = getDevice(peerId);
    $('chatName').textContent = nameOf(peerId);
    $('chatStatus').textContent = dev ? `${dev.ip} · online` : 'offline';
    $('chatAvatar').textContent = initials(nameOf(peerId));
    $('chatDrawer').hidden = false;
    document.body.classList.add('drawer-open');
    renderChat();
    $('chatText').focus();
    markSeen(peerId); // opening the thread means I've read what's there
  }

  function closeChat() {
    activeChat = null;
    $('chatDrawer').hidden = true;
    document.body.classList.remove('drawer-open');
  }

  function sendChat() {
    const input = $('chatText');
    const text = input.value.trim();
    if (!text || !activeChat) return;
    flux.signalSend(activeChat, { type: 'chat', text });
    pushMsg(activeChat, true, text);
    input.value = '';
    renderChat();
  }

  function onChatArrived(peerId, text) {
    pushMsg(peerId, false, text);
    messageSound();
    if (chatIsVisible(peerId)) {
      renderChat();
      markSeen(peerId); // I'm looking right at it
    } else {
      unread.set(peerId, (unread.get(peerId) || 0) + 1);
      onUnread();
    }
  }

  /* ------------------------------------------------------------------ call */

  function setCallUI(phase) {
    const overlay = $('callOverlay');
    const actions = $('callActions');
    const stateEl = $('callState');
    const timerEl = $('callTimer');
    overlay.hidden = phase === 'idle';
    if (phase === 'idle') return;

    $('callName').textContent = nameOf(call.peerId);
    $('callAvatar').textContent = initials(nameOf(call.peerId));
    actions.innerHTML = '';
    timerEl.hidden = phase !== 'active';

    const btn = (cls, label, fn) => {
      const b = document.createElement('button');
      b.className = 'call-btn ' + cls;
      b.innerHTML = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
      return b;
    };

    if (phase === 'outgoing') {
      stateEl.textContent = 'Calling…';
      btn('hangup', 'End', hangup);
    } else if (phase === 'incoming') {
      stateEl.textContent = 'Incoming voice call';
      btn('decline', 'Decline', () => declineIncoming());
      btn('accept', 'Accept', () => acceptIncoming());
    } else if (phase === 'active') {
      stateEl.textContent = 'Connected';
      btn('mute', call.muted ? 'Unmute' : 'Mute', toggleMute);
      btn('hangup', 'End', hangup);
    } else if (phase === 'ended') {
      stateEl.textContent = call.endReason || 'Call ended';
      timerEl.hidden = true;
    }
  }

  function newPeerConnection(peerId, callId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        flux.signalSend(peerId, { type: 'call-ice', callId, candidate: plainCandidate(e.candidate) });
      }
    };
    pc.ontrack = (e) => {
      const audio = $('remoteAudio');
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
    };
    pc.oniceconnectionstatechange = () => {
      if (!call) return;
      const st = pc.iceConnectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        if (call.phase === 'active') endCall('Call disconnected');
      }
    };
    return pc;
  }

  async function getMic() {
    // On macOS this triggers the single system mic prompt up front (instead of
    // getUserMedia failing until the user clicks Allow several times).
    try { await flux.ensureMic(); } catch (_) {}
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  async function startCall(peerId) {
    if (call) return; // already in a call
    const callId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random());
    call = { peerId, callId, role: 'caller', phase: 'outgoing', pc: null,
             stream: null, pendingIce: [], muted: false };
    setCallUI('outgoing');
    startRing(true);
    try {
      call.stream = await getMic();
      call.pc = newPeerConnection(peerId, callId);
      for (const t of call.stream.getTracks()) call.pc.addTrack(t, call.stream);
      const offer = await call.pc.createOffer({ offerToReceiveAudio: true });
      await call.pc.setLocalDescription(offer);
      flux.signalSend(peerId, { type: 'call-invite', callId, sdp: plainSdp(call.pc.localDescription) });
    } catch (err) {
      endCall(micError(err));
    }
  }

  function micError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone blocked — allow mic access in system settings';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'Mic is in use by another app';
    // surface the real reason so unusual failures are diagnosable
    return 'Could not start audio' + (name ? ' (' + name + ')' : (err && err.message ? ' (' + err.message + ')' : ''));
  }

  function onCallInvite(peerId, callId, sdp) {
    // Only truly busy when a live call is up. A call in the brief 'ended' state
    // (showing the "Call ended" card) must not reject a fresh invite.
    if (call && call.phase !== 'ended') {
      flux.signalSend(peerId, { type: 'call-busy', callId });
      return;
    }
    if (call) teardown(); // clear a lingering ended-call card
    call = { peerId, callId, role: 'callee', phase: 'incoming', pc: null,
             stream: null, pendingIce: [], offer: sdp, muted: false };
    setCallUI('incoming');
    startRing(false);
  }

  async function acceptIncoming() {
    if (!call || call.phase !== 'incoming') return;
    stopRing();
    try {
      call.stream = await getMic();
      call.pc = newPeerConnection(call.peerId, call.callId);
      for (const t of call.stream.getTracks()) call.pc.addTrack(t, call.stream);
      await call.pc.setRemoteDescription(call.offer);
      await flushIce();
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      flux.signalSend(call.peerId, { type: 'call-accept', callId: call.callId, sdp: plainSdp(call.pc.localDescription) });
      goActive();
    } catch (err) {
      endCall(micError(err));
    }
  }

  function declineIncoming() {
    if (!call) return;
    const peerId = call.peerId;
    const callId = call.callId;
    teardown();
    setCallUI('idle');
    try { flux.signalSend(peerId, { type: 'call-reject', callId }); } catch (_) {}
  }

  async function onCallAccept(callId, sdp) {
    if (!call || call.callId !== callId || call.role !== 'caller') return;
    stopRing();
    try {
      await call.pc.setRemoteDescription(sdp);
      await flushIce();
      goActive();
    } catch (_) {
      endCall('Call setup failed');
    }
  }

  async function flushIce() {
    if (!call || !call.pc) return;
    const pending = call.pendingIce;
    call.pendingIce = [];
    for (const c of pending) {
      try { await call.pc.addIceCandidate(c); } catch (_) {}
    }
  }

  async function onCallIce(callId, candidate) {
    if (!call || call.callId !== callId || !call.pc) return;
    // buffer until the remote description is in place, else addIceCandidate throws
    if (!call.pc.remoteDescription) { call.pendingIce.push(candidate); return; }
    try { await call.pc.addIceCandidate(candidate); } catch (_) {}
  }

  function goActive() {
    if (!call) return;
    call.phase = 'active';
    call.startedAt = Date.now();
    setCallUI('active');
    call.timer = setInterval(() => {
      const sec = Math.floor((Date.now() - call.startedAt) / 1000);
      $('callTimer').textContent = fmtClock(sec);
    }, 500);
  }

  function toggleMute() {
    if (!call || !call.stream) return;
    call.muted = !call.muted;
    for (const t of call.stream.getAudioTracks()) t.enabled = !call.muted;
    setCallUI('active');
  }

  // End the call from this side. Always tears down locally first so hanging up
  // never depends on the peer or the network being reachable — the button can
  // never leave you stuck in a call. We still tell the peer (best effort); if
  // that frame is lost, their WebRTC ICE state flips to disconnected and their
  // side ends on its own too.
  function hangup() {
    if (!call) return;
    if (call.phase === 'incoming') { declineIncoming(); return; }
    const peerId = call.peerId;
    const callId = call.callId;
    teardown();          // local end is unconditional
    setCallUI('idle');
    try { flux.signalSend(peerId, { type: 'call-hangup', callId }); } catch (_) {}
  }

  function onCallHangup(callId) {
    if (!call || call.callId !== callId) return;
    endCall('Call ended', false); // peer already hung up — don't echo back
  }

  function onCallRejected(callId, busy) {
    if (!call || call.callId !== callId) return;
    endCall(busy ? 'Busy — try again later' : 'Call declined', false);
  }

  // End with a short status message, then close the overlay. By default we also
  // tell the peer to hang up, so a failure or drop on our side (e.g. the callee's
  // mic won't start) never leaves the other side stuck ringing or "in a call"
  // (which then reports Busy on the next attempt). Pass notify=false when the
  // peer is the one that ended it, to avoid echoing the message back.
  function endCall(reason, notify = true) {
    if (!call) return;
    if (notify) {
      try { flux.signalSend(call.peerId, { type: 'call-hangup', callId: call.callId }); } catch (_) {}
    }
    call.endReason = reason;
    call.phase = 'ended';
    setCallUI('ended');
    teardown(true);
    setTimeout(() => { if (call && call.phase === 'ended') setCallUI('idle'); call = null; }, 1600);
  }

  function teardown(keepRecord) {
    stopRing();
    if (call) {
      if (call.timer) { clearInterval(call.timer); call.timer = null; }
      if (call.pc) { try { call.pc.close(); } catch (_) {} call.pc = null; }
      if (call.stream) { for (const t of call.stream.getTracks()) { try { t.stop(); } catch (_) {} } call.stream = null; }
    }
    const audio = $('remoteAudio');
    if (audio) { audio.srcObject = null; }
    if (!keepRecord) call = null;
  }

  /* ------------------------------------------------------- signal dispatch */

  function handleSignal({ peerId, msg }) {
    switch (msg.type) {
      case 'chat': onChatArrived(peerId, String(msg.text || '')); break;
      case 'chat-seen': onChatSeen(peerId); break;
      case 'call-invite': onCallInvite(peerId, msg.callId, msg.sdp); break;
      case 'call-accept': onCallAccept(msg.callId, msg.sdp); break;
      case 'call-ice': onCallIce(msg.callId, msg.candidate); break;
      case 'call-reject': onCallRejected(msg.callId, false); break;
      case 'call-busy': onCallRejected(msg.callId, true); break;
      case 'call-hangup': onCallHangup(msg.callId); break;
      default: break;
    }
  }

  /* --------------------------------------------------------------- wire-up */

  function init(opts) {
    getDevice = opts.getDevice || getDevice;
    onUnread = opts.onUnread || onUnread;

    flux.onSignal(handleSignal);

    $('chatCloseBtn').addEventListener('click', closeChat);
    $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
    $('chatCallBtn').addEventListener('click', () => { if (activeChat) startCall(activeChat); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // A live call always takes priority: Escape is a guaranteed way to end or
      // decline it even if a button were ever unclickable.
      if (call && call.phase !== 'ended') {
        if (call.phase === 'incoming') declineIncoming();
        else hangup();
        return;
      }
      if (!$('chatDrawer').hidden) closeChat();
    });
  }

  window.Comms = {
    init,
    openChat,
    startCall,
    unread: (peerId) => unread.get(peerId) || 0,
    inCall: () => !!call,
  };
})();
