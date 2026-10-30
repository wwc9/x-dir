// 热键录制按钮（设置 → 截图，2026-10-30）：点击进入录制态，直接按下组合键
// 即捕获（lib/hotkey.captureHotkey 判定），Esc / 失焦 / 点击外部取消；无效
// 组合（裸字母等）经 notify 提示并保持录制。键位呈现复用 np-kbd 键帽（与
// 快捷键清单页同一视觉语言），样式类 np-hotrec 在 index.css。
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { captureHotkey } from "../lib/hotkey";

export interface HotkeyRecorderProps {
  /** 当前热键串（如 "Ctrl+Alt+A"） */
  value: string;
  disabled?: boolean;
  /** 捕获到完整组合（调用方负责落盘与重注册） */
  onApply: (combo: string) => void;
  /** 无效组合提示（灵动岛 toast） */
  notify: (msg: string) => void;
}

export function HotkeyRecorder({ value, disabled, onApply, notify }: HotkeyRecorderProps) {
  const [rec, setRec] = useState(false);
  const rootRef = useRef<HTMLButtonElement>(null);
  // onApply/notify 闭包经 ref 取最新值，录制监听不随其重建
  const applyRef = useRef(onApply);
  applyRef.current = onApply;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRec(false);
        return;
      }
      const r = captureHotkey(e);
      if (r.state === "ok") {
        setRec(false);
        applyRef.current(r.combo);
      } else if (r.state === "invalid") {
        notifyRef.current(r.reason);
      }
    };
    // 捕获阶段先于页面/React 快捷键路由（lib/keyboard.ts）吞掉录制期按键
    window.addEventListener("keydown", onKey, true);
    const cancel = () => setRec(false);
    window.addEventListener("blur", cancel);
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) cancel();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [rec]);

  const toggle = useCallback(() => setRec((v) => !v), []);

  return (
    <button
      ref={rootRef}
      type="button"
      className={`np-hotrec ${rec ? "is-rec" : ""}`}
      disabled={disabled}
      onClick={toggle}
    >
      <span className="np-kbds">
        {value.split("+").map((seg, j) => (
          <Fragment key={j}>
            {j > 0 && <span className="np-kbd-plus">+</span>}
            <kbd className="np-kbd">{seg}</kbd>
          </Fragment>
        ))}
      </span>
      <span className="np-hotrec-hint">{rec ? "按下组合键 · Esc 取消" : "点击更改"}</span>
    </button>
  );
}
