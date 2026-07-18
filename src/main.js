'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Discovery, TransferServer, sendPaths, primaryLocalIP, DEFAULT_TRANSFER_PORT } = require('./core');

const SMOKE = process.argv.includes('--smoke');
const START_HIDDEN = process.argv.includes('--hidden');

let win = null;
let tray = null;
let discovery = null;
let transferServer = null;
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

async function startNetwork() {
  transferServer = new TransferServer({
    getDownloadDir: () => settings.downloadDir,
    shouldAccept: askApproval,
  });
  transferServer.on('transfer', pushTransfer);
  transferServer.on('error', (err) => console.error('transfer server:', err.message));
  const port = await transferServer.start(DEFAULT_TRANSFER_PORT);

  discovery = new Discovery({
    id: settings.deviceId,
    name: settings.deviceName,
    platform: process.platform === 'darwin' ? 'mac' : (process.platform === 'win32' ? 'windows' : 'linux'),
    transferPort: port,
  });
  discovery.on('update', pushDevices);
  discovery.on('error', (err) => console.error('discovery:', err.message));
  await discovery.start();
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
    await startNetwork();
    setupIpc();
    createWindow();
    createTray();

    if (SMOKE) {
      setTimeout(() => {
        console.log('SMOKE_OK port=' + transferServer.port);
        quitting = true;
        app.quit();
      }, 4000);
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
  });
}
