import { useCallback, useEffect, useRef, useState } from "react";
import {
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
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
import { fileIcon } from "../lib/fileIcons";
import { fileNameOf } from "../lib/path";
import { shelfEntryIsDir } from "../lib/shelf";
import { randomSchemeName } from "../lib/schemeName";
import { DENSITY } from "../lib/tokens";
import { useDnd } from "../stores/dnd";
import { useLayout } from "../stores/layout";
import { useSettings } from "../stores/settings";
import { confirmDialog, useUi } from "../stores/ui";
import { AppIcon } from "./AppIcon";

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
  return (
    <div className="np-layoutpicker">
      {PRESET_LIST.map((p) => (
        <button
          key={p.id}
          className="np-layouttile"
          title={p.tip}
          onClick={() => useLayout.getState().preset(p.id)}
        >
          <span className="np-side-thumb">
            <MiniTreeSvg node={PRESET_TREES[p.id]} size={DENSITY.sideThumbLg} />
          </span>
          <span>{p.label}</span>
        </button>
      ))}
      <div className="np-layouthint">
        预设之外，每个窗格可继续 ──/│ 递归分裂成任意混合布局
      </div>
    </div>
  );
}

/** 暂存区（侧边栏下半）：临时拖放文件/文件夹，用到时拖出到目标窗格。
 *  拖入 = OLE 落点分流（oleDispatch 命中 [data-shelf] 即入库，Explorer 拖入同管线）；
 *  拖出 = 行拖起走同一 startDrag 管线，落窗格即移动，effect ≠ none 视为已取走并移出暂存。 */
