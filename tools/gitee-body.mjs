// Gitee Release body 更新（2026-11-11）：读 release-notes.md 分类格式 →
// DELETE 旧 Release → POST 新 Release（带完整分类编号 body）。
// 写操作全部走 curl.exe 子进程 + basic auth（node fetch 的 POST 被 WAF 拦），
// DELETE 与 POST 之间留 15s 冷却（WAF 限速窗口）。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const uj = JSON.parse(readFileSync(join(ROOT, "update.json"), "utf8"));
const Version = process.argv[2] ?? conf.version;
const Tag = `v${Version}`;
const Owner = "wwc9";
const Repo = "x-dir";
const API = "https://gitee.com/api/v5";

const credOut = execFileSync("git", ["credential", "fill"], {
  input: `protocol=https\nhost=gitee.com\n\n`,
  encoding: "utf8",
});
const cred = Object.fromEntries(credOut.trim().split("\n").map((l) => l.split("=", 2)));
const auth = `Authorization: Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}`;

const bodyMd = readFileSync(join(ROOT, "dist-release", `v${Version}`, "release-notes.md"), "utf8");

function curlJson(method, path, bodyFile) {
  const args = ["-s", "-X", method, `${API}${path}`, "-H", auth];
  if (bodyFile) {
    args.push("-H", "Content-Type: application/json; charset=utf-8");
    args.push("--data-binary", `@${bodyFile}`);
  }
  const delays = [5000, 15000, 30000, 60000];
  let out = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      console.log(`  WAF 挑战，${delays[attempt - 1] / 1000}s 后重试（第 ${attempt} 次）…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt - 1]);
    }
    out = execFileSync("curl.exe", [...args, "-H", "Accept: application/json"], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    if (out.trimStart().startsWith("{") || out.trimStart().startsWith("[")) {
      return JSON.parse(out);
    }
  }
  throw new Error(`非 JSON 响应：${method} ${path} → ${out.slice(0, 120)}`);
}

function writeTempJson(obj) {
  const p = join(ROOT, "dist-release", `v${Version}`, ".tmp-body.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

// ── 1. 删除旧 Release（如有）──
const rels = curlJson("GET", `/repos/${Owner}/${Repo}/releases?per_page=100`);
const old = Array.isArray(rels) ? rels.find((r) => r.tag_name === Tag) : null;
if (old) {
  console.log(`删除旧 Release id ${old.id} …`);
  curlJson("DELETE", `/repos/${Owner}/${Repo}/releases/${old.id}`);
  // WAF 限速窗口冷却
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
}

// ── 2. 创建新 Release（含分类编号发行说明）──
const bodyFile = writeTempJson({ tag_name: Tag, name: `X-Dir ${Tag}`, body: bodyMd, prerelease: false });
const rel = curlJson("POST", `/repos/${Owner}/${Repo}/releases`, bodyFile);
if (!rel.id) {
  console.error(`创建失败：${JSON.stringify(rel).slice(0, 300)}`);
  process.exit(1);
}
console.log(`Release ${Tag} 已发布（id ${rel.id}，发行说明 ${bodyMd.length} 字）`);
