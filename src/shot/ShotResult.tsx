// 滚动长图结果窗（§3.6 二期 B 批，label shot-result）：长图等比显示、区内
// 滚动查看，底部工具条复制 / 保存 / 贴图 / 关闭。截断（动态内容中断或高度
// 上限）时顶部提示条说明。长图文件由 Rust 侧在本窗销毁时清理；贴图会先在
// Rust 侧复制专属副本，不受本窗清理影响。
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Copy, Pin, Save, X } from "lucide-react";

import { api } from "../lib/ipc";
import { AppIcon } from "../components/AppIcon";

export interface ResultBoot {
  window: "result";
  file: string;
  /** 长图原始物理像素尺寸 */
  w: number;
  h: number;
  /** true = 因动态内容 / 高度上限中途截断 */
  truncated: boolean;
}

export function ShotResult({ boot }: { boot: ResultBoot }) {
  const win = getCurrentWindow();
  const [busy, setBusy] = useState<"" | "copy" | "save" | "pin">("");
  const [tip, setTip] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void win.close().catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    async (action: "copy" | "save" | "pin") => {
      if (busy) return;
      setBusy(action);
      try {
        if (action === "copy") {
          await api.shotResultCopy(boot.file);
          void win.close().catch(() => undefined);
        } else if (action === "save") {
          const saved = await api.shotResultSave(boot.file);
          if (saved) {
            setTip(`已保存 ${saved.split(/[\\/]/).pop()}`);
            setBusy("");
            setTimeout(() => void win.close().catch(() => undefined), 1400);
          } else {
            setBusy(""); // 取消保存对话框
          }
        } else {
          // 贴图出现在结果窗中心（窗口物理位置 + 物理尺寸）
          const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
          await api.shotPinFile(boot.file, pos.x + size.width / 2, pos.y + size.height / 2);
          void win.close().catch(() => undefined);
        }
      } catch (e) {
        setTip(`操作失败：${String(e)}`);
        setBusy("");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, boot.file],
  );

  return (
    <div className="np-shot-result">
      {boot.truncated && (
        <div className="np-shot-result-trunc">
          内容动态变化或已达高度上限，长图在此截断（可框选更小区域重试）
        </div>
      )}
      <div className="np-shot-result-view">
        <img
          ref={imgRef}
          src={convertFileSrc(boot.file)}
          crossOrigin="anonymous"
          alt="滚动长图"
          draggable={false}
          // 首帧就绪回执：Rust 此时才 show（提前 show 闪黑屏）
          onLoad={() => void api.shotReady().catch(() => undefined)}
          style={{ width: boot.w }}
        />
      </div>
      <div className="np-shot-result-bar">
        <span className="np-shot-result-dim">
          {boot.w.toLocaleString()} × {boot.h.toLocaleString()} px
        </span>
        {tip ? (
          <span className="np-shot-result-tip">{tip}</span>
        ) : (
          <span className="np-shot-result-tip">Esc 关闭</span>
        )}
        <button className="np-shot-btn" disabled={busy !== ""} onClick={() => void run("pin")}>
          <AppIcon icon={Pin} />
          贴图
        </button>
        <button
          className="np-shot-btn primary"
          disabled={busy !== ""}
          onClick={() => void run("copy")}
        >
          <AppIcon icon={Copy} />
          复制
        </button>
        <button className="np-shot-btn" disabled={busy !== ""} onClick={() => void run("save")}>
          <AppIcon icon={busy === "save" ? Check : Save} />
          保存
        </button>
        <button
          className="np-shot-btn danger"
          disabled={busy !== ""}
          onClick={() => void win.close().catch(() => undefined)}
        >
          <AppIcon icon={X} />
          关闭
        </button>
      </div>
    </div>
  );
}
