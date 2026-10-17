// 文件类型图标预览生成器：从 src/lib/fileIcons.ts（单一数据源）生成
// design/file-icons-preview.html。运行：node tools/gen-file-icon-preview.mjs
// 原理：typescript.transpileModule 剥类型 → 落临时 .mjs 导入真实映射表 →
// react-dom/server 把 Lucide 组件渲成 SVG → 按 colorVar 分组铺 HTML。
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

// 1) 剥类型并落盘临时模块（放在 node_modules/.cache 下以便解析 lucide-react/react）
const srcPath = path.join(root, "src", "lib", "fileIcons.ts");
const js = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const cacheDir = path.join(root, "node_modules", ".cache");
fs.mkdirSync(cacheDir, { recursive: true });
const genPath = path.join(cacheDir, "file-icons.gen.mjs");
fs.writeFileSync(genPath, js, "utf8");
const { BY_EXT, BY_NAME, TYPE_NAMES, ICON_CATEGORY_NAMES, typeName } = await import(
  pathToFileURL(genPath).href
);

// 2) Lucide 图标 → SVG 字符串
function svgOf(icon, size = 22) {
  return renderToStaticMarkup(React.createElement(icon, { size, strokeWidth: 2 }));
}

// 3) 按 colorVar 分组（保持 BY_EXT 插入顺序 = 分类顺序）
const groups = new Map();
for (const [ext, spec] of Object.entries(BY_EXT)) {
  if (!groups.has(spec.colorVar)) groups.set(spec.colorVar, []);
  groups.get(spec.colorVar).push({ ext, spec });
}
for (const [name, spec] of Object.entries(BY_NAME)) {
  if (!groups.has(spec.colorVar)) groups.set(spec.colorVar, []);
  groups.get(spec.colorVar).push({ ext: name, spec, byName: true });
}

