'use strict';
/* Generates build/icon.png (256), build/icon.ico and build/tray.png (32)
 * with zero dependencies: minimal PNG encoder + PNG-compressed ICO. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------ PNG encoder */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------------------------------------------------------- drawing */

// lightning bolt polygon, in 0..1 space
const BOLT = [
  [0.58, 0.10], [0.32, 0.55], [0.47, 0.55], [0.40, 0.90], [0.69, 0.42], [0.53, 0.42],
];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const SS = 3; // supersampling
  const c1 = [79, 140, 255];   // #4f8cff
  const c2 = [157, 92, 255];   // #9d5cff

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;      // rounded-rect coverage
      let boltCov = 0;  // bolt coverage
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // rounded rect test
          const cx = Math.max(radius, Math.min(size - radius, px));
          const cy = Math.max(radius, Math.min(size - radius, py));
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy <= radius * radius) {
            cov += 1;
            if (pointInPolygon(px / size, py / size, BOLT)) boltCov += 1;
          }
        }
      }
      cov /= SS * SS;
      boltCov /= SS * SS;
      if (cov === 0) continue;
      const t = (x + y) / (2 * size);
      const base = [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
      const off = (y * size + x) * 4;
      rgba[off] = Math.round(lerp(base[0], 255, boltCov));
      rgba[off + 1] = Math.round(lerp(base[1], 255, boltCov));
      rgba[off + 2] = Math.round(lerp(base[2], 255, boltCov));
      rgba[off + 3] = Math.round(cov * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

/* -------------------------------------------------------------------- ICO */

function makeIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, pngBuf]);
}

/* ------------------------------------------------------------------- main */

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const png256 = drawIcon(256);
const png32 = drawIcon(32);

fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeIco(png256, 256));
fs.writeFileSync(path.join(outDir, 'tray.png'), png32);
console.log('icons written to', outDir);
