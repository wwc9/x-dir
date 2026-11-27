// 全局快捷键（§7.2）：地址栏等输入框内只处理 Esc 失焦，其余键路由到
// 活动窗格的 ListHandlers（lib/listRegistry）。

import { dfsPanes } from "./layoutTree";
import { usePanes } from "../stores/panes";
import type { ViewMode } from "./ipc";
import { THIS_PC } from "./ipc";
import { getList } from "./listRegistry";
import { zoomStep } from "./zoom";
import { DENSITY } from "./tokens";
import { useUndo } from "./undo";
import { useLayout } from "../stores/layout";
import { closePaneConfirmed, useUi } from "../stores/ui";
import { useSettings } from "../stores/settings";
import { pickStartIndex, usePreview } from "../stores/preview";
import { typeAheadCycle, typeAheadRematch, typeAheadStep, type TypeAheadMatch } from "./typeAhead";
import { deletePaths } from "./operations";
import { api } from "./ipc";

type Dir = "up" | "down" | "left" | "right";

// ── 首字母跳转（type-ahead）缓冲：无修饰键单字符累积，停顿 DENSITY.typeAheadMs
//    即清空；匹配逻辑在 lib/typeAhead.ts（纯函数，配单测）。缓冲与命中经
//    useUi.typeAhead 回显到活动窗格列表角落的定位 pill ──
let taBuf = "";
let taTimer: number | undefined;
/** 最近一次生效匹配（含生效针/档位）：Tab 循环与 Backspace 重匹配的依据；
 *  无命中为 null（此时 Tab 无集可循环） */
let taMatch: TypeAheadMatch | null = null;

function typeAheadReset(): void {
  taBuf = "";
  taMatch = null;
  if (taTimer !== undefined) {
    clearTimeout(taTimer);
    taTimer = undefined;
  }
  useUi.getState().setTypeAhead(null);
}

/** 供列表组件在硬切换目录（load 上下文变化）时清缓冲：缓冲是模块级会话态，
 *  换目录后旧缓冲继续接续匹配、旧回显 pill 残留到超时（2026-11-27 审查修复） */
export function resetTypeAhead(): void {
  typeAheadReset();
}

