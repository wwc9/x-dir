// CDP 按键助手：Input.dispatchKeyEvent 发真实（trusted）键盘事件。
// 用法：node tools/cdp-key.mjs <port> <key> [code] [keyCode]
import { readFileSync } from "node:fs";

const [port, key, code, keyCode] = process.argv.slice(2);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.title === "X-Dir")
  ?? list.find((t) => t.type === "page");
if (!page?.webSocketDebuggerUrl) {
  console.error("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("cdp timeout 15s")), 15000);
  let n = 0;
  const send = (obj) => ws.send(JSON.stringify(obj));
  ws.onopen = () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      n += 1;
      send({
        id: n,
        method: "Input.dispatchKeyEvent",
        params: {
          type,
          key,
          ...(code ? { code } : {}),
          ...(keyCode ? { windowsVirtualKeyCode: Number(keyCode) } : {}),
        },
      });
    }
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && (msg.result || msg.error)) {
      if (msg.error) { clearTimeout(timer); reject(new Error(JSON.stringify(msg.error))); }
      // 等最后一个 id 的响应
      if (msg.id === n) { clearTimeout(timer); resolve("ok"); }
    }
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
});
ws.close();
console.log(result);
