import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// tailwind v4: index.css 顶部 @import "tailwindcss" 提供 preflight 基础层与
// @custom-variant dark(暗色变体),插件不可移除
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/** 样式加载顺序守卫（2026-11-06 定案，异机「弹窗风格不一样」根因修复）：
 *  rolldown 打包把 blueprint.css 提升到入口 main-*.css 并在 <head> 里垫后
 *  加载，index.css（含全部 .bp6-* 覆写）归组件 chunk 先加载——同权重下后者胜，
 *  我们对弹窗/按钮/菜单/遮罩的覆写全部失效，打包版弹窗走 Blueprint 默认主题
 *  （浅色 #f6f7f9 灰身白头/4px 圆角/0.7 深遮罩），与 dev 表现分裂。本插件在
 *  产物生成时把含 np 设计 token（--np-bg）的 css 统一挪到全部 stylesheet 之后，
 *  恢复「Blueprint 先、我们的后」与 dev 一致的级联顺序；不依赖 rolldown 内部
 *  分块行为，多 chunk 演化下仍成立 */
function cssOrderGuard(): Plugin {
  return {
    name: "xdir-css-order-guard",
    enforce: "post",
    generateBundle(_options, bundle) {
      const ours = new Set<string>();
      for (const [file, asset] of Object.entries(bundle)) {
        if (asset.type !== "asset" || !file.endsWith(".css")) continue;
        if (String(asset.source).includes("--np-bg:")) ours.add("/" + file);
      }
      if (!ours.size) return;
      for (const [file, html] of Object.entries(bundle)) {
        if (html.type !== "asset" || !file.endsWith(".html")) continue;
        let text = String(html.source);
        const linkRe = /<link rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/g;
        const links = [...text.matchAll(linkRe)];
        if (links.length < 2) continue;
        const mine = links.filter((m) => ours.has(m[1]));
        if (!mine.length) continue;
        // 摘出我们的 link，再拼接到最后一个 stylesheet 之后（保持其余相对顺序）
        for (const m of mine) text = text.replace(m[0], "");
        const last = links[links.length - 1][0];
        text = text.replace(last, last + mine.map((m) => m[0]).join(""));
        html.source = text;
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), cssOrderGuard()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      // 多页入口：主窗口 index.html + 截图族窗口轻量入口 shot.html（§3.6）
      // + 剪贴板历史浮窗轻量入口 clipboard.html（§3.7）
      input: {
        main: "index.html",
        shot: "shot.html",
        clip: "clipboard.html",
      },
    },
  },
}));
