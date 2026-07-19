# Contributing to FluxDrop

Thanks for your interest in improving FluxDrop! It's a small, dependency-free
Electron app for high-speed LAN file transfer, chat, and voice calls between
Windows and macOS. Contributions of all kinds are welcome — bug fixes, features,
docs, and testing on real hardware.

## Getting started

```bash
git clone https://github.com/Jhon12111/fluxdrop.git
cd fluxdrop
npm install
npm start          # launch the app
```

Requirements: **Node.js 18+** and npm. No other system dependencies.

## Project layout

| Path | What it is |
|------|------------|
| `src/core.js` | Discovery (UDP multicast + broadcast) and the parallel-stream file transfer engine. **No Electron imports — plain Node, unit-testable.** |
| `src/signal.js` | Always-on TCP signaling channel used for chat and call setup. Also Electron-free. |
| `src/main.js` | Electron main process: window, tray, IPC, notifications, auto-update check. |
| `src/preload.js` | The `flux` bridge exposed to the renderer (contextIsolation on). |
| `src/renderer/` | UI. `app.js` (devices/transfers/settings), `comms.js` (chat + WebRTC voice), `app.css`, `index.html`. |
| `test/` | `selftest.js`, `cancel-hang.js` (run by `npm test`) plus manual harnesses. |

## Running the tests

```bash
npm test           # protocol self-test + cancel regression test
npm run smoke      # boots the app headless, prints SMOKE_OK, exits
```

`node test/fakepeer.js` pretends to be a second computer on the LAN and sends a
file to your running app, so you can exercise the approval UI with one machine.

## How it works (quick tour)

- **Discovery** — each device broadcasts *and* multicasts a heartbeat on UDP
  52130. Multicast matters because many Wi-Fi access points drop client-to-client
  broadcast, which is why two devices on the same Wi-Fi may not otherwise see
  each other.
- **Transfer** — a control socket negotiates `offer → accept/reject`, then 4
  parallel TCP streams pull 8 MB chunks from one shared queue (port 52131).
- **Chat & calls** — a persistent TCP signaling channel (port 52132) carries
  text messages and WebRTC SDP/ICE. Audio itself flows peer-to-peer over WebRTC
  with LAN host candidates (no STUN/TURN server).

## Guidelines

- Keep `core.js` and `signal.js` free of Electron imports so they stay testable.
- No new runtime dependencies without discussion — zero-dep is a design goal.
- Add or update a test when you fix a bug or add behavior to the engine.
- Match the existing code style (2-space indent, `'use strict'`, small helpers).
- Run `npm test` and `npm run smoke` before opening a PR.

## Reporting bugs

Open an issue with your OS/versions, steps to reproduce, and whether both
devices are on the **same** network. Network/firewall details help a lot for
discovery problems.

## License

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
