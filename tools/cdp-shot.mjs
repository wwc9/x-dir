// CDP 截图助手（cdp-eval.mjs 配套）：对主窗 target 执行 Page.captureScreenshot，
// 支持 clip 区域（CSS px）与缩放。用法：
//   node tools/cdp-shot.mjs <port> <out.png> [clipX clipY clipW clipH] [scale]
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const port = argv[0];
const out = argv[1];
const clip =
  argv.length >= 6
    ? {
        x: Number(argv[2]),
        y: Number(argv[3]),
        width: Number(argv[4]),
        height: Number(argv[5]),
        scale: argv[6] ? Number(argv[6]) : 2,
      }
    : undefined;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.title === "X-Dir")
  ?? list.find((t) => t.type === "page");
if (!page?.webSocketDebuggerUrl) {
  console.error("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const b64 = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("cdp timeout 15s")), 15000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: "Page.captureScreenshot",
      params: { format: "png", ...(clip ? { clip } : {}) },
    }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) {
      clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result?.data);
    }
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
});
ws.close();
writeFileSync(out, Buffer.from(b64, "base64"));
console.log(`saved ${out}${clip ? ` (clip ${clip.x},${clip.y} ${clip.width}x${clip.height} @${clip.scale}x)` : ""}`);
