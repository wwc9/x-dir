import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  FolderInput,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Save,
  SaveAll,
  Trash2,
  X,
} from "lucide-react";

import { api, THIS_PC } from "../lib/ipc";
import {
  applyPreset,
  mkPane,
  treeDividers,
  type LayoutNode,
  type Preset,
} from "../lib/layoutTree";
import { extOf, fileIcon } from "../lib/fileIcons";
import { fileNameOf } from "../lib/path";
import { shelfEntryIsDir } from "../lib/shelf";
import { randomSchemeName } from "../lib/schemeName";
import { moveWorkspace, orderWorkspaces } from "../lib/workspaceOrder";
import { DENSITY } from "../lib/tokens";
import { useDnd } from "../stores/dnd";
import { useIcons } from "../stores/icons";
import { useLayout } from "../stores/layout";
import { useSettings } from "../stores/settings";
import { useT } from "../lib/i18n";
import { confirmDialog, useUi } from "../stores/ui";
import { beginShelfDrag, endShelfDrag } from "../lib/oleDispatch";
import { AppIcon } from "./AppIcon";
import { FadeInIcon } from "./FileList";

/** 自动保存的会话不属于用户方案，不显示在边栏 */
const LAST_SESSION = "上次会话";
/** 内置默认方案：可保存覆盖（保存后跟随自定义布局），不可删除；出厂形态 = 2×2 */
const DEFAULT_SCHEME = "默认方案";
const DEFAULT_PRESET = "2x2";
/** 默认方案的出厂预览树（未保存过时显示/应用这棵） */
const DEFAULT_TREE: LayoutNode = applyPreset(mkPane(THIS_PC), DEFAULT_PRESET);

/** 布局预设（顺序与图示一致）：应用 = 以当前窗格路径按预设重建分割树 */
const PRESET_LIST: { id: Preset; label: string; tip: string }[] = [
  { id: "1x1", label: "单格", tip: "单窗格" },
  { id: "1x2", label: "左右两栏 1×2", tip: "左右两栏" },
  { id: "2x1", label: "上下两行 2×1", tip: "上下两行" },
  { id: "1x3", label: "三栏 1×3", tip: "三栏" },
  { id: "3x1", label: "三行 3×1", tip: "三行" },
  { id: "2x2", label: "四宫格 2×2", tip: "四宫格" },
  { id: "2x3", label: "六宫格·竖 2×3", tip: "两行三列" },
  { id: "3x2", label: "六宫格·横 3×2", tip: "三行两列" },
  { id: "3x3", label: "九宫格 3×3", tip: "九宫格" },
  { id: "1|2", label: "左侧栏 + 右上下", tip: "左侧栏，右侧上下两格" },
  { id: "2|1", label: "右侧栏 + 左上下", tip: "右侧栏，左侧上下两格" },
  { id: "1+2", label: "顶栏 + 下左右", tip: "顶栏，下方左右两格" },
  { id: "2+1", label: "底栏 + 上左右", tip: "底栏，上方左右两格" },
  { id: "1+3", label: "顶栏 + 双侧栏", tip: "顶栏，下方三栏" },
  { id: "bento-t", label: "便当·上二下一", tip: "上两格 + 下整行（均分）" },
  { id: "bento-l", label: "便当·左一右二", tip: "左整列 + 右两格（均分）" },
];

/** 各预设的示意树：仅用于渲染描线缩略图，不参与真实布局 */
const PRESET_TREES = Object.fromEntries(
  PRESET_LIST.map((p) => [p.id, applyPreset(mkPane(THIS_PC), p.id)]),
) as Record<Preset, LayoutNode>;

const W_MIN = 120;
const W_MAX = 340;
/** 上下分割比例钳制（布局方案卡占比）：两侧各保 20% 可用高度 */
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;

interface Scheme {
  name: string;
  tree: LayoutNode | null;
}

/** 布局缩略图（描线风格，同布局预设图示）：外框圆角矩形 + 内部分割线；
 *  线段几何由 lib/layoutTree.ts 的 treeDividers 纯函数给出（带单测） */
