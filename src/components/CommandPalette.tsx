// 功能库快速命令面板（2026-11-11 方案 C「贴身轻浮窗」定稿，design/palette-c.html）：
// 右键菜单「功能库…」唤起，吸附右键菜单锚位（无全屏遮罩，点击面板外即关）。
// 搜索跨全库（名称/说明/分组，空格分词 AND），↑↓ 选择 / Enter 执行 / Esc 关闭；
// 执行经 listRegistry.builtinMenuItem 与右键菜单同一执行器——右键现场（选中
// 条目/触发窗格列表上下文）随闭包传入功能。面板纯逻辑（过滤/可用性/定位钳制）
// 在 lib/palette.ts 配 vitest。
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { useUi } from "../stores/ui";
import { getList } from "../lib/listRegistry";
import {
  clampPalettePos,
  filterPalette,
  paletteItems,
  type PaletteItem,
} from "../lib/palette";
import { DENSITY } from "../lib/tokens";
import { t } from "../lib/i18n";
import { AppIcon } from "./AppIcon";

/** 面板定宽（2026-11-12 用户反馈两轮收窄 440→380→340）；行数上限与高度估算供定位钳制（启发式，与右键
 *  菜单 DENSITY.menuClampW 同口径——组件未量测前先用常量落位） */
const PANEL_W = 340;
const ROWS_MAX = 10;
/** 搜索行 + 底栏 + 内边距的chrome 高度估算 */
const CHROME_H = 74;

/** 名称命中高亮（首个命中词包 mark）：返回三段，mid 非空即有命中 */
function hlRange(text: string, query: string): [string, string, string] {
  const term = query.trim().toLowerCase().split(/\s+/)[0];
  if (!term) return [text, "", ""];
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return [text, "", ""];
  return [text.slice(0, i), text.slice(i, i + term.length), text.slice(i + term.length)];
}

export function CommandPalette() {
  const palette = useUi((s) => s.palette);
  const close = useUi((s) => s.closePalette);
  const [query, setQuery] = useState("");
  const [cur, setCur] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // window 捕获键盘监读取的最新态（面板开合/过滤都重渲染，闭包取 ref 防过期）
  const stateRef = useRef({ cur, items: [] as PaletteItem[] });
  const sel = palette?.sel ?? [];

  const items = useMemo(
    () =>
      palette
        ? filterPalette(
            // 搜索针以译名重建（i18n）：EN 语言下英文关键词可搜
            paletteItems(palette.sel).map((it) => ({
              ...it,
              search: `${t(it.fn.label)}${t(it.fn.desc)}${t(it.fn.group)}`.toLowerCase(),
            })),
            query,
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palette, query],
  );
  stateRef.current.items = items;
  stateRef.current.cur = cur;

  // 每次唤起重置搜索与选择，搜索框抢焦点（主窗已聚焦，单次即可）
  useEffect(() => {
    if (!palette) return;
    setQuery("");
    setCur(0);
    inputRef.current?.focus();
  }, [palette]);

  // 执行：与右键菜单同一执行器（listRegistry 闭包持有触发窗格列表上下文）；
  // available=false 或执行器缺位（列表已卸载）一律不动作
  const exec = (it: PaletteItem) => {
    if (!palette || !it.available) return;
    const mi = getList(palette.tabId)?.builtinMenuItem?.(it.fn.key, palette.sel);
    if (!mi) return;
    close();
    mi.action?.();
  };

  // 键盘：window 捕获全权接管（keyboard.ts 模态守卫遇 ui.palette 直接停用，
  // 双保险不重复处理）；↑↓ 循环、Enter 执行当前、Esc 关闭
  useEffect(() => {
    if (!palette) return;
    const onKey = (e: KeyboardEvent) => {
      const st = stateRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setCur(st.items.length ? (st.cur + 1) % st.items.length : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCur(st.items.length ? (st.cur - 1 + st.items.length) % st.items.length : 0);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = st.items[st.cur];
        if (it) exec(it);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette, close]);

  // 点击面板外即关（mousedown 捕获，无遮罩——方案 C 保持右键操作流连续）
  useEffect(() => {
    if (!palette) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [palette, close]);

  // 吸附定位钳制（右/下溢出回推；高度按行数估算，行数钳 ROWS_MAX）
  const pos = useMemo(() => {
    if (!palette) return null;
    const h =
      CHROME_H + Math.min(Math.max(items.length, 1), ROWS_MAX) * DENSITY.rowH;
    return clampPalettePos(palette.x, palette.y, PANEL_W, h, window.innerWidth, window.innerHeight);
  }, [palette, items.length]);

  if (!palette || !pos) return null;

  return (
    <div
      ref={rootRef}
      className="np-palette"
      style={{ left: pos.x, top: pos.y, width: PANEL_W }}
    >
      <div className="np-palette-search">
        <AppIcon icon={Search} />
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          placeholder={t("搜索功能，回车直接执行…")}
          onChange={(e) => {
            setQuery(e.target.value);
            setCur(0);
          }}
        />
      </div>
      <div className="np-palette-rows">
        {items.length === 0 ? (
          <div className="np-palette-empty">{t("没有匹配的功能")}</div>
        ) : (
          items.map((it, i) => {
            const label = t(it.fn.label);
            const [pre, mid, post] = hlRange(label, query);
            return (
              <div
                key={it.fn.key}
                className={`np-palette-row ${i === cur ? "is-on" : ""} ${
                  it.available ? "" : "is-off"
                }`}
                data-tip={it.available ? undefined : t("当前选中项不满足此功能的条件")}
                onMouseEnter={() => setCur(i)}
                onClick={() => exec(it)}
              >
                <AppIcon icon={it.fn.icon} />
                <span className="np-palette-name">
                  {pre}
                  {mid && <mark>{mid}</mark>}
                  {post}
                </span>
                <span className="np-palette-group">{t(it.fn.group)}</span>
              </div>
            );
          })
        )}
      </div>
      <div className="np-palette-foot">
        <span className="np-palette-chip">
          {sel.length > 0
            ? sel.length === 1
              ? sel[0].name
              : `${sel[0].name} +${sel.length - 1}`
            : t("未选中")}
        </span>
        <span className="np-palette-keys">
          <kbd className="np-kbd">↑↓</kbd>
          {t("选择")}
          <i>·</i>
          <kbd className="np-kbd">Enter</kbd>
          {t("执行")}
          <i>·</i>
          <kbd className="np-kbd">Esc</kbd>
          {t("关闭")}
        </span>
      </div>
    </div>
  );
}
