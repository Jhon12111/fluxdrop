# FluxDrop

**Download: [fluxdrop-hazel.vercel.app](https://fluxdrop-hazel.vercel.app)**

Universal high-speed LAN file transfer for **Windows** and **macOS**.
Transfer files and folders between any computers on the same Wi‑Fi / network at
full link speed — no internet, no cables, no size limits.

## Features

- **Auto discovery** — every computer running FluxDrop on the same network
  appears automatically (UDP broadcast, no setup).
- **High speed** — 4 parallel TCP streams pulling 8 MB chunks from a shared work
  queue, so a single large file parallelises just as well as many small ones
  (800+ MB/s measured loopback).
- **Approve incoming files** — you get a desktop notification and an in-app
  prompt showing who is sending, what, and how big. Nothing is written until you
  accept. Tick **Always allow** to trust a device and skip the prompt next time.
- **Cancel any time** — both sender and receiver can cancel from the transfer
  list; partial files are removed automatically.
- **Connect by IP** — if a device doesn't appear automatically (firewall,
  unusual network), reach it directly by typing its IP address.
- **Clear history** — one click removes finished transfers from the list.
- Received files go to your chosen folder (default: `Downloads/FluxDrop`).
  Folder structure is preserved; duplicate names get ` (1)` suffixes.
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

## Protocol (v2)

- **Discovery**: UDP broadcast on port `52130`, JSON heartbeat every 2 s,
  peers expire after 7 s. `bye` packet on shutdown.
- **Transfer**: TCP on port `52131` (falls back to an ephemeral port, which is
  advertised in the discovery packet). Length-prefixed JSON control frames.
  - control socket: `offer` → `accept`/`reject` → chunk headers + payload → `done`
  - data sockets: `join` → chunk headers + payload
  - Every file is split into 8 MB chunks pulled from one shared work queue by
    all 4 streams; the receiver writes each chunk at its absolute offset.
- Receiver sanitizes all paths (no `..`, no absolute paths, Windows-invalid
  characters stripped) and never executes anything it receives.

## Speed notes

Throughput is capped by the slowest link between the two computers:

| Link | Realistic ceiling |
| --- | --- |
| 100 Mbit ethernet port | ~12 MB/s |
| 2.4 GHz Wi‑Fi | ~2–8 MB/s |
| 5 GHz Wi‑Fi (Wi‑Fi 5) | ~40–70 MB/s |
| Gigabit ethernet | ~110 MB/s |
| 2.5G+ ethernet / Wi‑Fi 6E | 250 MB/s+ |

If you are seeing ~12 MB/s, one of the two machines (or the router port it is
plugged into) is almost certainly negotiating a 100 Mbit link — check the
adapter's link speed. For maximum throughput use wired gigabit ethernet, or
5 GHz / Wi‑Fi 6 with both devices near the router.

Both machines must be on the same network, and the network must allow
peer-to-peer traffic (some guest/hotel Wi‑Fi networks isolate clients).