function MiniTreeSvg({ node, size }: { node: LayoutNode; size: number }) {
  return (
    <svg
      className="np-side-svg"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
    >
      <rect
        x={0.5}
        y={0.5}
        width={size - 1}
        height={size - 1}
        rx={2.5}
        fill="none"
        stroke="currentColor"
      />
      {treeDividers(node, size).map((l, i) => (
        <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke="currentColor" />
      ))}
    </svg>
  );
}

/** 布局预设选择面板（16 种，4×4；挂在顶栏"布局预设"按钮下，2026-10-12 自边栏移入）：
 *  应用后弹层保持打开，可连续试排 */
export function PresetPicker() {
  const t = useT();
  return (
    <div className="np-layoutpicker">
      {PRESET_LIST.map((p) => (
        <button
          key={p.id}
          className="np-layouttile"
          data-tip={t(p.tip)}
          onClick={() => useLayout.getState().preset(p.id)}
        >
          <span className="np-side-thumb">
            <MiniTreeSvg node={PRESET_TREES[p.id]} size={DENSITY.sideThumbLg} />
          </span>
          <span>{t(p.label)}</span>
        </button>
      ))}
      <div className="np-layouthint">
        {t("预设之外，每个窗格可继续 ──/│ 递归分裂成任意混合布局")}
      </div>
    </div>
  );
}

/** 暂存行拖拽臂（展开卡与折叠飞出面板共用，2026-11-12 提到模块级）：
 *  行拖起走 startDrag 管线，落窗格即移动/复制（按暂存区模式），落 Explorer
 *  由 OLE 结算（明确回传 move 才移出暂存，copy 保留条目） */
function armShelfRowDrag(e: React.MouseEvent, path: string) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const onMove = (ev: MouseEvent) => {
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    cleanup();
    // 标记暂存区拖拽源：落点分发按标题切换钮的 移动/复制 语义执行传输；
    // 应用内落点（窗格/暂存区）的移出由 handleDrop 统一决策（有完整落点
    // 上下文，暂存条目拖回暂存区 = 无操作），这里只结算拖出到 Explorer
    // 的 OLE 效果（明确回传 move 才移出暂存，copy 保留条目）
    beginShelfDrag();
    api
      .startDrag([path])
      .then((effect) => {
        endShelfDrag();
        if (effect === "move") useSettings.getState().removeShelf(path);
      })
      .catch((err) => {
        endShelfDrag();
        useUi.getState().toast(String(err), "error");
      });
  };
  const onUp = () => cleanup();
  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** 暂存区（侧边栏下半）：临时拖放文件/文件夹，用到时拖出到目标窗格。
 *  拖入 = OLE 落点分流（oleDispatch 命中 [data-shelf] 即入库，Explorer 拖入同管线）；
 *  拖出 = 行拖起走同一 startDrag 管线，落窗格即移动，effect ≠ none 视为已取走并移出暂存。 */
