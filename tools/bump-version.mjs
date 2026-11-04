// 版本号五处联动 bump（发布日动作，平时不动）：
//   package.json / package-lock.json（两处）/ src-tauri/tauri.conf.json /
//   src-tauri/Cargo.toml / src-tauri/Cargo.lock（x-dir 条目）/ update.json
// update.json 的 pubDate 仅在版本实际变化时刷新为当天；notes 留给发布日手工填写。
// JSON 文件走 parse/stringify（键序保留、2 空格缩进，与 npm/tauri 原格式一致），
// TOML/lock 走精确文本替换——PowerShell 的 JSON 往返会重排转义，故用 node 脚本。
//
// 用法：
//   node tools/bump-version.mjs 0.2.0     # bump 到 0.2.0（同版本重跑 = 无操作幂等）
//   node tools/bump-version.mjs --check   # 只读校验五处一致性（不一致退出码 1）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = {
  pkg: join(ROOT, "package.json"),
  lock: join(ROOT, "package-lock.json"),
  conf: join(ROOT, "src-tauri", "tauri.conf.json"),
  toml: join(ROOT, "src-tauri", "Cargo.toml"),
  cargoLock: join(ROOT, "src-tauri", "Cargo.lock"),
  manifest: join(ROOT, "update.json"),
};

/** 读出五处当前版本号 */
function readAll() {
  const pkg = JSON.parse(readFileSync(FILES.pkg, "utf8"));
  const lock = JSON.parse(readFileSync(FILES.lock, "utf8"));
  const conf = JSON.parse(readFileSync(FILES.conf, "utf8"));
  const toml = readFileSync(FILES.toml, "utf8");
  const cargoLock = readFileSync(FILES.cargoLock, "utf8");
  const manifest = JSON.parse(readFileSync(FILES.manifest, "utf8"));
  const tomlVer = toml.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const lockVer =
    cargoLock.match(/\[\[package\]\]\s*\nname = "x-dir"\s*\nversion = "([^"]+)"/)?.[1] ?? null;
  return {
    "package.json": pkg.version ?? null,
    "package-lock.json": lock.version && lock.packages?.[""]?.version ? [lock.version, lock.packages[""].version] : [null, null],
    "tauri.conf.json": conf.version ?? null,
    "Cargo.toml": tomlVer,
    "Cargo.lock": lockVer,
    "update.json": manifest.version ?? null,
  };
}

// ── --check：只读校验 ─────────────────────────────────────────────────────────
if (process.argv[2] === "--check") {
  const all = readAll();
  const flat = Object.values(all).flat();
  const ok = flat.every((v) => v === flat[0]);
  for (const [k, v] of Object.entries(all)) {
    console.log(`${String(v).padEnd(28)} ${k}`);
  }
  if (!ok) {
    console.error("✗ 五处版本号不一致，先跑 node tools/bump-version.mjs <版本> 对齐");
    process.exit(1);
  }
  console.log(`✓ 版本号五处一致：v${flat[0]}`);
  process.exit(0);
}

// ── bump：参数校验 + 五处写入 ────────────────────────────────────────────────
const NEW = process.argv[2];
if (!NEW || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(NEW)) {
  console.error("用法：node tools/bump-version.mjs <新版本，如 0.2.0 或 1.0.0-rc.1>");
  process.exit(1);
}
const current = readAll();
const changed = Object.values(current).flat()[0] !== NEW;

// package.json / package-lock.json / tauri.conf.json / update.json：JSON 精确改写。
// 按原文件行尾序列化、内容无变化则跳过写盘（保证同版本幂等重跑零 diff，
// 也不会把 CRLF 仓库刷成 LF 制造幻影改动）
function writeIfChanged(file, text) {
  if (readFileSync(file, "utf8") !== text) writeFileSync(file, text, "utf8");
}
for (const [file, edit] of [
  [FILES.pkg, (o) => { o.version = NEW; }],
  [FILES.lock, (o) => { o.version = NEW; o.packages[""].version = NEW; }],
  [FILES.conf, (o) => { o.version = NEW; }],
  [FILES.manifest, (o) => {
    o.version = NEW;
    if (changed) o.pubDate = new Date().toISOString().slice(0, 10); // 版本实际变化才刷新发布日
  }],
]) {
  const raw = readFileSync(file, "utf8");
  const obj = JSON.parse(raw);
  edit(obj);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(obj, null, 2).replace(/\n/g, eol);
  writeIfChanged(file, raw.endsWith("\n") ? body + eol : body); // 末尾换行有无也随原文件
}

// Cargo.toml：首个 ^version 行（[package] 段，无其他 version 行在前）
{
  const text = readFileSync(FILES.toml, "utf8");
  writeIfChanged(FILES.toml, text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${NEW}"`));
}

// Cargo.lock：x-dir 条目块（其余依赖版本不受影响，无需 cargo update）
{
  const text = readFileSync(FILES.cargoLock, "utf8");
  const re = /(\[\[package\]\]\s*\nname = "x-dir"\s*\nversion = )"([^"]+)"/;
  if (!re.test(text)) {
    console.error("✗ Cargo.lock 中找不到 x-dir 条目，请检查文件结构");
    process.exit(1);
  }
  writeIfChanged(FILES.cargoLock, text.replace(re, `$1"${NEW}"`));
}

console.log(changed ? `已 bump 至 v${NEW}（六文件；update.json pubDate 已刷新为今天）` : `v${NEW} 与当前一致，无写入（幂等重跑）`);
console.log("后续：cargo check 验证 lock → 填 update.json notes → 打 tag → 双端 Release 挂产物");
