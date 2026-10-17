// 顶栏灵动岛（2026-10-15）：中央动态信息位，默认回落为活动窗格路径。
// 仲裁规则在 lib/island（纯函数配单测），本组件只做订阅、渲染与点击行为：
// 任务 → 展开任务面板（进度条 + 暂停/继续 + 取消，原 JobCenter 已并入）；
// 交换模式 → 取消；全盘搜索 → 唤起面板；回执 → 点击消去。
// 剪贴板持有为纯指示（不响应点击，粘贴仍走 Ctrl+V / 右键菜单）。
import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  Check,
  CircleX,
  ClipboardCopy,
  Info,
  Scissors,
  Search,
} from "lucide-react";

import { THIS_PC } from "../lib/ipc";
import { fileNameOf } from "../lib/path";
import { DENSITY } from "../lib/tokens";
import {
  resolveIsland,
  summarizeJobs,
  type IslandView,
} from "../lib/island";
import { useClipboard } from "../stores/clipboard";
import { useIsland } from "../stores/island";
import { useJobs } from "../stores/jobs";
import { useLayout } from "../stores/layout";
import { usePanes } from "../stores/panes";
import { useUi } from "../stores/ui";
import { AppIcon } from "./AppIcon";
import { JobList } from "./JobList";

export function IslandPill({ path }: { path: string }) {
  const order = useJobs((s) => s.order);
  const jobs = useJobs((s) => s.jobs);
  const expanded = useJobs((s) => s.expanded);
  const swap = useUi((s) => s.swapFrom !== null);
  const receipts = useIsland((s) => s.receipts);
  const gsearch = useIsland((s) => s.gsearch);
  const clip = useClipboard((s) => s.clip);
  // 活动窗格选中数（默认路径态后缀：「已选 N 项」）
  const activeTabId = useLayout(
    (s) => s.activePane()?.tabs[s.activePane()!.activeTab]?.id ?? "",
  );
  const selected = usePanes((s) =>
    activeTabId ? (s.tabs[activeTabId]?.selected.length ?? 0) : 0,
  );

  // 1s 心跳：驱动回执过期（组件极小，1fps 重渲染可忽略）
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => {
      useIsland.getState().prune(Date.now());
      tick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const view: IslandView = resolveIsland({
    now: Date.now(),
    job: summarizeJobs(jobs, order),
    swap,
    gsearch,
    receipts,
    clip: clip ? { count: clip.paths.length, cut: clip.mode === "cut" } : null,
    path,
    selected,
  });

  // 各通道的点击行为（path/clipboard 默认态为静态，事件透传给外层拖拽区拖动窗口）
  function onClick() {
    switch (view.kind) {
      case "job":
        useJobs.getState().toggleExpanded();
        break;
      case "swap":
        useUi.getState().cancelSwap();
        break;
      case "gsearch":
        useUi.getState().openGlobalSearch();
        break;
      case "receipt":
        useIsland.getState().dismissReceipt(view.receipt.id);
        break;
    }
  }

  const interactive =
    view.kind === "job" ||
    view.kind === "swap" ||
    view.kind === "gsearch" ||
    view.kind === "receipt";
  const cls = [
    "np-island",
    interactive ? "is-clickable" : "is-static",
    view.kind === "receipt" ? `is-${view.receipt.tone}` : "",
    view.kind === "job" || view.kind === "swap" || view.kind === "gsearch"
      ? "is-live"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const inner = (() => {
    switch (view.kind) {
      case "job": {
        const j = view.job;
        const pctText =
          j.percent === null
            ? j.anyQueued
              ? "排队中"
              : "…"
            : `${Math.round(j.percent * 100)}%`;
        const state = j.anyPaused ? " · 已暂停" : "";
        return (
          <>
            {/* 迷你进度条：不确定态（排队/无总量）降透明度示意 */}
            <span
              className={`np-island-bar${j.percent === null ? " is-und" : ""}`}
              aria-hidden="true"
            >
              <span
                style={{ width: `${Math.round((j.percent ?? 0.35) * 100)}%` }}
              />
            </span>
            <span className="np-ellipsis">
              {j.label}
              {j.count > 1 ? ` ×${j.count}` : ""} {pctText}
              {state}
            </span>
          </>
        );
      }
      case "swap":
        return (
          <>
            <AppIcon icon={ArrowLeftRight} size={DENSITY.iconXs} />
            <span>点选目标窗格 · Esc 取消</span>
          </>
        );
      case "gsearch":
        return (
          <>
            <AppIcon icon={Search} size={DENSITY.iconXs} />
            <span>全盘搜索… {view.matched} 项</span>
          </>
        );
      case "receipt": {
        const Icon =
          view.receipt.tone === "ok" ? Check : view.receipt.tone === "fail" ? CircleX : Info;
        return (
          <>
            <AppIcon icon={Icon} size={DENSITY.iconXs} />
            <span className="np-ellipsis">{view.receipt.text}</span>
          </>
        );
      }
      case "clipboard":
        return (
          <>
            <AppIcon
              icon={view.cut ? Scissors : ClipboardCopy}
              size={DENSITY.iconXs}
            />
            <span>
              已{view.cut ? "剪切" : "复制"} {view.count} 项
            </span>
          </>
        );
      case "path":
        return (
          <>
            <span>{path === THIS_PC ? "此电脑" : fileNameOf(path)}</span>
            {view.selected > 0 && (
              <span className="np-island-sel">已选 {view.selected} 项</span>
            )}
          </>
        );
    }
  })();

  return (
    <span className="np-island-wrap">
      <button
        type="button"
        className={cls}
        onClick={onClick}
        title={islandTitle(view)}
      >
        {inner}
      </button>
      {/* 任务面板：锚定岛下方，展开开关与 pill 点击共享（stores/jobs.expanded） */}
      {expanded && view.kind === "job" && <JobList />}
    </span>
  );
}

function islandTitle(view: IslandView): string {
  switch (view.kind) {
    case "job":
      return "点击展开任务面板（暂停/继续/取消）";
    case "swap":
      return "点击取消交换（Esc 同效）";
    case "gsearch":
      return "点击打开全盘搜索";
    case "receipt":
      return view.receipt.text;
    case "clipboard":
      return "";
    case "path":
      return "";
  }
}
