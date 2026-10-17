// 品牌图标生成器：渲染 v9-4 号九宫格渐变 logo（亮蓝→天蓝→冰蓝 对角渐变，直角九宫格）
// 并产出 src-tauri/icons/ 全套资产（PNG / ICO / ICNS）。
// 运行：node tools/gen-logo-icon.mjs
// 渲染为解析式（轴对齐矩形精确覆盖率抗锯齿），无外部依赖。

import { writeFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ── 品牌几何（96 视框）与配色 ──
const G = [4, 36, 68]; // 格子起点
const CELL = 26; // 格子边长
const STOPS = [
  [0.0, [0x35, 0x74, 0xf0]], // 亮蓝（主色）
  [0.5, [0x5c, 0x9d, 0xff]], // 天蓝（暗色主题强调）
  [1.0, [0xba, 0xe2, 0xfd]], // 冰蓝
];

function grad(t) {
  t = Math.min(1, Math.max(0, t));
  for (let k = 0; k < STOPS.length - 1; k++) {
    const [o0, c0] = STOPS[k];
    const [o1, c1] = STOPS[k + 1];
    if (t <= o1) {
      const f = (t - o0) / (o1 - o0);
      return c0.map((v, i) => Math.round(v + (c1[i] - v) * f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// 单个像素（96 空间中的正方形 [px, px+foot)）与九宫格的精确覆盖率合成。
// 格子互不重叠且轴对齐：面积法即精确抗锯齿。
function renderRGBA(size) {
  const foot = 96 / size;
  const out = Buffer.alloc(size * size * 4);
  const rects = [];
  for (const gx of G) for (const gy of G) rects.push([gx, gy, gx + CELL, gy + CELL]);
  const gradAt = (x, y) => grad((x - 4 + (y - 4)) / 180); // 对角轴投影：(4,4)→(94,94)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x0 = px * foot, y0 = py * foot, x1 = x0 + foot, y1 = y0 + foot;
      let r = 0, g = 0, b = 0, cov = 0;
      for (const [rx0, ry0, rx1, ry1] of rects) {
        const ix0 = Math.max(x0, rx0), iy0 = Math.max(y0, ry0);
        const ix1 = Math.min(x1, rx1), iy1 = Math.min(y1, ry1);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        const area = ((ix1 - ix0) * (iy1 - iy0)) / (foot * foot);
        const [cr, cg, cb] = gradAt((ix0 + ix1) / 2, (iy0 + iy1) / 2);
        r += cr * area; g += cg * area; b += cb * area; cov += area;
      }
      const o = (py * size + px) * 4;
      out[o] = Math.round(r / cov); out[o + 1] = Math.round(g / cov);
      out[o + 2] = Math.round(b / cov); out[o + 3] = Math.round(cov * 255);
    }
  }
  return out;
}

// ── PNG 编码（RGBA8，filter 0） ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO / ICNS 容器 ──
function encodeICO(pngs) {
  // pngs: [{ size, data(PNG) }]；256 的宽高字段写 0
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((it, i) => {
    const e = dir.subarray(i * 16, i * 16 + 16);
    e[0] = it.size >= 256 ? 0 : it.size;
    e[1] = it.size >= 256 ? 0 : it.size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(it.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += it.data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((it) => it.data)]);
}
function encodeICNS(pngs) {
  // pngs: [{ type, data }]；ic07=128 ic08=256 ic09=512 ic10=1024
  const chunks = pngs.map((it) => {
    const head = Buffer.from(it.type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(it.data.length + 8);
    return Buffer.concat([head, len, it.data]);
  });
  const total = chunks.reduce((n, c) => n + c.length, 0) + 8;
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

// ── 产出 ──
const OUT = new URL("../src-tauri/icons/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const png = (size) => encodePNG(renderRGBA(size), size);

const iconSizes = [16, 20, 24, 32, 48, 64, 128, 256];
const ico = encodeICO(iconSizes.map((s) => ({ size: s, data: png(s) })));
writeFileSync(OUT + "icon.ico", ico);

for (const s of [32, 128, 256]) {
  const name = s === 256 ? "128x128@2x.png" : `${s}x${s}.png`;
  writeFileSync(OUT + name, png(s));
}

// icon.png / StoreLogo.png 沿用旧文件尺寸
function oldSize(file) {
  try {
    const b = readFileSync(OUT + file);
    return b.readUInt32BE(16);
  } catch {
    return 0;
  }
}
const iconPngSize = oldSize("icon.png") || 512;
writeFileSync(OUT + "icon.png", png(iconPngSize));

const storeOld = oldSize("StoreLogo.png");
if (storeOld) writeFileSync(OUT + "StoreLogo.png", png(storeOld));
for (const n of [30, 44, 71, 89, 107, 142, 150, 284, 310])
  writeFileSync(OUT + `Square${n}x${n}Logo.png`, png(n));

// icns：ic07(128) ic08(256) ic09(512) ic10(1024)
const icns = encodeICNS([
  { type: "ic07", data: png(128) },
  { type: "ic08", data: png(256) },
  { type: "ic09", data: png(512) },
  { type: "ic10", data: png(1024) },
]);
writeFileSync(OUT + "icon.icns", icns);

console.log(
  `OK → icons/ 更新：icon.ico(${ico.length}B, ${iconSizes.join("/")}) ` +
  `icon.png(${iconPngSize}) StoreLogo(${storeOld || "skip"}) icns(${icns.length}B)`,
);