function focusNearest(activePaneId: string, dir: Dir): boolean {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-id]"),
  );
  const mine = nodes.find((n) => n.dataset.paneId === activePaneId);
  if (!mine) return false;
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
  if (best) {
    useLayout.getState().setActive(best.id);
    return true;
  }
  return false;
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
  // ── 文本复制让路（2026-11-23 用户需求「预览/关于等界面的文本要支持复制」）：
  //    正文选区在场时 Ctrl+C / Ctrl+X 交还浏览器原生复制，不再路由成列表文件
  //    复制/剪切——快速预览开着时 ui.dialog 不置位、按键会一路落到列表路由，
  //    关于等浮窗对话框（aboutOpen 等独立开关不经模态守卫）同理，文本复制
  //    曾被文件复制劫持；Ctrl+A 在选区所在的文本容器（预览正文 / 对话框内容
  //    面）内全选，替代会选中整页 UI 文字的浏览器全选。node 测试环境无
  //    getSelection：整体跳过，保持原路由 ──
  const selApi =
    typeof window.getSelection === "function" ? window.getSelection() : null;
  if (
    selApi &&
    selApi.type === "Range" &&
    !selApi.isCollapsed &&
    ctrl0 &&
    !e.altKey &&
    !e.shiftKey
  ) {
    const lo = k0.toLowerCase();
    if (lo === "c" || lo === "x") return;
    if (lo === "a") {
      const anchor = selApi.anchorNode;
      const hostEl =
        anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
      const box = hostEl?.closest?.(".np-pv-body, .bp6-dialog-body") ?? null;
      if (box && typeof document.createRange === "function") {
        const rg = document.createRange();
        rg.selectNodeContents(box);
        selApi.removeAllRanges();
        selApi.addRange(rg);
        e.preventDefault();
        return;
      }
    }
  }
  // 右键菜单打开：Esc 关闭（其余键被下方模态守卫拦截）
  if (e.key === "Escape" && useUi.getState().menu) {
    useUi.getState().closeMenu();
    e.preventDefault();
    return;
  }
  // 独立页（右键菜单编辑页 / 全盘搜索页 / 工作日历页，占满顶栏以下整区）：Esc 关闭；
  // 输入框内先失焦（菜单页/日历页语义）/ 由页面自带 onKeyDown 关闭（搜索页两处
  // 输入框均 stopPropagation，不落到这里）。设置已是浮窗 Dialog，Esc 由 Blueprint 处理。
  // 页面上叠着对话框（重置预设确认/设置浮窗）或 Blueprint 弹层（NpSelect 下拉/
  // 条件编辑浮层/预设菜单）时 Esc 只关最上层的它——Blueprint 与此处都会收到
  // 同一事件，若不避开会连页面一起退出
  const pageUi = useUi.getState();
  if (
    e.key === "Escape" &&
    (pageUi.menuPage || pageUi.globalSearch || pageUi.calendarOpen) &&
    !pageUi.dialog &&
    !document.querySelector(".bp6-popover")
  ) {
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      t.blur();
    } else if (pageUi.menuPage) {
      useUi.getState().closeMenuPage();
    } else if (pageUi.calendarOpen) {
      useUi.getState().closeCalendar();
    } else {
      useUi.getState().closeGlobalSearch();
    }
    e.preventDefault();
    return;
  }
  // 模态面（对话框 / 全盘搜索 / 右键菜单 / 菜单编辑页 / 功能库面板）打开：
  // 全局快捷键一律停用——否则 Enter 确认删除会同时 onEnter"打开"被删文件，
  // 方向键会移动背后列表。面板内控件自带按键处理（Blueprint canEscapeKeyClose /
  // 面板 onKeyDown）；功能库面板由 CommandPalette 的 window 捕获监听全权处理
  const ui = useUi.getState();
  if (ui.dialog || ui.globalSearch || ui.menu || ui.menuPage || ui.palette || ui.calendarOpen) return;
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
  //    由 QuickPreviewHost 统一处理），Enter = 用默认程序打开，Esc 关闭。
  //    Space 忽略键盘自动重复（e.repeat）：长按只首次生效一次，不反复开关面板
  //    （Explorer 同款）；↑/↓ 的重复保留——按住连续切换是预期行为 ──
  const pv = usePreview.getState();
  if (pv.queue.length) {
    if (k === " " && !e.repeat) {
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
    // Delete：删除当前预览项并前进（与头部删除钮同语义、同任务引擎——走
    // enqueueDelete 带进度/撤销回执，删后队列前进而非关闭，可连续清点）。
    // 2026-11-27 审查修复：此前该键落到背后列表 list.onDelete，预览对象与
    // 选中集脱节时空选中也能删掉列表条目，且删除不入任务引擎无撤销
    if (k === "Delete") {
      const cur = pv.current();
      if (cur) {
        const confirmDelete = useSettings.getState().confirmDelete;
        e.preventDefault();
        void deletePaths([cur.path], confirmDelete, e.shiftKey).then(() => {
          // 确认流程（若弹）结束后前进：取消确认也前进，预览是浏览流语义
          usePreview.getState().removeCurrent();
        });
        return;
      }
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      k === "ArrowDown" ? pv.next() : pv.prev();
      e.preventDefault();
      return;
    }
    // Ctrl+F：预览内查找（宿主搜索条由 usePreview.searchOpen 驱动聚焦）
    if (ctrl && !e.altKey && lower === "f") {
      pv.setSearchOpen(true);
      e.preventDefault();
      return;
    }
  } else if (k === " " && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const snap = list?.getSnapshot();
    // 队列含文件夹：走文件夹元信息卡（子项数/体积，preview/PreviewBody 路由）。
    // 空选中不开（pickStartIndex 回落 -1）：Quick Look 惯例，杜绝「空选预览
    // 第一项 + Delete 误删首项」的误删链（2026-11-27 实测事故定案）
    const files = snap ? snap.entries : [];
    const start = snap ? pickStartIndex(files, snap.selected) : -1;
    if (files.length && start >= 0) {
      pv.openPreview(files, start);
    }
    e.preventDefault();
    return;
  }

  // ── 定位激活期专用键（2026-11-05 定案，pill 未激活时各键保持原语义）：
  //    Tab / Shift+Tab = 命中集内下一个 / 上一个（沿用产生命中时的生效针与档位）；
  //    Backspace = 回删缓冲末位并重匹配（当前项仍命中则驻留原位只刷统计；
  //    缓冲删空 = 清 pill 收场，本次不触发上级目录）──
  if (
    taBuf &&
    !pv.queue.length &&
    !useUi.getState().swapFrom &&
    !ctrl &&
    !e.altKey &&
    !e.metaKey &&
    (k === "Tab" || k === "Backspace") &&
    list
  ) {
    const snap = list.getSnapshot();
    if (snap.entries.length) {
      if (taTimer !== undefined) clearTimeout(taTimer);
      taTimer = window.setTimeout(typeAheadReset, DENSITY.typeAheadMs);
      const curIdx = snap.entries.findIndex(
        (en) => en.path === snap.selected[snap.selected.length - 1],
      );
      if (k === "Tab") {
        if (taMatch) {
          const r = typeAheadCycle(snap.entries, taMatch, curIdx, e.shiftKey ? -1 : 1);
          if (r) {
            taMatch = r;
            list.revealEntry(snap.entries[r.idx].path);
            useUi.getState().setTypeAhead({
              buf: r.disp,
              hit: snap.entries[r.idx].name,
              pos: r.pos,
              total: r.total,
              needle: r.needle,
              mode: r.mode,
            });
          }
        }
        e.preventDefault();
        return;
      }
      // Backspace 回删
      taBuf = taBuf.slice(0, -1);
      if (!taBuf) {
        typeAheadReset();
        e.preventDefault();
        return;
      }
      const r = typeAheadRematch(snap.entries, taBuf, curIdx);
      if (r) {
        taMatch = r;
        taBuf = r.buf;
        list.revealEntry(snap.entries[r.idx].path);
      } else {
        taMatch = null;
      }
      useUi.getState().setTypeAhead({
        buf: r?.disp ?? taBuf,
        hit: r ? snap.entries[r.idx].name : null,
        pos: r?.pos,
        total: r?.total,
        needle: r?.needle,
        mode: r?.mode,
      });
      e.preventDefault();
      return;
    }
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
      const prevBuf = taBuf;
      taBuf = prevBuf + k.toLowerCase();
      taTimer = window.setTimeout(typeAheadReset, DENSITY.typeAheadMs);
      const curIdx = snap.entries.findIndex(
        (en) => en.path === snap.selected[snap.selected.length - 1],
      );
      // 匹配策略全在纯函数内（前缀/*包含/重复字母循环/拼音中段，TC 语义；配单测）
      const r = typeAheadStep(snap.entries, prevBuf, k, curIdx);
      if (r) {
        taBuf = r.buf;
        taMatch = r;
        list.revealEntry(snap.entries[r.idx].path);
      } else {
        taMatch = null;
      }
      useUi
        .getState()
        .setTypeAhead({
          // 无命中显示完整输入缓冲；命中显示生效匹配针 + 序位/总数
          buf: r?.disp ?? taBuf,
          hit: r ? snap.entries[r.idx].name : null,
          pos: r?.pos,
          total: r?.total,
          needle: r?.needle,
          mode: r?.mode,
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
    const moved = focusNearest(activePaneId, k.slice(5).toLowerCase() as Dir);
    if (!moved) {
      // Explorer 兼容退化（2026-11-25 规范化）：唯一窗格 / 该方向无邻居窗格时，
      // Alt+← = 后退、Alt+→ = 前进、Alt+↑ = 上级目录（Win11 Alt+↑ 惯例）——
      // 多窗格下方向键仍优先切焦点（Q-Dir 核心），不受影响
      if (tabId) {
        if (k === "ArrowLeft") usePanes.getState().back(tabId);
        else if (k === "ArrowRight") usePanes.getState().forward(tabId);
        else if (k === "ArrowUp") list?.onBackspace();
      }
      e.preventDefault();
      return;
    }
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
  // Alt+D（Explorer 惯例）/ Ctrl+L（浏览器惯例，2026-11-25 规范化补齐）：聚焦地址栏
  if ((e.altKey && lower === "d") || (ctrl && !e.altKey && !e.shiftKey && lower === "l")) {
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
  // F3：循环切换活动窗格视图（详细信息 → 列表 → 缩略图，2026-11-25 加 grid）
  if (k === "F3" && pane && tabId) {
    const order: ViewMode[] = ["details", "list", "grid"];
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
