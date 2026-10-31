// 剪贴板历史浮窗（§3.7，Ditto 式）：搜索框 + 类型段选 + 虚拟列表 + 状态行。
// 数据过滤/分页全在 Rust 端（铁律 3），列表只渲染可见行（铁律 1，TanStack
// Virtual）。键盘：↑↓ 选择 / Enter 直接粘贴 / Ctrl+Enter 仅复制 / Ctrl+P
// 置顶 / Del 删除 / Esc 关闭（有搜索词先清空）。窗口显隐与失焦自动收由
// Rust 管理；本页经窗口 focus 事件感知「被呼出」→ 刷新列表并聚焦搜索框。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pin, PinOff, Search, Trash2 } from "lucide-react";

import { api, type ClipHistItem, type Settings } from "../lib/ipc";
import { clipKindMeta, formatSize, relTime } from "../lib/cliphist";
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
];

export function ClipHistWindow() {
  const [items, setItems] = useState<ClipHistItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [sel, setSel] = useState(0);
  const [flash, setFlash] = useState("");
  const [directPaste, setDirectPaste] = useState(true);
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
  const stateRef = useRef({ items, sel, query, kind, directPaste });
  stateRef.current = { items, sel, query, kind, directPaste };

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
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        keepId.current = null;
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

  /** 写回：direct = 直接粘贴（Ctrl 修饰或设置关闭 = 仅复制）。粘贴失败时
   *  Rust 保持浮窗打开，此处提示降级 */
  const pasteItem = useCallback(
    (item: ClipHistItem, ctrl: boolean) => {
      const direct = stateRef.current.directPaste && !ctrl;
      api
        .cliphistWriteBack(item.id, direct)
        .then((pasted) => {
          if (direct && !pasted) {
            flashMsg("已复制到剪贴板（未能自动粘贴，请手动 Ctrl+V）");
          }
        })
        .catch((e) => flashMsg(`复制失败：${String(e)}`));
    },
    [flashMsg],
  );

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

  const goTo = useCallback((idx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = idx * ROW_H;
    // 视口边缘外才滚动（半屏跟随），避免每按一次都抖动
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - Math.floor(el.clientHeight / 2)) });
    }
  }, []);

  // 全局键盘（捕获）：浮窗是独立窗口，keydown 直接在 window 上接
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // IME 组合输入中不接管：Enter=提交候选、Esc=取消组合（截图文字工具
      // 同口径；合成键在中文输入法下 key 呈 "Process"，天然不命中各分支）
      if (e.isComposing || e.keyCode === 229) return;
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

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || busy.current || !hasMore.current) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 4) {
      void fetchPage(loadedCount.current, true, null);
    }
  }, [fetchPage]);

  return (
    <div className="np-clip">
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
                  className={`np-clip-row ${vi.index === sel ? "is-sel" : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: ROW_H,
                    transform: `translateY(${vi.start}px)`,
                  }}
                  onClick={(e) => pasteItem(it, e.ctrlKey)}
                >
                  {it.thumb ? (
                    <img className="np-clip-thumb" src={it.thumb} alt="" />
                  ) : (
                    <AppIcon icon={clipKindMeta(it.kind).icon} size={DENSITY.iconMd} />
                  )}
                  <span className="np-clip-preview">{it.preview}</span>
                  {it.pinned && <span className="np-clip-pinmark" data-tip="已置顶" />}
                  <span className="np-clip-meta">
                    {relTime(it.createdAt)} · {formatSize(it.size)}
                  </span>
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
                      data-tip="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        delItem(it);
                      }}
                    >
                      <AppIcon icon={Trash2} size={DENSITY.iconXs} />
                    </button>
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
              <kbd className="np-kbd">Enter</kbd> 粘贴
              <kbd className="np-kbd">Ctrl+Enter</kbd> 仅复制
            </span>
          </>
        )}
      </div>
    </div>
  );
}
