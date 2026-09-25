// Generates the extension's PNG icons (a blue tile with a white "side panel" glyph)
// without any image dependencies. Run with `npm run icons`.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function render(size) {
  const ss = 4; // supersampling for smooth edges
  const px = Buffer.alloc(size * size * 4);
  const blue = [11, 92, 171];
  const white = [255, 255, 255];
  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, rr = 0, gg = 0, bb = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          if (!inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.2)) continue;
          // Window outline with a side panel on the right.
          const inWindow = inRoundRect(u, v, 0.18, 0.24, 0.82, 0.76, 0.06);
          const inInner = inRoundRect(u, v, 0.25, 0.31, 0.75, 0.69, 0.02);
          const inPanel = u >= 0.56 && u <= 0.75 && v >= 0.31 && v <= 0.69;
          const glyph = inWindow && (!inInner || inPanel);
          const c = glyph ? white : blue;
          a += 1; rr += c[0]; gg += c[1]; bb += c[2];
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      if (a) { px[i] = rr / a; px[i + 1] = gg / a; px[i + 2] = bb / a; }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(outDir, `icon-${size}.png`), render(size));
}
console.log('Icons written to public/icons');
