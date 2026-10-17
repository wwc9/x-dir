// V3 OLE 拖拽的前端分发：拖出 = api.startDrag（Rust DoDragDrop）；
// 拖入/窗内落点 = Tauri onDragDropEvent（WebView2 拖放目标携带完整路径），
// 命中判定优先 DOM elementFromPoint（免换算误差），回退 lib/hitTest.ts 纯函数
// （单测覆盖）。

import { getCurrentWebview } from "@tauri-apps/api/webview";

import { THIS_PC } from "./ipc";
import { allSourcesInside, dropGuard, hitPane, type PaneRects } from "./hitTest";
import { dfsPanes, type LayoutNode } from "./layoutTree";
import { transfer } from "./operations";
import { useLayout } from "../stores/layout";
import { useSettings } from "../stores/settings";
import { useUi } from "../stores/ui";
import { useDnd } from "../stores/dnd";

interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths: string[];
  position: { x: number; y: number }; // 物理像素
}

function collectRects(): PaneRects[] {
  const out: PaneRects[] = [];
  document.querySelectorAll<HTMLElement>("[data-pane-id]").forEach((el) => {
    const paneId = el.dataset.paneId;
    if (!paneId) return;
    const tabbar = el.querySelector<HTMLElement>(".np-tabbar");
    if (!tabbar) return;
    out.push({
      paneId,
      pane: el.getBoundingClientRect(),
      tabbar: tabbar.getBoundingClientRect(),
    });
  });
  return out;
}

/** 落点命中：优先 DOM 命中（坐标语义与元素布局同源，无换算误差），
 *  点落在窗格间隙/遮挡层时回退矩形判定（hitPane，单测覆盖） */
function hitAt(cssX: number, cssY: number): { paneId: string; onTabbar: boolean } | null {
  const el = document.elementFromPoint(cssX, cssY);
  const paneEl = el?.closest<HTMLElement>("[data-pane-id]");
  if (paneEl?.dataset.paneId) {
    return {
      paneId: paneEl.dataset.paneId,
      onTabbar: !!el!.closest(".np-tabbar"),
    };
  }
  return hitPane(collectRects(), cssX, cssY);
}

async function handleDrop(paths: string[], cssX: number, cssY: number) {
  // 落在暂存区（侧边栏下半）：路径入库即完成，不进入窗格传输（Explorer 拖入同管线）。
  // 必须先于窗格命中判定——暂存区不在任何 [data-pane-id] 内。
  const overShelf = document
    .elementFromPoint(cssX, cssY)
    ?.closest<HTMLElement>("[data-shelf]");
  if (overShelf) {
    const added = useSettings.getState().addShelf(paths);
    useUi
      .getState()
      .toast(added ? `已暂存 ${added} 项` : "这些项已在暂存区（或暂存区已满）");
    return;
  }
  const hit = hitAt(cssX, cssY);
  // 落在边栏/顶栏/沟槽等非窗格区域：忽略
  if (!hit) return;
  const layout = useLayout.getState();
  const pane = layout.tree
    ? dfsPanes(layout.tree as LayoutNode).find((x) => x.id === hit.paneId)
    : null;
  const tab = pane?.tabs[pane.activeTab];
  const destPath = tab?.path ?? THIS_PC;

  // 落到标签条 = 在该窗格新标签打开（仅单个文件夹，§7.4 语义）
  if (hit.onTabbar) {
    if (paths.length === 1) {
      useLayout.getState().newTab(hit.paneId, paths[0]);
    } else {
      useUi.getState().toast("标签栏一次只能接收一个文件夹", "error");
    }
    return;
  }
  // "此电脑"是虚拟页，不能接收放置——明确告知，避免看起来像拖放失效
  if (destPath === THIS_PC || !pane) {
    useUi.getState().toast("「此电脑」页不能放置文件，请拖到打开了文件夹的窗格", "error");
    return;
  }
  if (allSourcesInside(paths, destPath)) return;
  // 自落守护：后端 move/copy 有同类守卫，前端先行拦截省一次失败任务与报错 toast
  const guard = dropGuard(paths, destPath);
  if (guard === "self") return; // 拖到正显示源目录的窗格：无操作（对齐 Explorer）
  if (guard === "inside") {
    useUi.getState().toast("不能把文件夹放入它自身内部", "error");
    return;
  }
  await transfer(paths, destPath, "move");
}

/** App 启动时挂载：拖拽高亮 + 落点分发（物理坐标 → CSS 换算，逐事件取缩放） */
export async function initOleDnd(): Promise<() => void> {
  let last: { x: number; y: number } | null = null;
  const un = await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload as DragDropPayload;
    // 物理像素 → CSS 像素：缩放逐事件现取，跨不同 DPI 显示器拖动也准确
    const scale = window.devicePixelRatio || 1;
    if (p.type === "leave") {
      last = null;
      useDnd.getState().setPoint(null);
      return;
    }
    const css = { x: p.position.x / scale, y: p.position.y / scale };
    if (p.type === "drop") {
      last = null;
      useDnd.getState().setPoint(null);
      void handleDrop(p.paths, css.x, css.y);
    } else {
      // over 事件随鼠标移动高频推送：位移 < 3px 不刷 store（省 IPC 与重渲染）
      if (last && Math.hypot(css.x - last.x, css.y - last.y) < 3) return;
      last = css;
      useDnd.getState().setPoint(css);
    }
  });
  return un;
}
