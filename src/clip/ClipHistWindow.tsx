// 剪贴板历史浮窗（§3.7，Ditto 式）：自绘顶栏（标题 + 置顶/最小化/最大化/
// 关闭 + 拖动）+ 搜索框 + 类型段选 + 虚拟列表 + 状态行。数据过滤/分页全在
// Rust 端（铁律 3），列表只渲染可见行（铁律 1，TanStack Virtual 动态行高——
// 预览自适应最多 3 行）。键盘：↑↓ 选择 / Enter 直接粘贴 / Ctrl+Enter 仅复制
// / Ctrl+P 置顶 / Del 删除 / Esc 关闭（有搜索词先清空）。窗口显隐与失焦
// 自动收由 Rust 管理；本页经窗口 focus 事件感知「被呼出」→ 刷新并聚焦。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ClipboardList,
  Copy,
  Minus,
  Pin,
  PinOff,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { api, type ClipHistItem, type Settings } from "../lib/ipc";
import { clipKindMeta } from "../lib/cliphist";
import { AppIcon } from "../components/AppIcon";
import { initTooltip } from "../lib/tooltip";
import { DENSITY } from "../lib/tokens";

const PAGE = 50;
const ROW_H = DENSITY.rowH;

const KIND_TABS: { v: string; l: string }[] = [
  { v: "", l: "全部" },
  { v: "text", l: "文本" },
  { v: "image", l: "图片" },
  { v: "files", l: "文件" },
  { v: "dirs", l: "文件夹" },
];

