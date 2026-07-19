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
- **Text chat** — message any device on the network right from its card; a
  desktop notification and unread badge appear when the window isn't focused.
- **Voice calls** — call another device over Wi‑Fi. The receiver gets a ringing
  prompt and can Accept or Decline; audio flows peer-to-peer over WebRTC (no
  server). Either side can hang up any time (button or `Esc`).
- **Update alerts** — FluxDrop checks GitHub for new releases and shows a banner
  and notification when one is available. Nothing installs automatically; you
  choose when to download. Also under Settings → *Check for updates*.

## Discovery / reliability

Discovery uses UDP **multicast** (group `239.255.42.130`) alongside broadcast.
Many Wi‑Fi access points silently drop client-to-client broadcast, which is the
usual reason a Mac and a PC on the same Wi‑Fi don't see each other; multicast is
forwarded far more reliably. If a device still doesn't appear, use **Connect by
IP** and check both firewalls.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for a full tour of the codebase.

```bash
npm install
npm test        # engine selftest (transfer + integrity + discovery) + cancel regression
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

- **Discovery**: UDP multicast (`239.255.42.130`) + broadcast on port `52130`,
  JSON heartbeat every 2 s, peers expire after 7 s. `bye` packet on shutdown.
- **Transfer**: TCP on port `52131` (falls back to an ephemeral port, which is
  advertised in the discovery packet). Length-prefixed JSON control frames.
  - control socket: `offer` → `accept`/`reject` → chunk headers + payload → `done`
  - data sockets: `join` → chunk headers + payload
  - Every file is split into 8 MB chunks pulled from one shared work queue by
    all 4 streams; the receiver writes each chunk at its absolute offset.
- **Signaling** (chat + calls): TCP on port `52132`, length-prefixed JSON. First
  frame is a `hello` with the device id; then `chat` and `call-*` frames
  (`call-invite`/`accept`/`reject`/`ice`/`hangup`). Voice media is WebRTC
  peer-to-peer with LAN host candidates (no STUN/TURN).
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

## Contributing

FluxDrop is open source and contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm test` and `npm run smoke`
before opening a pull request.

## License

[MIT](LICENSE) © Ashik Mahmud