function Shelf() {
  const t = useT();
  const items = useSettings((s) => s.staging);
  const realIcons = useSettings((s) => s.realIcons);
  const stagingMode = useSettings((s) => s.stagingMode);
  const iconMap = useIcons((s) => s.icons);
  const extMap = useIcons((s) => s.exts);
  const point = useDnd((s) => s.point);
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  // 真实图标：与文件列表同源（设置 realIcons 开关 + icons store 路径表/扩展名共享表）；
  // 暂存区条目 ≤200 全量直发（immediate 跳过防抖，条目少无需可见窗裁剪）
  useEffect(() => {
    if (!realIcons || !items.length) return;
    useIcons.getState().requestIcons(items, true);
  }, [items, realIcons]);

  // OLE 拖拽悬停高亮：dnd store 推 CSS 坐标，与自身矩形判定
  useEffect(() => {
    if (!point || !ref.current) {
      setOver(false);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    setOver(
      point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom,
    );
  }, [point]);

  return (
    <div ref={ref} className={`np-shelf${over ? " on" : ""}`} data-shelf>
      <div className="np-side-h">
        <span className="np-shelf-title">{t("暂存区")}</span>
        <div className="np-side-actions">
          {/* 拖出语义切换（2026-10-21 定案 · 方案 F 滑块式双图标分段，替换原双段
              文字分段）：thumb 滑块平移指示当前态，folder-input = 移动、copy = 复制，
              两态同见点另一半即切换；移动 = 落窗格即移动并移出暂存（默认）；
              复制 = 复制到目标窗格、条目保留。几何 2026-10-22 锁定 22+2+22，
              与布局方案卡标题行 .np-side-add 逐列对齐（见 index.css .np-shelf-modeseg） */}
          <span
            className="np-shelf-modeseg"
            role="group"
            aria-label={t("拖出语义：移动/复制")}
            data-mode={stagingMode}
          >
            <span className="np-shelf-modeseg-thumb" aria-hidden />
            <button
              className={stagingMode === "move" ? "on" : ""}
              data-tip={
                stagingMode === "move"
                  ? t("移动：拖动条目到窗格即移动，并移出暂存（当前模式）")
                  : t("切换为移动：拖动条目到窗格即移动，并移出暂存")
              }
              aria-label={t("拖出语义：移动")}
              aria-pressed={stagingMode === "move"}
              onClick={() => useSettings.getState().update({ stagingMode: "move" })}
            >
              <AppIcon icon={FolderInput} size={DENSITY.iconSm} />
            </button>
            <button
              className={stagingMode === "copy" ? "on" : ""}
              data-tip={
                stagingMode === "copy"
                  ? t("复制：拖动条目到窗格即复制，保留原件（当前模式）")
                  : t("切换为复制：拖动条目到窗格即复制，保留原件")
              }
              aria-label={t("拖出语义：复制")}
              aria-pressed={stagingMode === "copy"}
              onClick={() => useSettings.getState().update({ stagingMode: "copy" })}
            >
              <AppIcon icon={Copy} size={DENSITY.iconSm} />
            </button>
          </span>
          <button
            className="np-side-add"
            data-tip={t("清空暂存区")}
            disabled={!items.length}
            onClick={() => useSettings.getState().clearShelf()}
          >
            <AppIcon icon={Trash2} size={DENSITY.iconSm} />
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="np-shelf-empty">
          <div className="np-shelf-empty-badge">
            <AppIcon icon={Inbox} size={DENSITY.iconLg} />
          </div>
          <div className="np-shelf-empty-main">{t("暂存区还是空的")}</div>
          <div className="np-shelf-empty-sub">{t("拖入文件/文件夹即可暂存，跨会话保留")}</div>
        </div>
      ) : (
        <div className="np-shelf-list">
          {items.map((p) => {
            const name = fileNameOf(p);
            const isDir = shelfEntryIsDir(p);
            const spec = fileIcon(name, isDir);
            return (
              <div
                key={p.toLowerCase()}
                className="np-shelf-row"
                data-tip={p}
                onMouseDown={(e) => armShelfRowDrag(e, p)}
              >
                {realIcons ? (
                  (() => {
                    const u = iconMap[p] ?? extMap[extOf(name)] ?? undefined;
                    return u ? (
                      <FadeInIcon src={u} />
                    ) : (
                      <span className="np-icon-slot" />
                    );
                  })()
                ) : (
                  <AppIcon
                    icon={spec.icon}
                    size={DENSITY.iconMd}
                    colorVar={spec.colorVar}
                  />
                )}
                <span className="np-shelf-name">{name}</span>
                <button
                  className="np-shelf-del"
                  data-tip={t("移出暂存区")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => useSettings.getState().removeShelf(p)}
                >
                  <AppIcon icon={X} size={DENSITY.iconXs} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 折叠边栏的暂存区（2026-11-12 用户需求「暂存区也要有折叠效果」）：mini 钮
 *  （Inbox + 计数占 char 槽）承接展开卡两个职责——① data-shelf 落点：拖文件
 *  到钮上即暂存（OLE 分流同展开卡，dnd 悬停同款淡染+虚线高亮）；② 点击弹
 *  右侧飞出面板列条目，行内拖出/移出/清空与展开卡同一管线（armShelfRowDrag） */
function ShelfMini() {
  const t = useT();
  const items = useSettings((s) => s.staging);
  const realIcons = useSettings((s) => s.realIcons);
  const iconMap = useIcons((s) => s.icons);
  const extMap = useIcons((s) => s.exts);
  const point = useDnd((s) => s.point);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // 拖拽悬停高亮：dnd store 推 CSS 坐标，与钮矩形判定（同展开卡口径）
  useEffect(() => {
    if (!point || !btnRef.current) {
      setOver(false);
      return;
    }
    const r = btnRef.current.getBoundingClientRect();
    setOver(
      point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom,
    );
  }, [point]);

  const toggle = () => {
    // 空暂存不弹面板（钮上的 data-tip 已表达空态，面板只剩一句空话）；
    // 非空才定位展开：钮右侧 8px，右/下溢出回推（行高按两行名 40px 估，
    // 面板根再夹 maxHeight 兜底——估算误差不致溢出窗口）
    if (open || !items.length) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const h = Math.min(items.length, 12) * 40 + 42;
    setPos({
      x: Math.min(r.right + 8, Math.max(8, window.innerWidth - 272)),
      y: Math.min(Math.max(8, r.top - 4), Math.max(8, window.innerHeight - h - 8)),
    });
    setOpen(true);
  };

  // Esc / 点击外部关闭（捕获；钮与面板内部点击不关）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (popRef.current?.contains(el) || btnRef.current?.contains(el)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        className={`np-side-mini np-side-shelfmini${open ? " on" : ""}${over ? " dnd-on" : ""}`}
        data-shelf
        data-tip={
          items.length
            ? t("暂存区 {n} 项（点击查看 · 拖文件到这里暂存）", { n: items.length })
            : t("暂存区还是空的（拖文件到这里暂存）")
        }
        onClick={toggle}
      >
        <span className="np-side-thumb">
          <AppIcon icon={Inbox} size={DENSITY.iconSm} />
        </span>
        <span className="np-side-char">
          {items.length > 99 ? "99+" : items.length}
        </span>
      </button>
      {open && items.length > 0 && (
        <div
          ref={popRef}
          className="np-shelf-flyout"
          data-shelf
          style={{
            left: pos.x,
            top: pos.y,
            maxHeight: window.innerHeight - pos.y - 8,
          }}
        >
          <div className="np-shelf-flyout-h">
            <span>
              {t("暂存区")} · {items.length}
            </span>
            <button
              className="np-side-add"
              data-tip={t("清空暂存区")}
              disabled={!items.length}
              onClick={() => useSettings.getState().clearShelf()}
            >
              <AppIcon icon={Trash2} size={DENSITY.iconSm} />
            </button>
          </div>
          <div className="np-shelf-flyout-list">
              {items.map((p) => {
                const name = fileNameOf(p);
                const isDir = shelfEntryIsDir(p);
                const spec = fileIcon(name, isDir);
                return (
                  <div
                    key={p.toLowerCase()}
                    className="np-shelf-row"
                    data-tip={p}
                    onMouseDown={(e) => armShelfRowDrag(e, p)}
                  >
                    {realIcons ? (
                      (() => {
                        const u = iconMap[p] ?? extMap[extOf(name)] ?? undefined;
                        return u ? (
                          <FadeInIcon src={u} />
                        ) : (
                          <span className="np-icon-slot" />
                        );
                      })()
                    ) : (
                      <AppIcon
                        icon={spec.icon}
                        size={DENSITY.iconMd}
                        colorVar={spec.colorVar}
                      />
                    )}
                    <span className="np-shelf-name">{name}</span>
                    <button
                      className="np-shelf-del"
                      data-tip={t("移出暂存区")}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => useSettings.getState().removeShelf(p)}
                    >
                      <AppIcon icon={X} size={DENSITY.iconXs} />
                    </button>
                  </div>
                );
              })}
            </div>
        </div>
      )}
    </>
  );
}

/** 左侧边栏：布局方案（工作区）列表 + 内置默认方案；可拖拽调宽、可折叠 */
export function Sidebar() {  const t = useT();
  const [items, setItems] = useState<Scheme[]>([]);
  // 显示顺序（2026-11-06 拖动排序）：settings.workspaceOrder 重排，新方案
  // 字典序追加尾；松手落 settings。拖拽用指针事件手写（HTML5 dnd 在主窗被
  // tauri 原生拖放接收接管而无法启动——Windows 上 dragDropEnabled 默认开启
  // 会吞页面内 dragstart，而原生接收是外部文件拖入的依赖不能关），与侧栏
  // 宽度拖拽同款 mousedown+move 会话模式
  const order = useSettings((s) => s.workspaceOrder);
  const [dragName, setDragName] = useState<string | null>(null);
  const dragNameRef = useRef<string | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  /** 指针拖拽会话：down 起点 → 位移超阈值进入拖拽态；ref 全程同步可读 */
  const dragSessionRef = useRef<{
    name: string;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const ordered = useMemo(
    () => orderWorkspaces(items.map((i) => i.name), order),
    [items, order],
  );
  const itemOf = useMemo(() => {
    const m = new Map(items.map((i) => [i.name, i]));
    return (n: string) => m.get(n);
  }, [items]);
  const [current, setCurrent] = useState<string | null>(DEFAULT_SCHEME);
  /** 已保存的默认方案树；null = 未保存过（应用/显示出厂 2×2） */
  const [defaultTree, setDefaultTree] = useState<LayoutNode | null>(null);
  // 宽度/折叠/上下分割集中存 settings（2026-10-12 配置集中化）；拖动经本地态实时反馈、松手提交
  const savedWidth = useSettings((s) => s.sidebarWidth);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const savedRatio = useSettings((s) => s.sideSplitRatio);
  const [dragW, setDragW] = useState<number | null>(null);
  const dragWRef = useRef<number | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const dragRatioRef = useRef<number | null>(null);
  const width = dragW ?? savedWidth;
  const ratio = dragRatio ?? savedRatio;
  const asideRef = useRef<HTMLElement>(null);

  const refresh = useCallback(() => {
    // 默认方案单独取（不在用户方案列表里）：已保存则缩略图/应用跟随，未保存回落出厂树
    api
      .loadWorkspace(DEFAULT_SCHEME)
      .then((ws) => setDefaultTree((ws.tree as LayoutNode | null) ?? null))
      .catch(() => setDefaultTree(null));
    api
      .listWorkspaces()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n !== LAST_SESSION && n !== DEFAULT_SCHEME)
            .map(async (name) => {
              try {
                const ws = await api.loadWorkspace(name);
                return { name, tree: (ws.tree as LayoutNode | null) ?? null };
              } catch {
                return { name, tree: null };
              }
            }),
        ),
      )
      .then(setItems)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    // 配置导入会整体替换 workspaces/*.json：监听导入完成事件刷新方案列表
    const onImported = () => refresh();
    window.addEventListener("xdir-workspaces-changed", onImported);
    return () => window.removeEventListener("xdir-workspaces-changed", onImported);
  }, [refresh]);

  // 指针拖拽排序会话（2026-11-06）：down 记起点（卡片 onPointerDown 写入
  // dragSessionRef），move 超 4px 阈值进入拖拽态——源卡半透明 + 指针下目标卡
  // 上缘 accent 指示线（elementsFromPoint 命中 [data-ws-name]）；up 落位
  // （moveWorkspace → settings.workspaceOrder）或未激活则还原为点击语义。
  // 命中元素经 pointer-events 顶层的 tooltip 层不受影响（tooltip 无 data-ws-name）
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ss = dragSessionRef.current;
      if (!ss) return;
      if (!ss.moved && Math.hypot(e.clientX - ss.startX, e.clientY - ss.startY) < 4) return;
      if (!ss.moved) {
        ss.moved = true;
        dragNameRef.current = ss.name;
        setDragName(ss.name);
      }
      const hit = document
        .elementsFromPoint(e.clientX, e.clientY)
        .find((el) => el instanceof HTMLElement && el.dataset.wsName) as HTMLElement | undefined;
      const overName = hit?.dataset.wsName ?? null;
      const idx = overName ? ordered.indexOf(overName) : -1;
      setOverIdx(idx >= 0 && overName !== ss.name ? idx : null);
    };
    const onUp = () => {
      const ss = dragSessionRef.current;
      dragSessionRef.current = null;
      if (ss?.moved) {
        // overIdx 经 setState 异步——落位目标在 onMove 里同步算不出，这里
        // 从最终指示态取：直接读 React 最新渲染前的 overIdx 闭包值可能滞后
        // 一帧，改为在 onMove 同步镜像一份 ref
        const target = overIdxRef.current;
        if (target !== null) {
          const from = ordered.indexOf(ss.name);
          if (from >= 0 && target !== from) {
            useSettings
              .getState()
              .update({ workspaceOrder: moveWorkspace(ordered, from, target) });
          }
        }
      }
      dragNameRef.current = null;
      setDragName(null);
      setOverIdx(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [ordered]);
  const overIdxRef = useRef<number | null>(null);
  overIdxRef.current = overIdx;

  function applyDefault() {
    useLayout.getState().init(defaultTree ?? DEFAULT_TREE);
    setCurrent(DEFAULT_SCHEME);
  }

  /** 保存到选中方案（含内置默认方案，直接覆盖；缩略图随 refresh 更新） */
  async function saveToCurrent() {
    const tree = useLayout.getState().tree;
    if (!tree) return;
    if (!current) {
      await saveCurrent();
      return;
    }
    try {
      await api.saveWorkspace(current, tree);
      useUi.getState().toast(t("已保存到方案“{name}”", { name: t(current) }));
      refresh();
    } catch (e) {
      useUi.getState().toast(t("保存方案失败：{e}", { e: String(e) }), "error");
    }
  }

  async function saveCurrent() {
    // 随机默认名：避开已有方案（含内置），撞名自动追加序号
    const existing = await api.listWorkspaces().catch<string[]>(() => []);
    const name = await useUi.getState().openDialog<string | null>({
      type: "input",
      title: t("保存布局方案"),
      label: t("方案名称"),
      initial: randomSchemeName(existing),
      okText: t("保存"),
    });
    const tree = useLayout.getState().tree;
    if (!name || !tree) return;
    if (name === DEFAULT_SCHEME) {
      useUi.getState().toast(t("“默认方案”是内置方案，请换一个名字"), "error");
      return;
    }
    try {
      await api.saveWorkspace(name, tree);
      useUi.getState().toast(t("方案“{name}”已保存", { name: t(name) }));
      setCurrent(name);
      refresh();
    } catch (e) {
      useUi.getState().toast(t("保存方案失败：{e}", { e: String(e) }), "error");
    }
  }

  async function apply(name: string) {
    try {
      const ws = await api.loadWorkspace(name);
      if (ws.tree) {
        useLayout.getState().init(ws.tree as never);
        setCurrent(name);
      }
    } catch (e) {
      useUi.getState().toast(t("加载失败：{e}", { e: String(e) }), "error");
    }
  }

  async function remove(name: string) {
    const ok = await confirmDialog({
      title: t("删除方案"),
      message: t("确定删除方案“{name}”吗？删除后不可恢复。", { name: t(name) }),
      kind: "danger",
      okText: t("删除"),
    });
    if (!ok) return;
    await api.deleteWorkspace(name).catch(() => undefined);
    if (current === name) setCurrent(null);
    refresh();
  }

  /** 重命名方案（2026-11-11）：同名冲突由后端拒绝（红字 toast，不静默覆盖）；
   *  成功后顺序表原地换名（保留拖动排序），当前选中名跟随 */
  async function rename(name: string) {
    const next = await useUi.getState().openDialog<string | null>({
      type: "input",
      title: t("重命名方案"),
      label: t("方案名称"),
      initial: name,
      okText: t("重命名"),
    });
    if (!next || next === name) return;
    if (next === DEFAULT_SCHEME) {
      useUi.getState().toast(t("“默认方案”是内置方案，请换一个名字"), "error");
      return;
    }
    try {
      await api.renameWorkspace(name, next);
      const order = useSettings.getState().workspaceOrder;
      if (order.includes(name)) {
        useSettings
          .getState()
          .update({ workspaceOrder: order.map((n) => (n === name ? next : n)) });
      }
      if (current === name) setCurrent(next);
      useUi.getState().toast(t("方案已重命名为“{name}”", { name: t(next) }));
      refresh();
    } catch (e) {
      useUi.getState().toast(t("重命名失败：{e}", { e: String(e) }), "error");
    }
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const handle = (e.currentTarget as HTMLElement);
    const startX = e.clientX;
    const startW = useSettings.getState().sidebarWidth;
    handle.classList.add("np-side-resizing");
    // rAF 节流（2026-11-06）：mousemove 直连 setState 的高频重排在长帧里
    // 让 WebView 合成器来不及绘制新区域（配合窗口底色=画布色双保险，
    // 消除拖宽时右缘露底黑条）；松手提交仍用 ref 内最新值
    let raf = 0;
    const move = (ev: MouseEvent) => {
      const latest = Math.min(W_MAX, Math.max(W_MIN, startW + ev.clientX - startX));
      dragWRef.current = latest;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          setDragW(dragWRef.current);
        });
      }
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      handle.classList.remove("np-side-resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (dragWRef.current !== null) {
        useSettings.getState().update({ sidebarWidth: dragWRef.current });
      }
      dragWRef.current = null;
      setDragW(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  /** 两卡上下分割：按指针在边栏内的纵向位置归一为比例，钳 0.2–0.8，松手提交 */
  function startSplit(e: React.MouseEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const rect = asideRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    handle.classList.add("np-side-resizing");
    let raf = 0; // rAF 节流，同上（2026-11-06）
    const move = (ev: MouseEvent) => {
      const r = Math.min(
        SPLIT_MAX,
        Math.max(SPLIT_MIN, (ev.clientY - rect.top) / rect.height),
      );
      dragRatioRef.current = r;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          setDragRatio(dragRatioRef.current);
        });
      }
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      handle.classList.remove("np-side-resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (dragRatioRef.current !== null) {
        useSettings.getState().update({ sideSplitRatio: dragRatioRef.current });
      }
      dragRatioRef.current = null;
      setDragRatio(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  if (collapsed) {
    // 折叠态：顶部展开按钮，下方竖排各方案（缩略图 + 名称首字），点击直接切换
    return (
      <aside className="np-sidebar np-sidebar-collapsed">
        <button
          className="np-side-add"
          data-tip={t("展开边栏")}
          onClick={() => useSettings.getState().update({ sidebarCollapsed: false })}
        >
          <AppIcon icon={PanelLeftOpen} size={DENSITY.iconSm} />
        </button>
        <button
          className={`np-side-mini${current === DEFAULT_SCHEME ? " on" : ""}`}
          data-tip={t("切换到默认方案")}
          onClick={applyDefault}
        >
          <span className="np-side-thumb">
            <MiniTreeSvg node={defaultTree ?? DEFAULT_TREE} size={DENSITY.sideThumbSm} />
          </span>
          <span className="np-side-char">{t(DEFAULT_SCHEME).slice(0, 2)}</span>
        </button>
        {items.map((it) => (
          <button
            key={it.name}
            className={`np-side-mini${current === it.name ? " on" : ""}`}
            data-tip={it.name}
            onClick={() => void apply(it.name)}
          >
            {it.tree && (
              <span className="np-side-thumb">
                <MiniTreeSvg node={it.tree} size={DENSITY.sideThumbSm} />
              </span>
            )}
            <span className="np-side-char">{it.name.slice(0, 2)}</span>
          </button>
        ))}
        <ShelfMini />
      </aside>
    );
  }

  return (
    <aside ref={asideRef} className="np-sidebar" style={{ flexBasis: width }}>
      <div
        className="np-side-card"
        style={{ flex: `0 1 ${ratio * 100}%`, minHeight: 96 }}
      >
      <div className="np-side-h">
        <span>{t("布局方案")}</span>
        <div className="np-side-actions">
          <button
            className="np-side-add"
            data-tip={t("保存当前布局到选中方案")}
            onClick={() => void saveToCurrent()}
          >
            <AppIcon icon={Save} size={DENSITY.iconSm} />
          </button>
          <button
            className="np-side-add"
            data-tip={t("把当前窗口组合另存为新方案")}
            onClick={() => void saveCurrent()}
          >
            <AppIcon icon={SaveAll} size={DENSITY.iconSm} />
          </button>
          <button
            className="np-side-add"
            data-tip={t("折叠边栏")}
            onClick={() => useSettings.getState().update({ sidebarCollapsed: true })}
          >
            <AppIcon icon={PanelLeftClose} size={DENSITY.iconSm} />
          </button>
        </div>
      </div>

      <div className="np-side-scroll">
        <div
          className={`np-side-item${current === DEFAULT_SCHEME ? " on" : ""}`}
          onClick={applyDefault}
          data-tip={
            current === DEFAULT_SCHEME
              ? t("当前方案（改动后点上方保存覆盖）")
              : t("应用默认方案（可保存覆盖；不可删除）")
          }
        >
          <span className="np-side-thumb">
            <MiniTreeSvg node={defaultTree ?? DEFAULT_TREE} size={DENSITY.sideThumbMd} />
          </span>
          <span className="np-side-name">{t(DEFAULT_SCHEME)}</span>
        </div>

        {ordered.map((name, idx) => {
          const it = itemOf(name);
          if (!it) return null;
          return (
            <div
              key={it.name}
              data-ws-name={it.name}
              className={`np-side-item${current === it.name ? " on" : ""}${
                dragName === it.name ? " dragging" : ""
              }${overIdx === idx && dragName && dragName !== it.name ? " drag-over" : ""}`}
              onPointerDown={(e) => {
                // 左键且非删除钮/链路上才进入潜在拖拽会话；点击语义由 onClick
                // 承担（位移未超阈值时会话不激活，click 照常）
                if (e.button !== 0) return;
                dragSessionRef.current = {
                  name: it.name,
                  startX: e.clientX,
                  startY: e.clientY,
                  moved: false,
                };
              }}
              onClickCapture={(e) => {
                // 拖拽已发生时吞掉落点 click（up 后浏览器补发的 click 不应切换方案）
                if (dragSessionRef.current?.moved) {
                  e.stopPropagation();
                  e.preventDefault();
                }
              }}
              onClick={() => void apply(it.name)}
              data-tip={
                current === it.name
                  ? t("当前方案（改动后点上方保存覆盖）")
                  : t("点击切换 · 拖动调整顺序")
              }
            >
              {it.tree && (
                <span className="np-side-thumb">
                  <MiniTreeSvg node={it.tree} size={DENSITY.sideThumbMd} />
                </span>
              )}
              <span className="np-side-name">{it.name}</span>
              <button
                className="np-side-ren"
                data-tip={t("重命名方案")}
                onClick={(e) => {
                  e.stopPropagation();
                  void rename(it.name);
                }}
              >
                <AppIcon icon={Pencil} size={DENSITY.iconXs} />
              </button>
              <button
                className="np-side-del"
                data-tip={t("删除方案")}
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(it.name);
                }}
              >
                <AppIcon icon={X} size={DENSITY.iconXs} />
              </button>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="np-side-empty">
            {t("还没有自定义方案。")}
            <br />
            {t("摆好窗格组合后，点上方“另存为新方案”保存。")}
          </div>
        )}
      </div>
      </div>

      <div
        className="np-side-split"
        onMouseDown={startSplit}
        data-tip={t("拖动调整上下高度")}
      />

      <Shelf />

      <div className="np-side-resize" onMouseDown={startResize} data-tip={t("拖动调整宽度")} />
    </aside>
  );
}
