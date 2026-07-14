# FluxDrop

Universal high-speed LAN file transfer for **Windows** and **macOS**.
Transfer files and folders between any computers on the same Wi‑Fi / network at
full link speed — no internet, no cables, no size limits.

## Features

- **Auto discovery** — every computer running FluxDrop on the same network
  appears automatically (UDP broadcast, no setup).
- **High speed** — raw TCP streaming with 4 MB chunks; saturates gigabit Wi‑Fi
  and wired links (800+ MB/s measured loopback).
- **Zero-friction receive** — incoming files are accepted automatically and
  saved to your chosen folder (default: `Downloads/FluxDrop`). Folder structure
  is preserved; duplicate names get ` (1)` suffixes.
- **Cross-platform** — Windows ⇄ Windows, Mac ⇄ Mac, Windows ⇄ Mac.
- **Background agent** — closing the window hides it to the system tray; the
  app keeps receiving. Optional start-at-login.
- **Drag & drop** — drop files onto a device card, or use Send Files /
  Send Folder buttons.

## Development

```bash
npm install
npm test        # core engine selftest (transfer + integrity + discovery)
npm start       # run the app
```

## Building installers

```bash
npm run icons     # regenerate icons (no dependencies needed)
npm run dist      # Windows NSIS installer  -> release/FluxDrop-Setup-*.exe
npm run dist:mac  # macOS DMG (must be run on a Mac) -> release/FluxDrop-*.dmg
```

The Windows installer adds a firewall allow-rule for private networks when it
runs elevated; otherwise Windows shows its standard one-time firewall prompt on
first launch — click **Allow** on *Private networks*.

## Protocol (v1)

- **Discovery**: UDP broadcast on port `52130`, JSON heartbeat every 2 s,
  peers expire after 7 s. `bye` packet on shutdown.
- **Transfer**: TCP on port `52131` (falls back to an ephemeral port, which is
  advertised in the discovery packet). Length-prefixed JSON control frames
  (`offer` → `accept` → raw payload → `done`), then the raw bytes of every
  file in manifest order.
- Receiver sanitizes all paths (no `..`, no absolute paths, Windows-invalid
  characters stripped) and never executes anything it receives.

## Notes

- Both machines must be on the same network, and the network must allow
  peer-to-peer traffic (some guest/hotel Wi‑Fi networks isolate clients).
- Speed is limited by the slowest link — for multi-gigabit transfers use
  wired Ethernet or Wi‑Fi 6/6E/7.
