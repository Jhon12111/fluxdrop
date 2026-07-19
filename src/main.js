'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { Discovery, TransferServer, sendPaths, primaryLocalIP, DEFAULT_TRANSFER_PORT } = require('./core');
const { Signaling } = require('./signal');

const REPO = 'Jhon12111/fluxdrop';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

const SMOKE = process.argv.includes('--smoke');
const START_HIDDEN = process.argv.includes('--hidden');

let win = null;
let tray = null;
let discovery = null;
let transferServer = null;
let signaling = null;
let quitting = false;

const transfers = new Map(); // id -> record
const sendRegistry = new Map(); // id -> { cancel }
const pendingRequests = new Map(); // id -> { info, resolve, notification }

/* ---------------------------------------------------------------- settings */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

let settings = null;

function loadSettings() {
  const defaults = {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    downloadDir: path.join(app.getPath('downloads'), 'FluxDrop'),
    autoLaunch: true,
    trustedDevices: [], // device ids that skip the approval prompt
    lastNotifiedVersion: '', // newest version we've already alerted about
  };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings = { ...defaults, ...raw };
  } catch (_) {
    settings = defaults;
  }
  saveSettings();
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('failed to save settings:', err.message);
  }
}

function applyAutoLaunch() {
  if (!app.isPackaged) return; // don't register the dev process
  app.setLoginItemSettings({
    openAtLogin: !!settings.autoLaunch,
    args: ['--hidden'],
  });
}

/* ------------------------------------------------------------------ window */

function iconPath(name) {
  return path.join(__dirname, '..', 'build', name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 920,
    minHeight: 600,
    show: !START_HIDDEN,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (SMOKE) {
    win.webContents.on('console-message', (e, level, message) => {
      if (level >= 2) console.log('RENDERER[' + level + ']: ' + message);
    });
    win.webContents.on('did-fail-load', (e, code, desc) => console.log('LOAD FAIL: ' + desc));
  }

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide(); // keep receiving in the background
    }
  });
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('FluxDrop — LAN file transfer');
  const menu = Menu.buildFromTemplate([
    { label: 'Open FluxDrop', click: showWindow },
    { label: 'Open received files', click: () => shell.openPath(settings.downloadDir) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', showWindow);
}

/* --------------------------------------------------------------- messaging */

function sendToUI(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function pushDevices() {
  sendToUI('devices', [...discovery.devices.values()]);
}

function pushTransfer(record) {
  transfers.set(record.id, record);
  // keep the last 50 records
  if (transfers.size > 50) {
    const oldest = [...transfers.values()]
      .filter((t) => t.state !== 'active')
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const t of oldest.slice(0, transfers.size - 50)) transfers.delete(t.id);
  }
  sendToUI('transfer', record);
}

/* ----------------------------------------------------------------- network */

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Ask the user whether to accept an incoming transfer.
 * Trusted devices are auto-accepted. Otherwise the request is shown in the
 * window (and as a desktop notification) until answered or timed out.
 */
function askApproval(info) {
  if (settings.trustedDevices.includes(info.peerId)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, trust) => {
      if (settled) return;
      settled = true;
      if (ok && trust && info.peerId && !settings.trustedDevices.includes(info.peerId)) {
        settings.trustedDevices.push(info.peerId);
        saveSettings();
      }
      pendingRequests.delete(info.id);
      sendToUI('request-resolved', info.id);
      resolve(ok);
    };

    pendingRequests.set(info.id, { info, finish });
    sendToUI('request', info);
    showWindow();

    if (Notification.isSupported()) {
      const n = new Notification({
        title: `${info.peerName} wants to send you files`,
        body: `${info.label} · ${fmtBytes(info.totalBytes)} — click to review`,
        icon: iconPath('icon.png'),
      });
      n.on('click', showWindow);
      n.show();
    }
  });
}

/* ------------------------------------------------------------ auto-update */

/** Compare dotted numeric versions. Returns 1 if a>b, -1 if a<b, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'FluxDrop-Updater',
        Accept: 'application/vnd.github+json',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.end();
  });
}

/**
 * Check GitHub for a newer release. On finding one, tell the window (banner)
 * and — unless we've already alerted about this exact version — raise a desktop
 * notification. `manual` forces the notification and returns a status string.
 */
