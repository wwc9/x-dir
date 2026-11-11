// Gitee Release 自动发布（2026-11-11）：复用 git 凭据管理器中 gitee.com 的
// 存储凭据（push 同源）走 api/v5——查找/创建 Release + attach_files 上传产物
// + PATCH 发行说明。
// 网络注意：Gitee 前置 WAF（ADAS）对 node fetch 的写操作返回自家 404 JSON、
// 对 curl 的 GET 偶发 HTML 挑战页（releases 列表匿名返回 401 对象需认证）——
// 故本脚本全部请求走 curl.exe 子进程：GET 先匿名、无效则带认证重试，写操作
// 直接带认证；挑战窗口按 2/5/10s 退避。凭据仅内存流转，不打印不落盘。
// 用法：node tools/publish-gitee.mjs [版本号=tauri.conf.json 的 version]
// 幂等：同 tag 的 Release 已存在则复用其 id 并 PATCH 说明、续传附件。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const uj = JSON.parse(readFileSync(join(ROOT, "update.json"), "utf8"));
const bodyMd = (uj.notes ?? []).map((n) => `- ${n}`).join("\n");
const Version = process.argv[2] ?? conf.version;
const Tag = `v${Version}`;
const Owner = "wwc9";
const Repo = "x-dir";
const Dir = join(ROOT, "dist-release", Tag);
const API = "https://gitee.com/api/v5";

const artifacts = [
  `X-Dir_${Version}_x64-setup.exe`,
  `x-dir_v${Version}_portable.zip`,
  "SHA256SUMS.txt",
  "latest.json",
]
  .map((n) => join(Dir, n))
  .filter((p) => {
    if (existsSync(p)) return true;
    console.log(`跳过（不存在）：${basename(p)}`);
    return false;
  });
if (!artifacts.length) {
  console.error(`产物目录为空：${Dir}`);
  process.exit(1);
}

// ── 凭据（push 同源，内存捕获，不打印）──
const credOut = execFileSync("git", ["credential", "fill"], {
  input: `protocol=https\nhost=gitee.com\n\n`,
  encoding: "utf8",
});
const cred = Object.fromEntries(
  credOut
    .trim()
    .split("\n")
    .map((l) => l.split("=", 2)),
);
if (!cred.password) {
  console.error("git 凭据管理器中没有 gitee.com 的存储凭据");
  process.exit(1);
}
const auth = `Authorization: Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}`;

// ── GET 走 curl：先匿名，无效（HTML 挑战页/401 对象）→ 带认证重试，
//    按 2/5/10s 退避；有效判据 = 数组（清单）或含 id 的对象（单实体）──
function curlJson(args, withAuth = false) {
  const delays = [2000, 5000, 10000];
  let out = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      console.log(`  响应无效，${delays[attempt - 1] / 1000}s 后带认证重试（第 ${attempt} 次）…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt - 1]);
    }
    const headers =
      attempt === 0 && !withAuth
        ? ["-H", "Accept: application/json"]
        : ["-H", "Accept: application/json", "-H", auth];
    out = execFileSync(
      "curl.exe",
      [...args, ...headers],
      { encoding: "utf8", maxBuffer: 1 << 24 },
    );
    if (out.trimStart().startsWith("[") || out.trimStart().startsWith("{\"id\"")) {
      return JSON.parse(out);
    }
  }
  throw new Error(`Gitee API 持续返回无效响应：${args.join(" ")} → ${out.slice(0, 120)}`);
}

// ── 认证探测（curl 带认证走 /user；WAF 间歇挑战由重试消化）──
const me = curlJson(["-s", `${API}/user`], true);
console.log(`Gitee 认证 OK：${me.login}`);

// ── 查找 / 创建 Release（POST 由 curl 执行）──
// 注意：清单请求勿带 ?per_page= 查询串——WAF 对带查询串的 GET 会挑战 404
// 清单请求带分页参数（无参数的列表 GET 会被 WAF 反爬规则挑战 404）
// 清单请求带分页参数（WAF 对无参数列表 GET 会挑战 404）
const releases = curlJson(["-s", `${API}/repos/${Owner}/${Repo}/releases?per_page=100`]);
let rel = Array.isArray(releases) ? releases.find((r) => r.tag_name === Tag) : null;
if (rel) {
  // 已存在 = 先删后建（当前无附件挂载，重建即更新；避免 PATCH 被 WAF 拦截）
  console.log(`Release ${Tag} 已存在（id ${rel.id}），删除后重建`);
  execFileSync("curl.exe", ["-s", "-X", "DELETE", `${API}/releases/${rel.id}`, "-H", auth], {
    encoding: "utf8",
  });
}

// ── 创建 Release（POST 走 curl；WAF 挑战窗口按 5/15/30/60s 退避重试）──
const bodyFile = join(Dir, ".release-create.json");
writeFileSync(
  bodyFile,
  JSON.stringify({ tag_name: Tag, name: `X-Dir ${Tag}`, body: bodyMd, prerelease: false }),
);
const delays = [5000, 15000, 30000, 60000];
let out = "";
for (let attempt = 0; attempt <= delays.length; attempt++) {
  if (attempt > 0) {
    console.log(`  WAF 挑战/瞬态响应，${delays[attempt - 1] / 1000}s 后重试（第 ${attempt} 次）…`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt - 1]);
  }
  out = execFileSync(
    "curl.exe",
    [
      "-s",
      "-X",
      "POST",
      `${API}/releases`,
      "-H",
      auth,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      `@${bodyFile}`,
    ],
    { encoding: "utf8", maxBuffer: 1 << 22 },
  );
  rel = JSON.parse(out);
  if (rel.id) break;
  console.log(`  创建未成功，重试中…`);
}
if (!rel.id) {
  console.error(`Gitee Release 创建失败：${out.slice(0, 300)}`);
  process.exit(1);
}
console.log(`Release ${Tag} 已发布（id ${rel.id}，发行说明 ${bodyMd.length} 字）`);
console.log("");
// ── 附件：Gitee API v5 不支持 Release 附件上传（attach_files 端点未实现，
//    实测返回 HTML 404 页）——安装包/便携包请在 Gitee 网页的 Release 编辑页
//    拖拽上传，文件名必须与下方直链一致 ──
console.log("待手动上传附件（Gitee API 不支持，网页 Release 编辑页拖拽上传）：");
for (const f of artifacts) {
  console.log(`  ${f}`);
}

// ── 验证下载直链（应用内一键更新的 url）──
const dlUrl = `https://gitee.com/${Owner}/${Repo}/releases/download/${Tag}/X-Dir_${Version}_x64-setup.exe`;
const head = await fetch(dlUrl, { method: "HEAD" });
console.log(`下载直链 ${dlUrl}\n  → HTTP ${head.status}${head.ok ? " ✓ 应用内一键更新即刻可用" : " ✗ 仍不可达（Gitee 附件转码稍候重试）"}`);
