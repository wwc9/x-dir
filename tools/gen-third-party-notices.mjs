// 生成 THIRD-PARTY-NOTICES.txt（AGENTS.md §8 发布要件）：汇总随 X-Dir 再分发的
// 全量第三方依赖（Rust crates 编译进 x-dir.exe + npm 生产依赖打进前端），
// 逐条列出 名称@版本 / 许可证 / 版权人 / 仓库地址，并在附录收录标准许可证全文。
//
// 数据源全部本地可得，无需额外安装（区别于 cargo-about / license-checker 方案）：
// - Rust：cargo metadata（读 Cargo.lock，离线，按 Windows 目标过滤）+ ~/.cargo/registry/src 源码包 LICENSE
// - npm：npm ls --all --omit=dev --json + node_modules 各包 package.json / LICENSE
// 许可证全文从依赖自带 LICENSE 文件按「含+排除」签名特征提取（杜绝手抄错漏；
// MIT/MIT-0、BSD-2/BSD-3、ISC/0BSD 这类同源文本靠第二标记区分）。
// 识别不了的 SPDX 或找不到文本的条目会在文件内标注并打印 REVIEW 清单，人工补全后重跑。
//
// 用法：node tools/gen-third-party-notices.mjs   （依赖变更后重新生成一次）
import { execFileSync, execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "THIRD-PARTY-NOTICES.txt");

// ── 许可证签名特征：re = 必含特征，not = 排除特征（区分同源文本） ──────────────
const SIGNATURES = [
  { id: "Apache-2.0", re: /Apache License[\s\S]*Version 2\.0, January 2004/ },
  // 标准 MIT 带归属条款；MIT-0 是删掉该条款的变体，二者其余文本逐字相同
  { id: "MIT-0", re: /Permission is hereby granted, free of charge/, not: /The above copyright notice shall be included/ },
  { id: "MIT", re: /Permission is hereby granted, free of charge[\s\S]*The above copyright notice shall be included/ },
  // BSD 三条款多出 "Neither the name…" 第 3 条；二条款没有
  { id: "BSD-3-Clause", re: /Redistribution and use in source and binary forms[\s\S]*neither the name/i },
  { id: "BSD-2-Clause", re: /Redistribution and use in source and binary forms/i, not: /neither the name/i },
  { id: "MPL-2.0", re: /Mozilla Public License Version 2\.0/ },
  // ISC 与 0BSD 开头句逐字相同，靠其后有无 "subject to the following conditions" 区分
  { id: "ISC", re: /ISC License|subject to the following conditions/ },
  { id: "0BSD", re: /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/, not: /subject to the following conditions/ },
  { id: "Unicode-3.0", re: /UNICODE LICENSE V[13]/i },
  { id: "Unicode-DFS-2016", re: /UNICODE, INC\. LICENSE/ },
  { id: "Unlicense", re: /free and unencumbered software released into the public domain/ },
  { id: "CC0-1.0", re: /CC0 1\.0 Universal/ },
  { id: "Zlib", re: /This software is provided 'as-is'/ },
  { id: "BSL-1.0", re: /Boost Software License - Version 1\.0/ },
  { id: "BlueOak-1.0.0", re: /Blue Oak Model License/ },
  { id: "CDLA-Permissive-2.0", re: /Community Data License Agreement Permissive 2\.0/ },
];
const KNOWN = new Set(SIGNATURES.map((s) => s.id));

/** 一个文件命中的全部许可证标识（检测前把折行折叠为单空格，免疫源文件 80 列硬换行） */
function detectIds(text) {
  const flat = text.replace(/[ \t]*\r?\n[ \t]*/g, " ");
  return SIGNATURES.filter((s) => s.re.test(flat) && !(s.not?.test(flat) ?? false)).map((s) => s.id);
}

/** SPDX 表达式拆 token："MIT OR Apache-2.0"、"(MIT OR Apache-2.0) AND Unicode-3.0"
 *  → ["MIT","Apache-2.0","Unicode-3.0"]（AND/OR 视作同列展示，括号剥除，WITH 例外丢弃） */
function licenseTokens(spdx) {
  if (!spdx) return [];
  return [
    ...new Set(
      spdx
        .split(/\s+(?:OR|AND)\s+|\//)
        .map((s) => s.trim().split(/\s+WITH\s+/)[0].replace(/[()[\]]/g, ""))
        .filter(Boolean),
    ),
  ];
}

/** 读取目录下全部许可证类文件（每个 ≤128KB，最多 4 个）。
 *  名字不做行首锚定：aho-corasick 的 Unlicense 文件名是不带前缀的 UNLICENSE */
function readLicenseFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const picked = names
    .filter((n) => /licen[cs]e|copying|copyright|notice/i.test(n) && !/\.(rst|md|go|rs|ts|js)$/i.test(n))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 4);
  return picked.flatMap((n) => {
    const p = join(dir, n);
    try {
      if (!statSync(p).isFile() || statSync(p).size > 128 * 1024) return [];
      const text = readFileSync(p, "utf8");
      return [{ name: n, text, ids: detectIds(text) }];
    } catch {
      return [];
    }
  });
}

