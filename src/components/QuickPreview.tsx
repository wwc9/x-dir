// 快速预览宿主（Quick Look 模型，V2 立项）：非阻断式大浮层，Space/Esc/↑↓ 三键闭环。
// 渲染核心抽在 preview/PreviewBody（与全盘搜索内嵌面板共用），本文件只管外壳：
// Dialog、header 动作条、prev/next、页脚元信息、选中同步活动窗格。

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { Button, Dialog, DialogBody, InputGroup } from "@blueprintjs/core";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCopy,
  Copy,
  FolderOpen,
  RotateCw,
  Search,
  SquareArrowOutUpRight,
  Trash2,
  WrapText,
  X,
} from "lucide-react";

import { api, type FileEntry } from "../lib/ipc";
import { enqueueDelete } from "../lib/operations";
import { loadDialogPrefs, saveDialogPrefs } from "../lib/dialogPrefs";
import { parentPath } from "../lib/path";
import { getList } from "../lib/listRegistry";
import { fileIcon } from "../lib/fileIcons";
import { PREVIEW_LABELS, previewKind, type PreviewKind } from "../lib/previewKind";
import { SEARCHABLE_KINDS, type PreviewSearchCtl } from "../lib/previewSearch";
import { DENSITY } from "../lib/tokens";
import { useLayout } from "../stores/layout";
import { useClipboard } from "../stores/clipboard";
import { usePanes } from "../stores/panes";
import { usePreview } from "../stores/preview";
import { confirmDialog, useUi } from "../stores/ui";
import { AppIcon, ic } from "./AppIcon";
import { codeLangOf } from "./preview/DocPreview";
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
  // 页码跳转槽（2026-11-25 用户定稿放 footer 中央，不遮 PDF 内容）：PdfPreview
  // 经 portal 渲染进该槽（footer 三段：左 meta / 中跳转 / 右文件序位）
  const [jumpSlot, setJumpSlot] = useState<HTMLSpanElement | null>(null);
  // 文本自动换行开关（默认开 = 历史行为；关闭后 nowrap + 行号）
  const [textWrap, setTextWrap] = useState(true);
  // 预览内查找（Ctrl+F 唤起；词/活动命中/总数由宿主持有）
  const searchOpen = usePreview((s) => s.searchOpen);
  const setSearchOpen = usePreview((s) => s.setSearchOpen);
  const [term, setTerm] = useState("");
  const [matchActive, setMatchActive] = useState(0);
  const [matchTotal, setMatchTotal] = useState(0);
  const searchable = SEARCHABLE_KINDS.has(kind);
  const searchRef = useRef<HTMLInputElement>(null);

  // 换条目：查找态与命中归零（store 开关一并收起）；换行开关重置为该类型默认
  // ——代码文件默认不换行（带行号，VS Code 主流读码形态），其余文本默认换行
  const entryKey = entry?.path;
  useEffect(() => {
    setTerm("");
    setMatchActive(0);
    setMatchTotal(0);
    setSearchOpen(false);
    setTextWrap(!(entry && !entry.isDir && codeLangOf(entry.name)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey]);

  // ── 窗口化尺寸（2026-11-19 用户需求「快速预览窗口要支持调整高度和宽度」）：
  // CSS 原生 resize:both 手柄（右下角 grip，见 .np-pv），尺寸经 dialogPrefs
  // 记忆——开窗读 quickPreview 档（缺省走 CSS var 响应式默认），用户拖拽
  // （pointerdown 落在右下 grip 角）触发的尺寸变化防抖写档；浏览器拖拽会直写
  // element.style，React 侧经 ResizeObserver 同步 state 保持一致，导航换文件
  // 不重置（窗口尺寸跟随会话），关窗重开 = 上次尺寸。
  // 比例档（2026-11-26 用户需求「默认尺寸要和工具整体尺寸的比例要固定——
  // 有时候工具界面缩放之后预览界面变得很小」）：dialogPrefs 改存**相对主窗
  // 比例**（rw/rh = 预览 px / 主窗 inner 宽高）而非绝对像素——旧档存 px 在
  // 主窗缩放/换大屏后比例失衡（小窗开大档溢出、大窗开小档缩成一点）。开窗
  // 与主窗 resize 都按比例 × 当前窗尺寸重算（钳 360×280 下限 / 主窗留 24px
  // 边距上限）；旧 px 档沿用一次，下次拖拽保存即迁移为比例档；从未拖拽过
  // 走 CSS var（86vw/78vh，本身即响应式比例）
  const [pvSize, setPvSize] = useState<{ w?: number; h?: number }>({});
  const pvRatioRef = useRef<{ rw: number; rh: number } | null>(null);
  const pvOpenRef = useRef(false);
  const clampPvRatio = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  const applyPvRatio = (rw: number, rh: number) => {
    pvRatioRef.current = { rw, rh };
    setPvSize({
      w: clampPvRatio(Math.round(rw * window.innerWidth), 360, window.innerWidth - 24),
      h: clampPvRatio(Math.round(rh * window.innerHeight), 280, window.innerHeight - 24),
    });
  };
  useEffect(() => {
    const isOpen = !!entry;
    if (isOpen && !pvOpenRef.current) {
      // ⚠ fallback 必须含键（mergeDialogPrefs 只拷 fallback 已有的键），
      // 空对象会静默吞掉全部保存值；缺 rw/rh 键比例档同样被剥掉；0 由下方
      // 映射回 undefined 走响应式默认
      const p = loadDialogPrefs<{ w: number; h: number; rw?: number; rh?: number }>(
        "quickPreview",
        { w: 0, h: 0, rw: 0, rh: 0 },
      );
      if (p.rw && p.rh) {
        applyPvRatio(p.rw, p.rh);
      } else if (p.w > 0 && p.h > 0) {
        // 旧版绝对像素档：沿用一次（saveDialogPrefs 整键替换，下次拖拽保存
        // 即整体迁移为比例档）
        pvRatioRef.current = {
          rw: clampPvRatio(p.w / window.innerWidth, 0.15, 0.95),
          rh: clampPvRatio(p.h / window.innerHeight, 0.15, 0.95),
        };
        setPvSize({ w: p.w, h: p.h });
      } else {
        pvRatioRef.current = null;
        setPvSize({});
      }
    }
    pvOpenRef.current = isOpen;
  }, [entry]);

  useEffect(() => {
    if (!entry) return;
    // 机制（全 window 捕获层委托，无元素预解析——开窗 effect 时 portal 元素
    // 未必可查，一次性 querySelector 会空手而归致监听落空 2026-11-19 实测）：
    // pointerdown 落在 .np-pv 右下 20px grip 角 → 记起点尺寸置 pending；
    // pointerup / 1s 兜底采样提交——尺寸变了才 setPvSize + saveDialogPrefs
    let pending = false;
    let w0 = 0;
    let h0 = 0;
    const onDown = (e: PointerEvent) => {
      const box = (e.target as HTMLElement | null)
        ?.closest?.(".np-dialog.np-pv") as HTMLElement | null;
      if (!box) return;
      const r = box.getBoundingClientRect();
      if (r.right - e.clientX > 20 || r.bottom - e.clientY > 20) return;
      pending = true;
      w0 = Math.round(box.clientWidth);
      h0 = Math.round(box.clientHeight);
    };
    const commit = () => {
      if (!pending) return;
      const box = document.querySelector<HTMLElement>(".np-dialog.np-pv");
      if (!box) return;
      const w = Math.round(box.clientWidth);
      const h = Math.round(box.clientHeight);
      if (w === w0 && h === h0) return;
      pending = false;
      setPvSize({ w, h });
      // 比例档落盘（相对主窗 inner 尺寸，2026-11-26）
      const rw = clampPvRatio(w / window.innerWidth, 0.15, 0.95);
      const rh = clampPvRatio(h / window.innerHeight, 0.15, 0.95);
      pvRatioRef.current = { rw, rh };
      saveDialogPrefs("quickPreview", { rw, rh });
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", commit, true);
    const t = window.setInterval(commit, 1000);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", commit, true);
      window.clearInterval(t);
    };
  }, [entry !== null]);

  // 主窗缩放 → 预览按记忆比例跟随重排（比例恒定；从未拖拽过的纯默认档走
  // CSS var vw/vh 天然跟随，无需处理）
  useEffect(() => {
    const onWinResize = () => {
      const r = pvRatioRef.current;
      if (!r || !pvOpenRef.current) return;
      applyPvRatio(r.rw, r.rh);
    };
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  // Ctrl+F（keyboard 路由）唤起后聚焦输入框
  useEffect(() => {
    if (searchOpen)
      requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  const stepMatch = (dir: 1 | -1) => {
    setMatchActive((a) =>
      matchTotal > 0 ? (a + dir + matchTotal) % matchTotal : 0,
    );
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setTerm("");
    setMatchActive(0);
    setMatchTotal(0);
  };
  const searchCtl: PreviewSearchCtl | undefined = useMemo(
    () =>
      searchable && searchOpen
        ? { term, active: matchActive, onTotal: (n) => setMatchTotal(n) }
        : undefined,
    [searchable, searchOpen, term, matchActive],
  );

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
      .then(() => useUi.getState().toast(t("路径已复制")))
      .catch(() => useUi.getState().toast(t("复制失败"), "error"));
  }

  function copyFile(en: FileEntry) {
    useClipboard.getState().set("copy", [en.path]);
    useUi.getState().toast(t("已复制到应用剪贴板，可在窗格中粘贴"));
  }

  function removeFile(en: FileEntry) {
    void confirmDialog({
      title: t("删除文件"),
      message: t("确定将 \"{name}\" 移入回收站吗？", { name: en.name }),
      kind: "warn",
      okText: t("删除"),
    }).then((ok) => {
      if (!ok) return;
      // 走任务引擎 enqueueDelete（2026-11-27 审查修复）：带进度卡/撤销回执，
      // 与列表删除同链路；此前直调 api.deleteItems 无任务无撤销。删除后
      // 预览前进到下一项（队列空则关闭），支持连续清点
      void enqueueDelete([en.path], false);
      usePreview.getState().removeCurrent();
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
      return `${d.encoding} · ${t("{n} 行", { n: lines.toLocaleString() })}${d.truncated ? t(" · 已截断") : ""}`;
    }
    if (canUseLoad && meta.load.stage === "office") {
      const d = meta.load.data;
      return `${t("{n} 节", { n: d.sections.length })}${d.truncated ? t(" · 已截断") : ""}`;
    }
    if (kind === "pdf" && meta.pdfPages !== null)
      return t("PDF · {n} 页", { n: meta.pdfPages });
    if (kind === "officeBinary" && meta.pdfPages !== null)
      return t("转换预览 · {n} 页", { n: meta.pdfPages });
    if (kind === "archive" && meta.infoText) return meta.infoText;
    if (kind === "folder" && meta.infoText)
      return t("文件夹 · {x}", { x: meta.infoText });
    return t(PREVIEW_LABELS[kind]);
  };

  const spec = entry ? fileIcon(entry.name, entry.isDir, false) : null;

  return (
    <Dialog
      isOpen={!!entry}
      onClose={close}
      className="np-dialog np-pv"
      style={{
        width: pvSize.w ? `${pvSize.w}px` : "var(--np-pv-w)",
        height: pvSize.h ? `${pvSize.h}px` : "var(--np-pv-h)",
      }}
      canOutsideClickClose
      canEscapeKeyClose={false}
      isCloseButtonShown={false}
    >
      {entry && spec && (
        <DialogBody className="np-pv">
          <header className="np-pv-head">
            <AppIcon icon={spec.icon} size={DENSITY.iconMd} colorVar={spec.colorVar} />
            <span className="np-pv-name np-ellipsis">{entry.name}</span>
            <span className="np-pv-badge">{t(PREVIEW_LABELS[kind])}</span>
            <span className="np-pv-head-spacer" />
            <Button
              minimal
              size="small"
              icon={ic(ChevronLeft)}
              data-tip={t("上一个")} data-kbd="↑"
              disabled={queue.length <= 1}
              onClick={prev}
            />
            <Button
              minimal
              size="small"
              icon={ic(ChevronRight)}
              data-tip={t("下一个")} data-kbd="↓"
              disabled={queue.length <= 1}
              onClick={next}
            />
            {/* 旋转仅图片与 PDF（2026-11-23 用户需求「预览要支持对文件旋转」）：
                图片经 ImagePreview 变换矩阵，PDF 经旋转视口重渲染（文本层随视口
                同转，选中/查找高亮不漂移） */}
            {(kind === "image" || kind === "pdf") && (
              <Button
                minimal
                size="small"
                icon={ic(RotateCw)}
                data-tip={t("顺时针旋转 90°")}
                onClick={() => setRotateTick((t) => t + 1)}
              />
            )}
            {kind === "text" && (
              <Button
                minimal
                size="small"
                icon={ic(WrapText)}
                active={!textWrap}
                data-tip={
                  textWrap
                    ? t("自动换行：开（点击改为不换行 + 行号）")
                    : t("自动换行：关（点击改为换行 + 行号）")
                }
                onClick={() => setTextWrap((w) => !w)}
              />
            )}
            {searchable &&
              (searchOpen ? (
                <div className="np-pv-searchbar">
                  <InputGroup
                    small
                    leftElement={ic(Search)}
                    placeholder={t("查找…")}
                    value={term}
                    inputRef={searchRef}
                    onChange={(e) => {
                      setTerm(e.target.value);
                      setMatchActive(0);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        stepMatch(e.shiftKey ? -1 : 1);
                        e.preventDefault();
                      } else if (e.key === "Escape") {
                        closeSearch();
                      }
                    }}
                  />
                  <span className="np-pv-search-count">
                    {term ? `${matchTotal ? Math.min(matchActive + 1, matchTotal) : 0} / ${matchTotal}` : ""}
                  </span>
                  <Button
                    minimal
                    size="small"
                    icon={ic(ChevronUp)}
                    data-tip={t("上一个命中")} data-kbd="Shift+Enter"
                    disabled={!matchTotal}
                    onClick={() => stepMatch(-1)}
                  />
                  <Button
                    minimal
                    size="small"
                    icon={ic(ChevronDown)}
                    data-tip={t("下一个命中")} data-kbd="Enter"
                    disabled={!matchTotal}
                    onClick={() => stepMatch(1)}
                  />
                  <Button
                    minimal
                    size="small"
                    icon={ic(X)}
                    data-tip={t("关闭查找")} data-kbd="Esc"
                    onClick={closeSearch}
                  />
                </div>
              ) : (
                <Button
                  minimal
                  size="small"
                  icon={ic(Search)}
                  data-tip={t("预览内查找")} data-kbd="Ctrl+F"
                  onClick={() => setSearchOpen(true)}
                />
              ))}
            <Button
              minimal
              size="small"
              icon={ic(Copy)}
              data-tip={t("复制完整路径")}
              onClick={() => copyPath(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(ClipboardCopy)}
              data-tip={t("复制文件（可在窗格中粘贴）")} data-kbd="Ctrl+C"
              onClick={() => copyFile(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(Trash2)}
              data-tip={t("删除到回收站")} data-kbd="Delete"
              className="np-pv-danger"
              onClick={() => removeFile(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(SquareArrowOutUpRight)}
              data-tip={t("用默认程序打开")} data-kbd="Enter"
              onClick={() => openDefault(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(FolderOpen)}
              data-tip={t("打开所在文件夹")}
              onClick={() => reveal(entry)}
            />
            <Button
              minimal
              size="small"
              icon={ic(X)}
              data-tip={t("关闭")} data-kbd="Esc / Space"
              onClick={close}
            />
          </header>
          <PreviewBody
            entry={entry}
            rotateSignal={rotateTick}
            onOpen={openDefault}
            onReveal={reveal}
            onMeta={setMeta}
            search={searchCtl}
            textWrap={textWrap}
            jumpSlot={jumpSlot}
          />
          <footer className="np-pv-foot">
            <span className="np-ellipsis">{footerLeft()}</span>
            <span className="np-pv-foot-spacer" />
            <span ref={setJumpSlot} className="np-pv-foot-jumpslot" />
            <span className="np-pv-foot-spacer" />
            <span className="np-pv-pos">
              {index + 1} / {queue.length}
            </span>
          </footer>
        </DialogBody>
      )}
    </Dialog>
  );
}
