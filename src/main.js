'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage } = require('electron');
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

/* ---------------------------------------------------------------- settings */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

let settings = null;

function loadSettings() {
  const defaults = {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    downloadDir: path.join(app.getPath('downloads'), 'FluxDrop'),
    autoLaunch: true,
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

async function startNetwork() {
  transferServer = new TransferServer({
    getDownloadDir: () => settings.downloadDir,
    selfId: settings.deviceId,
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

/* --------------------------------------------------------------------- IPC */

function setupIpc() {
  ipcMain.handle('get-state', () => ({
    settings: {
      deviceName: settings.deviceName,
      downloadDir: settings.downloadDir,
      autoLaunch: settings.autoLaunch,
    },
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
    if (entry) entry.cancel();
    return { ok: !!entry };
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

    const shotArg = process.argv.find((a) => a.startsWith('--shot='));
    if (shotArg) {
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
      }, 3000);
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
