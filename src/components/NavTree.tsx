import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  Computer,
  Folder,
  FolderOpen,
  HardDrive,
  RefreshCw,
} from "lucide-react";

import { api, THIS_PC, type DriveInfo } from "../lib/ipc";
import { DENSITY } from "../lib/tokens";
import { FadeInIcon } from "./FileList";
import { useLayout } from "../stores/layout";
import { TREE_W_MAX, TREE_W_MIN, treeChildPath, useNavTree } from "../stores/navtree";
import { usePanes } from "../stores/panes";
import { useIcons } from "../stores/icons";
import { useSettings } from "../stores/settings";
import { AppIcon } from "./AppIcon";

interface FlatNode {
  key: string;
  path: string;
  name: string;
  depth: number;
  open: boolean;
  kind: "pc" | "drive" | "dir";
}

const ROW_H = DENSITY.rowH;

/** 全局目录导航树（所有窗格共用；挂在左侧边栏右侧，可拖宽）。
 *  点击节点 = 在活动窗格打开；箭头 = 展开/收起；展开时经 list_dirs 懒加载子目录。
 *  图标走文件类型语义色族（--np-icon-folder / --np-icon-drive，AGENTS §4.5 特例） */
export function NavTree() {
  const visible = useSettings((s) => s.navTreeVisible);
  const width = useSettings((s) => s.navTreeWidth);
  const expandedList = useSettings((s) => s.navTreeExpanded);
  const realIcons = useSettings((s) => s.realIcons);
  const iconMap = useIcons((s) => s.icons);
  const located = useNavTree((s) => s.located);
  const children = useNavTree((s) => s.children);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [dragW, setDragW] = useState<number | null>(null);
  const dragWRef = useRef<number | null>(null);
  const scrolledRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activePath = useLayout((s) => {
    const pane = s.activePane();
    return pane ? (pane.tabs[pane.activeTab]?.path ?? THIS_PC) : THIS_PC;
  });
  const expanded = useMemo(
    () => new Set(expandedList),
    [expandedList],
  );

  useEffect(() => {
    api.getDrives().then(setDrives).catch(() => undefined);
  }, []);

  // 展开状态 → 可见节点扁平列表（虚拟滚动数据源）
  const flat = useMemo(() => {
    const out: FlatNode[] = [];
    const pushKids = (path: string, depth: number) => {
      for (const name of children[path] ?? []) {
        const cp = treeChildPath(path, name);
        const open = expanded.has(cp);
        out.push({ key: cp, path: cp, name, depth, open, kind: "dir" });
        if (open) pushKids(cp, depth + 1);
      }
    };
    const pcOpen = expanded.has(THIS_PC);
    out.push({ key: THIS_PC, path: THIS_PC, name: "此电脑", depth: 0, open: pcOpen, kind: "pc" });
    if (pcOpen) {
      for (const d of drives) {
        const p = `${d.letter}\\`;
        const open = expanded.has(p);
        out.push({
          key: p,
          path: p,
          name: d.label ? `${d.label} (${d.letter})` : d.letter,
          depth: 1,
          open,
          kind: "drive",
        });
        if (open) pushKids(p, 2);
      }
    }
    return out;
  }, [expanded, children, drives]);

  const virt = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: DENSITY.overscan,
  });

  // 真实文件图标开启时，为可见节点请求真实图标（未命中前回退 Lucide）
  useEffect(() => {
    if (!realIcons || flat.length === 0) return;
    const paths = flat
      .filter((n) => n.kind !== "pc")
      .map((n) => n.path);
    if (paths.length) useIcons.getState().requestIcons(paths, true);
  }, [flat, realIcons]);

  // 定位联动：目标节点进入扁平列表后滚动到可见区（子目录懒加载完成后自动补滚）
  useEffect(() => {
    if (!located || scrolledRef.current === located) return;
    const idx = flat.findIndex((n) => n.path === located);
    if (idx >= 0) {
      virt.scrollToIndex(idx, { align: "center" });
      scrolledRef.current = located;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [located, flat]);

  if (!visible) return null;

  function openPath(path: string) {
    const pane = useLayout.getState().activePane();
    const tabId = pane?.tabs[pane.activeTab]?.id;
    if (tabId) usePanes.getState().navigate(tabId, path);
  }

  function startResize(e: ReactMouseEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startW = useSettings.getState().navTreeWidth;
    handle.classList.add("np-side-resizing");
    const move = (ev: MouseEvent) => {
      // 拖拽中仅本地状态实时反馈，松手才写入 settings.json
      const latest = Math.min(
        TREE_W_MAX,
        Math.max(TREE_W_MIN, startW + ev.clientX - startX),
      );
      dragWRef.current = latest;
      setDragW(latest);
    };
    const up = () => {
      handle.classList.remove("np-side-resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (dragWRef.current !== null) {
        useSettings.getState().update({ navTreeWidth: dragWRef.current });
      }
      dragWRef.current = null;
      setDragW(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <aside className="np-navtree" style={{ width: dragW ?? width }}>
      <div className="np-side-h">
        <span>导航树</span>
        <button
          className="np-side-add"
          data-tip="刷新（重新读取已展开的目录）"
          onClick={() => useNavTree.getState().refresh()}
        >
          <AppIcon icon={RefreshCw} size={DENSITY.iconSm} />
        </button>
      </div>

      <div className="np-tree-rows" ref={scrollRef}>
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((vi) => {
            const n = flat[vi.index];
            const realUrl = realIcons && n.kind !== "pc" ? iconMap[n.path] : undefined;
            const cls =
              `np-tree-row` +
              (activePath === n.path ? " on" : "") +
              (located === n.path && activePath !== n.path ? " loc" : "");
            return (
              <div
                key={n.key}
                className={cls}
                style={
                  {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                    paddingLeft: 6 + n.depth * 16,
                  } as CSSProperties
                }
                data-tip={n.path}
                onClick={() => openPath(n.path)}
                onMouseDown={(e) => {
                  // 中键 = 在活动窗格新标签打开（与列表行中键同语义）
                  if (e.button === 1) {
                    e.preventDefault();
                    const pane = useLayout.getState().activePaneId;
                    if (pane) useLayout.getState().newTab(pane, n.path);
                  }
                }}
              >
                <span
                  className={`np-tree-chev${n.open ? " open" : ""}`}
                  data-tip={n.open ? "收起" : "展开"}
                  onClick={(e) => {
                    e.stopPropagation();
                    useNavTree.getState().toggleDir(n.path);
                  }}
                >
                  <AppIcon icon={ChevronRight} size={DENSITY.iconSm} />
                </span>
                <span className="np-tree-ic">
                  {realUrl ? (
                    <FadeInIcon src={realUrl} />
                  ) : n.kind === "pc" ? (
                    <AppIcon icon={Computer} size={DENSITY.iconSm} colorVar="--np-icon-drive" />
                  ) : n.kind === "drive" ? (
                    <AppIcon icon={HardDrive} size={DENSITY.iconSm} colorVar="--np-icon-drive" />
                  ) : n.open && n.kind === "dir" ? (
                    <AppIcon icon={FolderOpen} size={DENSITY.iconSm} colorVar="--np-icon-folder" />
                  ) : (
                    <AppIcon icon={Folder} size={DENSITY.iconSm} colorVar="--np-icon-folder" />
                  )}
                </span>
                <span className="np-tree-name">{n.name}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="np-tree-resize" onMouseDown={startResize} data-tip="拖动调整宽度" />
    </aside>
  );
}
