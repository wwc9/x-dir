// 顶栏灵动岛（2026-10-15）：中央动态信息位，默认回落为活动窗格路径。
// 仲裁规则在 lib/island（纯函数配单测），本组件只做订阅、渲染与点击行为：
// 任务 → 展开任务面板（进度条 + 暂停/继续 + 取消，原 JobCenter 已并入）；
// 交换模式 → 取消；全盘搜索 → 唤起面板；回执 → 点击消去。
// 剪贴板持有为纯指示（不响应点击，粘贴仍走 Ctrl+V / 右键菜单）。
import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  CircleX,
  ClipboardCopy,
  Copy,
  Info,
  Pin,
  PinOff,
  Scissors,
  Search,
  X,
} from "lucide-react";

import { THIS_PC } from "../lib/ipc";
import { fileNameOf } from "../lib/path";
import { shouldExpandReceipt } from "../lib/island";
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

  // 1s 心跳：驱动回执过期（组件极小，1fps 重渲染可忽略）；holdRef = 悬停中的
  // 回执（展笺方案 A：悬停续期，渲染期镜像进 ref 供定时器闭包读取）
  const [, tick] = useState(0);
  const holdRef = useRef<string | null>(null);
  // 悬停态：展开回执展笺（仅回执通道且长文本，见 longReceipt）
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => {
      useIsland.getState().prune(Date.now(), holdRef.current ?? undefined);
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
  // 展笺（2026-11-17 方案 A）：仅回执通道且文本超出胶囊单行容量时，悬停展开
  const isReceipt = view.kind === "receipt";
  const longReceipt = isReceipt && shouldExpandReceipt(view.receipt.text);
  // 心跳闭包经 ref 读当前悬停回执 id（渲染期镜像；固定态永不过期无需续期）
  holdRef.current =
    isReceipt && hover && !view.receipt.pinned ? view.receipt.id : null;
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
              ? t("排队中")
              : "…"
            : `${Math.round(j.percent * 100)}%`;
        const state = j.anyPaused ? t(" · 已暂停") : "";
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
              {t(j.label)}
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
            <span>{t("点选目标窗格 · Esc 取消")}</span>
          </>
        );
      case "gsearch":
        return (
          <>
            <AppIcon icon={Search} size={DENSITY.iconXs} />
            <span>{t("全盘搜索… {n} 项", { n: view.matched })}</span>
          </>
        );
      case "receipt": {
        const Icon =
          view.receipt.tone === "ok" ? Check : view.receipt.tone === "fail" ? CircleX : Info;
        return (
          <>
            <AppIcon icon={Icon} size={DENSITY.iconXs} />
            <span className="np-ellipsis">{view.receipt.text}</span>
            {longReceipt && <AppIcon icon={ChevronDown} size={DENSITY.iconXs} />}
            {view.receipt.action && (
              <button
                className="np-island-act"
                onClick={(e) => {
                  e.stopPropagation();
                  view.receipt.action?.run();
                  useIsland.getState().dismissReceipt(view.receipt.id);
                }}
              >
                {view.receipt.action.label}
              </button>
            )}
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
              {view.cut
                ? t("已剪切 {n} 项", { n: view.count })
                : t("已复制 {n} 项", { n: view.count })}
            </span>
          </>
        );
      case "path":
        return (
          <>
            <span>{path === THIS_PC ? t("此电脑") : fileNameOf(path)}</span>
            {view.selected > 0 && (
              <span className="np-island-sel">{t("已选 {n} 项", { n: view.selected })}</span>
            )}
          </>
        );
    }
  })();

  return (
    <span
      className="np-island-wrap"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={cls}
        onClick={onClick}
        data-tip={longReceipt ? "" : islandTitle(view)}
      >
        {inner}
      </button>
      {/* 展笺：锚定岛下方（与任务面板同锚点语义），全文 + 复制/固定/消去。
          仅回执通道且长文本、悬停期间渲染；固定后展笺随时可再展开查看 */}
      {isReceipt && longReceipt && hover && (
        <div
          className={`np-island-sheet is-${view.receipt.tone}${
            view.receipt.pinned ? " is-pinned" : ""
          }`}
        >
          <div className="np-island-sheet-body">
            <AppIcon
              icon={
                view.receipt.tone === "ok"
                  ? Check
                  : view.receipt.tone === "fail"
                    ? CircleX
                    : Info
              }
              size={DENSITY.iconSm}
              colorVar={
                view.receipt.tone === "fail"
                  ? "--np-danger"
                  : view.receipt.tone === "ok"
                    ? "--np-success"
                    : undefined
              }
            />
            <span>{view.receipt.text}</span>
          </div>
          <div className="np-island-sheet-foot">
            {view.receipt.action && (
              <button
                className="np-island-act"
                onClick={() => {
                  view.receipt.action?.run();
                  useIsland.getState().dismissReceipt(view.receipt.id);
                }}
              >
                {view.receipt.action.label}
              </button>
            )}
            <button
              className="np-island-sheet-btn"
              onClick={() => {
                navigator.clipboard
                  .writeText(view.receipt.text)
                  .then(() => useUi.getState().toast(t("已复制详情")))
                  .catch(() => undefined);
              }}
            >
              <AppIcon icon={Copy} size={DENSITY.iconXs} />
              {t("复制详情")}
            </button>
            <button
              className="np-island-sheet-btn"
              onClick={() =>
                useIsland.getState().pinReceipt(view.receipt.id, !view.receipt.pinned)
              }
            >
              <AppIcon icon={view.receipt.pinned ? PinOff : Pin} size={DENSITY.iconXs} />
              {view.receipt.pinned ? t("取消固定") : t("固定不自动消失")}
            </button>
            <span style={{ flex: 1 }} />
            <button
              className="np-island-sheet-x"
              onClick={() => useIsland.getState().dismissReceipt(view.receipt.id)}
            >
              <AppIcon icon={X} size={DENSITY.iconXs} />
            </button>
          </div>
          <span className="np-island-sheet-line" aria-hidden />
        </div>
      )}
      {/* 任务面板：锚定岛下方，展开开关与 pill 点击共享（stores/jobs.expanded） */}
      {expanded && view.kind === "job" && <JobList />}
    </span>
  );
}

function islandTitle(view: IslandView): string {
  switch (view.kind) {
    case "job":
      return t("点击展开任务面板（暂停/继续/取消）");
    case "swap":
      return t("点击取消交换（Esc 同效）");
    case "gsearch":
      return t("点击打开全盘搜索");
    case "receipt":
      return view.receipt.text;
    case "clipboard":
      return "";
    case "path":
      return "";
  }
}
