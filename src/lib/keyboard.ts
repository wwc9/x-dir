// 全局快捷键（§7.2）：地址栏等输入框内只处理 Esc 失焦，其余键路由到
// 活动窗格的 ListHandlers（lib/listRegistry）。

import { dfsPanes } from "./layoutTree";
import { usePanes } from "../stores/panes";
import type { ViewMode } from "./ipc";
import { THIS_PC } from "./ipc";
import { getList } from "./listRegistry";
import { zoomStep } from "./zoom";
import { DENSITY } from "./tokens";
import { pickTypeAhead } from "./typeAhead";
import { useUndo } from "./undo";
import { useLayout } from "../stores/layout";
import { closePaneConfirmed, useUi } from "../stores/ui";
import { useSettings } from "../stores/settings";
import { pickStartIndex, usePreview } from "../stores/preview";
import { api } from "./ipc";

type Dir = "up" | "down" | "left" | "right";

// ── 首字母跳转（type-ahead）缓冲：无修饰键单字符累积，停顿 DENSITY.typeAheadMs
//    即清空；匹配逻辑在 lib/typeAhead.ts（纯函数，配单测）。缓冲与命中经
//    useUi.typeAhead 回显到活动窗格列表角落的定位 pill ──
let taBuf = "";
let taTimer: number | undefined;

function typeAheadReset(): void {
  taBuf = "";
  if (taTimer !== undefined) {
    clearTimeout(taTimer);
    taTimer = undefined;
  }
  useUi.getState().setTypeAhead(null);
}

function focusNearest(activePaneId: string, dir: Dir) {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-id]"),
  );
  const mine = nodes.find((n) => n.dataset.paneId === activePaneId);
  if (!mine) return;
  const r0 = mine.getBoundingClientRect();
  const cx0 = r0.left + r0.width / 2;
  const cy0 = r0.top + r0.height / 2;
  let best: { id: string; d: number } | null = null;
  for (const n of nodes) {
    const id = n.dataset.paneId;
    if (!id || id === activePaneId) continue;
    const r = n.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let ok = false;
    let d = 0;
    if (dir === "left") {
      ok = r.right <= r0.left + 1;
      d = Math.abs(cy - cy0) * 3 + (r0.left - r.right);
    } else if (dir === "right") {
      ok = r.left >= r0.right - 1;
      d = Math.abs(cy - cy0) * 3 + (r.left - r0.right);
    } else if (dir === "up") {
      ok = r.bottom <= r0.top + 1;
      d = Math.abs(cx - cx0) * 3 + (r0.top - r.bottom);
    } else {
      ok = r.top >= r0.bottom - 1;
      d = Math.abs(cx - cx0) * 3 + (r.top - r0.bottom);
    }
    if (ok && d >= 0 && (!best || d < best.d)) best = { id, d };
  }
  if (best) useLayout.getState().setActive(best.id);
}

