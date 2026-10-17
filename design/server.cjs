// 预览静态服务器：node server.js 后访问 http://127.0.0.1:8931/preview.html
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = 8931;

http
  .createServer((req, res) => {
    const rel = req.url === "/" ? "preview.html" : decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(root, rel);
    fs.readFile(file, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const ext = path.extname(file);
      const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" };
      res.setHeader("Content-Type", types[ext] ?? "application/octet-stream");
      res.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`serving ${root} at http://127.0.0.1:${port}/preview.html`));
