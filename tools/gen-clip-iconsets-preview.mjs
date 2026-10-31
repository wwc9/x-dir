// 剪贴板类型图标「字形」候选预览生成器 → design/clip-iconsets-preview.html
// 运行：node tools/gen-clip-iconsets-preview.mjs
// 与 gen-clip-icons-preview.mjs 同法：react-dom/server 渲染 Lucide → 内联 SVG。
// 本页聚焦字形选型（容器风格已定案：纯灰线性无底板），5 套组合 × 6 类型。
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const lucide = require("lucide-react");

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);

const svg = (name, size = 14) => {
  const C = lucide[name];
  if (!C) throw new Error(`lucide 缺少图标 ${name}`);
  return renderToStaticMarkup(React.createElement(C, { size, strokeWidth: 2 }));
};

/** 五套字形方案：key = 类型，值 = lucide 图标名 */
const SETS = [
  {
    id: "A",
    name: "现役基线",
    desc: "FileText / Link / FolderTree / Image / Files / Folder——文档框为主，当前线上形态",
    badge: "当前",
    icons: { text: "FileText", link: "Link", path: "FolderTree", image: "Image", files: "Files", dirs: "Folder" },
  },
  {
    id: "B",
    name: "内容形态（去文件框）",
    desc: "直接画内容本身：文字行 / 链环 / 路线 / 相机 / 单纸 / 闭夹——更轻、更现代",
    icons: { text: "AlignLeft", link: "Link2", path: "Route", image: "Camera", files: "File", dirs: "FolderClosed" },
  },
  {
    id: "C",
    name: "实物象形",
    desc: "便签 / 地球 / 硬盘 / 相框 / 叠层 / 开夹——「东西感」最强，辨识靠象形",
    icons: { text: "StickyNote", link: "Globe", path: "HardDrive", image: "Image", files: "Layers", dirs: "FolderOpen" },
  },
  {
    id: "D",
    name: "极简单形",
    desc: "T 字 / 链 / 定位钉 / 图框 / 双纸 / 文件夹——笔画最少，视觉最轻",
    icons: { text: "Type", link: "Link", path: "MapPin", image: "Image", files: "Copy", dirs: "Folder" },
  },
  {
    id: "E",
    name: "混搭（推荐）",
    desc: "Aa 字形 / 外链 / 目录树 / 图框 / 文件堆 / 开夹——文本用 Aa 最达意，其余取各家最强",
    badge: "推荐",
    icons: { text: "Text", link: "ExternalLink", path: "FolderTree", image: "Image", files: "FileStack", dirs: "FolderOpen" },
  },
];

const KINDS = [
  { k: "text", label: "文本", prev: "季度审计报告要点：收入确认与截止性测试样本…" },
  { k: "link", label: "链接", prev: "https://github.com/wwc9/x-dir" },
  { k: "path", label: "路径", prev: "E:\\Code\\AIProject\\x-dir\\REQUIREMENTS.md" },
  { k: "image", label: "图片", prev: "835×476 位图" },
  { k: "files", label: "文件", prev: "凭证汇总表.xlsx 等 3 项" },
  { k: "dirs", label: "文件夹", prev: "2026 年度底稿" },
];

const rowsOf = (set) =>
  KINDS.map(
    (kd, i) => `      <div class="row ${i % 2 === 1 ? "alt" : ""}">
        <span class="idx">${i + 1}</span>
        <span class="kcell">${svg(set.icons[kd.k])}</span>
        <span class="prev">${kd.prev}</span>
        <span class="right"><span class="meta">${kd.label}</span></span>
      </div>`,
  ).join("\n");

// 顶部大图对照（每套一行：6 类型的 24px 大图 + 名字）
const bigRow = (set) =>
  KINDS.map(
    (kd) =>
      `    <div class="big"><div class="bigicon">${svg(set.icons[kd.k], 22)}</div><div class="biglabel">${kd.label}<span class="en">${set.icons[kd.k]}</span></div></div>`,
  ).join("\n");