async function checkForUpdates(manual = false) {
  try {
    const rel = await fetchLatestRelease();
    const remote = String(rel.tag_name || '').replace(/^v/, '');
    if (!remote) throw new Error('no version in release');
    const current = app.getVersion();
    if (compareVersions(remote, current) <= 0) {
      return { ok: true, upToDate: true, current };
    }
    const info = { version: remote, url: rel.html_url, notes: String(rel.body || '').slice(0, 600) };
    sendToUI('update-available', info);

    if (manual || settings.lastNotifiedVersion !== remote) {
      settings.lastNotifiedVersion = remote;
      saveSettings();
      if (Notification.isSupported()) {
        const n = new Notification({
          title: `FluxDrop ${remote} is available`,
          body: 'A new version is ready to download — click to get it.',
          icon: iconPath('icon.png'),
        });
        n.on('click', () => { showWindow(); shell.openExternal(info.url); });
        n.show();
      }
    }
    return { ok: true, upToDate: false, info };
  } catch (err) {
    if (manual) return { ok: false, error: err.message };
    return null; // silent on automatic checks
  }
}

async function startNetwork() {
  transferServer = new TransferServer({
    getDownloadDir: () => settings.downloadDir,
    shouldAccept: askApproval,
  });
  transferServer.on('transfer', pushTransfer);
  transferServer.on('error', (err) => console.error('transfer server:', err.message));
  const port = await transferServer.start(DEFAULT_TRANSFER_PORT);

  signaling = new Signaling({ id: settings.deviceId });
  signaling.on('message', onSignalMessage);
  signaling.on('error', (err) => console.error('signaling:', err.message));
  const sport = await signaling.start();

  discovery = new Discovery({
    id: settings.deviceId,
    name: settings.deviceName,
    platform: process.platform === 'darwin' ? 'mac' : (process.platform === 'win32' ? 'windows' : 'linux'),
    transferPort: port,
    signalPort: sport,
  });
  discovery.on('update', pushDevices);
  discovery.on('error', (err) => console.error('discovery:', err.message));
  await discovery.start();
}

/* ------------------------------------------------------- chat & call relay */

// The renderer owns all chat/call logic (incl. WebRTC). Main just relays frames
// between the signaling socket and the window, and raises OS notifications for
// things that arrive while FluxDrop isn't focused.
function peerNameFor(peerId) {
  const dev = discovery && [...discovery.devices.values()].find((d) => d.id === peerId);
  return dev ? dev.name : 'A device';
}

function onSignalMessage({ peerId, msg }) {
  sendToUI('signal', { peerId, msg });

  const focused = win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  if (msg.type === 'chat' && !focused && Notification.isSupported()) {
    const n = new Notification({
      title: `${peerNameFor(peerId)}`,
      body: String(msg.text || '').slice(0, 140),
      icon: iconPath('icon.png'),
    });
    n.on('click', showWindow);
    n.show();
  }
  if (msg.type === 'call-invite') {
    showWindow(); // bring the ringing UI to the front
    if (!focused && Notification.isSupported()) {
      const n = new Notification({
        title: `${peerNameFor(peerId)} is calling…`,
        body: 'Incoming voice call — click to answer',
        icon: iconPath('icon.png'),
      });
      n.on('click', showWindow);
      n.show();
    }
  }
}

async function doSend(deviceId, paths) {
  const device = discovery.devices.get(deviceId);
  if (!device) throw new Error('Device is no longer online');
  await sendPaths({
    host: device.ip,
    port: device.port,
    self: { id: settings.deviceId, name: settings.deviceName },
    paths,
    peerName: device.name,
    peerId: device.id,
    registry: sendRegistry,
    onUpdate: pushTransfer,
  });
}

/** Send to a raw IP (manual "Connect by IP" fallback when discovery fails). */
async function doSendToIp(ip, paths) {
  // if that IP happens to be a discovered device, use its real name/port
  const known = [...discovery.devices.values()].find((d) => d.ip === ip);
  await sendPaths({
    host: ip,
    port: known ? known.port : DEFAULT_TRANSFER_PORT,
    self: { id: settings.deviceId, name: settings.deviceName },
    paths,
    peerName: known ? known.name : ip,
    peerId: known ? known.id : '',
    registry: sendRegistry,
    onUpdate: pushTransfer,
  });
}

/* --------------------------------------------------------------------- IPC */

