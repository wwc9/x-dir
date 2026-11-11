// latest.json 生成（发布日动作）：从构建产出的 .sig 读取 minisign 签名 +
// 安装包文件名，生成 updater 插件清单。无 BOM UTF-8（BOM 令 JSON 解析失败）。
// 用法：node tools/gen-latest-json.mjs <setup.exe 路径> <sig 路径> <下载直链>
//       [notes]  —— 写到 stdout，重定向落盘
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [setup, sig, url, notes] = process.argv.slice(2);
if (!setup || !sig || !url) {
  console.error("usage: node gen-latest-json.mjs <setup.exe> <setup.exe.sig> <url> [notes]");
  process.exit(1);
}
const m = basename(setup).match(/(\d+\.\d+\.\d+)(?=[._-]|$)/);
if (!m) {
  console.error("无法从文件名解析版本号：" + setup);
  process.exit(1);
}
const manifest = {
  version: m[1],
  notes: notes ? [notes] : ["见 Release 说明"],
  pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sig, "utf8").trim(),
      url,
    },
  },
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
