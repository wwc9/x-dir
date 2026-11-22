// 滚动截图控制条（§3.6 二期 B 批；2026-10-29 改停靠选区正下方，PixPin
// 样式）：显示已捕获尺寸与滚动方向，完成 = 用已拼内容出结果，取消 / Esc =
// 丢弃。长图预览在侧边的 ScrollPreview 窗（label shot-scroll），本窗（label
// shot-bar）只发控制命令与接收进度事件：更新尺寸显示、初始「向下滚动 ·
// 缓慢匀速」引导、滚太快警示（shot-scroll-fast 事件，2.5s 消退）。窗口几何
// 由 Rust 侧决定。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, X } from "lucide-react";

import { api } from "../lib/ipc";
import { useBarTip } from "./barTip";
import { AppIcon } from "../components/AppIcon";
import { DENSITY } from "../lib/tokens";

export interface ScrollBarBoot {
  window: "scrollbar";
  /** 选区物理像素宽（尺寸显示 W × 已捕获高度） */
  w: number;
}

export function ScrollBar({ boot }: { boot: ScrollBarBoot }) {
  /** 常驻窗复用：选区宽随会话变，boot 事件换装并整体重置 */
  const [selW, setSelW] = useState(boot.w);
  const [height, setHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 滚太快警示（Rust 流式帧匹配失败/捕获失败 = 速度超匹配能力） */
  const [warn, setWarn] = useState(false);
  /** 换装序号：常驻窗停靠屏外，每次换装重绘后回执 Rust 才上屏（无感链路） */
  const [dress, setDress] = useState(0);
  const warnTimer = useRef<number | null>(null);

  // 窗体透明强制（ScrollFrame/GifBar 同款）：index.css 的 body 规则
  // （--np-bg）会盖掉 shot.html 内联透明——环留区域必须透出桌面
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    const un = listen<{ w: number }>("shot-bar-boot", (e) => {
      setSelW(e.payload.w);
      setHeight(0);
      setBusy(false);
      setWarn(false);
      setDress((d) => d + 1);
      sentW.current = 0; // 新会话允许缩宽（内容宽随选区变）
      sentH.current = 0;
    });
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  useBarTip();

  // 内容自适应宽（GIF 浮条同款，2026-11-21「工具条太宽」）：量实宽 + 透明
  // 环留（左右 16×2，承载完整阴影）16px 档量化回传 Rust 缩窗，同会话只增
  // 不减（已捕获高度文本逐秒增长不抖动）；高 = 卡实高 + 环留（上4/下28）
  const barRef = useRef<HTMLDivElement>(null);
  const sentW = useRef(0);
  const sentH = useRef(0);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const target = Math.ceil((el.offsetWidth + 32) / 16) * 16;
    const h = el.offsetHeight + 32;
    if (target > 0 && (target > sentW.current || (sentW.current > 0 && h !== sentH.current))) {
      sentW.current = Math.max(sentW.current, target);
      sentH.current = h;
      void api.shotBarResize(target, h).catch(() => undefined);
    }
  });

  // 首绘/换装重绘后回执 Rust（shot_ready）才原子移动上屏（无感链路）
  useEffect(() => {
    const a = requestAnimationFrame(() => {
      requestAnimationFrame(() => void api.shotReady().catch(() => undefined));
    });
    return () => cancelAnimationFrame(a);
  }, [dress]);

  useEffect(() => {
    const un = listen<{ height: number }>("shot-scroll-progress", (e) =>
      setHeight(e.payload.height),
    );
    return () => {
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // 滚太快警示：出现 2.5s 自动消退；持续滚快则反复触发
  useEffect(() => {
    const un = listen("shot-scroll-fast", () => {
      setWarn(true);
      if (warnTimer.current !== null) window.clearTimeout(warnTimer.current);
      warnTimer.current = window.setTimeout(() => setWarn(false), 2500);
    });
    return () => {
      if (warnTimer.current !== null) window.clearTimeout(warnTimer.current);
      void un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const act = useCallback(
    (action: "finish" | "cancel") => {
      if (busy) return;
      setBusy(true);
      void api.shotScrollControl(action).catch(() => setBusy(false));
    },
    [busy],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        act("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        act("finish");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  return (
    <div ref={barRef} className="np-shot-sbar">
      <div className="np-shot-sbar-row">
        <span className="np-shot-sbar-dot" />
        {warn ? (
          <span className="np-shot-sbar-warn">滚动过快，请放慢</span>
        ) : height > 0 ? (
          <span className="np-shot-sbar-dim">
            {selW.toLocaleString()} × {height.toLocaleString()}
          </span>
        ) : (
          <span className="np-shot-sbar-dim">向下滚动 · 缓慢匀速</span>
        )}
        <span className="np-shot-sbar-dir" data-tip="横向滚动截图暂未支持">
          纵向
        </span>
        <span className="np-shot-sbar-spacer" />
        <button
          className="np-shot-tool np-shot-ok"
          data-tip="用已拼内容出结果"
          data-kbd="Enter"
          disabled={busy}
          onClick={() => act("finish")}
        >
          <AppIcon icon={Check} size={DENSITY.iconLg} />
        </button>
        <button
          className="np-shot-tool np-shot-danger"
          data-tip="丢弃长图"
          data-kbd="Esc"
          disabled={busy}
          onClick={() => act("cancel")}
        >
          <AppIcon icon={X} size={DENSITY.iconLg} />
        </button>
      </div>
    </div>
  );
}
