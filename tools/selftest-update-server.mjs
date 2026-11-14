// 一键更新全链路自测用的本地清单/安装包服务器（tools/update-selftest.ps1 驱动）。
// 用法：node tools/selftest-update-server.mjs <目录> <端口>
// 仅本机回环可达，目录下 latest.json + 安装包由自测脚本组装。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 8997);
if (!dir) {
  console.error("usage: node selftest-update-server.mjs <dir> <port>");
  process.exit(1);
}

const MIME = {
  ".json": "application/json",
  ".exe": "application/octet-stream",
  ".sig": "application/octet-stream",
};

createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  const path = join(dir, name);
  if (!path.startsWith(join(dir, ""))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
    console.log(`[selftest-server] 200 ${name} (${body.length}B)`);
  } catch {
    res.writeHead(404).end("not found");
    console.log(`[selftest-server] 404 ${name}`);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`[selftest-server] listening http://127.0.0.1:${port}/ serving ${dir}`);
});
