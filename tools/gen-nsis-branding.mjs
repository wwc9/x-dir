// NSIS 安装器品牌图生成器：向导欢迎页左侧大图（sidebar 164×314）与内页顶部横幅
// （header 150×57），BMP-24bit（NSIS MUI2 要求，无压缩无 alpha）。
// 视觉与 src-tauri/icons 同源：九宫格渐变 logo（深海曙光：靛蓝→亮蓝→饱和青 对角渐变）的
// 几何与配色逐字复用 tools/gen-logo-icon.mjs，底色为应用画布同族的浅蓝白渐变——
// 安装向导默认视觉是 Tauri 官方 logo，此脚本产出 X-Dir 自己的品牌图交由
// tauri.conf.json → bundle.windows.nsis.{headerImage,sidebarImage} 引用。
// 运行：node tools/gen-nsis-branding.mjs（产物落 src-tauri/icons/，同时出 PNG 供预览）
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── 品牌几何与配色（与 gen-logo-icon.mjs 保持同源，改一处必须同步两处） ──────
const G = [4, 36, 68]; // 九宫格起点（96 视窗）
const CELL = 26; // 格子边长
// 「深海曙光」（2026-11-05 定案，方案 A）；与 gen-logo-icon.mjs / BrandLogo.tsx 同源
const STOPS = [
  [0.0, [0x24, 0x47, 0xe8]], // 靛蓝
  [0.5, [0x4f, 0x8b, 0xff]], // 亮蓝
  [1.0, [0x14, 0xcf, 0xdc]], // 饱和青
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
const RECTS = [];
for (const gx of G) for (const gy of G) RECTS.push([gx, gy, gx + CELL, gy + CELL]);
const gradAt = (x, y) => grad((x - 4 + (y - 4)) / 180); // 对角轴投影：(4,4)→(94,94)

// ── 画布：RGB 底色 + 纵向浅蓝白渐变 ────────────────────────────────────────────
function makeCanvas(w, h, top, bottom) {
  const buf = Buffer.alloc(w * h * 3);
  const rowCol = (y) => {
    const f = y / (h - 1);
    return top.map((c, i) => Math.round(c + (bottom[i] - c) * f));
  };
  for (let y = 0; y < h; y++) {
    const [r, g, b] = rowCol(y);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
    }
  }
  return buf;
}

/** 九宫格 logo 盖印：以 (x0,y0) 为左上角、边长 L 像素画入 RGB 画布。
 *  逐像素 96 空间精确覆盖率抗锯齿（面积法，同 gen-logo-icon），coverage 作 alpha
 *  与底色合成——BMP-24bit 无 alpha 通道，边缘在生成期就压平 */
function stampMark(canvas, w, h, x0, y0, L) {
  for (let py = Math.max(0, Math.floor(y0)); py < Math.min(h, Math.ceil(y0 + L)); py++) {
    for (let px = Math.max(0, Math.floor(x0)); px < Math.min(w, Math.ceil(x0 + L)); px++) {
      // 目标像素映射回 96 视窗的足迹
      const fx0 = ((px - x0) / L) * 96, fy0 = ((py - y0) / L) * 96;
      const fx1 = ((px + 1 - x0) / L) * 96, fy1 = ((py + 1 - y0) / L) * 96;
      let r = 0, g = 0, b = 0, cov = 0;
      for (const [rx0, ry0, rx1, ry1] of RECTS) {
        const ix0 = Math.max(fx0, rx0), iy0 = Math.max(fy0, ry0);
        const ix1 = Math.min(fx1, rx1), iy1 = Math.min(fy1, ry1);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        const area = ((ix1 - ix0) * (iy1 - iy0)) / ((fx1 - fx0) * (fy1 - fy0));
        const [cr, cg, cb] = gradAt((ix0 + ix1) / 2, (iy0 + iy1) / 2);
        r += cr * area; g += cg * area; b += cb * area; cov += area;
      }
      if (cov <= 0) continue;
      const o = (py * w + px) * 3;
      const bg = [canvas[o], canvas[o + 1], canvas[o + 2]];
      canvas[o] = Math.round((r / cov) * cov + bg[0] * (1 - cov));
      canvas[o + 1] = Math.round((g / cov) * cov + bg[1] * (1 - cov));
      canvas[o + 2] = Math.round((b / cov) * cov + bg[2] * (1 - cov));
    }
  }
}

// ── BMP-24bit 编码（BI_RGB、底-顶行序、行 4 字节对齐、RGB→BGR 通道交换） ──────
function encodeBMP24(rgb, w, h) {
  const rowRaw = w * 3;
  const rowPad = (4 - (rowRaw % 4)) % 4;
  const rowSize = rowRaw + rowPad;
  const pixSize = rowSize * h;
  const buf = Buffer.alloc(54 + pixSize);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(54 + pixSize, 2);
  buf.writeUInt32LE(54, 10); // 像素数据偏移
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22); // 正值 = 底-顶
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixSize, 34);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * rowRaw; // 翻转为底-顶
    for (let x = 0; x < w; x++) {
      const s = src + x * 3;
      const d = 54 + y * rowSize + x * 3;
      buf[d] = rgb[s + 2]; // B
      buf[d + 1] = rgb[s + 1]; // G
      buf[d + 2] = rgb[s]; // R
    }
  }
  return buf;
}

// ── PNG 编码（RGBA8，filter 0）——仅供人眼预览，不入打包配置 ──────────────────
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
function encodePNG(rgb, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = y * (w * 4 + 1) + 1 + x * 4;
      raw[d] = rgb[s]; raw[d + 1] = rgb[s + 1]; raw[d + 2] = rgb[s + 2]; raw[d + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── 产出 ─────────────────────────────────────────────────────────────────────
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
const BG_TOP = [0xef, 0xf4, 0xfe]; // 浅蓝白（画布同族）
const BG_BOTTOM = [0xdc, 0xe9, 0xfc];

// sidebar 164×314：欢迎页左侧整幅；logo 居中偏上，边长 96（与 96 视窗 1:1）
{
  const w = 164, h = 314;
  const c = makeCanvas(w, h, BG_TOP, BG_BOTTOM);
  stampMark(c, w, h, (w - 96) / 2, 64, 96);
  writeFileSync(join(OUT, "nsis-sidebar.bmp"), encodeBMP24(c, w, h));
  writeFileSync(join(OUT, "nsis-sidebar.preview.png"), encodePNG(c, w, h));
}

// header 150×57：内页顶部横幅（NSIS 默认渲染在右上）；小尺寸 logo，右置留边
{
  const w = 150, h = 57;
  const c = makeCanvas(w, h, BG_TOP, BG_BOTTOM);
  stampMark(c, w, h, w - 33 - 10, (h - 33) / 2, 33);
  writeFileSync(join(OUT, "nsis-header.bmp"), encodeBMP24(c, w, h));
  writeFileSync(join(OUT, "nsis-header.preview.png"), encodePNG(c, w, h));
}

console.log("OK → icons/nsis-sidebar.bmp(164×314) + nsis-header.bmp(150×57)（含 PNG 预览）");
