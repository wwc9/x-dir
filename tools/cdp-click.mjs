// CDP 点击助手：Input.dispatchMouseEvent 发真实（trusted）鼠标按下/抬起。
// 用法：node tools/cdp-click.mjs <port> <x> <y> [dbl]
import { readFileSync } from "node:fs";

const [port, xs, ys, dbl] = process.argv.slice(2);
const x = Number(xs);
const y = Number(ys);

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
  const seq = [
    { type: "mouseMoved", x, y },
    { type: "mousePressed", x, y, button: "left", clickCount: 1 },
    { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
  ];
  if (dbl) for (const t of ["mousePressed", "mouseReleased"]) seq.push({ type: t, x, y, button: "left", clickCount: 2 });
  let n = 0;
  ws.onopen = () => {
    for (const s of seq) {
      n += 1;
      ws.send(JSON.stringify({ id: n, method: "Input.dispatchMouseEvent", params: s }));
    }
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && (msg.result || msg.error)) {
      if (msg.error) { clearTimeout(timer); reject(new Error(JSON.stringify(msg.error))); }
      if (msg.id === n) { clearTimeout(timer); resolve("ok"); }
    }
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
});
ws.close();
console.log(result);