export function ClipHistWindow() {
  const [items, setItems] = useState<ClipHistItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [sel, setSel] = useState(0);
  const [flash, setFlash] = useState("");
  const [directPaste, setDirectPaste] = useState(true);
  /** 浮窗置顶常驻（会话级）：失焦不自动收窗，Enter 转为仅复制不关窗（连续取用） */
  const [winPinned, setWinPinned] = useState(false);
  /** 浮窗最大化（顶栏钮/双击顶栏，Rust 侧手动工作区方案；重开后复位） */
  const [isMaxed, setIsMaxed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 装载协程防乱序：仅最后一次发起的请求可落盘（搜索防抖/翻页竞态）
  const loadKey = useRef("");
  const busy = useRef(false);
  const loadedCount = useRef(0);
  const hasMore = useRef(false);
  // 下次刷新要保持选择的条目 id（置顶/删除后选择不跳回首行）
  const keepId = useRef<number | null>(null);
  // 键盘/事件处理器读取的最新态（避免重绑 window 监听、闭包过期）
  const stateRef = useRef({ items, sel, query, kind, directPaste, winPinned, isMaxed });
  stateRef.current = { items, sel, query, kind, directPaste, winPinned, isMaxed };

  const fetchPage = useCallback(
    async (offset: number, append: boolean, keep: number | null) => {
      const { query: q, kind: k, items: cur } = stateRef.current;
      const key = `${q}|${k}|${offset}|${append}`;
      loadKey.current = key;
      busy.current = true;
      try {
        const page = await api.cliphistList(q, k, offset, PAGE);
        if (loadKey.current !== key) return;
        const list = append ? [...cur, ...page.items] : page.items;
        setItems(list);
        setTotal(page.total);
        loadedCount.current = offset + page.items.length;
        hasMore.current = loadedCount.current < page.total;
        if (keep != null) {
          const i = list.findIndex((x) => x.id === keep);
          setSel(i >= 0 ? i : 0);
        } else {
          setSel(0);
        }
      } catch {
        // 查询失败静默：保留现有列表（空态兜底）
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  /** 搜索词/类型变更（120ms 防抖）与初次挂载都走这里 */
  useEffect(() => {
    const t = window.setTimeout(() => void fetchPage(0, false, null), 120);
    return () => window.clearTimeout(t);
  }, [query, kind, fetchPage]);

  // 挂载一次性接线：偏好（直接粘贴 + 深浅色，轻量窗不走 settings store）、
  // cliphist-updated 事件（聚焦中才刷新）、窗口 focus（= Rust 呼出）刷新+聚焦
  useEffect(() => {
    const offs: (() => void)[] = [initTooltip()];
    const applyTheme = (theme: Settings["theme"]) => {
      const dark =
        theme === "dark" ||
        (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("bp6-dark", dark);
    };
    const onScheme = () => applyTheme("system");
    void api
      .getSettings()
      .then((st) => {
        setDirectPaste(st?.cliphistDirectPaste ?? true);
        const theme = st?.theme ?? "system";
        applyTheme(theme);
        if (theme === "system") {
          window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onScheme);
        }
      })
      .catch(() => undefined);
    let unlistenEv: (() => void) | undefined;
    void listen("cliphist-updated", () => {
      if (!document.hasFocus()) return;
      // 置顶/删除预登记的保持选择优先，否则维持当前选择条目
      const keep =
        keepId.current ?? stateRef.current.items[stateRef.current.sel]?.id ?? null;
      keepId.current = null;
      void fetchPage(0, false, keep);
    }).then((f) => {
      unlistenEv = f;
    });
    let unFocus: (() => void) | undefined;
    const focusSearch = () => {
      // WebView2 激活序列会在原生焦点落定后把 activeElement 重置为 body：
      // 单次延迟聚焦在「页面首次被激活」时仍会被冲掉（2026-10-31 E2E 实测），
      // 120/350/700ms 三重试兜底覆盖激活完成时刻，幂等无害
      [120, 350, 700].forEach((ms) => {
        window.setTimeout(() => {
          if (document.activeElement !== inputRef.current) {
            inputRef.current?.focus();
            inputRef.current?.select();
          }
        }, ms);
      });
    };
    // DOM focus 兜底：capabilities 修复后 tauri://focus 为主，浏览器焦点事件
    // 双保险（停靠态窗口常驻可见，部分环境只触发其中之一）
    window.addEventListener("focus", focusSearch);
    // 焦点自卫（2026-10-31 终案）：冷启动首次激活时 WebView2 激活序列可能在
    // 事件 + 三重试之后仍重置 activeElement——低频守卫接管，本页持有焦点且
    // 焦点悬在 body（未被按钮等接住）时归还搜索框；停靠态 hasFocus=false 自空转
    const focusGuard = window.setInterval(() => {
      if (document.hasFocus() && document.activeElement === document.body) {
        inputRef.current?.focus();
      }
    }, 400);
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        keepId.current = null;
        // 重开（呼出）时 Rust 已复位默认尺寸，最大化图标同步归零
        setIsMaxed(false);
        void fetchPage(0, false, null);
        focusSearch();
      })
      .then((f) => {
        unFocus = f;
      });
    return () => {
      offs.forEach((f) => f());
      unlistenEv?.();
      unFocus?.();
      window.clearInterval(focusGuard);
      window.removeEventListener("focus", focusSearch);
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .removeEventListener("change", onScheme);
    };
  }, [fetchPage]);

  const flashMsg = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(""), 2500);
  }, []);

  /** 写回：direct = 直接粘贴（Ctrl 修饰、设置关闭或浮窗常驻 = 仅复制）。
   *  常驻态下目标窗口已随交互漂移、自动粘贴语义不再可靠，且关窗违背常驻
   *  初衷——一律仅复制 + 页脚回执，用户手动 Ctrl+V（Rust 侧同判不关窗） */
  const pasteItem = useCallback(
    (item: ClipHistItem, ctrl: boolean) => {
      const { directPaste: dp, winPinned: pinned } = stateRef.current;
      const direct = dp && !ctrl && !pinned;
      api
        .cliphistWriteBack(item.id, direct)
        .then((pasted) => {
          if (pinned) {
            flashMsg("已复制到剪贴板");
          } else if (direct && !pasted) {
            flashMsg("已复制到剪贴板（未能自动粘贴，请手动 Ctrl+V）");
          }
        })
        .catch((e) => flashMsg(`复制失败：${String(e)}`));
    },
    [flashMsg],
  );

  /** 浮窗置顶常驻开关：置位 Rust 侧失焦豁免 + 本页回写语义切换 */
  const togglePinWindow = useCallback(() => {
    const next = !stateRef.current.winPinned;
    setWinPinned(next);
    void api.cliphistSetPinned(next).catch(() => undefined);
  }, []);

  /** 顶栏窗口钮：最小化/关闭都为收起（浮窗常驻停靠态、任务栏无入口，系统
   *  最小化会失联）；最大化 = Rust 手动撑满工作区（规避与停靠位互作） */
  const hideWindow = useCallback(() => {
    void api.cliphistHide().catch(() => undefined);
  }, []);

  const toggleMax = useCallback(() => {
    const next = !stateRef.current.isMaxed;
    setIsMaxed(next);
    void api.cliphistSetMaximized(next).catch(() => undefined);
  }, []);

  const pinItem = useCallback((item: ClipHistItem) => {
    keepId.current = item.id;
    void api.cliphistSetPin(item.id, !item.pinned).catch(() => undefined);
  }, []);

  const delItem = useCallback((item: ClipHistItem) => {
    const { items: list } = stateRef.current;
    const idx = list.findIndex((x) => x.id === item.id);
    // 删除后保持选择落在相邻条目上
    keepId.current = list[idx + 1]?.id ?? list[idx - 1]?.id ?? null;
    void api.cliphistDelete(item.id).catch(() => undefined);
  }, []);

  /** 清空全部未置顶条目：两段式确认（首击布防 3 秒，再击执行——轻量窗无
   *  confirmDialog 基建，且清空影响面大需要防误触） */
  const [clearArmed, setClearArmed] = useState(false);
  const onClear = useCallback(() => {
    if (!clearArmed) {
      setClearArmed(true);
      window.setTimeout(() => setClearArmed(false), 3000);
      return;
    }
    setClearArmed(false);
    keepId.current = null;
    void api.cliphistClear().catch(() => undefined);
  }, [clearArmed]);

  // 行高动态（预览自适应最多 3 行）：estimateSize 给单行基线，实际由
  // measureElement 量测；getItemKey 以条目 id 缓存尺寸，刷新不串行高
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  const goTo = useCallback(
    (idx: number) => {
      // 视口内不动（auto），出视口才滚动跟随
      virtualizer.scrollToIndex(idx, { align: "auto" });
    },
    [virtualizer],
  );

  // 全局键盘（捕获）：浮窗是独立窗口，keydown 直接在 window 上接
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // IME 组合输入中不接管：Enter=提交候选、Esc=取消组合（截图文字工具
      // 同口径；合成键在中文输入法下 key 呈 "Process"，天然不命中各分支）
      if (e.isComposing || e.keyCode === 229) return;
      // 聚焦兜底：冷启动首次激活时三重试仍可能被 WebView2 激活序列冲掉——
      // 可打印字符落键到 body 时夺回输入焦点，并把该字符补进搜索词（免丢键）
      if (
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        document.activeElement !== inputRef.current
      ) {
        inputRef.current?.focus();
        setQuery((q) => q + e.key);
        return;
      }
      const { items: list, sel: i, query: q } = stateRef.current;
      const cur = list[i];
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const next =
            e.key === "ArrowDown" ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
          setSel(next);
          goTo(next);
          break;
        }
        case "Enter":
          if (cur) {
            e.preventDefault();
            pasteItem(cur, e.ctrlKey);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (q) {
            setQuery("");
            inputRef.current?.focus();
          } else {
            void api.cliphistHide().catch(() => undefined);
          }
          break;
        case "p":
        case "P":
          if (e.ctrlKey && cur) {
            e.preventDefault();
            pinItem(cur);
          }
          break;
        case "Delete":
          // 输入框聚焦时 Del 属于编辑键，不删条目
          if (document.activeElement === inputRef.current) break;
          if (cur) {
            e.preventDefault();
            delItem(cur);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pasteItem, pinItem, delItem, goTo]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || busy.current || !hasMore.current) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 4) {
      void fetchPage(loadedCount.current, true, null);
    }
  }, [fetchPage]);

  return (
    <div className="np-clip">
      {/* 自绘顶栏：拖动区（data-tauri-drag-region，双击 = 最大化/还原）+
          窗口四钮（置顶常驻/最小化/最大化/关闭，np-winbtn 统一配方） */}
      <header
        className="np-cliptb"
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          toggleMax();
        }}
      >
        <span className="np-cliptb-title" data-tauri-drag-region>
          <AppIcon icon={ClipboardList} size={DENSITY.iconSm} />
          剪贴板
        </span>
        <button
          className={`np-winbtn ${winPinned ? "is-on" : ""}`}
          data-tip={
            winPinned
              ? "浮窗常驻：开（点击恢复失焦自动关闭）"
              : "浮窗常驻：关（点击常驻屏幕，失焦不自动关闭，Enter 转为仅复制）"
          }
          aria-label="浮窗常驻开关"
          onClick={togglePinWindow}
        >
          <AppIcon icon={winPinned ? PinOff : Pin} size={DENSITY.iconSm} />
        </button>
        <button
          className="np-winbtn"
          data-tip="最小化（收起浮窗，热键再唤）"
          onClick={hideWindow}
        >
          <AppIcon icon={Minus} size={DENSITY.iconSm} />
        </button>
        <button
          className="np-winbtn"
          data-tip={isMaxed ? "还原" : "最大化（撑满当前屏幕）"}
          onClick={toggleMax}
        >
          <AppIcon icon={isMaxed ? Copy : Square} size={DENSITY.iconSm} />
        </button>
        <button className="np-winbtn np-winbtn-close" data-tip="关闭（收起浮窗）" onClick={hideWindow}>
          <AppIcon icon={X} size={DENSITY.iconSm} />
        </button>
      </header>
      <div className="np-clip-head">
        <div className="np-clip-searchrow">
          <AppIcon icon={Search} size={DENSITY.iconSm} />
          <input
            ref={inputRef}
            className="np-clip-search"
            value={query}
            spellCheck={false}
            placeholder="搜索剪贴板历史（文本与文件路径）"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="np-clip-seg">
          {KIND_TABS.map((t) => (
            <button key={t.v} className={kind === t.v ? "is-on" : ""} onClick={() => setKind(t.v)}>
              {t.l}
            </button>
          ))}
        </div>
      </div>
      <div ref={scrollRef} className="np-clip-list" onScroll={onScroll}>
        {items.length === 0 ? (
          <div className="np-clip-empty">
            {query ? "没有匹配的条目" : "暂无剪贴板历史——复制点什么试试"}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const it = items[vi.index];
              return (
                <div
                  key={it.id}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  className={`np-clip-row ${vi.index % 2 === 1 ? "is-alt" : ""} ${
                    vi.index === sel ? "is-sel" : ""
                  }`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                  onClick={(e) => pasteItem(it, e.ctrlKey)}
                >
                  <span className="np-clip-idx">{vi.index + 1}</span>
                  {/* 类型图标（2026-10-31 用户终案）：纯灰线性，无底板无角标，
                      类型信息由 meta 文字标签承载 */}
                  <span className="np-clip-kind">
                    <AppIcon icon={clipKindMeta(it.kind).icon} size={DENSITY.iconSm} />
                  </span>
                  {it.thumb ? <img className="np-clip-thumb" src={it.thumb} alt="" /> : null}
                  <span className="np-clip-preview">{it.preview}</span>
                  {it.pinned && (
                    <span className="np-clip-pinmark" data-tip="已置顶">
                      <AppIcon icon={Pin} size={DENSITY.iconXs} />
                    </span>
                  )}
                  {/* 右侧固定宽操作列：meta 与悬停动作钮列内切换（不跳宽） */}
                  <span className="np-clip-right">
                    <span className="np-clip-meta">{clipKindMeta(it.kind).label}</span>
                    <span className="np-clip-actions">
                      <button
                        data-tip={it.pinned ? "取消置顶" : "置顶（豁免清理）"}
                        onClick={(e) => {
                          e.stopPropagation();
                          pinItem(it);
                        }}
                      >
                        <AppIcon icon={it.pinned ? PinOff : Pin} size={DENSITY.iconXs} />
                      </button>
                      <button
                        className="np-clip-del"
                        data-tip="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          delItem(it);
                        }}
                      >
                        <AppIcon icon={Trash2} size={DENSITY.iconXs} />
                      </button>
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="np-clip-foot">
        {flash || (
          <>
            共 {total} 条
            <button
              className="np-clip-clear"
              data-tip="清空全部未置顶条目（两击确认）"
              onClick={onClear}
            >
              <AppIcon icon={Trash2} size={DENSITY.iconXs} />
              {clearArmed ? "确认清空？" : "清空"}
            </button>
            <span className="np-clip-keys">
              {winPinned ? (
                <>
                  <kbd className="np-kbd">Enter</kbd> 复制（常驻中）
                </>
              ) : (
                <>
                  <kbd className="np-kbd">Enter</kbd> 粘贴
                  <kbd className="np-kbd">Ctrl+Enter</kbd> 仅复制
                </>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