/** 从许可证文本提取版权行：行首锚定 + 必须带年份（或 (c)/© 紧跟年份），
 *  防把折行后恰以 "copyright license…" 开头的 Apache 正文句误当归属行；去重限 3 行 */
function copyrightLines(texts) {
  const seen = new Set();
  const out = [];
  for (const { text } of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length > 160 || !/^[#*>\s-]*(?:\(c\)\s*\d|©\s*\d|copyright[:(\s]+(?:\(c\)[\s,]+)?\d{2,4})/i.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

// ── Rust crates：cargo metadata + 本地 registry 源码 ─────────────────────────
// --filter-platform 只保留实际链进 Windows x64 产物的依赖：默认全平台清单会把
// xcap 拉进的 Linux/Wayland 侧库（libwayshot-xcap）与 uefi 目标侧 crate（r-efi，
// LGPL）误报进来——它们从不编译进 x-dir.exe，列入清单既失实又虚引合规红线
function collectRust() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--manifest-path",
        join(ROOT, "src-tauri", "Cargo.toml"),
        "--filter-platform",
        "x86_64-pc-windows-msvc",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const srcRoot = join(os.homedir(), ".cargo", "registry", "src");
  const hosts = existsSync(srcRoot) ? readdirSync(srcRoot).map((h) => join(srcRoot, h)) : [];
  return meta.packages
    .filter((p) => !meta.workspace_members.includes(p.id))
    .map((p) => {
      const srcDir = hosts.map((h) => join(h, `${p.name}-${p.version}`)).find((d) => existsSync(d));
      const files = readLicenseFiles(srcDir);
      return {
        eco: "rust",
        name: p.name,
        version: p.version,
        spdx: p.license || null,
        tokens: licenseTokens(p.license),
        repo: p.repository || null,
        authors: p.authors?.filter(Boolean).join(", ") || null,
        files,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── npm：npm ls 生产树 + node_modules 包内文件 ───────────────────────────────
// npm ls 树含 peer/optional 节点且可能带 invalid 退出码，stdout 永远是合法 JSON
function collectNpm() {
  let json = "";
  try {
    json = execSync("npm ls --all --omit=dev --json", {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    json = e.stdout?.toString() ?? "";
  }
  const found = new Map(); // name@version → {name,version}
  (function walk(node) {
    for (const [name, info] of Object.entries(node.dependencies ?? {})) {
      if (info?.version && !/^@types\//.test(name)) found.set(`${name}@${info.version}`, { name, version: info.version });
      if (info?.dependencies) walk(info);
    }
  })(JSON.parse(json));
  return [...found.values()]
    .map(({ name, version }) => {
      const pkgPath = join(ROOT, "node_modules", ...name.split("/"), "package.json");
      let pkg = {};
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch {
        /* 缺包（optional/平台隔离）跳过 */
      }
      if (!pkg.name) return null;
      const files = readLicenseFiles(dirname(pkgPath));
      return {
        eco: "npm",
        name,
        version,
        spdx: pkg.license ?? null,
        tokens: licenseTokens(typeof pkg.license === "string" ? pkg.license : pkg.license?.type),
        repo: typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? null),
        author: pkg.author?.name ?? (typeof pkg.author === "string" ? pkg.author : null),
        files,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── 组装输出 ─────────────────────────────────────────────────────────────────
const rust = collectRust();
const npm = collectNpm();
const entries = [...rust, ...npm];

// 附录全文：每个标准许可证取一份命中文件（顺序取条目序，取到即止）
const appendix = new Map(); // licenseId → text
for (const e of entries) {
  for (const f of e.files) {
    for (const id of f.ids) {
      if (!appendix.has(id)) appendix.set(id, f.text.trim());
    }
  }
}

const appVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const ownLicense = readFileSync(join(ROOT, "LICENSE"), "utf8").trim();
if (!appendix.has("MIT")) appendix.set("MIT", ownLicense); // 附录缺 MIT 时用项目自身 LICENSE 兜底

// ── 随发布物分发的第三方二进制资产（非 crate/npm，2026-11-08 内嵌 7-Zip）──
// 官方未修改的 7z.exe/7z.dll（tools/get-7zip.ps1 哈希锁定下载）经 Tauri
// resources 随安装包/便携包分发，命令行调用（arm's length）。许可证 = LGPL-2.1
// + unRAR 限制条款，全文从随库的 src-tauri/binaries/7-Zip-License.txt 内嵌。
const BUNDLED_ASSETS = [
  {
    name: "7-Zip (7z.exe / 7z.dll)",
    version: "25.01",
    license: "LGPL-2.1 + unRAR restriction",
    repo: "https://www.7-zip.org / https://github.com/ip7z/7zip",
    rights: "Copyright (c) 1999-2025 Igor Pavlov",
    licenseFile: join(ROOT, "src-tauri", "binaries", "7-Zip-License.txt"),
  },
  {
    // holiday-cn 按年 JSON 数据（MIT）转译为 src/lib/holidays.ts 随前端打包，
    // 提供法定节假日/调休班休（工作日历，2026-11-13）；MIT 全文见附录
    name: "holiday-cn 数据（holiday-cn per-year JSON, bundled as src/lib/holidays.ts）",
    version: "2024-2027 数据集（2026-11-13 抓取）",
    license: "MIT",
    repo: "https://github.com/NateScarlet/holiday-cn",
    rights: "Copyright (c) 2020 NateScarlet",
  },
];

const review = [];
const lines = [];
lines.push("THIRD-PARTY NOTICES FOR X-Dir", "=".repeat(120), "");
lines.push(`X-Dir v${appVersion} · Copyright (c) 2026 wwwwwc · 本软件以 MIT 许可证发布（全文见附录）。`);
lines.push("");
lines.push("本文件汇总随 X-Dir 一并再分发的全部第三方组件的归属与许可信息：");
lines.push("  · Rust crates —— 编译进 x-dir.exe（含传递依赖，已按 Windows x64 目标过滤）");
lines.push("  · npm packages —— 打包进前端资源（生产依赖，@types 等仅开发期组件除外）");
lines.push("各条目按「名称 版本 — 许可证 — 仓库 — 版权人」列出；标准许可证全文统一收录于附录，");
lines.push("条目不再逐个内嵌。非标准许可证（或未识别 SPDX）的条目在其下方内嵌原文。");
lines.push("");
lines.push(`由 tools/gen-third-party-notices.mjs 生成于 ${new Date().toISOString().slice(0, 10)}；依赖变更后请重新生成。`);
lines.push("");

for (const [eco, title] of [
  ["rust", "RUST CRATES（编译进 x-dir.exe）"],
  ["npm", "NPM PACKAGES（打包进前端资源）"],
]) {
  const list = entries.filter((e) => e.eco === eco);
  lines.push("", `${title}（${list.length} 项）`, "-".repeat(120));
  for (const e of list) {
    const rights = copyrightLines(e.files);
    if (!rights.length && (e.authors ?? e.author)) rights.push(`Copyright ${e.authors ?? e.author}`);
    const lic = e.spdx ?? "（未声明）";
    lines.push(`· ${e.name} ${e.version} — ${lic}${e.repo ? ` — ${e.repo.replace(/^git\+/, "")}` : ""}`);
    if (rights.length) lines.push(`  ${rights.join(" / ")}`);
    // 附录没有全文的 token：若某文件签名恰为该 token 则内嵌该文件；否则标注人工补全
    for (const t of e.tokens.filter((t) => !appendix.has(t))) {
      const hit = e.files.find((f) => f.ids.includes(t));
      if (hit) {
        lines.push(`  [${t} 全文]`, ...hit.text.trim().split(/\r?\n/).map((l) => `  | ${l}`));
      } else {
        lines.push(`  ⚠ 许可证「${t}」未收录全文（依赖未携带可识别文本），需人工补全`);
        review.push(`${e.name}@${e.version}: ${t} 无文本`);
      }
    }
    if (!e.spdx) review.push(`${e.name}@${e.version}: 无 SPDX 声明`);
  }
}

lines.push("", "随发布物分发的第三方二进制资产（BUNDLED BINARIES）", "-".repeat(120));
for (const a of BUNDLED_ASSETS) {
  lines.push(
    `· ${a.name} ${a.version} — ${a.license} — ${a.repo}`,
    `  ${a.rights}`,
  );
  // licenseFile 缺省 = 许可证已收录于附录（如 MIT），不强制附带全文文件
  if (a.licenseFile && existsSync(a.licenseFile)) {
    lines.push(`  [${a.license} 全文]`, ...readFileSync(a.licenseFile, "utf8").trim().split(/\r?\n/).map((l) => `  | ${l}`));
  } else if (a.licenseFile) {
    lines.push(`  ⚠ 许可证全文缺失（${a.licenseFile}），需人工补全`);
    review.push(`${a.name}: 许可证文件缺失`);
  }
}

lines.push("", "附录：标准许可证全文", "=".repeat(120));
for (const { id } of SIGNATURES) {
  const text = appendix.get(id);
  if (!text) continue;
  lines.push("", `[${id}]`, "-".repeat(120), ...text.split(/\r?\n/));
}

writeFileSync(OUT, lines.join("\r\n") + "\r\n", "utf8");
console.log(`已生成 ${OUT}：Rust ${rust.length} 项 + npm ${npm.length} 项；附录收录 ${[...appendix.keys()].join(", ")}`);
if (review.length) {
  console.warn("REVIEW（需人工核对）：");
  for (const r of review) console.warn(`  - ${r}`);
  process.exitCode = 1;
}
