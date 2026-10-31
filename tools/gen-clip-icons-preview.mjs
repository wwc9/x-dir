// 剪贴板类型图标风格候选预览生成器 → design/clip-icons-preview.html
// 运行：node tools/gen-clip-icons-preview.mjs
// 原理同 gen-file-icon-preview.mjs：react-dom/server 把 Lucide 组件渲成 SVG 内联。
// 用户在页面上挑选风格编号后，应用到 src/clip/ClipHistWindow.tsx + index.css。
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

// 主字形（现役）与替换字形（字形对照候选）
const G = {
  text: svg("FileText"),
  image: svg("Image"),
  files: svg("Files"),
  dirs: svg("Folder"),
  textAlt: svg("Type"),
  imageAlt: svg("Camera"),
  filesAlt: svg("FileStack"),
  dirsAlt: svg("FolderClosed"),
};

/** 候选：每项 { id, name, desc, badge?, cell(kind) → 图标格 HTML, rowCls? } */
const VARIANTS = [
  {
    id: 1,
    name: "现状（改造前）",
    desc: "muted 灰线性图标，无底板——对照基线",
    badge: "当前前",
    cell: (k) => `<span class="kcell bare">${G[k]}</span>`,
  },
  {
    id: 2,
    name: "语义色线性",
    desc: "仅给图标上类型色，无底板；最轻的彩色方案",
    cell: (k) => `<span class="kcell bare" style="color:var(--k)">${G[k]}</span>`,
  },
  {
    id: 3,
    name: "淡染方底 + 语义色图标",
    desc: "类型色 12% 淡染圆角方底 + 同色线图标；徽章感强、彩色但不刺眼",
    badge: "推荐",
    cell: (k) => `<span class="kcell box tint">${G[k]}</span>`,
  },
  {
    id: 4,
    name: "实心方底 + 白图标",
    desc: "类型色实底 + 白线图标（iOS 文件 App 风）；最重、最醒目",
    cell: (k) => `<span class="kcell box solid">${G[k]}</span>`,
  },
  {
    id: 5,
    name: "淡染圆底 + 语义色图标",
    desc: "同 3 但圆底；更圆润，与 pill 设计语言呼应",
    cell: (k) => `<span class="kcell box tint round">${G[k]}</span>`,
  },
  {
    id: 6,
    name: "实心圆底 + 白图标",
    desc: "同 4 但圆底；圆点徽章放大版",
    cell: (k) => `<span class="kcell box solid round">${G[k]}</span>`,
  },
  {
    id: 7,
    name: "描边方底 + 语义色图标",
    desc: "透明底 + 类型色 1px 描边；边界清晰、底色干净",
    cell: (k) => `<span class="kcell box outline">${G[k]}</span>`,
  },
  {
    id: 8,
    name: "填充式图标",
    desc: "图标整体填充类型色（无底板）；体量介于线性与实底之间",
    cell: (k) => `<span class="kcell bare filled">${G[k]}</span>`,
  },
  {
    id: 9,
    name: "左缘色条 + 灰图标",
    desc: "行左缘 3px 类型色条（不占图标位）+ 现状灰图标；类型信息靠色条",
    rowCls: "rowbar",
    cell: (k) => `<span class="kcell bare">${G[k]}</span>`,
  },
  {
    id: 10,
    name: "灰图标 + 色点角标",
    desc: "现状灰图标右下角叠类型色小点；改动最小的一档彩色",
    cell: (k) => `<span class="kcell dotwrap">${G[k]}</span>`,
  },
  {
    id: 11,
    name: "换字形对照",
    desc: "淡染方底（同 3）+ 替换字形：T 字 / 相机 / 文件堆 / 关闭文件夹",
    cell: (k) => `<span class="kcell box tint">${G[`${k}Alt`]}</span>`,
  },
  {
    id: 12,
    name: "配色 B：文本也上色",
    desc: "同 3 容器，但文本改文档蓝（灰→蓝）；彩色更满 vs 文本类低调",
    cell: (k) =>
      `<span class="kcell box tint${k === "text" ? " paletteB" : ""}">${G[k]}</span>`,
  },
];

