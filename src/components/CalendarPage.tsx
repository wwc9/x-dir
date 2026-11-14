// 工作日历整页（2026-11-13 新功能；2026-11-13 增强批：搜索 / 任务分类 /
// 拖拽改期 / 条目右键轻菜单 / Ctrl-C·V·Delete 键盘补全 / 年视图热力图 /
// 定期任务入口）。占满顶栏以下区域（np-menupage 壳，与定制页/全盘搜索页
// 同构，整页互斥）。左 = 月视图（首行单行收纳 日期+农历/节日+班休徽标，
// 条目摘要 ≤2 行带状态竖条）或年视图热力图；右 = 当日条目编辑面板。
// 数据在 Rust 端 config/worklog.json（铁律 3：按月下发，前端不囤全量）。
// 键盘：方向键移格 / Enter 新增 / T 今天 / PgUp PgDn 翻月 / Ctrl-C·V 跨日
// 复制粘贴 / Delete 删除选中条目。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, InputGroup } from "@blueprintjs/core";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  X,
} from "lucide-react";

import { useSettings } from "../stores/settings";
import { useUi, type MenuItem } from "../stores/ui";
import { t, useT } from "../lib/i18n";
import { api, type WorkEntry, type WorklogHit } from "../lib/ipc";
import {
  dateKey,
  dayKind,
  holidayOf,
  lunarLine,
  lunarSubtitle,
  monthMatrix,
  parseKey,
  WEEK_ZH,
  type SubTag,
  type Worklog,
} from "../lib/calendar";
import { AppIcon, ic } from "./AppIcon";
import { Seg } from "./ImgDialogs";
import { NpSelect } from "./NpSelect";
import { DENSITY } from "../lib/tokens";

const TODAY = new Date();
const TODAY_KEY = dateKey(TODAY.getFullYear(), TODAY.getMonth() + 1, TODAY.getDate());

const STATUS_ORDER = ["todo", "doing", "done"] as const;

/** 日期单元格用真实日期（首尾行的越界 d 由 Date 自动翻月），统一以真实键存取 */
function realDate(cell: { y: number; m: number; d: number }): {
  ry: number;
  rm: number;
  rd: number;
  key: string;
} {
  const dt = new Date(cell.y, cell.m - 1, cell.d);
  const ry = dt.getFullYear();
  const rm = dt.getMonth() + 1;
  const rd = dt.getDate();
  return { ry, rm, rd, key: dateKey(ry, rm, rd) };
}

/** 搜索命中高亮：大小写不敏感切分，命中段加粗 */
function highlightText(text: string, query: string): Array<{ t: string; hit: boolean }> {
  const q = query.trim();
  if (!q) return [{ t: text, hit: false }];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  const out: Array<{ t: string; hit: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: text.slice(last, i), hit: false });
    out.push({ t: text.slice(i, i + m[0].length), hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), hit: false });
  return out;
}

