'use strict';
/* global flux */

const state = {
  devices: [],
  transfers: new Map(), // id -> record
  requests: new Map(),  // id -> info
  speeds: new Map(),    // id -> { t, bytes, speed }
  settings: null,
  self: null,
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- helpers */

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  const mbps = (bps * 8) / 1e6;
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`;
  return `${fmtBytes(bps)}/s`;
}

function fmtEta(record, speed) {
  if (!speed || record.state !== 'active') return '';
  const left = record.totalBytes - record.bytes;
  const s = Math.ceil(left / speed);
  if (s < 60) return `${s}s left`;
  return `${Math.floor(s / 60)}m ${s % 60}s left`;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function platformIcon(platform) {
  if (platform === 'mac') {
    return '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M17.05 12.54c-.03-2.42 1.98-3.58 2.07-3.64-1.13-1.65-2.88-1.88-3.5-1.9-1.48-.15-2.9.88-3.65.88-.76 0-1.92-.86-3.16-.84-1.62.02-3.12.95-3.96 2.4-1.7 2.94-.43 7.28 1.21 9.66.81 1.17 1.77 2.47 3.03 2.42 1.22-.05 1.68-.78 3.15-.78s1.89.78 3.17.76c1.31-.03 2.14-1.18 2.94-2.36.93-1.35 1.31-2.66 1.33-2.73-.03-.01-2.55-.98-2.63-3.87zm-2.4-7.1c.67-.82 1.13-1.95 1-3.08-.97.04-2.15.65-2.85 1.46-.62.72-1.17 1.88-1.02 2.98 1.08.09 2.19-.55 2.87-1.36z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 5.5 10.5 4.4v7.1H3V5.5zm0 13 7.5 1.1v-7H3v5.9zM11.5 4.2 21 3v8.5h-9.5V4.2zm0 15.6L21 21v-8.5h-9.5v7.3z"/></svg>';
}

/* --------------------------------------------------------------- requests */

function renderRequests() {
  const section = $('requestsSection');
  const list = $('requestList');
  const items = [...state.requests.values()];
  section.hidden = items.length === 0;
  list.innerHTML = '';

  for (const info of items) {
    const el = document.createElement('div');
    el.className = 'request-item';
    el.innerHTML = `
      <div class="r-icon">↓</div>
      <div>
        <div class="r-title"><b>${esc(info.peerName)}</b> wants to send you ${esc(info.label)}</div>
        <div class="r-sub">${info.fileCount} file${info.fileCount === 1 ? '' : 's'} · ${fmtBytes(info.totalBytes)} · from ${esc(info.ip)}</div>
      </div>
      <div class="r-actions">
        <label class="r-trust" title="Always accept files from this device without asking">
          <input type="checkbox" data-role="trust" /> Always allow
        </label>
        <button class="btn danger" data-act="decline">Decline</button>
        <button class="btn primary" data-act="accept">Accept</button>
      </div>
    `;
    const trust = () => el.querySelector('[data-role="trust"]').checked;
    el.querySelector('[data-act="accept"]').addEventListener('click', () => {
      flux.respondRequest(info.id, true, trust());
      state.requests.delete(info.id);
      renderRequests();
    });
    el.querySelector('[data-act="decline"]').addEventListener('click', () => {
      flux.respondRequest(info.id, false, false);
      state.requests.delete(info.id);
      renderRequests();
    });
    list.appendChild(el);
  }
}

/* ---------------------------------------------------------------- devices */

function renderDevices() {
  const grid = $('deviceGrid');
  const empty = $('emptyState');
  empty.hidden = state.devices.length > 0;
  grid.innerHTML = '';

  for (const dev of state.devices) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.dataset.id = dev.id;
    card.innerHTML = `
      <div class="device-top">
        <div class="device-avatar">${platformIcon(dev.platform)}</div>
        <div style="min-width:0">
          <div class="device-name">${esc(dev.name)}</div>
          <div class="device-meta">${esc(dev.ip)} · ${dev.platform === 'mac' ? 'macOS' : 'Windows'}</div>
        </div>
      </div>
      <div class="device-actions">
        <button class="btn primary grow" data-act="files">Send Files</button>
        <button class="btn secondary grow" data-act="folder">Send Folder</button>
      </div>
      <div class="device-hint">or drag &amp; drop files here</div>
    `;
    card.querySelector('[data-act="files"]').addEventListener('click', () => flux.pickAndSend(dev.id, 'files'));
    card.querySelector('[data-act="folder"]').addEventListener('click', () => flux.pickAndSend(dev.id, 'folder'));

    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drag-over');
      const paths = [...e.dataTransfer.files].map((f) => flux.pathForFile(f)).filter(Boolean);
      if (paths.length) flux.sendPaths(dev.id, paths);
    });
    grid.appendChild(card);
  }
}

/* -------------------------------------------------------------- transfers */

function computeSpeed(record) {
  const prev = state.speeds.get(record.id);
  const now = performance.now();
  if (!prev) {
    state.speeds.set(record.id, { t: now, bytes: record.bytes, speed: 0 });
    return 0;
  }
  const dt = (now - prev.t) / 1000;
  if (dt < 0.15) return prev.speed;
  const inst = (record.bytes - prev.bytes) / dt;
  const speed = prev.speed ? prev.speed * 0.6 + inst * 0.4 : inst;
  state.speeds.set(record.id, { t: now, bytes: record.bytes, speed });
  return speed;
}

function renderTransfers() {
  const section = $('transfersSection');
  const list = $('transferList');
  const records = [...state.transfers.values()].sort((a, b) => b.startedAt - a.startedAt);
  section.hidden = records.length === 0;
  list.innerHTML = '';

  for (const r of records) {
    const speed = r.state === 'active' ? (state.speeds.get(r.id) || {}).speed || 0 : 0;
    const pct = r.totalBytes > 0 ? Math.min(100, (r.bytes / r.totalBytes) * 100) : 0;
    const isRecv = r.direction === 'recv';
    const stateLabel = {
      pending: 'Waiting for the other device to accept…',
      active: `${fmtBytes(r.bytes)} of ${fmtBytes(r.totalBytes)} · ${fmtEta(r, speed)}`,
      done: 'Completed',
      error: `Failed — ${r.error || 'unknown error'}`,
      canceled: 'Canceled',
      declined: 'Declined',
    }[r.state] || r.state;

    const item = document.createElement('div');
    item.className = 'transfer-item';
    item.innerHTML = `
      <div class="t-icon ${isRecv ? 'recv' : ''}">${isRecv ? '↓' : '↑'}</div>
      <div class="t-main">
        <div class="t-title">${esc(r.label)} ${isRecv ? 'from' : 'to'} ${esc(r.peerName)}</div>
        <div class="t-sub ${r.state}">${esc(stateLabel)}</div>
        <div class="t-bar"><div class="t-bar-fill ${r.state === 'done' ? 'done' : ''} ${r.state === 'error' || r.state === 'canceled' || r.state === 'declined' ? 'error' : ''}" style="width:${r.state === 'done' ? 100 : pct}%"></div></div>
      </div>
      <div class="t-right">
        <div class="t-speed">${r.state === 'active' ? fmtSpeed(speed) : fmtBytes(r.totalBytes)}</div>
        ${r.state === 'active' || r.state === 'pending'
          ? `<button class="t-cancel" data-id="${r.id}">Cancel</button>`
          : `<div class="t-state ${r.state}">${r.state === 'done' ? '✓ ' + (isRecv ? 'Received' : 'Sent') : ''}</div>`}
      </div>
    `;
    // Cancel is handled by one delegated listener on the list (see init), so a
    // click still registers even if this node is rebuilt mid-progress.
    list.appendChild(item);
  }
}

/* --------------------------------------------------------------- settings */

function openSettings() {
  $('inpName').value = state.settings.deviceName;
  $('inpDir').value = state.settings.downloadDir;
  $('inpAutoLaunch').checked = !!state.settings.autoLaunch;
  const n = state.settings.trustedCount || 0;
  $('trustedRow').hidden = n === 0;
  $('trustedText').textContent = `${n} trusted device${n === 1 ? '' : 's'} skip the approval prompt.`;
  $('settingsModal').showModal();
}

async function saveSettings() {
  const patch = {
    deviceName: $('inpName').value,
    autoLaunch: $('inpAutoLaunch').checked,
  };
  await flux.setSettings(patch);
  state.settings.deviceName = patch.deviceName || state.settings.deviceName;
  state.settings.autoLaunch = patch.autoLaunch;
  $('selfName').textContent = state.settings.deviceName;
  $('settingsModal').close();
}

/* --------------------------------------------------------------- dragging */

// prevent the window from navigating when files are dropped outside a card
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

/* -------------------------------------------------------------------- init */

async function init() {
  const st = await flux.getState();
  state.settings = st.settings;
  state.self = st.self;
  state.devices = st.devices;
  for (const t of st.transfers) state.transfers.set(t.id, t);
  for (const r of st.requests || []) state.requests.set(r.id, r);

  $('selfName').textContent = st.self.name;
  $('selfIp').textContent = `${st.self.ip} · v${st.self.version}`;

  renderDevices();
  renderTransfers();
  renderRequests();

  flux.onRequest((info) => {
    state.requests.set(info.id, info);
    renderRequests();
  });

  flux.onRequestResolved((id) => {
    state.requests.delete(id);
    renderRequests();
  });

  flux.onDevices((devices) => {
    state.devices = devices;
    renderDevices();
  });

  flux.onTransfer((record) => {
    state.transfers.set(record.id, record);
    if (record.state === 'active') computeSpeed(record);
    else state.speeds.delete(record.id);
    renderTransfers();
  });

  $('btnSettings').addEventListener('click', openSettings);
  $('contactDev').addEventListener('click', (e) => { e.preventDefault(); flux.contactDeveloper(); });
  $('contactDevModal').addEventListener('click', (e) => { e.preventDefault(); flux.contactDeveloper(); });
  $('btnCloseSettings').addEventListener('click', () => $('settingsModal').close());
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnOpenDownloads').addEventListener('click', () => flux.openDownloads());

  // Delegated cancel — survives the periodic re-render of the transfer list.
  $('transferList').addEventListener('click', (e) => {
    const btn = e.target.closest('.t-cancel');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Canceling…';
    flux.cancelTransfer(btn.dataset.id);
  });

  $('btnClearHistory').addEventListener('click', async () => {
    await flux.clearHistory();
    for (const [id, r] of state.transfers) {
      if (r.state !== 'active' && r.state !== 'pending') state.transfers.delete(id);
    }
    renderTransfers();
  });

  // Connect by IP
  const manual = $('manualModal');
  $('btnManual').addEventListener('click', () => {
    $('inpIp').value = '';
    $('manualError').hidden = true;
    manual.showModal();
  });
  $('btnCloseManual').addEventListener('click', () => manual.close());
  const manualSend = async (mode) => {
    const ip = $('inpIp').value.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      $('manualError').textContent = 'Please enter a valid IPv4 address like 192.168.0.42';
      $('manualError').hidden = false;
      return;
    }
    const res = await flux.sendToIp(ip, mode);
    if (res && res.ok === false && res.error) {
      $('manualError').textContent = res.error;
      $('manualError').hidden = false;
      return;
    }
    manual.close();
  };
  $('btnManualFiles').addEventListener('click', () => manualSend('files'));
  $('btnManualFolder').addEventListener('click', () => manualSend('folder'));

  $('btnForgetTrusted').addEventListener('click', async () => {
    await flux.forgetTrusted();
    state.settings.trustedCount = 0;
    $('trustedRow').hidden = true;
  });
  $('btnChooseDir').addEventListener('click', async () => {
    const dir = await flux.chooseDownloadDir();
    $('inpDir').value = dir;
    state.settings.downloadDir = dir;
  });

  // periodic re-render so speed/ETA stay fresh
  setInterval(() => {
    const hasActive = [...state.transfers.values()].some((t) => t.state === 'active');
    if (hasActive) renderTransfers();
  }, 500);
}

init();
