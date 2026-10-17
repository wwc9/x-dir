// 快速预览宿主（Quick Look 模型，V2 立项）：非阻断式大浮层，Space/Esc/↑↓ 三键闭环。
// 渲染核心抽在 preview/PreviewBody（与全盘搜索内嵌面板共用），本文件只管外壳：
// Dialog、header 动作条、prev/next、页脚元信息、选中同步活动窗格。

import { useEffect, useState } from "react";
import { Button, Dialog } from "@blueprintjs/core";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Copy,
  FolderOpen,
  RotateCw,
  SquareArrowOutUpRight,
  Trash2,
  X,
} from "lucide-react";

import { api, type FileEntry } from "../lib/ipc";
import { parentPath } from "../lib/path";
import { getList } from "../lib/listRegistry";
import { fileIcon } from "../lib/fileIcons";
import { PREVIEW_LABELS, previewKind, type PreviewKind } from "../lib/previewKind";
import { DENSITY } from "../lib/tokens";
import { useLayout } from "../stores/layout";
import { useClipboard } from "../stores/clipboard";
import { usePanes } from "../stores/panes";
import { usePreview } from "../stores/preview";
import { confirmDialog, useUi } from "../stores/ui";
import { AppIcon, ic } from "./AppIcon";
import { needsPreviewLoad, PreviewBody, type PreviewMeta } from "./preview/PreviewBody";

