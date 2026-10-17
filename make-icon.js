// Генерирует иконку приложения (build/icon.png + build/icon.ico) без внешних зависимостей.
// Запускается автоматически перед npm start / dist / release.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const C1 = hex('#7b3df5'), C2 = hex('#d08bff');

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
function inRound(px, py) {           // скруглённый квадрат 512x512
  const r = 116, hx = 248, qx = Math.abs(px - 256) - (hx - r), qy = Math.abs(py - 256) - (hx - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}
const K_SEGS = [[172, 124, 172, 388], [338, 124, 198, 256], [216, 236, 344, 388]];
const R_K = 31;

function sample(u, v) {              // цвет в точке (u,v) в координатах 512x512 -> [r,g,b,a]
  if (!inRound(u, v)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (u + v) / 1024));
  let c = [lerp(C1[0], C2[0], t), lerp(C1[1], C2[1], t), lerp(C1[2], C2[2], t)];
  const hl = Math.pow(Math.max(0, 1 - v / 300), 2) * 0.16;           // блик сверху
  c = c.map((x) => lerp(x, 255, hl));
  if (K_SEGS.some((s) => segDist(u, v, ...s) <= R_K)) c = [255, 255, 255];
  const d = Math.hypot(u - 410, v - 112);                               // «LIVE»-точка
  if (d <= 46) c = [26, 12, 52];
  if (d <= 33) c = [255, 59, 92];
  return [c[0], c[1], c[2], 255];
}

function render(size) {
  const SS = 4, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const s = sample(((x + (sx + .5) / SS) / size) * 512, ((y + (sy + .5) / SS) / size) * 512);
      r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
    }
    const o = (y * size + x) * 4, n = SS * SS;
    buf[o] = a ? r / a : 0; buf[o + 1] = a ? g / a : 0; buf[o + 2] = a ? b / a : 0; buf[o + 3] = a / n;
  }
  return buf;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = render(size), stride = size * 4, rows = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) { rows[y * (stride + 1)] = 0; raw.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sizes) {
  const imgs = sizes.map((s) => png(s));
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(off, 12); off += imgs[i].length; return e;
  });
  return Buffer.concat([head, ...dir, ...imgs]);
}

function ensure(force) {
  const dir = path.join(__dirname, 'build');
  const p = path.join(dir, 'icon.png'), i = path.join(dir, 'icon.ico');
  if (!force && fs.existsSync(p) && fs.existsSync(i)) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, png(512));
  fs.writeFileSync(i, ico([16, 32, 48, 64, 128, 256]));
  return true;
}
module.exports = { ensure };
if (require.main === module) { ensure(true); console.log('icon: build/icon.png + build/icon.ico готовы'); }
