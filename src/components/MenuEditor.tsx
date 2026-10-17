// 右键菜单编辑器（定制页）：上方横条 = "窗格工具栏"编辑区（模拟窗格实际
// 导航栏 np-nav 的样子，共享功能库的第二个投放区）；下方双栏 = 左"启用菜单"
// （拖拽排序、条目展开条件设置）+ 右"功能库"（内置功能 + 分割线）。
// 拖拽用 Pointer 事件手动实现（阈值启动 + elementFromPoint 命中 + 自绘 ghost）——
// Tauri Windows 下 dragDropEnabled 会禁用页面内 HTML5 DnD，不能用原生 dragstart。
// 落点语义：左栏空处 = 追加，条目上 = 插到它前面；拖出左栏 = 取消。
import { useEffect, useRef, useState } from "react";
import {
  Button,
  ButtonGroup,
  InputGroup,
  PopoverNext,
  Switch,
} from "@blueprintjs/core";
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  ArrowRightToLine,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ClipboardPaste,
  Columns2,
  Copy,
  CornerLeftUp,
  Droplets,
  Eraser,
  ExternalLink,
  Eye,
  FileDown,
  FileMinus,
  FileOutput,
  FilePlus,
  FilePlus2,
  FileText,
  FileType,
  Files,
  FolderInput,
  FolderPlus,
  GitCompare,
  HardDrive,
  Images,
  Info,
  LayoutList,
  Layers,
  LayoutTemplate,
  List,
  ListChecks,
  ListOrdered,
  Menu as MenuIcon,
  Merge,
  Minimize2,
  Minus,
  Paintbrush,
  PanelTop,
  RectangleHorizontal,
  Replace,
  RotateCw,
  Route,
  Rows2,
  ScanEye,
  Scissors,
  Search,
  Star,
  Table,
  Terminal,
  TextCursorInput,
  Trash,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";

import type { MenuCond, MenuEntry } from "../lib/ipc";
import {
  areaLabel,
  BUILTIN_FNS,
  builtinByKey,
  builtinToolbarEntry,
  condSentence,
  defaultMenuEntries,
  defaultToolbarEntries,
  effectiveArea,
  ensureFixedEntries,
  ensureToolbarAddr,
  fnGroups,
  isFixedEntry,
  isFixedEntryId,
  newMenuId,
  spyGroup,
  type BuiltinFn,
} from "../lib/menuCommands";
import { DENSITY } from "../lib/tokens";
import { useSettings } from "../stores/settings";

/** 左栏（启用菜单）宽钳制 */
const LEFT_W_MIN = 240;
const LEFT_W_MAX = 480;
function clampLeftW(w: number): number {
  if (!Number.isFinite(w)) return 300;
  return Math.min(LEFT_W_MAX, Math.max(LEFT_W_MIN, Math.round(w)));
}

/** 两栏间拖宽：纯 Pointer 事件 + setPointerCapture——事件保证送达把手本身
 *  （拖出窗口也收得到 pointerup/cancel）。不能用「pointerdown + window 鼠标监听」：
 *  Chromium 对被取消/捕获的 pointerdown 会抑制兼容鼠标事件，mouseup 永不触发 =
 *  拖拽状态卡死。拖动中只写内存，松手经 update() 持久化；cursor/禁选中复用
 *  np-col-resizing */
function startLeftResize(e: React.PointerEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = useSettings.getState().menuedLeftWidth;
  const onMove = (ev: PointerEvent) => {
    useSettings.setState({ menuedLeftWidth: clampLeftW(startW + (ev.clientX - startX)) });
  };
  const onUp = () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("blur", onUp);
    document.body.classList.remove("np-col-resizing");
    useSettings
      .getState()
      .update({ menuedLeftWidth: useSettings.getState().menuedLeftWidth });
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  // 兜底：拖宽中途页面被卸载（如 Esc 关定制页）时捕获失效，window 侧收尾
  // 复位 body 光标态（onUp 幂等，与把手侧重复触发无副作用）
  window.addEventListener("pointerup", onUp);
  window.addEventListener("blur", onUp);
  document.body.classList.add("np-col-resizing");
}
import { confirmDialog } from "../stores/ui";
import { AppIcon, ic } from "./AppIcon";
import { NpSelect } from "./NpSelect";

/** 内置功能 → 图标映射（功能库卡片 / 启用菜单行 / 工具栏条带共用；
 *  窗格工具栏渲染端 Pane 也引用此表，新增功能图标只改这一处） */
export const FN_ICONS: Record<string, LucideIcon> = {
  open: ExternalLink,
  openTab: AppWindow,
  rename: TextCursorInput,
  batchRename: ListOrdered,
  delete: Trash2,
  deletePerm: Trash,
  properties: Info,
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  copyPath: Route,
  copyName: Type,
  copyToPane: ArrowRightToLine,
  moveToPane: ArrowLeftRight,
  colorTag: Paintbrush,
  addFavorite: Star,
  sysMenu: List,
  openTerminal: Terminal,
  pdfMerge: Files,
  pdfSplit: FileOutput,
  pdfExtract: FileDown,
  pdfRemove: FileMinus,
  pdfRotate: RotateCw,
  pdfCompress: Minimize2,
  pdfWatermark: Droplets,
  imgToPdf: Images,
  officeToPdf: FileText,
  officeClean: Eraser,
  officeToTxt: FileType,
  csvConvert: Replace,
  csvMerge: Table,
  textMerge: Merge,
  exportList: ClipboardList,
  newFolder: FolderPlus,
  newFile: FilePlus,
  new: FilePlus2,
  preview: ScanEye,
  refresh: RotateCw,
  selectAll: ListChecks,
  reverseSelect: ArrowUpDown,
  toggleHidden: Eye,
  zipHere: Archive,
  extract: ArchiveRestore,
  findDuplicates: Layers,
  dirSizes: HardDrive,
  compareFolders: GitCompare,
  up: CornerLeftUp,
  view: LayoutList,
  addr: RectangleHorizontal,
  search: Search,
  splitH: Columns2,
  splitV: Rows2,
  swap: ArrowLeftRight,
  organizeBy: FolderInput,
};