export function QuickPreviewHost() {
  const queue = usePreview((s) => s.queue);
  const index = usePreview((s) => s.index);
  const close = usePreview((s) => s.close);
  const next = usePreview((s) => s.next);
  const prev = usePreview((s) => s.prev);
  const entry: FileEntry | null = queue[index] ?? null;
  // 文件夹不按扩展名路由：isDir 直取 folder（目录名可能带点，如 "v1.2 备份"）
  const kind: PreviewKind = entry
    ? entry.isDir
      ? "folder"
      : previewKind(entry.name)
    : "fallback";

  const [meta, setMeta] = useState<PreviewMeta>({
    load: { stage: "loading" },
    pdfPages: null,
    infoText: null,
  });
  const [rotateTick, setRotateTick] = useState(0);

  // 预览位置变化（键盘 ↑↓ / 头部切换钮共用）→ 同步活动窗格列表选中（按路径，搜索结果同名不误伤）
  const entryPath = entry?.path;
  useEffect(() => {
    setRotateTick(0);
    if (!entryPath) return;
    const en = usePreview.getState().current();
    const pane = useLayout.getState().activePane();
    const tabId = pane?.tabs[pane.activeTab]?.id;
    if (en && tabId) usePanes.getState().setSelected(tabId, [en.path], en.path);
  }, [entryPath]);

  function openDefault(en: FileEntry) {
    // 文件夹"打开"= 活动窗格导航进入（不是丢给系统 Explorer）
    if (en.isDir) {
      const pane = useLayout.getState().activePane();
      const tabId = pane?.tabs[pane.activeTab]?.id;
      if (tabId) {
        close();
        usePanes.getState().navigate(tabId, en.path);
      }
      return;
    }
    void api.openItem(en.path).catch((err) => useUi.getState().toast(String(err), "error"));
  }

  function copyPath(en: FileEntry) {
    navigator.clipboard
      .writeText(en.path)
      .then(() => useUi.getState().toast("路径已复制"))
      .catch(() => useUi.getState().toast("复制失败", "error"));
  }

  function copyFile(en: FileEntry) {
    useClipboard.getState().set("copy", [en.path]);
    useUi.getState().toast("已复制到应用剪贴板，可在窗格中粘贴");
  }

  function removeFile(en: FileEntry) {
    void confirmDialog({
      title: "删除文件",
      message: `确定将 "${en.name}" 移入回收站吗？`,
      kind: "warn",
      okText: "删除",
    }).then((ok) => {
      if (!ok) return;
      close();
      void api.deleteItems([en.path]).catch((err) => useUi.getState().toast(String(err), "error"));
    });
  }

  function reveal(en: FileEntry) {
    const parent = parentPath(en.path);
    if (!parent) return;
    const pane = useLayout.getState().activePane();
    const tabId = pane?.tabs[pane.activeTab]?.id;
    if (!tabId) return;
    close();
    // 已在该目录时 navigate 自动 no-op（不产生重复历史）
    usePanes.getState().navigate(tabId, parent);
    // 同目录（最常见）：条目已在内存，直接选中 + 滚动定位（按路径匹配）
    const cur = getList(tabId);
    if (cur?.getSnapshot().entries.some((e) => e.path === en.path)) {
      cur.revealEntry(en.path);
      return;
    }
    // 跨目录：navigate 会清空选中，故在其后立即设置（选中先行，不依赖分页加载）；
    // 滚动定位等首屏数据到位后补做（大目录里目标可能不在已加载页，3s 内没到就放弃，
    // 保留选中态由状态条提示）
    usePanes.getState().setSelected(tabId, [en.path], en.path);
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      const l = getList(tabId);
      if (l?.getSnapshot().entries.some((e) => e.path === en.path)) {
        window.clearInterval(timer);
        l!.revealEntry(en.path);
      } else if (Date.now() - t0 > 3000) {
        window.clearInterval(timer);
      }
    }, 80);
  }

  const footerLeft = (): string => {
    if (!entry) return "";
    // load 状态按类型门控：切换类型瞬间上一文件的 load 是陈旧的，不可读
    const canUseLoad = needsPreviewLoad(kind);
    if (canUseLoad && meta.load.stage === "text") {
      const d = meta.load.data;
      const lines = d.content ? d.content.split("\n").length : 0;
      return `${d.encoding} · ${lines.toLocaleString()} 行${d.truncated ? " · 已截断" : ""}`;
    }
    if (canUseLoad && meta.load.stage === "office") {
      const d = meta.load.data;
      return `${d.sections.length} 节${d.truncated ? " · 已截断" : ""}`;
    }
    if (kind === "pdf" && meta.pdfPages !== null) return `PDF · ${meta.pdfPages} 页`;
    if (kind === "archive" && meta.infoText) return meta.infoText;
    if (kind === "folder" && meta.infoText) return `文件夹 · ${meta.infoText}`;
    return PREVIEW_LABELS[kind];
  };

  const spec = entry ? fileIcon(entry.name, entry.isDir, false) : null;

  return (
    <Dialog
      isOpen={!!entry}
      onClose={close}
      className="np-dialog np-pv"
      style={{ width: "var(--np-pv-w)", height: "var(--np-pv-h)" }}
      canOutsideClickClose
      canEscapeKeyClose={false}
      isCloseButtonShown={false}
    >
      {entry && spec && (
        <div className="np-pv">
          <header className="np-pv-head">
            <AppIcon icon={spec.icon} size={DENSITY.iconMd} colorVar={spec.colorVar} />
            <span className="np-pv-name np-ellipsis">{entry.name}</span>
            <span className="np-pv-badge">{PREVIEW_LABELS[kind]}</span>
            <span className="np-pv-head-spacer" />
            <Button
              minimal
              size="small"
              icon={ic(ChevronLeft)}
              title="上一个 (↑)"
              disabled={queue.length <= 1}
              onClick={prev}
            />
            <Button
              minimal
              size="small"
              icon={ic(ChevronRight)}
              title="下一个 (↓)"
              disabled={queue.length <= 1}
              onClick={next}
            />
            {kind === "image" && (
              <Button
                minimal
                size="small"
                icon={ic(RotateCw)}
                title="顺时针旋转 90°"
                onClick={() => setRotateTick((t) => t + 1)}
              />
            )}
            <Button
              minimal
              size="small"
              icon={ic(Copy)}
              title="复制完整路径"
              onClick={() => copyPath(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(ClipboardCopy)}
              title="复制文件（可在窗格中粘贴）"
              onClick={() => copyFile(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(Trash2)}
              title="删除到回收站"
              className="np-pv-danger"
              onClick={() => removeFile(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(SquareArrowOutUpRight)}
              title="用默认程序打开 (Enter)"
              onClick={() => openDefault(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(FolderOpen)}
              title="打开所在文件夹"
              onClick={() => reveal(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(X)}
              title="关闭 (Esc / Space)"
              onClick={close}
            />
          </header>
          <PreviewBody
            entry={entry}
            rotateSignal={rotateTick}
            onOpen={openDefault}
            onReveal={reveal}
            onMeta={setMeta}
          />
          <footer className="np-pv-foot">
            <span className="np-ellipsis">{footerLeft()}</span>
            <span className="np-pv-foot-spacer" />
            <span className="np-pv-pos">
              {index + 1} / {queue.length}
            </span>
          </footer>
        </div>
      )}
    </Dialog>
  );
}