function setupIpc() {
  ipcMain.handle('get-state', () => ({
    settings: {
      deviceName: settings.deviceName,
      downloadDir: settings.downloadDir,
      autoLaunch: settings.autoLaunch,
      trustedCount: settings.trustedDevices.length,
    },
    requests: [...pendingRequests.values()].map((p) => p.info),
    self: {
      id: settings.deviceId,
      name: settings.deviceName,
      ip: primaryLocalIP(),
      platform: process.platform === 'darwin' ? 'mac' : 'windows',
      version: app.getVersion(),
    },
    devices: [...discovery.devices.values()],
    transfers: [...transfers.values()],
  }));

  ipcMain.handle('set-settings', (e, patch) => {
    if (typeof patch.deviceName === 'string' && patch.deviceName.trim()) {
      settings.deviceName = patch.deviceName.trim().slice(0, 48);
      discovery.updateSelf({ name: settings.deviceName });
    }
    if (typeof patch.autoLaunch === 'boolean') {
      settings.autoLaunch = patch.autoLaunch;
      applyAutoLaunch();
    }
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle('choose-download-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose where received files are saved',
      defaultPath: settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!res.canceled && res.filePaths[0]) {
      settings.downloadDir = res.filePaths[0];
      saveSettings();
    }
    return settings.downloadDir;
  });

  ipcMain.handle('contact-developer', () => {
    shell.openExternal('mailto:ashikmahmud284@gmail.com?subject=FluxDrop');
  });

  ipcMain.handle('open-downloads', () => {
    fs.mkdirSync(settings.downloadDir, { recursive: true });
    shell.openPath(settings.downloadDir);
  });

  ipcMain.handle('pick-and-send', async (e, { deviceId, mode }) => {
    const props = mode === 'folder'
      ? ['openDirectory', 'multiSelections']
      : ['openFile', 'multiSelections'];
    const res = await dialog.showOpenDialog(win, {
      title: mode === 'folder' ? 'Choose folder(s) to send' : 'Choose file(s) to send',
      properties: props,
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
    doSend(deviceId, res.filePaths).catch((err) => console.error('send failed:', err.message));
    return { ok: true };
  });

  ipcMain.handle('send-paths', (e, { deviceId, paths }) => {
    if (!Array.isArray(paths) || paths.length === 0) return { ok: false };
    doSend(deviceId, paths).catch((err) => console.error('send failed:', err.message));
    return { ok: true };
  });

  ipcMain.handle('cancel-transfer', (e, id) => {
    const entry = sendRegistry.get(id);
    if (entry) { entry.cancel(); return { ok: true }; }
    return { ok: transferServer.cancel(id) }; // incoming transfer
  });

  ipcMain.handle('clear-history', () => {
    for (const [id, r] of transfers) {
      if (r.state !== 'active' && r.state !== 'pending') transfers.delete(id);
    }
    return { ok: true };
  });

  ipcMain.handle('send-to-ip', async (e, { ip, mode }) => {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''))) {
      return { ok: false, error: 'Invalid IP address' };
    }
    const props = mode === 'folder'
      ? ['openDirectory', 'multiSelections']
      : ['openFile', 'multiSelections'];
    const res = await dialog.showOpenDialog(win, {
      title: mode === 'folder' ? 'Choose folder(s) to send' : 'Choose file(s) to send',
      properties: props,
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
    doSendToIp(ip, res.filePaths).catch((err) => console.error('manual send failed:', err.message));
    return { ok: true };
  });

  ipcMain.handle('respond-request', (e, { id, accept, trust }) => {
    const pending = pendingRequests.get(id);
    if (!pending) return { ok: false };
    pending.finish(!!accept, !!trust);
    return { ok: true };
  });

  ipcMain.handle('forget-trusted', () => {
    settings.trustedDevices = [];
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle('check-updates', () => checkForUpdates(true));

  ipcMain.handle('open-release', (e, url) => {
    // only ever open our own release pages
    if (typeof url === 'string' && url.startsWith('https://github.com/' + REPO)) {
      shell.openExternal(url);
      return { ok: true };
    }
    shell.openExternal('https://github.com/' + REPO + '/releases/latest');
    return { ok: true };
  });

  // Relay a chat/call frame to a peer. The renderer passes the peer id; we look
  // up its current ip/signal-port from discovery so a connection can be dialed
  // on demand.
  ipcMain.handle('signal-send', (e, { peerId, msg }) => {
    if (!signaling) return { ok: false, error: 'not ready' };
    const dev = [...discovery.devices.values()].find((d) => d.id === peerId);
    const target = dev ? { id: dev.id, ip: dev.ip, sport: dev.sport } : peerId;
    const ok = signaling.send(target, msg);
    return { ok };
  });
}

/* -------------------------------------------------------------------- boot */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    loadSettings();
    applyAutoLaunch();

    // Voice calls need the microphone. Grant it to our own pages only; deny
    // everything else. (getUserMedia still respects the OS-level mic setting.)
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media' || permission === 'mediaKeySystem');
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) =>
      permission === 'media' || permission === 'mediaKeySystem');

    await startNetwork();
    setupIpc();
    createWindow();
    createTray();

    // Check GitHub for a newer release shortly after launch, then periodically.
    setTimeout(() => checkForUpdates(false), 8000);
    setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);

    if (SMOKE) {
      setTimeout(() => {
        console.log('SMOKE_OK port=' + transferServer.port);
        quitting = true;
        app.quit();
      }, 4000);
    }

    // diagnostic: --sdp-test checks whether an SDP / ICE candidate survives the
    // structured-clone (IPC) + JSON boundary the real signaling path crosses.
    if (process.argv.includes('--sdp-test')) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const r = await win.webContents.executeJavaScript(`(async () => {
              const out = {};
              const pc = new RTCPeerConnection({ iceServers: [] });
              const dc = pc.createDataChannel('x');
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              const desc = pc.localDescription;
              try { structuredClone(desc); out.cloneDesc = 'OK'; } catch (e) { out.cloneDesc = 'THROW ' + e.name; }
              out.jsonDesc = JSON.stringify(desc).slice(0, 40);
              const cand = await new Promise(res => { pc.onicecandidate = e => { if (e.candidate) res(e.candidate); }; });
              try { structuredClone(cand); out.cloneCand = 'OK'; } catch (e) { out.cloneCand = 'THROW ' + e.name; }
              out.jsonCand = JSON.stringify(cand).slice(0, 40);
              pc.close();
              return out;
            })()`);
            console.log('SDPTEST ' + JSON.stringify(r));
          } catch (e) { console.log('SDPTEST EXEC_ERR ' + e.message); }
          quitting = true; app.quit();
        }, 2500);
      });
    }

    // diagnostic: --mic-test tries getUserMedia in the renderer and prints the
    // exact outcome (device list + any error name/message), then quits.
    if (process.argv.includes('--mic-test')) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const r = await win.webContents.executeJavaScript(`(async () => {
              const out = { secureContext: window.isSecureContext, hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };
              try {
                const devs = await navigator.mediaDevices.enumerateDevices();
                out.audioInputs = devs.filter(d => d.kind === 'audioinput').length;
              } catch (e) { out.enumErr = e.name + ': ' + e.message; }
              try {
                const s = await navigator.mediaDevices.getUserMedia({ audio: true });
                out.getUserMedia = 'OK';
                out.trackLabels = s.getAudioTracks().map(t => t.label);
                s.getTracks().forEach(t => t.stop());
              } catch (e) { out.getUserMedia = 'ERR ' + e.name + ': ' + e.message; }
              return out;
            })()`);
            console.log('MICTEST ' + JSON.stringify(r));
          } catch (e) {
            console.log('MICTEST EXEC_ERR ' + e.message);
          }
          quitting = true;
          app.quit();
        }, 2500);
      });
    }

    // test hook: --click=<css selector> clicks an element once it appears
    const clickArg = process.argv.find((a) => a.startsWith('--click='));
    if (clickArg) {
      const sel = clickArg.slice('--click='.length);
      const timer = setInterval(async () => {
        try {
          const hit = await win.webContents.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(sel)});
                      if (!el) return false; el.click(); return true; })()`
          );
          if (hit) { clearInterval(timer); console.log('CLICKED ' + sel); }
        } catch (_) {}
      }, 400);
    }

    const shotArg = process.argv.find((a) => a.startsWith('--shot='));
    if (shotArg) {
      const delayArg = process.argv.find((a) => a.startsWith('--shot-delay='));
      const shotDelay = delayArg ? Number(delayArg.split('=')[1]) : 3000;
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shotArg.slice('--shot='.length), img.toPNG());
          console.log('SHOT_OK');
        } catch (err) {
          console.error('shot failed:', err.message);
        }
        quitting = true;
        app.quit();
      }, shotDelay);
    }
  }).catch((err) => {
    console.error('startup failed:', err);
    dialog.showErrorBox('FluxDrop failed to start', String(err.message || err));
    app.exit(1);
  });

  app.on('activate', showWindow); // macOS dock click
  app.on('window-all-closed', () => { /* keep running in tray */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    if (discovery) discovery.stop();
    if (transferServer) transferServer.stop();
    if (signaling) signaling.stop();
  });
}