/** 选中依赖三档（菜单与工具栏统一语义），对外措辞 =「启用时机」：
 *  总是 = 菜单两处出现/工具栏恒可用；选中时 = 菜单仅选中右键/工具栏按选中项判定；
 *  未选中时 = 菜单仅空白处右键/工具栏作用于当前文件夹 */
const SCOPE_OPTS: { value: MenuEntry["area"]; label: string }[] = [
  { value: "both", label: "总是" },
  { value: "sel", label: "选中时" },
  { value: "blank", label: "未选中时" },
];

const TARGET_OPTS: { value: MenuCond["target"]; label: string }[] = [
  { value: "all", label: "不限" },
  { value: "file", label: "仅文件" },
  { value: "dir", label: "仅文件夹" },
];

/** 「启用时机」选项按功能能力位约束（不限仍受 supportsSel/supportsBlank 收窄）：
 *  不支持的分段禁用并悬停说明（菜单语境，SG_OPTS 为段选择器选项） */
function areaOptsFor(fn: BuiltinFn | undefined) {
  return SCOPE_OPTS.map((o) => ({
    ...o,
    disabled:
      o.value === "sel"
        ? !(fn?.supportsSel ?? true)
        : o.value === "blank"
          ? !(fn?.supportsBlank ?? true)
          : false,
    title:
      o.value === "sel" && !fn?.supportsSel
        ? "该功能仅空白处可用"
        : o.value === "blank" && !fn?.supportsBlank
          ? "该功能仅选中条目可用"
          : undefined,
  }));
}
/** 分段快选（方案 A）：np-seg 语言同设置面板，单击切换、无下拉嵌套 */
function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <ButtonGroup className="np-seg" size="small" variant="minimal">
      {options.map((o) => (
        <Button
          key={o.value}
          active={o.value === value}
          disabled={o.disabled}
          title={o.title}
          text={o.label}
          onClick={() => onChange(o.value)}
        />
      ))}
    </ButtonGroup>
  );
}
/** 条目对应内置功能（sep/未知 id = undefined） */
function entryFn(en: MenuEntry): BuiltinFn | undefined {
  return en.kind === "builtin" ? builtinByKey(en.id.slice("builtin:".length)) : undefined;
}
/** 实际生效的出现位置（能力位收窄后） */
function effArea(en: MenuEntry): MenuEntry["area"] | null {
  const fn = entryFn(en);
  return fn ? effectiveArea(fn.supportsSel, fn.supportsBlank, en.area) : en.area;
}
/** 行内条件摘要：四个条件恒展示，依次为 位置 / 对象 / 数量 / 类型（默认值 = 不限） */
function condChipTexts(en: MenuEntry): string[] {
  const min = en.cond.minCount ?? 1;
  const max = en.cond.maxCount;
  const count =
    min > 1 && max > 0
      ? `${min}–${max} 项`
      : min > 1
        ? `≥ ${min}`
        : max > 0
          ? max === 1
            ? "1 项"
            : `≤ ${max}`
          : "不限";
  const exts = en.cond.exts.trim();
  const type = exts ? exts.split(/[,，;；\s]+/).filter(Boolean).join(",") : "不限";
  const obj =
    en.cond.target === "file" ? "仅文件" : en.cond.target === "dir" ? "仅文件夹" : "不限";
  return [areaChipText(en), obj, count, type];
}
/** 行内区域标签：显示生效区域而非所设值（收窄时由回显句解释原因） */
function areaChipText(en: MenuEntry): string {
  const eff = effArea(en);
  return eff ? areaLabel(eff) : "不显示";
}
/** 回显句补充说明：所设启用时机被能力位收窄 / 完全不生效时讲明原因 */
function condNote(en: MenuEntry): string {
  const eff = effArea(en);
  if (eff === null) return "（当前启用时机下不会显示）";
  if (eff !== en.area)
    return eff === "sel" ? "（该功能不支持未选中）" : "（该功能不支持选中）";
  return "";
}

const COUNT_MIN_OPTS = Array.from({ length: 9 }, (_, k) => ({
  value: k + 1,
  label: `≥ ${k + 1} 项`,
}));
const COUNT_MAX_OPTS = [
  { value: 0, label: "数量不限" },
  ...Array.from({ length: 9 }, (_, k) => ({ value: k + 1, label: `≤ ${k + 1} 项` })),
];