const KINDS = [
  { k: "text", label: "文本", prev: "季度审计报告要点：收入确认与截止性测试样本…", meta: "文本 · 刚刚 · 1.2 KB" },
  { k: "image", label: "图片", prev: "835×476 位图", meta: "图片 · 3 分钟前 · 225.0 KB" },
  { k: "files", label: "文件", prev: "凭证汇总表.xlsx 等 3 项", meta: "文件 · 11 分钟前 · 93 B" },
  { k: "dirs", label: "文件夹", prev: "2026 年度底稿", meta: "文件夹 · 1 小时前 · 51 B" },
];

const rowsOf = (v) =>
  KINDS.map(
    (kd, i) => `      <div class="row ${i % 2 === 1 ? "alt" : ""} ${v.rowCls ?? ""}" style="--k: var(--k-${kd.k})">
        <span class="idx">${i + 1}</span>
        ${v.cell(kd.k)}
        <span class="prev">${kd.prev}</span>
        <span class="meta">${kd.meta}</span>
      </div>`,
  ).join("\n");

const cards = VARIANTS.map(
  (v) => `  <div class="card${v.badge === "推荐" ? " recommend" : ""}">
    <div class="head"><b>${v.id}. ${v.name}</b>${v.badge ? `<span class="pill">${v.badge}</span>` : ""}</div>
    <div class="desc">${v.desc}</div>
    <div class="list">
${rowsOf(v)}
    </div>
  </div>`,
).join("\n");