const cards = SETS.map(
  (set) => `  <div class="card${set.badge === "推荐" ? " recommend" : ""}">
    <div class="head"><b>${set.id}. ${set.name}</b>${set.badge ? `<span class="pill">${set.badge}</span>` : ""}</div>
    <div class="bigs">
${bigRow(set)}
    </div>
    <div class="desc">${set.desc}</div>
    <div class="list">
${rowsOf(set)}
    </div>
  </div>`,
).join("\n");

const html = `<!DOCTYPE html>
<html lang="zh-CN" class="">
<head>
<meta charset="UTF-8">
<title>x-dir · 剪贴板类型图标字形候选（5 套）</title>
<style>
  :root {
    --surface:#ffffff; --surface2:#f0f2f5; --border:#d6dbe2; --hairline:rgba(16,24,40,.06);
    --fg:#1a2129; --muted:#8b929c; --sel:rgba(53,116,240,.12); --hover:rgba(26,33,41,.055);
    --stripe:rgba(26,33,41,.05); --radius:6px; --accent:#3574f0;
  }
  html.dark {
    --surface:#1b1e23; --surface2:#24282f; --border:#3a414b; --hairline:rgba(255,255,255,.08);
    --fg:#e8eaed; --muted:#8b929c; --sel:rgba(92,157,255,.16); --hover:rgba(255,255,255,.055);
    --stripe:rgba(255,255,255,.04); --accent:#5c9dff;
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--surface2); color:var(--fg); font:13px/1.45 system-ui,"Segoe UI","Microsoft YaHei",sans-serif; padding:28px 34px 40px; }
  h1 { font-size:17px; }
  .sub { color:var(--muted); margin:6px 0 4px; }
  .toggle { margin:10px 0 20px; padding:3px 12px; border:1px solid var(--border); border-radius:999px;
    background:var(--surface); color:var(--fg); cursor:pointer; font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(430px, 1fr)); gap:14px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 12px 10px; position:relative; }
  .card.recommend { outline:2px solid var(--accent); }
  .head { display:flex; align-items:center; gap:8px; font-size:13px; margin-bottom:8px; }
  .pill { font-size:10px; color:#fff; background:var(--accent); border-radius:999px; padding:1px 8px; }
  .bigs { display:flex; flex-wrap:wrap; gap:10px 16px; padding:10px 4px; border:1px dashed var(--border);
    border-radius:8px; margin-bottom:8px; background:var(--surface2); }
  .big { display:flex; flex-direction:column; align-items:center; width:74px; }
  .bigicon { color:var(--fg); display:flex; }
  .biglabel { font-size:11px; margin-top:3px; text-align:center; color:var(--fg); }
  .biglabel .en { display:block; color:var(--muted); font-size:10px; font-family:ui-monospace,Consolas,monospace; }
  .desc { color:var(--muted); font-size:11px; line-height:1.5; margin:0 0 10px; }
  .list { border:1px solid var(--hairline); border-radius:8px; overflow:hidden; }
  .row { display:flex; align-items:center; gap:7px; padding:3px 8px; min-height:28px; }
  .row.alt { background:var(--stripe); }
  .idx { width:24px; text-align:center; margin-right:-4px; color:var(--muted); font-size:11px; font-variant-numeric:tabular-nums; }
  .kcell { flex:none; display:inline-flex; width:18px; height:18px; align-items:center; justify-content:center; color:var(--muted); }
  .prev { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .right { flex:none; width:44px; display:flex; justify-content:flex-end; }
  .meta { font-size:11px; color:var(--muted); }
</style>
</head>
<body>
  <h1>剪贴板类型图标 · 字形候选（5 套）</h1>
  <div class="sub">容器风格已定案（纯灰线性、无底板无角标），本页只选「画什么」：每套覆盖全部 6 类型。上区为 22px 大图对照（附 lucide 图标名），下区为仿真行内效果（与浮窗当前行样式一致）。挑好后告诉我方案编号（A–E），可跨方案混搭（报 类型=图标名 即可）。</div>
  <button class="toggle" onclick="document.documentElement.classList.toggle('dark')">浅 / 深切换</button>
  <div class="grid">
${cards}
  </div>
</body>
</html>
`;

const out = path.join(root, "design", "clip-iconsets-preview.html");
fs.writeFileSync(out, html, "utf8");
console.log(`生成 ${out}（${SETS.length} 套字形方案 × ${KINDS.length} 类型）`);