// 3) 从 index.css 提取 --np-icon-* 真实色值（浅色 :root 与 .dark 两段）：
//    以「行首 .dark,」锚定深色块（避开 Tailwind @custom-variant 行），
//    并只保留 BY_EXT/BY_NAME 实际引用的变量（滤掉 --np-icon-xs 等尺寸档）
const css = fs.readFileSync(path.join(root, "src", "index.css"), "utf8");
const darkBlock = css.indexOf("\n.dark,");
function iconVars(segment) {
  const out = {};
  for (const m of segment.matchAll(/(--np-icon-[a-z]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}
const usedVars = new Set(
  [...Object.values(BY_EXT), ...Object.values(BY_NAME)].map((s) => s.colorVar),
);
usedVars.add("--np-icon-folder"); // 文件夹/驱动器常量也进预览
usedVars.add("--np-icon-drive");
const keepUsed = (vars) =>
  Object.fromEntries(Object.entries(vars).filter(([k]) => usedVars.has(k)));
const lightVars = keepUsed(iconVars(css.slice(0, darkBlock)));
const darkVars = keepUsed(iconVars(css.slice(darkBlock)));
const tokenList = Object.entries(lightVars)
  .map(([k, v]) => `${k}: ${v};`)
  .join("\n    ");
const darkTokenList = Object.entries(darkVars)
  .map(([k, v]) => `${k}: ${v};`)
  .join("\n    ");

// 4) 铺 HTML
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
function groupHtml(colorVar, items) {
  const title = ICON_CATEGORY_NAMES[colorVar] ?? colorVar;
  const rows = items
    .map(({ ext, spec, byName }) => {
      const probe = byName ? ext : `.preview.${ext}`;
      const tn = typeName(probe, false);
      const shown = byName ? ext : `.${ext}`;
      return `<div class="cell" title="${shown}${tn ? ` · ${esc(tn)}` : ""}">
        <span class="ic" style="color: var(${colorVar})">${svgOf(spec.icon)}</span>
        <span class="tx"><b>${esc(shown)}</b><i>${esc(tn)}</i></span>
      </div>`;
    })
    .join("\n");
  return `<section><h2>${esc(title)} <em>${items.length}</em></h2><div class="grid">${rows}</div></section>`;
}

const sections = [...groups.entries()]
  .map(([colorVar, items]) => groupHtml(colorVar, items))
  .join("\n");
const extCount = Object.keys(BY_EXT).length;
const nameCount = Object.keys(BY_NAME).length;
const iconKinds = new Set(Object.values(BY_EXT).map((s) => s.icon.name ?? s.icon)).size;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>文件类型图标 · 全量预览（${extCount}+ 扩展名）</title>
<style>
  :root {
    --np-bg: #e9ecf1; --np-surface: #ffffff; --np-surface-2: #f0f2f5;
    --np-hairline: rgba(16, 24, 40, 0.06);
    --np-fg: #171d26; --np-muted: #66707e;
    --np-radius: 6px; --np-radius-lg: 10px; --np-radius-pill: 999px;
    --np-gap: 4px; --np-gutter: 8px;
    ${tokenList}
  }
  .dark {
    --np-bg: #131519; --np-surface: #1b1e23; --np-surface-2: #24282f;
    --np-hairline: rgba(255, 255, 255, 0.08);
    --np-fg: #e8eaed; --np-muted: #8b929c;
    ${darkTokenList}
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px clamp(16px, 4vw, 48px) 64px;
    background: var(--np-bg); color: var(--np-fg);
    font: 13px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
  header h1 { font-size: 17px; margin: 0; }
  header .stat { color: var(--np-muted); font-size: 12px; }
  header button {
    margin-left: auto; height: 26px; padding: 0 12px; border: 0; cursor: pointer;
    border-radius: var(--np-radius-pill); background: var(--np-surface);
    color: var(--np-fg); font: inherit; font-size: 12px;
    box-shadow: inset 0 0 0 1px var(--np-hairline);
  }
  section {
    background: var(--np-surface); border-radius: 14px; padding: 14px 16px;
    margin-bottom: 14px;
  }
  section h2 { font-size: 13px; margin: 0 0 10px; }
  section h2 em {
    font-style: normal; margin-left: 6px; padding: 0 8px;
    border-radius: var(--np-radius-pill); background: var(--np-surface-2);
    color: var(--np-muted); font-size: 11px;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 6px; }
  .cell {
    display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 40px;
    padding: 4px 8px; border-radius: var(--np-radius-lg);
    background: var(--np-surface-2); border: 1px solid var(--np-hairline);
  }
  .cell:hover { border-color: color-mix(in srgb, var(--np-fg) 22%, transparent); }
  .cell .ic { display: inline-flex; flex: 0 0 auto; }
  .cell .tx { display: flex; flex-direction: column; min-width: 0; }
  .cell .tx b { font-size: 12.5px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell .tx i { font-style: normal; font-size: 11px; color: var(--np-muted); }
  footer { margin-top: 18px; color: var(--np-muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>文件类型图标 · 全量预览</h1>
  <span class="stat">扩展名 ${extCount} + 无扩展名文件 ${nameCount} · 分类 ${groups.size} 组 · 图标 ${iconKinds} 种 · 数据源 src/lib/fileIcons.ts</span>
  <button onclick="document.body.classList.toggle('dark')">浅色 / 深色</button>
</header>
${sections}
<footer>由 tools/gen-file-icon-preview.mjs 生成 · 数据 = src/lib/fileIcons.ts（改映射后重新运行即可刷新本页）· 颜色 = index.css 的 --np-icon-* token</footer>
</body>
</html>
`;

const outPath = path.join(root, "design", "file-icons-preview.html");
fs.writeFileSync(outPath, html, "utf8");
console.log(
  `已生成 design/file-icons-preview.html · ${extCount} 扩展名 + ${nameCount} 文件名 · ${groups.size} 分类 · ${iconKinds} 种图标`,
);