function Shelf() {
  const items = useSettings((s) => s.staging);
  const point = useDnd((s) => s.point);
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

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

  function armRowDrag(e: React.MouseEvent, path: string) {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      cleanup();
      api
        .startDrag([path])
        .then((effect) => {
          if (effect !== "none") useSettings.getState().removeShelf(path);
        })
        .catch((err) => useUi.getState().toast(String(err), "error"));
    };
    const onUp = () => cleanup();
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div ref={ref} className={`np-shelf${over ? " on" : ""}`} data-shelf>
      <div className="np-side-h">
        <span className="np-shelf-title">
          <AppIcon icon={Inbox} size={DENSITY.iconSm} />
          暂存区
          {items.length > 0 && <span className="np-shelf-count">{items.length}</span>}
        </span>
        <div className="np-side-actions">
          <button
            className="np-side-add"
            title="清空暂存区"
            disabled={!items.length}
            onClick={() => useSettings.getState().clearShelf()}
          >
            <AppIcon icon={Trash2} size={DENSITY.iconSm} />
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="np-shelf-empty">
          把文件/文件夹拖到这里暂存，
          <br />
          用时再拖到目标文件夹。
        </div>
      ) : (
        <div className="np-shelf-list">
          {items.map((p) => {
            const name = fileNameOf(p);
            const spec = fileIcon(name, shelfEntryIsDir(p));
            return (
              <div
                key={p.toLowerCase()}
                className="np-shelf-row"
                title={p}
                onMouseDown={(e) => armRowDrag(e, p)}
              >
                <AppIcon icon={spec.icon} size={DENSITY.iconMd} colorVar={spec.colorVar} />
                <span className="np-shelf-name">{name}</span>
                <button
                  className="np-shelf-del"
                  title="移出暂存区"
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

/** 左侧边栏：布局方案（工作区）列表 + 内置默认方案；可拖拽调宽、可折叠 */
export function Sidebar() {
  const [items, setItems] = useState<Scheme[]>([]);
  const [current, setCurrent] = useState<string | null>(DEFAULT_SCHEME);
  /** 已保存的默认方案树；null = 未保存过（应用/显示出厂 2×2） */
  const [defaultTree, setDefaultTree] = useState<LayoutNode | null>(null);
  // 宽度/折叠集中存 settings（2026-10-12 配置集中化）；拖宽经本地态实时反馈、松手提交
  const savedWidth = useSettings((s) => s.sidebarWidth);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const [dragW, setDragW] = useState<number | null>(null);
  const dragWRef = useRef<number | null>(null);
  const width = dragW ?? savedWidth;

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
      useUi.getState().toast(`已保存到方案“${current}”`);
      refresh();
    } catch (e) {
      useUi.getState().toast(`保存方案失败：${String(e)}`, "error");
    }
  }

  async function saveCurrent() {
    // 随机默认名：避开已有方案（含内置），撞名自动追加序号
    const existing = await api.listWorkspaces().catch<string[]>(() => []);
    const name = await useUi.getState().openDialog<string | null>({
      type: "input",
      title: "保存布局方案",
      label: "方案名称",
      initial: randomSchemeName(existing),
      okText: "保存",
    });
    const tree = useLayout.getState().tree;
    if (!name || !tree) return;
    if (name === DEFAULT_SCHEME) {
      useUi.getState().toast("“默认方案”是内置方案，请换一个名字", "error");
      return;
    }
    try {
      await api.saveWorkspace(name, tree);
      useUi.getState().toast(`方案“${name}”已保存`);
      setCurrent(name);
      refresh();
    } catch (e) {
      useUi.getState().toast(`保存方案失败：${String(e)}`, "error");
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
      useUi.getState().toast(`加载失败：${String(e)}`, "error");
    }
  }

  async function remove(name: string) {
    const ok = await confirmDialog({
      title: "删除方案",
      message: `确定删除方案“${name}”吗？删除后不可恢复。`,
      kind: "danger",
      okText: "删除",
    });
    if (!ok) return;
    await api.deleteWorkspace(name).catch(() => undefined);
    if (current === name) setCurrent(null);
    refresh();
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const handle = (e.currentTarget as HTMLElement);
    const startX = e.clientX;
    const startW = useSettings.getState().sidebarWidth;
    handle.classList.add("np-side-resizing");
    const move = (ev: MouseEvent) => {
      const latest = Math.min(W_MAX, Math.max(W_MIN, startW + ev.clientX - startX));
      dragWRef.current = latest;
      setDragW(latest);
    };
    const up = () => {
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

  if (collapsed) {
    // 折叠态：顶部展开按钮，下方竖排各方案（缩略图 + 名称首字），点击直接切换
    return (
      <aside className="np-sidebar np-sidebar-collapsed">
        <button
          className="np-side-add"
          title="展开布局方案"
          onClick={() => useSettings.getState().update({ sidebarCollapsed: false })}
        >
          <AppIcon icon={PanelLeftOpen} size={DENSITY.iconSm} />
        </button>
        <button
          className={`np-side-mini${current === DEFAULT_SCHEME ? " on" : ""}`}
          title="默认方案"
          onClick={applyDefault}
        >
          <span className="np-side-thumb">
            <MiniTreeSvg node={defaultTree ?? DEFAULT_TREE} size={DENSITY.sideThumbSm} />
          </span>
          <span className="np-side-char">{DEFAULT_SCHEME.slice(0, 2)}</span>
        </button>
        {items.map((it) => (
          <button
            key={it.name}
            className={`np-side-mini${current === it.name ? " on" : ""}`}
            title={it.name}
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
      </aside>
    );
  }

  return (
    <aside className="np-sidebar" style={{ flexBasis: width }}>
      <div className="np-side-h">
        <span>布局方案</span>
        <div className="np-side-actions">
          <button
            className="np-side-add"
            title="保存当前布局到选中方案"
            onClick={() => void saveToCurrent()}
          >
            <AppIcon icon={Save} size={DENSITY.iconSm} />
          </button>
          <button
            className="np-side-add"
            title="把当前窗口组合另存为新方案"
            onClick={() => void saveCurrent()}
          >
            <AppIcon icon={SaveAll} size={DENSITY.iconSm} />
          </button>
          <button
            className="np-side-add"
            title="折叠边栏"
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
          title={
            current === DEFAULT_SCHEME
              ? "当前方案（改动后点上方保存覆盖）"
              : "应用默认方案（可保存覆盖；不可删除）"
          }
        >
          <span className="np-side-thumb">
            <MiniTreeSvg node={defaultTree ?? DEFAULT_TREE} size={DENSITY.sideThumbMd} />
          </span>
          <span className="np-side-name">{DEFAULT_SCHEME}</span>
        </div>

        {items.map((it) => (
          <div
            key={it.name}
            className={`np-side-item${current === it.name ? " on" : ""}`}
            onClick={() => void apply(it.name)}
            title={current === it.name ? "当前方案（改动后点上方保存图标覆盖）" : "点击切换到此布局"}
          >
            {it.tree && (
              <span className="np-side-thumb">
                <MiniTreeSvg node={it.tree} size={DENSITY.sideThumbMd} />
              </span>
            )}
            <span className="np-side-name">{it.name}</span>
            <button
              className="np-side-del"
              title="删除方案"
              onClick={(e) => {
                e.stopPropagation();
                void remove(it.name);
              }}
            >
              <AppIcon icon={X} size={DENSITY.iconXs} />
            </button>
          </div>
        ))}
        {items.length === 0 && (
          <div className="np-side-empty">
            还没有自定义方案。
            <br />
            摆好窗格组合后，点上方“另存为新方案”保存。
          </div>
        )}
      </div>

      <Shelf />

      <div className="np-side-resize" onMouseDown={startResize} title="拖动调整宽度" />
    </aside>
  );
}