export function onGlobalKeyDown(e: KeyboardEvent): void {
  const k0 = e.key;
  const ctrl0 = e.ctrlKey || e.metaKey;
  // Esc 的任何取消路径都顺带清掉 type-ahead 缓冲与回显 pill（若在缓冲中）
  if (k0 === "Escape") typeAheadReset();
  // WebView2 浏览器加速键（F5/Ctrl+R 重载、Ctrl+F 查找栏、Ctrl+P 打印）已在
  // Rust 侧关闭（src-tauri lib.rs），此处兜底：这些键在任何早退分支（输入框
  // 聚焦/模态守卫）都不得漏给 WebView2，否则整页重载（内存态全丢）/系统查找
  // 栏/打印框会抢在应用前面。F5 拦截后继续下落，由下方正常分支刷新活动窗格。
  if (
    k0 === "F5" ||
    (ctrl0 && !e.altKey && ["r", "f", "p"].includes(k0.toLowerCase()))
  ) {
    e.preventDefault();
  }
  // 右键菜单打开：Esc 关闭（其余键被下方模态守卫拦截）
  if (e.key === "Escape" && useUi.getState().menu) {
    useUi.getState().closeMenu();
    e.preventDefault();
    return;
  }
  // 独立页（右键菜单编辑页 / 全盘搜索页，占满顶栏以下整区）：Esc 关闭；输入框内
  // 先失焦（菜单页语义）/ 由页面自带 onKeyDown 关闭（搜索页两处输入框均
  // stopPropagation，不落到这里）。设置已是浮窗 Dialog，Esc 由 Blueprint 处理。
  // 页面上叠着对话框（重置预设确认/设置浮窗）或 Blueprint 弹层（NpSelect 下拉/
  // 条件编辑浮层/预设菜单）时 Esc 只关最上层的它——Blueprint 与此处都会收到
  // 同一事件，若不避开会连页面一起退出
  const pageUi = useUi.getState();
  if (
    e.key === "Escape" &&
    (pageUi.menuPage || pageUi.globalSearch) &&
    !pageUi.dialog &&
    !document.querySelector(".bp6-popover")
  ) {
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      t.blur();
    } else if (pageUi.menuPage) {
      useUi.getState().closeMenuPage();
    } else {
      useUi.getState().closeGlobalSearch();
    }
    e.preventDefault();
    return;
  }
  // Ctrl+Shift+F：全盘搜索（放在模态守卫之前——定制页内按下 = 切换到全盘搜索页，
  // 整页互斥由 openGlobalSearch 内部保证；对话框/右键菜单打开时仍拦截）
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
    const pg = useUi.getState();
    if (!pg.dialog && !pg.menu) {
      useUi.getState().openGlobalSearch();
      e.preventDefault();
      return;
    }
  }
  // 模态面（对话框 / 全盘搜索 / 右键菜单 / 菜单编辑页）打开：全局快捷键一律停用——
  // 否则 Enter 确认删除会同时 onEnter"打开"被删文件，方向键会移动背后列表。
  // 面板内控件自带按键处理（Blueprint canEscapeKeyClose / 面板 onKeyDown）
  const ui = useUi.getState();
  if (ui.dialog || ui.globalSearch || ui.menu || ui.menuPage) return;
  // Ctrl +/-/0：界面缩放（输入框内同样生效，与浏览器缩放习惯一致）
  if ((e.ctrlKey || e.metaKey) && ["=", "+", "-", "0"].includes(e.key)) {
    const s = useSettings.getState();
    s.update({ uiZoom: e.key === "0" ? 1 : zoomStep(s.uiZoom, e.key === "-" ? -1 : 1) });
    e.preventDefault();
    return;
  }
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
    if (e.key === "Escape") target.blur();
    return;
  }
  const { tree, activePaneId } = useLayout.getState();
  if (!tree || !activePaneId) return;

  const pane = dfsPanes(tree).find((p) => p.id === activePaneId);
  const tabId = pane?.tabs[pane.activeTab]?.id ?? null;
  const list = getList(tabId);
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  const lower = k.toLowerCase();

  // ── 快速预览（Quick Look 惯例）：Space 开/关；开着时 ↑/↓ 循环切换（选中态同步
  //    由 QuickPreviewHost 统一处理），Enter = 用默认程序打开，Esc 关闭。──
  const pv = usePreview.getState();
  if (pv.queue.length) {
    if (k === " ") {
      pv.close();
      e.preventDefault();
      return;
    }
    if (k === "Escape") {
      pv.close();
      e.preventDefault();
      return;
    }
    if (k === "Enter") {
      const cur = pv.current();
      if (cur) void api.openItem(cur.path).catch(() => undefined);
      e.preventDefault();
      return;
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      k === "ArrowDown" ? pv.next() : pv.prev();
      e.preventDefault();
      return;
    }
  } else if (k === " " && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const snap = list?.getSnapshot();
    // 队列含文件夹：走文件夹元信息卡（子项数/体积，preview/PreviewBody 路由）
    const files = snap ? snap.entries : [];
    if (files.length) {
      pv.openPreview(files, pickStartIndex(files, snap?.selected ?? []));
    }
    e.preventDefault();
    return;
  }

  // ── 首字母跳转：无修饰键单字符（Space=预览、IME 组合 key="Process" 均被排除）。
  //    预览/交换窗格进行中不响应，避免浮层背后静默改选。──
  if (
    !pv.queue.length &&
    !useUi.getState().swapFrom &&
    !ctrl &&
    !e.altKey &&
    !e.metaKey &&
    k.length === 1 &&
    k !== " " &&
    list
  ) {
    const snap = list.getSnapshot();
    if (snap.entries.length) {
      if (taTimer !== undefined) clearTimeout(taTimer);
      taBuf += k.toLowerCase();
      taTimer = window.setTimeout(typeAheadReset, DENSITY.typeAheadMs);
      const curIdx = snap.entries.findIndex(
        (en) => en.path === snap.selected[snap.selected.length - 1],
      );
      let idx = pickTypeAhead(snap.entries, taBuf, curIdx);
      if (idx === null && taBuf.length > 1) {
        // 整缓冲无命中：回退为仅本次按键再试（"ab" 打错退回单字符继续跳）
        taBuf = k.toLowerCase();
        idx = pickTypeAhead(snap.entries, taBuf, curIdx);
      }
      if (idx !== null) list.revealEntry(snap.entries[idx].path);
      useUi
        .getState()
        .setTypeAhead({
          buf: taBuf,
          hit: idx !== null ? snap.entries[idx].name : null,
        });
      e.preventDefault();
      return;
    }
  }

  // 窗格与标签
  if (ctrl && /^[1-9]$/.test(k)) {
    const target = dfsPanes(tree)[Number(k) - 1];
    if (target) useLayout.getState().setActive(target.id);
    e.preventDefault();
    return;
  }
  if (e.altKey && k.startsWith("Arrow")) {
    focusNearest(activePaneId, k.slice(5).toLowerCase() as Dir);
    e.preventDefault();
    return;
  }
  if (ctrl && e.shiftKey && (lower === "h" || lower === "v")) {
    useLayout.getState().split(lower === "h" ? "horizontal" : "vertical");
    e.preventDefault();
    return;
  }
  if (ctrl && e.shiftKey && lower === "w") {
    closePaneConfirmed(activePaneId);
    e.preventDefault();
    return;
  }
  if (ctrl && e.shiftKey && lower === "n") {
    list?.onNewFolder();
    e.preventDefault();
    return;
  }
  // 无 Shift 的字母键 e.key 为小写（Ctrl+T → "t"），一律比对 lower——
  // 比对大写原值会让快捷键在真实键盘上永不命中
  if (ctrl && lower === "t") {
    useLayout.getState().newTab(activePaneId);
    e.preventDefault();
    return;
  }
  if (ctrl && lower === "w" && pane) {
    useLayout.getState().closeTab(activePaneId, pane.activeTab);
    e.preventDefault();
    return;
  }
  if (ctrl && k === "Tab" && pane) {
    const n = pane.tabs.length;
    const next = e.shiftKey
      ? (pane.activeTab - 1 + n) % n
      : (pane.activeTab + 1) % n;
    useLayout.getState().activateTab(activePaneId, next);
    e.preventDefault();
    return;
  }
  if (e.altKey && lower === "d") {
    (
      document.querySelector(`[data-address="${activePaneId}"]`) as
        | HTMLInputElement
        | null
    )?.focus();
    e.preventDefault();
    return;
  }
  // Ctrl+F：打开/聚焦活动窗格的递归搜索框（V2 §3.2）
  if (ctrl && lower === "f" && tabId) {
    const cur = usePanes.getState().tabs[tabId];
    usePanes.getState().setSearch(tabId, cur?.search ?? "");
    requestAnimationFrame(() => {
      (
        document.querySelector(`[data-search="${activePaneId}"]`) as
          | HTMLInputElement
          | null
      )?.focus();
    });
    e.preventDefault();
    return;
  }
  // Ctrl+E：视图内过滤（就地收窄当前目录，不递归；Esc 退出还原）。
  // "此电脑"伪页无名称可过滤，不响应
  if (ctrl && lower === "e" && tabId && usePanes.getState().currentPathOf(tabId) !== THIS_PC) {
    usePanes.getState().setFilter(tabId, usePanes.getState().tabs[tabId]?.filter ?? "");
    requestAnimationFrame(() => {
      (
        document.querySelector(`[data-filter="${activePaneId}"]`) as
          | HTMLInputElement
          | null
      )?.focus();
    });
    e.preventDefault();
    return;
  }
  // Ctrl+Shift+C / X：复制 / 移动到目标窗格（每窗格记忆上次选过的对侧，
  // 未记忆回落 DFS 序首个其他窗格；目标在"此电脑"页视为无效）
  if (ctrl && e.shiftKey && (lower === "c" || lower === "x") && list) {
    list.onTransferToPane(lower === "x");
    e.preventDefault();
    return;
  }
  // F3：循环切换活动窗格视图（详细信息 → 列表）
  if (k === "F3" && pane && tabId) {
    const order: ViewMode[] = ["details", "list"];
    const cur = usePanes.getState().tabs[tabId]?.viewMode ?? "details";
    usePanes.getState().setView(tabId, order[(order.indexOf(cur) + 1) % order.length]);
    e.preventDefault();
    return;
  }
  if (k === "F5") {
    list?.onRefresh(true);
    e.preventDefault();
    return;
  }
  if (k === "Escape" && useUi.getState().swapFrom) {
    useUi.getState().cancelSwap();
    e.preventDefault();
    return;
  }
  // Esc：先关活动窗格的递归搜索，再退视图过滤，最后清空选择（Explorer 惯例；
  // 上面各分支优先）
  if (k === "Escape" && tabId) {
    const tab = usePanes.getState().tabs[tabId];
    if (tab?.search != null) {
      usePanes.getState().setSearch(tabId, null);
    } else if (tab?.filter != null) {
      usePanes.getState().setFilter(tabId, null);
    } else if (tab?.selected.length) {
      usePanes.getState().setSelected(tabId, [], null);
    }
    e.preventDefault();
    return;
  }
  // Shift+F10 / ContextMenu 键：键盘呼出选中项右键菜单（Windows 无障碍惯例）
  if ((k === "F10" && e.shiftKey) || k === "ContextMenu") {
    list?.onContextMenu();
    e.preventDefault();
    return;
  }

  // 列表操作（作用于活动窗格）
  if (k.startsWith("Arrow") && list) {
    list.onArrow(k.slice(5).toLowerCase() as Dir, e.shiftKey);
    e.preventDefault();
    return;
  }
  if (["PageUp", "PageDown", "Home", "End"].includes(k) && list) {
    list.onNav(k.toLowerCase() as "pageup" | "pagedown" | "home" | "end", e.shiftKey);
    e.preventDefault();
    return;
  }
  // Alt+Enter：属性（资源管理器惯例）
  if (e.altKey && k === "Enter" && list) {
    list.onProperties();
    e.preventDefault();
    return;
  }
  switch (k) {
    case "Enter":
      list?.onEnter();
      break;
    case "Backspace":
      list?.onBackspace();
      break;
    case "Delete":
      list?.onDelete(e.shiftKey);
      break;
    case "F2":
      list?.onRename();
      break;
    default:
      if (ctrl && lower === "a") {
        list?.onSelectAll();
        e.preventDefault();
      } else if (ctrl && lower === "c") {
        list?.onCopy(false);
      } else if (ctrl && lower === "x") {
        list?.onCopy(true);
      } else if (ctrl && lower === "v") {
        list?.onPaste();
      } else if (ctrl && lower === "z" && !e.shiftKey) {
        // 撤销（lib/undo 栈）：回收站删除/重命名/应用内移动/新建
        void useUndo.getState().undo();
        e.preventDefault();
      } else if (ctrl && (lower === "y" || (lower === "z" && e.shiftKey))) {
        // 重做：撤销的逆操作（Ctrl+Y 或 Ctrl+Shift+Z，编辑器惯例）
        void useUndo.getState().redo();
        e.preventDefault();
      }
  }
}