export function CalendarPage() {
  const t = useT();
  const showLunar = useSettings((s) => s.calendarShowLunar);
  const categories = useSettings((s) => s.calendarCategories);
  const colorBy = useSettings((s) => s.calendarColorBy);
  const [view, setView] = useState<"month" | "year">("month");
  const [y, setY] = useState(TODAY.getFullYear());
  const [m, setM] = useState(TODAY.getMonth() + 1);
  const [sel, setSel] = useState(TODAY_KEY);
  const [worklog, setWorklog] = useState<Worklog>({});
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [selEntry, setSelEntry] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<WorklogHit[] | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  // 连续滚动式月视图（2026-11-14 用户定案）：月份窗口随滚动双向扩展，
  // 页头年月为按钮（智能跳转面板：年份网格 + 12 月网格直达任意年月）
  const [months, setMonths] = useState<Array<[number, number]>>(() => {
    const arr: Array<[number, number]> = [];
    const base = new Date(TODAY.getFullYear(), TODAY.getMonth() - 2, 1);
    for (let i = 0; i < 5; i++) {
      const dt = new Date(base.getFullYear(), base.getMonth() + i, 1);
      arr.push([dt.getFullYear(), dt.getMonth() + 1]);
    }
    return arr;
  });
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpYear, setJumpYear] = useState(TODAY.getFullYear());
  const scrollRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef<Set<string>>(new Set());
  const pendingScrollRef = useRef<string | null>(null);
  const prevFirstRef = useRef<string | null>(null);
  const headCutRef = useRef(0);
  const growGuardRef = useRef(0);
  const dragRef = useRef<{ from: string; index: number } | null>(null);
  const dayClipboard = useRef<WorkEntry[] | null>(null);
  const worklogRef = useRef<Worklog>({});
  const pendingRef = useRef<Map<string, WorkEntry[]>>(new Map());
  const saveTimer = useRef<number | undefined>(undefined);
  const lastEntryRef = useRef<HTMLTextAreaElement | null>(null);
  worklogRef.current = worklog;
  const monthsRef = useRef(months);
  monthsRef.current = months;

  const statusLabel = useMemo(
    () => ({
      todo: t("待办"),
      doing: t("执行中"),
      done: t("已完成"),
    }),
    [t],
  );
  /** 全量冲刷未落盘修改（翻月/卸载前调用，防串月丢更新） */
  const flushAll = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const pending = pendingRef.current;
    pendingRef.current = new Map();
    for (const [key, entries] of pending) {
      void api.worklogSetDay(key, entries).catch(() => {
        useUi.getState().toast(t("工作记录保存失败：{k}", { k: key }), "error");
      });
    }
  }, [t]);

  // 数据拉取：月视图 = 滚动窗口内逐月按需拉取（每 (年,月) 一次）；
  // 年视图 = 全年 12 个月。窗口变化前先冲刷未落盘修改。
  useEffect(() => {
    flushAll();
    if (view !== "month") {
      let alive = true;
      void Promise.all(
        Array.from({ length: 12 }, (_, i) => api.worklogGetMonth(y, i + 1).catch(() => [])),
      ).then((rows) => {
        if (!alive) return;
        setWorklog((prev) => {
          const next = { ...prev };
          for (const days of rows) for (const d of days) next[d.date] = d.entries;
          return next;
        });
      });
      return () => {
        alive = false;
      };
    }
    for (const [yy, mm] of months) {
      const k = `${yy}-${mm}`;
      if (fetchedRef.current.has(k)) continue;
      fetchedRef.current.add(k);
      void api
        .worklogGetMonth(yy, mm)
        .then((days) => {
          setWorklog((prev) => {
            const next = { ...prev };
            for (const d of days) next[d.date] = d.entries;
            return next;
          });
        })
        .catch(() => undefined);
    }
  }, [view, y, months, flushAll]);

  // 卸载兜底冲刷
  useEffect(() => () => flushAll(), [flushAll]);

  // 搜索（250ms 防抖；空查询收起结果）
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void api
        .worklogSearch(q)
        .then((rs) => setHits(rs))
        .catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  /** 改某日条目：本地态即时 + 800ms 防抖批量落盘（空清单 = 删日） */
  const mutate = useCallback(
    (key: string, entries: WorkEntry[]) => {
      setWorklog((prev) => {
        const next = { ...prev };
        if (entries.length) next[key] = entries;
        else delete next[key];
        return next;
      });
      pendingRef.current.set(key, entries);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        const pending = pendingRef.current;
        pendingRef.current = new Map();
        let failed = false;
        for (const [k, list] of pending) {
          void api.worklogSetDay(k, list).catch(() => {
            failed = true;
          });
        }
        const now = new Date();
        setSavedAt(
          failed
            ? null
            : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
        );
        if (failed) useUi.getState().toast(t("工作记录保存失败"), "error");
      }, 800);
    },
    [t],
  );

  // ── 连续滚动窗口操作 ──
  const MONTH_CAP = 15;
  const prevYM = ([a, b]: [number, number]): [number, number] => (b === 1 ? [a - 1, 12] : [a, b - 1]);
  const nextYM = ([a, b]: [number, number]): [number, number] => (b === 12 ? [a + 1, 1] : [a, b + 1]);

  /** 确保月已入窗；未在窗时重置窗口并以目标月为中心、滚动静待落位 */
  const ensureMonth = useCallback((yy: number, mm: number) => {
    setMonths((prev) => {
      if (prev.some(([a, b]) => a === yy && b === mm)) return prev;
      const arr: Array<[number, number]> = [];
      const base = new Date(yy, mm - 3, 1);
      for (let i = 0; i < 5; i++) {
        const dt = new Date(base.getFullYear(), base.getMonth() + i, 1);
        arr.push([dt.getFullYear(), dt.getMonth() + 1]);
      }
      pendingScrollRef.current = `${yy}-${mm}`;
      return arr;
    });
  }, []);

  /** 窗口向头部扩展 n 个月（超上限裁尾——尾部裁剪不影响头部滚动位置） */
  const growHead = useCallback((n: number) => {
    const arr = [...monthsRef.current];
    for (let i = 0; i < n; i++) arr.unshift(prevYM(arr[0]));
    while (arr.length > MONTH_CAP) arr.pop();
    if (arr[0][0] !== monthsRef.current[0][0] || arr[0][1] !== monthsRef.current[0][1]) {
      setMonths(arr);
    }
  }, []);

  /** 窗口向尾部扩展 n 个月（超上限裁头——裁剪块数记账，布局效应补偿滚动位置） */
  const growTail = useCallback((n: number) => {
    const arr = [...monthsRef.current];
    for (let i = 0; i < n; i++) arr.push(nextYM(arr[arr.length - 1]));
    const cut = arr.length - MONTH_CAP;
    if (cut > 0) {
      arr.splice(0, cut);
      headCutRef.current += cut;
    }
    setMonths(arr);
  }, []);

  /** 滚动：近两端扩窗 + 焦点月跟踪（视口中心所在月驱动页头标签） */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const now = Date.now();
    if (now - growGuardRef.current > 120) {
      if (el.scrollTop < el.clientHeight) {
        growGuardRef.current = now;
        growHead(2);
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) {
        growGuardRef.current = now;
        growTail(2);
      }
    }
    const center = el.scrollTop + el.clientHeight / 2;
    for (const b of Array.from(el.querySelectorAll("[data-month]")) as HTMLElement[]) {
      if (b.offsetTop <= center && center < b.offsetTop + b.offsetHeight) {
        const [fy, fm] = (b.dataset.month ?? "").split("-").map(Number);
        if (fy && fm && (fy !== y || fm !== m)) {
          setY(fy);
          setM(fm);
        }
        break;
      }
    }
  }, [growHead, growTail, y, m]);

  /** 窗口变化后的滚动锚定：跳转落位 / 头部 prepend 与裁剪补偿 */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const [fy, fm] = months[0];
    const firstKey = `${fy}-${fm}`;
    if (!el) {
      prevFirstRef.current = firstKey;
      return;
    }
    const target = pendingScrollRef.current;
    if (target) {
      pendingScrollRef.current = null;
      const block = el.querySelector(`[data-month="${target}"]`) as HTMLElement | null;
      prevFirstRef.current = firstKey;
      if (block) el.scrollTop = block.offsetTop - 6;
      return;
    }
    if (prevFirstRef.current && prevFirstRef.current !== firstKey) {
      const idx = months.findIndex(([a, b]) => `${a}-${b}` === prevFirstRef.current);
      const h = (el.querySelector("[data-month]") as HTMLElement | null)?.offsetHeight ?? 0;
      const blockH = h > 0 ? h + 8 : 0;
      if (idx > 0) {
        el.scrollTop += idx * blockH; // 头部 prepend：内容下移，滚动位置等量补偿
      } else if (headCutRef.current > 0) {
        el.scrollTop -= headCutRef.current * blockH; // 头部裁剪：内容上移
        headCutRef.current = 0;
      }
    }
    prevFirstRef.current = firstKey;
  }, [months]);

  // 选中日所在月块滚入视野（方向键 / 跳转 / 回到今天共用）。
  // 依赖只挂 sel/view：窗口扩窗（months 变化）不得把滚动位置拽回选中月。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || view !== "month") return;
    const [sy, sm] = sel.split("-").map(Number);
    const block = el.querySelector(`[data-month="${sy}-${sm}"]`) as HTMLElement | null;
    if (!block) return;
    if (
      block.offsetTop < el.scrollTop ||
      block.offsetTop + block.offsetHeight > el.scrollTop + el.clientHeight
    ) {
      el.scrollTop = block.offsetTop - 6;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, view]);

  const stepMonth = useCallback(
    (delta: number) => {
      if (view === "year") {
        setY((prev) => prev + delta);
        return;
      }
      const [ny, nm] = delta < 0 ? prevYM([y, m]) : nextYM([y, m]);
      setY(ny);
      setM(nm);
      ensureMonth(ny, nm);
    },
    [view, y, m, ensureMonth],
  );

  const gotoOffset = useCallback(
    (days: number) => {
      setSel((prev) => {
        const p = prev.split("-").map(Number);
        const dt = new Date(p[0], p[1] - 1, p[2] + days);
        const ny = dt.getFullYear();
        const nm = dt.getMonth() + 1;
        const nd = dt.getDate();
        setY(ny);
        setM(nm);
        ensureMonth(ny, nm);
        return dateKey(ny, nm, nd);
      });
    },
    [ensureMonth],
  );

  const gotoToday = useCallback(() => {
    setY(TODAY.getFullYear());
    setM(TODAY.getMonth() + 1);
    ensureMonth(TODAY.getFullYear(), TODAY.getMonth() + 1);
    setSel(TODAY_KEY);
  }, [ensureMonth]);

  const jumpToDate = useCallback((key: string) => {
    const p = key.split("-").map(Number);
    setView("month");
    setY(p[0]);
    setM(p[1]);
    ensureMonth(p[0], p[1]);
    setSel(key);
  }, [ensureMonth]);

  /** 新增一条（双击格子 / 悬停 ＋ / Enter），并聚焦其输入框 */
  const addEntry = useCallback(
    (key: string) => {
      setSel(key);
      setView("month");
      const p = key.split("-").map(Number);
      setY(p[0]);
      setM(p[1]);
      const cur = worklogRef.current[key] ?? [];
      mutate(key, [...cur, { text: "", status: "done" }]);
      window.setTimeout(() => lastEntryRef.current?.focus(), 0);
    },
    [mutate],
  );

  /** 条目迁移（拖放 / 右键菜单同源）：源日删除 + 目标日追加 */
  const moveEntry = useCallback(
    (from: string, index: number, to: string) => {
      if (from === to) return;
      const src = [...(worklogRef.current[from] ?? [])];
      const [entry] = src.splice(index, 1);
      if (!entry) return;
      mutate(from, src);
      mutate(to, [...(worklogRef.current[to] ?? []), entry]);
    },
    [mutate],
  );

  /** 条目行右键轻菜单：三态标记 / 迁移 / 删除（useUi.openMenu 现成基建） */
  const entryMenu = useCallback(
    (key: string, index: number, x: number, y: number) => {
      const entry = (worklogRef.current[key] ?? [])[index];
      if (!entry) return;
      const moveTo = (to: string) => moveEntry(key, index, to);
      const items: MenuItem[] = [
        ...STATUS_ORDER.map((s) => ({
          label: statusLabel[s],
          disabled: entry.status === s,
          action: () => {
            const list = [...(worklogRef.current[key] ?? [])];
            if (!list[index]) return;
            list[index] = { ...list[index], status: s };
            mutate(key, list);
          },
        })),
        { sep: true },
        { label: t("迁移到昨天"), action: () => moveTo(offsetKey(key, -1)) },
        { label: t("迁移到明天"), action: () => moveTo(offsetKey(key, 1)) },
        { label: t("迁移到下周同一天"), action: () => moveTo(offsetKey(key, 7)) },
        {
          label: t("迁移到指定日期…"),
          action: () => {
            void useUi
              .getState()
              .openDialog<string>({
                type: "input",
                title: t("迁移到指定日期"),
                label: t("日期（yyyy-MM-dd）"),
                initial: key,
                validate: (v) => (parseKey(v.trim()) ? null : t("格式 yyyy-MM-dd")),
              })
              .then((v) => {
                const k = v?.trim();
                if (k) moveTo(k);
              });
          },
        },
        { sep: true },
        {
          label: t("删除"),
          danger: true,
          action: () => {
            const list = (worklogRef.current[key] ?? []).filter((_, j) => j !== index);
            mutate(key, list);
          },
        },
      ];
      useUi.getState().openMenu(items, x, y);
    },
    [mutate, moveEntry, statusLabel, t],
  );

  /** 格子空白右键：新增 / 定期任务 / 粘贴 */
  const cellMenu = useCallback(
    (key: string, x: number, y: number) => {
      const clip = dayClipboard.current;
      const items: MenuItem[] = [
        { label: t("添加一条工作"), action: () => addEntry(key) },
        {
          label: t("添加定期任务…"),
          action: () => {
            const p = parseKey(key);
            void useUi.getState().openDialog({ type: "recurrenceEdit", presetDay: p?.d });
          },
        },
      ];
      if (clip?.length) {
        items.push({ sep: true }, {
          label: t("粘贴 {n} 条", { n: clip.length }),
          action: () =>
            mutate(key, [...(worklogRef.current[key] ?? []), ...clip.map((e) => ({ ...e }))]),
        });
      }
      useUi.getState().openMenu(items, x, y);
    },
    [addEntry, mutate, t],
  );

  /** 智能跳转（跳转面板/快捷调用）：目标月在窗且两侧余量足够（头 ≥2 / 尾 ≥3
   *  块，扩窗触发阈值之外）时直接落位；否则重置窗口为目标月 ±3 居中，
   *  经 pendingScroll 在布局效应中统一落位——避免落位后生长补偿打架 */
  const jumpTo = useCallback(
    (yy: number, mm: number) => {
      setView("month");
      setY(yy);
      setM(mm);
      const arr = monthsRef.current;
      const idx = arr.findIndex(([a, b]) => a === yy && b === mm);
      const key = `${yy}-${mm}`;
      const el = scrollRef.current;
      if (idx >= 2 && arr.length - idx >= 3 && el) {
        pendingScrollRef.current = key;
        const block = el.querySelector(`[data-month="${key}"]`) as HTMLElement | null;
        if (block) el.scrollTop = block.offsetTop - 6;
      } else {
        const arr2: Array<[number, number]> = [];
        const base = new Date(yy, mm - 4, 1);
        for (let i = 0; i < 7; i++) {
          const dt = new Date(base.getFullYear(), base.getMonth() + i, 1);
          arr2.push([dt.getFullYear(), dt.getMonth() + 1]);
        }
        pendingScrollRef.current = key;
        setMonths(arr2);
      }
    },
    [],
  );

  // 跳转面板外点关闭
  useEffect(() => {
    if (!jumpOpen) return;
    const h = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".np-cal-jump") && !t.closest(".np-cal-ym")) setJumpOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [jumpOpen]);

  // 页内键盘（输入控件聚焦时让位：textarea 内 Enter 是换行、方向键是移光标）
  const onPageKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "c") {
      e.preventDefault();
      dayClipboard.current = (worklogRef.current[sel] ?? []).map((x) => ({ ...x }));
      if (dayClipboard.current.length) {
        useUi.getState().toast(t("已复制 {n} 条，点目标格子右键粘贴", { n: dayClipboard.current.length }));
      }
      return;
    }
    if (ctrl && e.key.toLowerCase() === "v") {
      e.preventDefault();
      const clip = dayClipboard.current;
      if (clip?.length) {
        mutate(sel, [...(worklogRef.current[sel] ?? []), ...clip.map((x) => ({ ...x }))]);
      }
      return;
    }
    if (e.key === "Delete" && selEntry != null) {
      e.preventDefault();
      const list = (worklogRef.current[sel] ?? []).filter((_, j) => j !== selEntry);
      mutate(sel, list);
      setSelEntry(null);
      return;
    }
    const dirs: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in dirs) {
      e.preventDefault();
      gotoOffset(dirs[e.key]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      addEntry(sel);
    } else if (e.key === "t" || e.key === "T") {
      gotoToday();
    } else if (e.key === "PageUp") {
      e.preventDefault();
      stepMonth(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      stepMonth(1);
    }
  };

  const selParts = sel.split("-").map(Number);
  const selDt = new Date(selParts[0], selParts[1] - 1, selParts[2]);
  const selEntries = worklog[sel] ?? [];
  const selOverdue = sel < TODAY_KEY;
  const monthPrefix = `${selParts[0]}-${String(selParts[1]).padStart(2, "0")}`;
  let monthDays = 0;
  let monthDone = 0;
  for (const [k, list] of Object.entries(worklog)) {
    if (!k.startsWith(monthPrefix)) continue;
    monthDays++;
    monthDone += list.filter((e) => e.status === "done").length;
  }
  const kind = dayKind(selParts[0], selParts[1], selParts[2]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  /** 竖条色类：状态维度（默认）/ 分类维度（未分类回落待办灰） */
  const barCls = useCallback(
    (e: WorkEntry): string => {
      if (colorBy === "category" && e.category && catById.has(e.category)) {
        return `np-cal-bar is-cat-${catById.get(e.category)!.color}`;
      }
      return `np-cal-bar is-${e.status}`;
    },
    [colorBy, catById],
  );

  // ── 年视图热力图数据 ──
  const heat = useMemo(() => {
    const countOf = (key: string) =>
      (worklog[key] ?? []).filter((e) => e.text).length;
    const jan1 = new Date(y, 0, 1);
    const lead = (jan1.getDay() + 6) % 7;
    const start = new Date(y, 0, 1 - lead);
    const weeks: Array<Array<{ key: string; d: number; n: number } | null>> = [];
    for (let t = start.getTime(); ; t += 7 * 86_400_000) {
      const week: Array<{ key: string; d: number; n: number } | null> = [];
      for (let di = 0; di < 7; di++) {
        const dt = new Date(t + di * 86_400_000);
        if (dt.getFullYear() !== y) {
          week.push(null);
          continue;
        }
        const key = dateKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
        week.push({ key, d: dt.getDate(), n: countOf(key) });
      }
      weeks.push(week);
      const last = new Date(t + 6 * 86_400_000);
      if (last.getFullYear() > y) break;
      if (last.getFullYear() === y && last.getMonth() === 11 && last >= new Date(y, 11, 31)) break;
    }
    return weeks;
  }, [worklog, y]);

  const hitList = hits;

  return (
    <section className="np-menupage" onKeyDown={onPageKeyDown}>
      <header className="np-menupage-head">
        <button
          className="np-menupage-back"
          data-tip={t("返回主界面")}
          data-kbd="Esc"
          onClick={() => {
            flushAll();
            useUi.getState().closeCalendar();
          }}
        >
          <AppIcon icon={ArrowLeft} size={DENSITY.iconSm} />
          <span>{t("返回主界面")}</span>
        </button>
        <span className="np-menupage-title">{t("工作日历")}</span>
        <span className="np-cal-hint">
          {t("方向键移格 · Enter 新增 · T 今天 · Ctrl-C/V 跨日复制 · 拖拽条目改期")}
        </span>
        <span className="np-cal-nav">
          <span className="np-cal-searchwrap">
            <InputGroup
              small
              leftElement={ic(Search)}
              className="np-cal-search"
              placeholder={t("搜索工作记录（拼音首字母亦可）")}
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setHits(null);
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
            />
            {hitList !== null && (
              <div className="np-cal-hits">
                {hitList.length === 0 && (
                  <div className="np-cal-hitempty">{t("无匹配结果")}</div>
                )}
                {hitList.map((h, i) => (
                  <button
                    key={`${h.date}-${h.index}-${i}`}
                    className="np-cal-hit"
                    onClick={() => {
                      jumpToDate(h.date);
                      setHits(null);
                    }}
                  >
                    <span className="np-cal-hitdate">{h.date.slice(5)}</span>
                    <i className={`np-cal-bar is-${h.status}`} />
                    <span className="np-cal-hittext">
                      {highlightText(h.text, query).map((seg, j) =>
                        seg.hit ? <b key={j}>{seg.t}</b> : <span key={j}>{seg.t}</span>,
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </span>
          <Seg<"month" | "year">
            value={view}
            options={[
              { value: "month", label: t("月") },
              { value: "year", label: t("年") },
            ]}
            onChange={(v) => setView(v)}
          />
          <Button
            minimal
            size="small"
            icon={ic(ChevronLeft)}
            aria-label={view === "year" ? t("上一年") : t("上一月")}
            data-tip={view === "year" ? t("上一年") : t("上一月（PageUp）")}
            onClick={() => stepMonth(-1)}
          />
          <button
            className="np-cal-ym"
            data-tip={t("选择年月跳转")}
            onClick={() => {
              setJumpYear(y);
              setJumpOpen((o) => !o);
            }}
          >
            {y}
            {t("年")}
            {view === "month" && m}
            {view === "month" && t("月")}
          </button>
          {jumpOpen && view === "month" && (
            <div className="np-cal-jump" onClick={(e) => e.stopPropagation()}>
              <div className="np-cal-jumprow">
                <Button minimal size="small" icon={ic(ChevronLeft)} aria-label={t("上一年")} onClick={() => setJumpYear((v) => v - 1)} />
                <span className="np-cal-explabel">
                  {jumpYear}
                  {t("年")}
                </span>
                <Button minimal size="small" icon={ic(ChevronRight)} aria-label={t("下一年")} onClick={() => setJumpYear((v) => v + 1)} />
                <Button
                  minimal
                  size="small"
                  className="np-cal-todaybtn"
                  data-tip={t("回到今天所在月份")}
                  onClick={() => {
                    jumpTo(TODAY.getFullYear(), TODAY.getMonth() + 1);
                    setSel(TODAY_KEY);
                    setJumpOpen(false);
                  }}
                >
                  {t("今天")}
                </Button>
              </div>
              <div className="np-cal-jumpgrid">
                {Array.from({ length: 9 }, (_, i) => jumpYear - 4 + i).map((yy) => (
                  <button
                    key={yy}
                    className={"np-cal-jumpcell" + (yy === jumpYear ? " is-cur" : "")}
                    onClick={() => setJumpYear(yy)}
                  >
                    {yy}
                  </button>
                ))}
              </div>
              <div className="np-cal-jumpgrid is-months">
                {Array.from({ length: 12 }, (_, i) => i + 1).map((mm) => (
                  <button
                    key={mm}
                    className={"np-cal-jumpcell" + (jumpYear === y && mm === m ? " is-cur" : "")}
                    onClick={() => {
                      jumpTo(jumpYear, mm);
                      setJumpOpen(false);
                    }}
                  >
                    {mm}
                    {t("月")}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Button
            minimal
            size="small"
            icon={ic(ChevronRight)}
            aria-label={view === "year" ? t("下一年") : t("下一月")}
            data-tip={view === "year" ? t("下一年") : t("下一月（PageDown）")}
            onClick={() => stepMonth(1)}
          />
          <Button minimal size="small" className="np-cal-todaybtn" onClick={gotoToday}>
            {t("今天")}
          </Button>
          <Button
            size="small"
            intent="primary"
            data-tip={t("按月度 / 年度 / 自定义日期范围导出工作 Markdown")}
            onClick={() => {
              flushAll();
              useUi.getState().openDialog({ type: "worklogExport" });
            }}
          >
            {t("导出")}
          </Button>
        </span>
      </header>
      <div className="np-menupage-body">
        <div className="np-cal-body">
          {view === "year" ? (
            <div className="np-cal-card np-cal-heatcard">
              <div className="np-cal-heatwrap">
                <div className="np-cal-heat">
                  {heat.map((week, wi) => (
                    <div className="np-cal-heatcol" key={wi}>
                      {week.map((cell, di) =>
                        cell ? (
                          <button
                            key={cell.key}
                            className={`np-cal-hday is-l${Math.min(4, cell.n === 0 ? 0 : cell.n <= 1 ? 1 : cell.n <= 2 ? 2 : cell.n <= 4 ? 3 : 4)}`}
                            data-tip={`${cell.key.slice(5).replace("-", "月")}日 · ${cell.n} 条`}
                            onClick={() => jumpToDate(cell.key)}
                          />
                        ) : (
                          <span key={`b-${wi}-${di}`} className="np-cal-hday is-blank" />
                        ),
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="np-cal-heatlegend">
                <span>{t("少")}</span>
                {[0, 1, 2, 3, 4].map((l) => (
                  <i key={l} className={`np-cal-hday is-l${l}`} />
                ))}
                <span>{t("多")}</span>
              </div>
            </div>
          ) : (
            <>
              <div className="np-cal-scroll" ref={scrollRef} onScroll={onScroll}>
                {months.map(([my, mm]) => (
                  <div className="np-cal-monthblock" data-month={`${my}-${mm}`} key={`${my}-${mm}`}>
                    <div className="np-cal-monthtitle">
                      {my}
                      {t("年")}
                      {mm}
                      {t("月")}
                    </div>
                    <div className="np-cal-week">
                  {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
                <div className="np-cal-grid">
                  {monthMatrix(my, mm).map((cell, i) => {
                    const { ry, rm, rd, key } = realDate(cell);
                    const hol = holidayOf(ry, rm, rd);
                    const sub = lunarSubtitle(ry, rm, rd);
                    const list = worklog[key] ?? [];
                    const dt = new Date(ry, rm - 1, rd);
                    const wkend = dt.getDay() === 0 || dt.getDay() === 6;
                    const cls = [
                      "np-cal-cell",
                      cell.inMonth ? "" : "is-dim",
                      key === sel ? "is-sel" : "",
                      key === TODAY_KEY ? "is-today" : "",
                      wkend ? "is-wkend" : "",
                      dropKey === key ? "is-drop" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const subCls: Record<SubTag, string> = {
                      fest: "is-fest",
                      term: "is-term",
                      solarfest: "is-solarfest",
                      plain: "",
                    };
                    return (
                      <div
                        key={`${i}-${key}`}
                        className={cls}
                        data-cal-key={cell.inMonth ? key : ""}
                        data-tip={
                          list.length
                            ? list.map((e) => `● ${statusLabel[e.status]}：${e.text}`).join("\n")
                            : undefined
                        }
                        onClick={(e) => {
                          const k = (e.currentTarget as HTMLElement).dataset.calKey;
                          if (!k) return;
                          if ((e.target as HTMLElement).closest(".np-cal-qa")) {
                            addEntry(k);
                            return;
                          }
                          setSel(k);
                        }}
                        onDoubleClick={(e) => {
                          const k = (e.currentTarget as HTMLElement).dataset.calKey;
                          if (k) addEntry(k);
                        }}
                        onContextMenu={(e) => {
                          if ((e.target as HTMLElement).closest(".np-cal-log")) return;
                          e.preventDefault();
                          const k = (e.currentTarget as HTMLElement).dataset.calKey;
                          if (k) cellMenu(k, e.clientX, e.clientY);
                        }}
                        onDragOver={(e) => {
                          if (!dragRef.current || !cell.inMonth) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dropKey !== key) setDropKey(key);
                        }}
                        onDragLeave={() => {
                          if (dropKey === key) setDropKey(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const dr = dragRef.current;
                          if (dr && dr.from !== key) moveEntry(dr.from, dr.index, key);
                          dragRef.current = null;
                          setDropKey(null);
                        }}
                      >
                        <div className="np-cal-crow">
                          <span className={key === TODAY_KEY ? "np-cal-dnum is-today" : "np-cal-dnum"}>
                            {cell.d}
                          </span>
                          {showLunar && (
                            <span className={`np-cal-sub ${subCls[sub.tag]}`}>{sub.text}</span>
                          )}
                          {hol && (
                            <span className={`np-cal-badge ${hol.off ? "is-off" : "is-on"}`}>
                              {hol.off ? t("休") : t("班")}
                            </span>
                          )}
                        </div>
                        {list.slice(0, 2).map((e, j) => (
                          <div
                            key={j}
                            className={e.status === "done" ? "np-cal-log is-done" : "np-cal-log"}
                            draggable
                            onDragStart={(e) => {
                              dragRef.current = { from: key, index: j };
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", key);
                            }}
                            onDragEnd={() => {
                              dragRef.current = null;
                              setDropKey(null);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              entryMenu(key, j, e.clientX, e.clientY);
                            }}
                          >
                            <i className={barCls(e)} />
                            <span className="np-cal-logtext">{e.text}</span>
                            <button
                              className="np-cal-check"
                              aria-label={e.status === "done" ? t("标记待办") : t("标记已完成")}
                              data-tip={e.status === "done" ? t("标记待办") : t("标记已完成")}
                              tabIndex={-1}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                const next = [...(worklogRef.current[key] ?? [])];
                                if (!next[j]) return;
                                next[j] = { ...next[j], status: next[j].status === "done" ? "todo" : "done" };
                                mutate(key, next);
                              }}
                            >
                              <AppIcon icon={Check} size={DENSITY.iconXs} />
                            </button>
                          </div>
                        ))}
                        {list.length > 2 && (
                          <div className="np-cal-log is-more">
                            <span className="np-cal-logtext">
                              {t("还有 {n} 条", { n: list.length - 2 })}
                            </span>
                          </div>
                        )}
                        {cell.inMonth && (
                          <button
                            className="np-cal-qa"
                            aria-label={t("添加一条工作")}
                            data-tip={t("添加一条工作")}
                            tabIndex={-1}
                          >
                            {t("＋")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                  </div>
                ))}
              </div>

              <aside className="np-cal-detail">
                <div className="np-cal-d1">
                  {selParts[1]}
                  {t("月")}
                  {selParts[2]}
                  {t("日")}
                  <small> {WEEK_ZH[(selDt.getDay() + 6) % 7]}</small>
                </div>
                <div className="np-cal-d2">{lunarLine(selParts[0], selParts[1], selParts[2])}</div>
                <div className="np-cal-chips">
                  {kind.kind === "off" && (
                    <span className="np-cal-chip is-off">{t("{n} · 休", { n: kind.holiday?.name ?? "" })}</span>
                  )}
                  {kind.kind === "on" && (
                    <span className="np-cal-chip is-on">
                      {t("调休 · 班（{n}）", { n: kind.holiday?.name ?? "" })}
                    </span>
                  )}
                  {kind.kind === "weekend" && <span className="np-cal-chip">{t("周末")}</span>}
                  {kind.kind === "work" && <span className="np-cal-chip">{t("工作日")}</span>}
                </div>
                <div className="np-cal-elist">
                  {selEntries.length === 0 && (
                    <div className="np-cal-empty">
                      {t("这一天还没有记录，点「添加一条工作」或直接双击格子。")}
                    </div>
                  )}
                  {selEntries.map((e, i) => (
                    <EntryCard
                      key={i}
                      index={i}
                      entry={e}
                      overdue={selOverdue && e.status !== "done"}
                      selected={selEntry === i}
                      statusLabel={statusLabel}
                      categories={categories}
                      onSelect={() => setSelEntry(i)}
                      onChange={(next) => {
                        const list = [...selEntries];
                        list[i] = next;
                        mutate(sel, list);
                      }}
                      onRemove={() => {
                        const list = selEntries.filter((_, j) => j !== i);
                        mutate(sel, list);
                        setSelEntry(null);
                      }}
                      refLast={i === selEntries.length - 1 ? lastEntryRef : undefined}
                    />
                  ))}
                </div>
                <Button
                  className="np-cal-addbtn"
                  minimal
                  size="small"
                  icon={ic(Plus)}
                  onClick={() => addEntry(sel)}
                >
                  {t("添加一条工作")}
                </Button>
                <div className="np-cal-dfoot">
                  <span>
                    {t("{a} 条 · {b} 字", {
                      a: selEntries.length,
                      b: selEntries.reduce((a, e) => a + e.text.length, 0),
                    })}
                  </span>
                  <span>
                    {savedAt
                      ? t("已保存 {t}", { t: savedAt })
                      : t("本月已记录 {d} 天 · 完成 {n} 条", { d: monthDays, n: monthDone })}
                  </span>
                </div>
              </aside>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** 日期键位移（右键迁移昨天/明天/下周用） */
function offsetKey(key: string, days: number): string {
  const p = key.split("-").map(Number);
  const dt = new Date(p[0], p[1] - 1, p[2] + days);
  return dateKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/** 单条工作卡：状态三态 Seg + 分类选择 + 悬停删除 + 自增高透明输入
 *  （已完成淡化/过期标红/单击卡片选中供 Delete 删除） */
function EntryCard({
  index,
  entry,
  overdue,
  selected,
  statusLabel,
  categories,
  onSelect,
  onChange,
  onRemove,
  refLast,
}: {
  index: number;
  entry: WorkEntry;
  overdue: boolean;
  selected: boolean;
  statusLabel: Record<(typeof STATUS_ORDER)[number], string>;
  categories: Array<{ id: string; name: string }>;
  onSelect(): void;
  onChange(next: WorkEntry): void;
  onRemove(): void;
  refLast?: RefObject<HTMLTextAreaElement | null>;
}) {
  const fit = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    if (index !== undefined && refLast) refLast.current = el;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  const cls = [
    "np-cal-entry",
    entry.status === "done" ? "is-done" : "",
    overdue ? "is-overdue" : "",
    selected ? "is-sel" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} onMouseDown={onSelect}>
      <div className="np-cal-erow">
        <Seg<(typeof STATUS_ORDER)[number]>
          value={entry.status}
          options={STATUS_ORDER.map((s) => ({ value: s, label: statusLabel[s] }))}
          onChange={(v) => onChange({ ...entry, status: v })}
        />
        {overdue && <span className="np-cal-chip is-off is-small">{t("已过期")}</span>}
        <button
          className="np-cal-edel"
          aria-label={t("删除这条工作")}
          data-tip={t("删除这条工作")}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <AppIcon icon={X} size={DENSITY.iconXs} />
        </button>
      </div>
      <textarea
        ref={fit}
        className="np-cal-etext"
        value={entry.text}
        placeholder={t("这条工作做了什么 / 要做什么…")}
        spellCheck={false}
        onChange={(e) => {
          onChange({ ...entry, text: e.currentTarget.value });
          fit(e.currentTarget);
        }}
      />
      <div className="np-cal-ecat">
        <NpSelect<string>
          className="np-cal-catsel"
          value={entry.category ?? ""}
          title={t("任务分类")}
          options={[
            { value: "", label: t("未分类") },
            ...categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
          onChange={(v) => onChange({ ...entry, category: v || undefined })}
        />
      </div>
    </div>
  );
}