// 图片行的徽章处理对照（缩略图与徽章并存的三种方式）
const thumbSection = `
  <h2 style="margin:34px 0 12px">图片行：徽章与大缩略图的相处方式</h2>
  <div class="grid">
    <div class="card"><div class="head"><b>A. 徽章独立列</b><span class="pill">已应用</span></div>
      <div class="desc">序号后先徽章后缩略图，各占其位；结构最直白，行稍宽</div>
      <div class="list">
        <div class="row" style="--k: var(--k-image)">
          <span class="idx">1</span><span class="kcell box tint">${G.image}</span>
          <span class="thumb"></span><span class="prev">835×476 位图</span><span class="meta">图片 · 刚刚</span>
        </div>
      </div>
    </div>
    <div class="card"><div class="head"><b>B. 徽章叠缩略图角</b></div>
      <div class="desc">小徽章叠在缩略图左上角；省一列宽度，徽章略小</div>
      <div class="list">
        <div class="row" style="--k: var(--k-image)">
          <span class="idx">1</span>
          <span class="thumb"><span class="kcell box tint overlay">${G.image}</span></span>
          <span class="prev">835×476 位图</span><span class="meta">图片 · 刚刚</span>
        </div>
      </div>
    </div>
    <div class="card"><div class="head"><b>C. 缩略图即类型</b></div>
      <div class="desc">图片行不放徽章（缩略图本身即类型信息，meta 有文字）；其余类型才有徽章</div>
      <div class="list">
        <div class="row" style="--k: var(--k-image)">
          <span class="idx">1</span>
          <span class="thumb"></span><span class="prev">835×476 位图</span><span class="meta">图片 · 刚刚</span>
        </div>
      </div>
    </div>
  </div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN" class="">
<head>
<meta charset="UTF-8">
<title>x-dir · 剪贴板类型图标风格候选</title>
<style>
  /* 与 index.css 同源取值（--np-* 摘录；改主样式时同步此处） */
  :root {
    --surface:#ffffff; --surface2:#f0f2f5; --border:#d6dbe2; --hairline:rgba(16,24,40,.06);
    --fg:#1a2129; --muted:#8b929c; --sel:rgba(53,116,240,.12); --hover:rgba(26,33,41,.055);
    --stripe:rgba(26,33,41,.05); --radius:6px;
    --k-text:#8a93a0; --k-image:#4586f0; --k-files:#e07817; --k-dirs:#d6a01a;
  }
  html.dark {
    --surface:#1b1e23; --surface2:#24282f; --border:#3a414b; --hairline:rgba(255,255,255,.08);
    --fg:#e8eaed; --muted:#8b929c; --sel:rgba(92,157,255,.16); --hover:rgba(255,255,255,.055);
    --stripe:rgba(255,255,255,.04);
    --k-text:#8b929c; --k-image:#4586f0; --k-files:#e07817; --k-dirs:#e5a922;
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--surface2); color:var(--fg); font:13px/1.45 system-ui,"Segoe UI","Microsoft YaHei",sans-serif; padding:28px 34px 40px; }
  h1 { font-size:17px; }
  .sub { color:var(--muted); margin:6px 0 4px; }
  .toggle { margin:10px 0 20px; padding:3px 12px; border:1px solid var(--border); border-radius:999px;
    background:var(--surface); color:var(--fg); cursor:pointer; font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 12px 10px; position:relative; }
  .card.recommend { outline:2px solid var(--k-image); }
  .head { display:flex; align-items:center; gap:8px; font-size:13px; }
  .pill { font-size:10px; color:#fff; background:var(--k-image); border-radius:999px; padding:1px 8px; }
  .desc { color:var(--muted); font-size:11px; line-height:1.5; margin:6px 0 10px; min-height:32px; }
  .list { border:1px solid var(--hairline); border-radius:8px; overflow:hidden; }
  .row { display:flex; align-items:center; gap:7px; padding:3px 8px; min-height:28px; }
  .row.alt { background:var(--stripe); }
  .row.rowbar { border-left:3px solid var(--k); padding-left:5px; }
  .idx { width:24px; text-align:center; color:var(--muted); font-size:11px; font-variant-numeric:tabular-nums; }
  .prev { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .meta { color:var(--muted); font-size:11px; white-space:nowrap; }
  /* 图标格：各风格的容器与着色 */
  .kcell { flex:none; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; }
  .kcell.bare { color:var(--muted); }
  .kcell.box { border-radius:var(--radius); }
  .kcell.tint { background:color-mix(in srgb, var(--k) 12%, transparent); color:var(--k); }
  .kcell.solid { background:var(--k); color:#fff; }
  .kcell.outline { border:1px solid var(--k); color:var(--k); }
  .kcell.round { border-radius:999px; }
  .kcell.filled { color:var(--k); }
  .kcell.filled svg { fill:var(--k); }
  .kcell.paletteB { --k:#3c6fb8; background:color-mix(in srgb, #3c6fb8 12%, transparent); }
  .kcell.dotwrap { position:relative; }
  .kcell.dotwrap::after { content:""; position:absolute; right:-1px; bottom:-1px; width:6px; height:6px;
    border-radius:999px; background:var(--k); border:1.5px solid var(--surface); }
  .thumb { flex:none; width:88px; height:52px; border-radius:var(--radius); background:var(--surface2); position:relative; }
  .thumb.overlay { position:relative; }
  .kcell.overlay { position:absolute; left:2px; top:2px; width:14px; height:14px; background:var(--surface); }
  .kcell.overlay svg { width:10px; height:10px; }
</style>
</head>
<body>
  <h1>剪贴板条目类型图标 · 风格候选</h1>
  <div class="sub">四种类型（文本 / 图片 / 文件 / 文件夹）× 12 种风格；类型色取自 --np-icon-* 语义色族（文本=灰 / 图片=蓝 / 文件=橙 / 文件夹=金）。挑好后告诉我编号（容器风格 + 图片行处理）即可应用到浮窗。</div>
  <button class="toggle" onclick="document.documentElement.classList.toggle('dark')">浅 / 深切换</button>
  <div class="grid">
${cards}
  </div>
${thumbSection}
</body>
</html>
`;

const out = path.join(root, "design", "clip-icons-preview.html");
fs.writeFileSync(out, html, "utf8");
console.log(`生成 ${out}（${VARIANTS.length} 种风格 + 图片行 3 种处理）`);