/** 选中数量预设：常用组合一键选，特殊范围才进「自定义…」露出上下限 */
type CountPreset = "any" | "one" | "multi" | "custom";
const COUNT_PRESET_OPTS: { value: CountPreset; label: string }[] = [
  { value: "any", label: "不限" },
  { value: "one", label: "恰好 1 项" },
  { value: "multi", label: "≥ 2 项" },
  { value: "custom", label: "自定义…" },
];
function countPresetOf(cond: MenuCond): CountPreset {
  const min = cond.minCount ?? 1;
  if (min === 1 && cond.maxCount === 0) return "any";
  if (min === 1 && cond.maxCount === 1) return "one";
  if (min === 2 && cond.maxCount === 0) return "multi";
  return "custom";
}
const COUNT_PRESET_VALUES: Record<CountPreset, { minCount: number; maxCount: number }> = {
  any: { minCount: 1, maxCount: 0 },
  one: { minCount: 1, maxCount: 1 },
  multi: { minCount: 2, maxCount: 0 },
  // 进入自定义时给一个与预设不同的常见起点，提示用户上下限已交由手动控制
  custom: { minCount: 2, maxCount: 0 },
};

/** 拖拽载荷：左栏内排序 / 跨栏添加 / 窗格工具栏投放共用 */
type DragPayload =
  | { src: "entry"; id: string }
  | { src: "builtin"; key: string }
  | { src: "sep" }
  | { src: "toolbar"; id: string };

function entryIcon(en: MenuEntry): LucideIcon {
  if (en.kind === "sep") return Minus;
  return FN_ICONS[en.id.slice("builtin:".length)] ?? List;
}

function entryLabel(en: MenuEntry): string {
  if (en.kind === "sep") return "—— 分割线 ——";
  return builtinByKey(en.id.slice("builtin:".length))?.label ?? en.id;
}

/** 工具栏回显句：condSentence 去掉右键前缀（作用域按条目出现位置） */
/** 工具栏回显句：启用时机按三档表述 + condSentence 去掉位置前缀 */
function toolbarSentence(cond: MenuCond, area: MenuEntry["area"]): string {
  const head =
    area === "sel"
      ? "选中时可用"
      : area === "blank"
        ? "未选中时可用（作用于当前文件夹）"
        : "总是可用";
  const rest = condSentence(cond, "sel").replace(/^选中条目时显示 · /, "");
  return `${head} · ${rest}`;
}

