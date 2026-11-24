// CDP evaluate 助手（readme-shots.ps1 配套）：--remote-debugging-port 起来后，
// 对主窗（index.html target）执行一段 JS 并回传结果值。
// 用法：node tools/cdp-eval.mjs <port> <js 表达式文件路径 | -c "表达式">
// 输出：JSON 结果字符串（stdout）；失败退出码 1 并输出错误到 stderr
import { readFileSync } from "node:fs";

const port = process.argv[2];
const arg = process.argv[3];
if (!port || !arg) {
  console.error("usage: node cdp-eval.mjs <port> <-c expr | file>");
  process.exit(1);
}
const expr = arg === "-c" ? process.argv[4] : readFileSync(arg, "utf8");

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// 主窗 target = 标题恰为 X-Dir（剪贴板/截图浮窗带后缀；主窗 URL 是
// http://localhost:1420/ 不带 index.html，按 URL 过滤会落空）
const page = list.find((t) => t.type === "page" && t.title === "X-Dir")
  ?? list.find((t) => t.type === "page");
if (!page?.webSocketDebuggerUrl) {
  console.error("no page target: " + JSON.stringify(list.map((t) => t.url)));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("cdp timeout 15s")), 15000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description ?? "page exception"));
      } else resolve(msg.result?.result?.value);
    }
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
});
ws.close();
console.log(typeof result === "undefined" ? "undefined" : JSON.stringify(result));
