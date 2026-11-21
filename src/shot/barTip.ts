// 浮条 tooltip 外渲染通道（2026-11-21 用户需求「像截图工具栏一样悬在按钮
// 上方」）：浮条窗仅 44px 高，窗内气泡上方翻不出、终钳必压条面——改由同会话
// 全屏穿透的遮罩窗（shot-frame，显示器原点全屏覆盖）代渲染：浮条侧监听
// data-tip/data-kbd 经事件下发（按钮顶缘中心虚拟屏坐标），遮罩窗侧以 np-tip
// 同款样式悬在按钮正上方。遮罩窗本就 set_ignore_cursor_events 穿透，气泡
// pointer-events:none，不新增任何点击拦截。行为对齐全局 tooltip：120ms 延迟、
// mousedown/Esc 即隐、focusin 同样触发。
import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";

const DELAY = 120;

/** 浮条挂载即接管 tooltip（替代 initTooltip）；返回 hide 供态变时清残留 */
export function useBarTip(): () => void {
  useEffect(() => {
    let timer: number | null = null;
    let cur: Element | null = null;
    let alive = true;
    const hide = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cur = null;
      if (alive) void emitTo("shot-frame", "shot-bar-tip", null).catch(() => undefined);
    };
    const show = (t: Element) => {
      const text = t.getAttribute("data-tip");
      if (!text) return;
      const r = t.getBoundingClientRect();
      void emitTo("shot-frame", "shot-bar-tip", {
        text,
        kbd: t.getAttribute("data-kbd"),
        // 按钮顶缘中心（虚拟屏逻辑坐标）：遮罩窗按自身 screenX/Y 换算窗口内位
        sx: window.screenX + r.left + r.width / 2,
        sy: window.screenY + r.top,
      }).catch(() => undefined);
    };
    const enter = (t: Element) => {
      if (t === cur) return;
      hide();
      cur = t;
      timer = window.setTimeout(() => {
        timer = null;
        if (cur === t) show(t);
      }, DELAY);
    };
    const over = (e: Event) => {
      const t = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (t) enter(t);
      else hide();
    };
    const focus = (e: FocusEvent) => {
      const t = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (t) enter(t);
    };
    const down = () => hide();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, []);
  return () => void emitTo("shot-frame", "shot-bar-tip", null).catch(() => undefined);
}