export function MenuEditor() {
  const s = useSettings();
  const entries = s.menuEntries;
  const toolbarEntries = s.toolbarEntries;
  const leftW = useSettings((st) => st.menuedLeftWidth);
  const set = (next: MenuEntry[]) => s.update({ menuEntries: next });
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 拖拽进行中（超过位移阈值后非 null），驱动 ghost 与指示线渲染 */
  const [active, setActive] = useState<DragPayload | null>(null);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    overLeft: boolean;
    overToolbar: boolean;
  } | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /** 拖拽悬停的窗格工具栏行（插入指示） */
  const [overToolId, setOverToolId] = useState<string | null>(null);
  /** 展开条件编辑的工具栏条目 */
  const [expTool, setExpTool] = useState<string | null>(null);
  /** 功能库「只展示未启用的功能」过滤开关 */
  const [onlyUnused, setOnlyUnused] = useState(false);
  /** 功能库目录（2026-10-15 A+B 改版）：当前高亮组（点击跳转置位 / scrollspy 跟随） */
  const [curGroup, setCurGroup] = useState<string>(fnGroups()[0] ?? "");
  const wallRef = useRef<HTMLDivElement | null>(null);
  /** 目录点击的平滑跳转期间挂起 scrollspy（否则 spy 会在动画途中抢回高亮） */
  const jumpLockRef = useRef(false);
  const jumpTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    payload: DragPayload;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  // 窗口级监听只挂一次，经 ref 取最新编排函数/视图（避免闭包过期）
  const opsRef = useRef({
    dropInsert: (_p: DragPayload, _to?: string) => {},
    moveTo: (_a: string, _b: string) => {},
    remove: (_id: string) => {},
    moveToEnd: (_id: string) => {},
    placeToolbarEntry: (_id: string, _to?: string) => {},
    addToolbarEntry: (_p: DragPayload, _to?: string) => {},
    removeToolbarEntry: (_id: string) => {},
  });

  const patch = (id: string, p: Partial<MenuEntry>) =>
    set(entries.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const patchCond = (id: string, p: Partial<MenuCond>) =>
    set(entries.map((e) => (e.id === id ? { ...e, cond: { ...e.cond, ...p } } : e)));
  const remove = (id: string) => {
    if (isFixedEntryId(id)) return; // 基础固定功能：不可移除（拖出左栏同样无效）
    set(entries.filter((e) => e.id !== id));
  };
  /** 重置为默认菜单布局（2026-10-15 定案：多套预设下线，单一出厂默认），需确认 */
  const applyMenuDefault = () => {
    void confirmDialog({
      title: "重置为默认方案",
      message:
        "把右键菜单重置为默认布局？当前布局将被覆盖（七项基础功能保留）。",
      kind: "warn",
      okText: "重置",
    }).then((ok) => {
      // 默认布局只覆盖可自定义区；缺失的基础固定功能由归一化补齐
      if (ok) set(ensureFixedEntries(defaultMenuEntries()));
    });
  };
  /** 重置为默认工具栏排列（2026-10-15 定案 = 定稿 10 键），需确认（地址框归一化兜底） */
  const applyToolbarDefault = () => {
    void confirmDialog({
      title: "重置为默认方案",
      message:
        "把窗格工具栏重置为默认排列？当前排列将被覆盖（地址框保留常驻）。",
      kind: "warn",
      okText: "重置",
    }).then((ok) => {
      if (ok) s.update({ toolbarEntries: ensureToolbarAddr(defaultToolbarEntries()) });
    });
  };
  const moveTo = (id: string, toId: string) => {
    if (id === toId) return;
    const from = entries.findIndex((e) => e.id === id);
    const to = entries.findIndex((e) => e.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set(next);
  };

  const makeEntry = (p: DragPayload): MenuEntry | null => {
    if (p.src === "sep") {
      return {
        id: newMenuId("sep"),
        kind: "sep",
        area: "sel",
        cond: { target: "all", minCount: 1, maxCount: 0, exts: "" },
      };
    }
    if (p.src === "builtin") {
      const fn = builtinByKey(p.key);
      // 仅工具栏的功能（无选中语义，supportsSel/Blank 双 false）不可入右键菜单
      if (!fn || (!fn.supportsSel && !fn.supportsBlank)) return null;
      return {
        id: `builtin:${fn.key}`,
        kind: "builtin",
        area: fn.area,
        cond: { ...fn.cond },
      };
    }
    return null; // toolbar 载荷不进右键菜单；entry 载荷不走 dropInsert
  };

  /** 落点处理：toId 有值 = 插到该条目前；否则追加末尾 */
  const dropInsert = (p: DragPayload, toId?: string) => {
    const en = makeEntry(p);
    if (!en) return;
    // 同一内置功能在右键菜单全布局唯一（双面功能已在菜单时再拖入菜单 = 忽略）
    if (en.kind === "builtin" && entries.some((e) => e.id === en.id)) return;
    const to = toId ? entries.findIndex((e) => e.id === toId) : -1;
    if (to < 0) {
      set([...entries, en]);
      return;
    }
    const next = [...entries];
    next.splice(to, 0, en);
    set(next);
  };
  const moveToEnd = (id: string) => {
    const from = entries.findIndex((e) => e.id === id);
    if (from < 0 || from === entries.length - 1) return;
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    next.push(moved);
    set(next);
  };
  // ── 窗格工具栏（共享功能库的第二个投放区）：settings.toolbarEntries 有序表 ──
  const placeToolbarEntry = (id: string, toId?: string) => {
    const en = toolbarEntries.find((e) => e.id === id);
    if (!en) return;
    const next = toolbarEntries.filter((e) => e.id !== id);
    const i = toId ? next.findIndex((e) => e.id === toId) : -1;
    if (i < 0) next.push(en);
    else next.splice(i, 0, en);
    s.update({ toolbarEntries: next });
  };
  /** 功能库 → 工具栏拖入启用：全部内置功能可入（2026-10-14 定案）；全栏唯一
   *  （已启用 = 忽略，排序走工具栏行内拖动）；条目上 = 插到它前面，空处 = 追加 */
  const addToolbarEntry = (p: DragPayload, toId?: string) => {
    if (p.src !== "builtin") return; // 分割线仅右键菜单可用
    if (toolbarEntries.some((e) => e.id === `builtin:${p.key}`)) return;
    const en = builtinToolbarEntry(p.key);
    const next = [...toolbarEntries];
    const i = toId ? next.findIndex((e) => e.id === toId) : -1;
    if (i < 0) next.push(en);
    else next.splice(i, 0, en);
    s.update({ toolbarEntries: next });
  };
  const removeToolbarEntry = (id: string) => {
    if (id === "builtin:addr") return; // 地址框固定常驻（可排序、不可移除）
    s.update({ toolbarEntries: toolbarEntries.filter((e) => e.id !== id) });
  };
  const patchToolbarCond = (
    id: string,
    p: Partial<MenuCond> | { area: MenuEntry["area"] },
  ) =>
    s.update({
      toolbarEntries: toolbarEntries.map((e) => {
        if (e.id !== id) return e;
        if ("area" in p) return { ...e, area: p.area };
        return { ...e, cond: { ...e.cond, ...p } };
      }),
    });
  /** 条件编辑浮层内容（方案 A 分段快选）：右键菜单条目 = 启用时机 + 三条件 + 人话回显 */
  const menuCondPanel = (en: MenuEntry) => (
    <div className="np-menued-cond">
      <div className="np-menued-cond-name">出现条件 · {entryLabel(en)}</div>
      <div className="np-menued-frow">
        <span className="np-menued-clabel">启用时机</span>
        <Seg
          value={en.area}
          options={areaOptsFor(entryFn(en))}
          onChange={(area) => patch(en.id, { area })}
        />
      </div>
      <div className="np-menued-frow">
        <span className="np-menued-clabel">对象类型</span>
        <Seg
          value={en.cond.target}
          options={TARGET_OPTS}
          onChange={(target) => patchCond(en.id, { target })}
        />
      </div>
      <div className="np-menued-frow">
        <span className="np-menued-clabel">选中数量</span>
        <Seg
          value={countPresetOf(en.cond)}
          options={COUNT_PRESET_OPTS}
          onChange={(p) => patchCond(en.id, COUNT_PRESET_VALUES[p])}
        />
      </div>
      {countPresetOf(en.cond) === "custom" && (
        <div className="np-menued-frow">
          <span className="np-menued-clabel" />
          <span className="np-menued-crange">
            <NpSelect
              value={en.cond.minCount}
              options={COUNT_MIN_OPTS}
              onChange={(minCount) => patchCond(en.id, { minCount })}
            />
            <NpSelect
              value={en.cond.maxCount}
              options={COUNT_MAX_OPTS}
              onChange={(maxCount) => patchCond(en.id, { maxCount })}
            />
          </span>
        </div>
      )}
      <div className="np-menued-frow">
        <span className="np-menued-clabel">文件类型</span>
        <InputGroup
          size="small"
          value={en.cond.exts}
          placeholder="如 pdf, txt（空 = 不限）"
          title={
            en.cond.target !== "file"
              ? "对象类型为「仅文件」时可配置"
              : "逗号/空格分隔扩展名白名单，不区分大小写"
          }
          disabled={en.cond.target !== "file"}
          spellCheck={false}
          onChange={(e) => patchCond(en.id, { exts: e.target.value })}
          onBlur={(e) => patchCond(en.id, { exts: e.target.value.trim().toLowerCase() })}
        />
      </div>
      <div className="np-menued-cprev">
        <AppIcon icon={Info} size={DENSITY.iconXs} />
        <span className="np-ellipsis">
          {condSentence(en.cond, effArea(en) ?? en.area)}
          {condNote(en)}
        </span>
      </div>
    </div>
  );
  /** 条件编辑浮层内容（方案 A 分段快选）：工具栏条目 = 启用时机 + 三条件 + 人话回显 */
  const toolCondPanel = (en: MenuEntry) => (
    <div className="np-menued-cond">
      <div className="np-menued-cond-name">
        启用条件 · {builtinByKey(en.id.slice("builtin:".length))?.label ?? en.id}
      </div>
      <div className="np-menued-frow">
        <span className="np-menued-clabel">启用时机</span>
        <Seg
          value={en.area}
          options={SCOPE_OPTS}
          onChange={(area) => patchToolbarCond(en.id, { area })}
        />
      </div>
      <div className="np-menued-frow">
        <span className="np-menued-clabel">对象类型</span>
        <Seg
          value={en.cond.target}
          options={TARGET_OPTS}
          onChange={(target) => patchToolbarCond(en.id, { target })}
        />
      </div>
      <div className="np-menued-frow">
        <span className="np-menued-clabel">选中数量</span>
        <Seg
          value={countPresetOf(en.cond)}
          options={COUNT_PRESET_OPTS}
          onChange={(p) => patchToolbarCond(en.id, COUNT_PRESET_VALUES[p])}
        />
      </div>
      {countPresetOf(en.cond) === "custom" && (
        <div className="np-menued-frow">
          <span className="np-menued-clabel" />
          <span className="np-menued-crange">
            <NpSelect
              value={en.cond.minCount}
              options={COUNT_MIN_OPTS}
              onChange={(minCount) => patchToolbarCond(en.id, { minCount })}
            />
            <NpSelect
              value={en.cond.maxCount}
              options={COUNT_MAX_OPTS}
              onChange={(maxCount) => patchToolbarCond(en.id, { maxCount })}
            />
          </span>
        </div>
      )}
      <div className="np-menued-frow">
        <span className="np-menued-clabel">文件类型</span>
        <InputGroup
          size="small"
          value={en.cond.exts}
          placeholder="如 pdf, txt（空 = 不限）"
          title={
            en.cond.target !== "file"
              ? "对象类型为「仅文件」时可配置"
              : "逗号/空格分隔扩展名白名单，不区分大小写"
          }
          disabled={en.cond.target !== "file"}
          spellCheck={false}
          onChange={(e) => patchToolbarCond(en.id, { exts: e.target.value })}
          onBlur={(e) =>
            patchToolbarCond(en.id, {
              exts: e.target.value.trim().toLowerCase(),
            })
          }
        />
      </div>
      <div className="np-menued-cprev">
        <AppIcon icon={Info} size={DENSITY.iconXs} />
        <span className="np-ellipsis">
          {toolbarSentence(en.cond, en.area)}
          {en.area === "sel" ? "（按当前窗格选中项判定，未满足时置灰）" : ""}
        </span>
      </div>
    </div>
  );
  opsRef.current = {
    dropInsert,
    moveTo,
    remove,
    moveToEnd,
    placeToolbarEntry,
    addToolbarEntry,
    removeToolbarEntry,
  };

  const payloadLabel = (p: DragPayload): string => {
    if (p.src === "sep") return "分割线";
    if (p.src === "toolbar") return builtinByKey(p.id.slice("builtin:".length))?.label ?? p.id;
    if (p.src === "builtin") return builtinByKey(p.key)?.label ?? p.key;
    const en = entries.find((e) => e.id === p.id);
    return en ? entryLabel(en) : p.id;
  };
  const payloadIcon = (p: DragPayload): LucideIcon => {
    if (p.src === "sep") return Minus;
    if (p.src === "toolbar") return FN_ICONS[p.id.slice("builtin:".length)] ?? List;
    if (p.src === "entry") {
      const en = entries.find((e) => e.id === p.id);
      return en ? entryIcon(en) : List;
    }
    return FN_ICONS[p.key] ?? List;
  };

  // ── Pointer 拖拽管线：位移 ≥4px 启动；elementFromPoint 命中行；松开结算 ──
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const st = dragRef.current;
      if (!st) return;
      if (!st.active) {
        if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < 4) return;
        st.active = true;
        setActive(st.payload);
      }
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      // 工具栏区嵌在左栏面板内：先判工具栏，命中时不再视作菜单投放区
      const overToolbar = !!el?.closest("[data-toolbar-zone]");
      const overLeft = !overToolbar && !!el?.closest("[data-menued-left]");
      setGhost({ x: e.clientX, y: e.clientY, overLeft, overToolbar });
      const row = overLeft ? el?.closest("[data-menued-row]") : null;
      setOverId(row?.getAttribute("data-menued-row") ?? null);
      const toolRow = overToolbar ? el?.closest("[data-toolbar-row]") : null;
      setOverToolId(toolRow?.getAttribute("data-toolbar-row") ?? null);
    };
    const onUp = (e: PointerEvent) => {
      const st = dragRef.current;
      dragRef.current = null;
      const wasActive = !!st?.active;
      setActive(null);
      setGhost(null);
      setOverId(null);
      setOverToolId(null);
      if (!st) return;
      if (!wasActive) {
        // 原地松开 = 点击：条目行展开/收起条件设置区（分割线无条件可设；
        // 工具栏行展开其条件编辑器；库行无点击行为——功能库仅拖拽添加）。
        // 行内小箭头钮经 stopPropagation 不进入拖拽管线，仍由自身 onClick 切换
        const p = st.payload;
        if (p.src === "entry" && !p.id.startsWith("sep:")) {
          const id = p.id;
          setExpanded((cur) => (cur === id ? null : id));
        } else if (p.src === "toolbar") {
          const id = p.id;
          setExpTool((cur) => (cur === id ? null : id));
        }
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const overToolbar = !!el?.closest("[data-toolbar-zone]");
      const overLeft = !overToolbar && !!el?.closest("[data-menued-left]");
      const rowId =
        overLeft && el
          ? (el.closest("[data-menued-row]")?.getAttribute("data-menued-row") ?? null)
          : null;
      const toolRowId =
        overToolbar && el
          ? (el.closest("[data-toolbar-row]")?.getAttribute("data-toolbar-row") ?? null)
          : null;
      if (st.payload.src === "toolbar") {
        // 工具栏条目：工具栏区内 = 放置（条目上 = 插到它前面，空处 = 追加/移到末尾）；
        // 拖出区外 = 移除（ghost 变红提示）
        if (overToolbar) opsRef.current.placeToolbarEntry(st.payload.id, toolRowId ?? undefined);
        else opsRef.current.removeToolbarEntry(st.payload.id);
      } else if (st.payload.src === "entry") {
        // 条目：拖出左栏（含拖回功能库）= 移除；左栏空处 = 移到末尾；
        // 拖到工具栏区 = 无效（原地弹回）
        if (!overLeft && !overToolbar) opsRef.current.remove(st.payload.id);
        else if (overLeft) {
          if (rowId) opsRef.current.moveTo(st.payload.id, rowId);
          else opsRef.current.moveToEnd(st.payload.id);
        }
      } else if (overToolbar) {
        // 功能库 → 工具栏：仅带「工具栏」能力的内置功能可入（其余原地弹回）
        opsRef.current.addToolbarEntry(st.payload, toolRowId ?? undefined);
      } else if (overLeft) {
        opsRef.current.dropInsert(st.payload, rowId ?? undefined);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const beginDrag = (e: React.PointerEvent, payload: DragPayload) => {
    if (e.button !== 0) return;
    dragRef.current = { payload, startX: e.clientX, startY: e.clientY, active: false };
  };
  const q = query.trim().toLowerCase();
  const used = new Set(entries.map((e) => e.id));
  const match = (label: string) => !q || label.toLowerCase().includes(q);
  // 功能库常驻全量胶囊（启用面以圆点标记）；「只展示未启用」开关可过滤
  const toolbarUsed = new Set(toolbarEntries.map((e) => e.id));
  // 插入指示线：工具栏钮拖动排序，或功能库拖入（全部内置功能可入工具栏）
  const toolDropHint =
    !!active && (active.src === "toolbar" || active.src === "builtin");
  const isUnusedFn = (f: BuiltinFn) => {
    const id = `builtin:${f.key}`;
    return !used.has(id) && !toolbarUsed.has(id);
  };
  const libFns = BUILTIN_FNS.filter(
    (f) => match(f.label) && (!onlyUnused || isUnusedFn(f)),
  );
  const showSep = !q || "分割线".includes(q);
  // ── 功能库目录（2026-10-15 A+B 定案）：点击平滑跳转 + scrollspy 高亮跟随 ──
  const groups = fnGroups();
  const visibleGroups = groups.filter((g) => libFns.some((f) => f.group === g));
  // 过滤后当前组可能被整组滤掉：高亮落到第一个可见组（spy 基准随之复位）
  const effGroup = visibleGroups.includes(curGroup) ? curGroup : (visibleGroups[0] ?? "");
  const jumpToGroup = (g: string) => {
    setCurGroup(g);
    const wrap = wallRef.current;
    const el = wrap?.querySelector<HTMLElement>(`[data-libcluster="${g}"]`);
    if (!wrap || !el) return;
    jumpLockRef.current = true;
    if (jumpTimerRef.current !== null) window.clearTimeout(jumpTimerRef.current);
    wrap.scrollTo({ top: el.offsetTop - 4, behavior: "smooth" });
    jumpTimerRef.current = window.setTimeout(() => {
      jumpLockRef.current = false;
      jumpTimerRef.current = null;
    }, DENSITY.libJumpLockMs);
  };
  const onWallScroll = () => {
    const wrap = wallRef.current;
    if (!wrap || jumpLockRef.current) return;
    const tops = Array.from(
      wrap.querySelectorAll<HTMLElement>("[data-libcluster]"),
    ).map((el) => ({ group: el.dataset.libcluster ?? "", top: el.offsetTop }));
    const g = spyGroup(tops, wrap.scrollTop, DENSITY.libSpyThreshold);
    if (g && g !== curGroup) setCurGroup(g);
  };

  return (
    <div className="np-menued">
      <div className="np-set-hint">
        把右侧功能拖入左侧菜单或上方工具栏即可启用；拖动排序，拖出区域即移除，点击条目可设置出现条件。
        带「固定」标记的基础功能不可移除；菜单功能在工具栏中按当前窗格选中项执行。
      </div>
      {/* 窗格工具栏区（共享功能库的第二个投放区）：横放在两栏上方，条带模拟
          窗格实际导航栏（np-nav）的样子——图标 + 标题文本的按钮同排；点击条目
          弹出启用条件浮层（不推移布局）；拖入启用/排序（插入指示 = 左缘竖线），
          拖出卡片 = 移除。data-toolbar-zone 挂整张面板卡（含标题/内边距）：
          只挂条带时丢在卡片空白处会被判为"拖出区外"，与左栏 data-menued-left 同理 */}
      <div className="np-menued-pane np-menued-toolzone" data-toolbar-zone>
        <div className="np-menued-title np-menued-toolhead">
          <span>窗格工具栏</span>
          <Button
            minimal
            size="small"
            icon={ic(LayoutTemplate)}
            text="重置为默认方案"
            onClick={applyToolbarDefault}
            title="恢复默认工具栏排列（地址框保留常驻）"
          />
        </div>
        <div className="np-menued-tbar">
          {toolbarEntries.map((en) => {
            const key = en.id.slice("builtin:".length);
            const rowCls = [
              key === "addr" ? "np-menued-taddr" : "np-menued-tbtn",
              active?.src === "toolbar" && active.id === en.id ? "is-drag" : "",
              toolDropHint && overToolId === en.id ? "is-drop-target" : "",
              expTool === en.id ? "is-on" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <PopoverNext
                key={en.id}
                isOpen={expTool === en.id}
                onInteraction={(next) => {
                  if (!next) setExpTool(null);
                }}
                placement="bottom-start"
                arrow={false}
                content={toolCondPanel(en)}
              >
                <div
                  data-toolbar-row={en.id}
                  className={rowCls}
                  title={`${builtinByKey(key)?.label ?? en.id} · ${toolbarSentence(en.cond, en.area)}`}
                  onPointerDown={(e) => beginDrag(e, { src: "toolbar", id: en.id })}
                >
                  <AppIcon icon={FN_ICONS[key] ?? List} size={DENSITY.iconSm} />
                  <span className="np-ellipsis">
                    {builtinByKey(key)?.label ?? en.id}
                    {key === "addr" && "（固定）"}
                  </span>
                </div>
              </PopoverNext>
            );
          })}
          {!toolbarEntries.length && (
            <div className="np-menued-empty">
              从功能库把功能拖到这里（任意功能都可入工具栏）
            </div>
          )}
        </div>
      </div>
      <div
        className="np-menued-cols"
        style={{ gridTemplateColumns: `${leftW}px var(--np-gutter) minmax(0, 1fr)` }}
      >
        {/* data-menued-left 挂在整个左栏面板上：标题行、列表、列表外空白都是投放区
            （只挂列表框时，拖到框下空白会被判为"拖出左栏"= 误删条目） */}
        <div className="np-menued-pane" data-menued-left>
          <div className="np-menued-title np-menued-headrow">
            <span>启用菜单</span>
            <span className="np-menued-headacts">
              <Button
                size="small"
                minimal
                onClick={() => {
                  void confirmDialog({
                    title: "清空自定义菜单",
                    message:
                      "清空当前菜单布局？仅保留七项基础固定功能，自定义排列不可恢复。",
                    kind: "warn",
                    okText: "清空",
                  }).then((ok) => {
                    if (ok) set(ensureFixedEntries([]));
                  });
                }}
              >
                清空
              </Button>
              <Button
                minimal
                size="small"
                icon={ic(LayoutTemplate)}
                text="重置为默认方案"
                onClick={applyMenuDefault}
                title="恢复默认菜单布局（七项基础功能保留）"
              />
            </span>
          </div>
          <div className="np-menued-list">
            {entries.map((en) => (
              <div key={en.id} className="np-menued-item">
                <div
                  data-menued-row={en.id}
                  className={`np-menued-row ${
                    active?.src === "entry" && active.id === en.id ? "is-drag" : ""
                  } ${active && overId === en.id ? "is-drop-target" : ""}`}
                  onPointerDown={(e) => beginDrag(e, { src: "entry", id: en.id })}
                >
                  <AppIcon icon={entryIcon(en)} size={DENSITY.iconSm} />
                  <span className="np-menued-label np-ellipsis">
                    {entryLabel(en)}
                  </span>
                  {isFixedEntry(en) && <span className="np-menued-chip">固定</span>}
                  {en.kind !== "sep" &&
                    condChipTexts(en).map((t) => (
                      <span key={t} className="np-menued-chip">
                        {t}
                      </span>
                    ))}
                  {en.kind !== "sep" && (
                    <PopoverNext
                      isOpen={expanded === en.id}
                      onInteraction={(next) => {
                        if (!next) setExpanded(null);
                      }}
                      placement="bottom-end"
                      arrow={false}
                      content={menuCondPanel(en)}
                    >
                      <button
                        className="np-menued-exp"
                        title="出现条件"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setExpanded(expanded === en.id ? null : en.id)}
                      >
                        <AppIcon
                          icon={expanded === en.id ? ChevronDown : ChevronRight}
                          size={DENSITY.iconXs}
                        />
                      </button>
                    </PopoverNext>
                  )}
                </div>
              </div>
            ))}
            {!entries.length && (
              <div className="np-menued-empty">
                菜单为空——从右侧功能库把功能拖到这里
              </div>
            )}
          </div>
        </div>
        <div
          className="np-menued-grip"
          onPointerDown={startLeftResize}
          title="拖动调整两栏宽度"
        />
        <div className="np-menued-pane">
          <div className="np-menued-title np-menued-libhead">
            <span>功能库</span>
            <span className="np-menued-libcount">{libFns.length}</span>
            <InputGroup
              className="np-menued-search"
              size="small"
              value={query}
              placeholder="搜索功能"
              leftElement={ic(Search)}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Switch
              checked={onlyUnused}
              label="只展示未启用的功能"
              onChange={(e) => setOnlyUnused(e.currentTarget.checked)}
            />
            <span className="np-menued-legend">
              <span className="np-menued-mark is-menu">
                <AppIcon icon={MenuIcon} size={DENSITY.iconXs} />
              </span>
              菜单
              <span className="np-menued-mark is-tool">
                <AppIcon icon={PanelTop} size={DENSITY.iconXs} />
              </span>
              工具栏
            </span>
          </div>
          <div className="np-menued-libbody">
            <nav className="np-menued-rail">
              {groups.map((g) => (
                <button
                  key={g}
                  className={`np-menued-ritem${g === effGroup ? " is-on" : ""}`}
                  onClick={() => jumpToGroup(g)}
                  title={`跳转到 ${g}`}
                >
                  {g}
                  <em>{BUILTIN_FNS.filter((f) => f.group === g).length}</em>
                </button>
              ))}
            </nav>
            <div
              className="np-menued-wallwrap"
              ref={wallRef}
              onScroll={onWallScroll}
            >
              {showSep && (
                <div className="np-menued-cluster" data-libcluster="布局">
                  <div className="np-menued-clabel">
                    <b>布局</b>
                    <span>1</span>
                  </div>
                  <div className="np-menued-wall">
                    <div
                      className="np-menued-librow"
                      onPointerDown={(e) => beginDrag(e, { src: "sep" })}
                      title="拖入左侧菜单添加分割线"
                    >
                      <AppIcon icon={Minus} size={DENSITY.iconSm} />
                      <span className="np-menued-label">分割线</span>
                    </div>
                  </div>
                </div>
              )}
              {visibleGroups.map((g) => (
                <div key={g} className="np-menued-cluster" data-libcluster={g}>
                  <div className="np-menued-clabel">
                    <b>{g}</b>
                    <span>{libFns.filter((f) => f.group === g).length}</span>
                  </div>
                  <div className="np-menued-wall">
                    {libFns
                      .filter((f) => f.group === g)
                      .map((f) => {
                        const id = `builtin:${f.key}`;
                        const dual = f.supportsSel || f.supportsBlank;
                        return (
                          <div
                            key={f.key}
                            className="np-menued-librow"
                            onPointerDown={(e) =>
                              beginDrag(e, { src: "builtin", key: f.key })
                            }
                            title={
                              dual
                                ? `${f.label}（拖入菜单或工具栏对应区域；可两面共享）`
                                : `${f.label}（仅可拖入工具栏）`
                            }
                          >
                            <AppIcon
                              icon={FN_ICONS[f.key] ?? List}
                              size={DENSITY.iconSm}
                            />
                            <span className="np-menued-label np-ellipsis">
                              {f.label}
                            </span>
                            <span className="np-menued-marks">
                              {used.has(id) && (
                                <span
                                  className="np-menued-mark is-menu"
                                  title="已启用 · 右键菜单"
                                >
                                  <AppIcon icon={MenuIcon} size={DENSITY.iconXs} />
                                </span>
                              )}
                              {toolbarUsed.has(id) && (
                                <span
                                  className="np-menued-mark is-tool"
                                  title="已启用 · 窗格工具栏"
                                >
                                  <AppIcon icon={PanelTop} size={DENSITY.iconXs} />
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
              {!visibleGroups.length && !showSep && (
                <div className="np-menued-empty">无匹配功能</div>
              )}
            </div>
          </div>
        </div>
      </div>
      {active && ghost && (
        <div
          className={`np-menued-ghost ${
            // 红染 = 松手将移除/无效（与 onUp 落点语义一致）：工具栏条目拖出卡片、
            // 菜单条目拖出左右两栏；库载荷落在工具栏卡上但无「工具栏」能力 = 无效弹回
            (active.src === "toolbar" && !ghost.overToolbar && active.id !== "builtin:addr") ||
            (active.src === "entry" &&
              !ghost.overLeft &&
              !ghost.overToolbar &&
              !isFixedEntryId(active.id)) ||
            (ghost.overToolbar && active.src === "sep")
              ? "is-remove"
              : ""
          }`}
          style={{
            left: ghost.x + DENSITY.dragGhostDx,
            top: ghost.y + DENSITY.dragGhostDy,
          }}
        >
          <AppIcon icon={payloadIcon(active)} size={DENSITY.iconSm} />
          <span className="np-ellipsis">{payloadLabel(active)}</span>
        </div>
      )}
    </div>
  );
}
