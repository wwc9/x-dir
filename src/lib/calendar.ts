// 工作日历纯函数（design/calendar-plan.md §5.1）：月矩阵 / 班休与农历副标题 /
// 导出构建与统计。班休以 holidays.ts 为唯一事实源（holiday-cn 数据，MIT）；
// 农历/节气/干支走 solarlunar（ISC）纯算法，传统节日与公历纪念日在本文件
// 常量表自算——不消费库内节日字段，防止与 holiday-cn 双源口径冲突。
// 用户可见文案（假日 chip、星期名、导出文档措辞）由组件层 t() 组合，本文件
// 只输出数据与中文日期惯用形（农历/节气/干支为本文化专有内容，不进 i18n）。

import solarLunar from "solarlunar";

import { HOLIDAYS } from "./holidays";

export type CalStatus = "todo" | "doing" | "done";

export interface WorkEntry {
  text: string;
  status: CalStatus;
  /** 分类 id（settings.calendarCategories 内定义；缺省 = 未分类） */
  category?: string;
  /** 定期任务模板 id（生成式实例溯源） */
  gen?: string;
}

/** 全量工作记录：键 = "yyyy-MM-dd"（本地时区，与文件列表 mtime 展示口径一致） */
export type Worklog = Record<string, WorkEntry[]>;

export interface CalCell {
  y: number;
  m: number;
  d: number;
  /** 是否属于所查月份（首尾行的前置/尾随置灰格） */
  inMonth: boolean;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function dateKey(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function parseKey(key: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** 6×7 月矩阵（周一起始）：首行补上月尾、末行补下月头，恒 42 格 */
export function monthMatrix(year: number, month: number): CalCell[] {
  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const days = new Date(year, month, 0).getDate();
  const prevDays = new Date(year, month - 1, 0).getDate();
  const cells: CalCell[] = [];
  for (let i = lead - 1; i >= 0; i--) cells.push({ y: year, m: month, d: prevDays - i, inMonth: false });
  for (let d = 1; d <= days; d++) cells.push({ y: year, m: month, d, inMonth: true });
  let next = 1;
  while (cells.length < 42) cells.push({ y: year, m: month, d: next++, inMonth: false });
  return cells;
}

export interface HolidayInfo {
  name: string;
  off: boolean;
}

/** 法定班休查询（holidays.ts 单一事实源）；数据未覆盖的年份返回 null */
export function holidayOf(y: number, m: number, d: number): HolidayInfo | null {
  const year = HOLIDAYS[String(y)];
  if (!year) return null;
  const md = `${pad2(m)}-${pad2(d)}`;
  const hit = year.find(([day]) => day === md);
  return hit ? { name: hit[1], off: hit[2] === 1 } : null;
}

export function isWeekend(y: number, m: number, d: number): boolean {
  const wd = new Date(y, m - 1, d).getDay();
  return wd === 0 || wd === 6;
}

/** 假日形态：off=法定休日 / on=调休上班日 / weekend=普通周末 / work=普通工作日 */
export type DayKind = "off" | "on" | "weekend" | "work";

export function dayKind(y: number, m: number, d: number): { kind: DayKind; holiday: HolidayInfo | null } {
  const holiday = holidayOf(y, m, d);
  if (holiday?.off) return { kind: "off", holiday };
  if (holiday) return { kind: "on", holiday };
  if (isWeekend(y, m, d)) return { kind: "weekend", holiday: null };
  return { kind: "work", holiday: null };
}

// ── 农历副标题（格子第二要素）：传统节日 > 除夕 > 节气 > 公历纪念日 > 农历日 ──

export type SubTag = "fest" | "term" | "solarfest" | "plain";

export interface SubTitle {
  text: string;
  tag: SubTag;
}

/** 农历传统节日（键 = lunarMonth-lunarDay；闰月不庆——传统历法惯例） */
const LUNAR_FEST: Record<string, string> = {
  "1-1": "春节",
  "1-15": "元宵节",
  "5-5": "端午节",
  "7-7": "七夕节",
  "8-15": "中秋节",
  "9-9": "重阳节",
  "12-8": "腊八节",
};

/** 公历纪念日（法定班休三节的名称已随班休数据展示，不在此重复） */
const SOLAR_FEST: Record<string, string> = {
  "3-8": "妇女节",
  "5-4": "青年节",
  "6-1": "儿童节",
  "8-1": "建军节",
  "9-10": "教师节",
  "12-13": "国家公祭日",
};

export function lunarSubtitle(y: number, m: number, d: number): SubTitle {
  const r = solarLunar.solar2lunar(y, m, d);
  if (r === -1) return { text: "", tag: "plain" };
  // 初一显示农历月名（正月/九月/腊月），其余显示日名（初二/十五/廿九）
  let sub = r.dayCn === "初一" ? r.monthCn : r.dayCn;
  const nx = solarLunar.solar2lunar(y, m, d + 1);
  const isChuxi =
    !r.isLeap && r.monthCn === "腊月" && nx !== -1 && nx.lMonth === 1 && nx.lDay === 1;
  const fest = r.isLeap ? undefined : LUNAR_FEST[`${r.lMonth}-${r.lDay}`];
  if (fest) return { text: fest, tag: "fest" };
  if (isChuxi) return { text: "除夕", tag: "fest" };
  if (r.term) return { text: r.term, tag: "term" };
  const solar = SOLAR_FEST[`${m}-${d}`];
  if (solar) return { text: solar, tag: "solarfest" };
  return { text: sub, tag: "plain" };
}

/** 详情面板完整农历行：`农历初五 · 丙午马年` / 节日节气日 `中秋节 · 丙午马年` */
export function lunarLine(y: number, m: number, d: number): string {
  const r = solarLunar.solar2lunar(y, m, d);
  if (r === -1) return "";
  const gz = `${r.gzYear}${r.animal}年`;
  const sub = lunarSubtitle(y, m, d);
  return sub.tag === "plain" ? `农历${sub.text} · ${gz}` : `${sub.text} · ${gz}`;
}

// ── 定期任务（模板生成式）规则引擎 ──

export interface CalendarCategoryInfo {
  id: string;
  name: string;
}

/** 由真实日期键推星期索引（0=周一 … 6=周日，与规则 weekly.days 口径一致） */
export function weekdayIndexOf(key: string): number {
  const p = parseKey(key);
  if (!p) return -1;
  return (new Date(p.y, p.m - 1, p.d).getDay() + 6) % 7;
}

/** 某月天数（闰年口径） */
export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/**
 * 定期规则在 [startKey, endKey] 闭区间内的应生成日期（升序去重）。
 * - weekly：命中 weekIndex 集合的日子
 * - workdays：每工作日 = dayKind work/on（法定休日不含、调休班日含——
 *   班休数据即中国日历正确性来源，这是与通用日历产品的差异化点）
 * - monthly：D 号（当月天数不足时钳制到月末，月底结算场景）
 * - yearly：M-D（当年无此日——如 2-29 平年——则当年不生成）
 * - postponeHoliday：weekly/monthly/yearly 命中法定休日时顺延到下一个
 *   非法定休日（多任务顺延撞日时去重）；workdays 规则自带避休，不适用
 */
export function dueDatesInRange(
  rule: RecurrenceRuleLike,
  startKey: string,
  endKey: string,
  opts?: { postponeHoliday?: boolean },
): string[] {
  const a = parseKey(startKey);
  const b = parseKey(endKey);
  if (!a || !b) return [];
  const t0 = new Date(a.y, a.m - 1, a.d).getTime();
  const t1 = new Date(b.y, b.m - 1, b.d).getTime();
  if (t1 < t0) return [];
  const postpone = opts?.postponeHoliday ?? false;
  const out = new Set<string>();
  for (let t = t0; t <= t1; t += 86_400_000) {
    const dt = new Date(t);
    const y = dt.getFullYear();
    const m = dt.getMonth() + 1;
    const d = dt.getDate();
    const key = dateKey(y, m, d);
    let hit = false;
    if (rule.kind === "weekly") {
      hit = rule.days.includes((dt.getDay() + 6) % 7);
    } else if (rule.kind === "workdays") {
      hit = dayKind(y, m, d).kind === "work" || dayKind(y, m, d).kind === "on";
    } else if (rule.kind === "monthly") {
      hit = d === Math.min(rule.day, daysInMonth(y, m));
    } else {
      hit = m === rule.m && d === rule.d;
    }
    if (!hit) continue;
    let finalKey = key;
    if (postpone && rule.kind !== "workdays") {
      const [py, pm, pd] = [y, m, d];
      let t2 = new Date(py, pm - 1, pd).getTime();
      // 最多顺延 31 天防呆（全年休日不可能连这么久）
      for (let guard = 0; guard < 31; guard++) {
        const d2 = new Date(t2);
        const y2 = d2.getFullYear();
        const m2 = d2.getMonth() + 1;
        const d2n = d2.getDate();
        if (holidayOf(y2, m2, d2n)?.off !== true) break;
        t2 += 86_400_000;
      }
      const d2 = new Date(t2);
      finalKey = dateKey(d2.getFullYear(), d2.getMonth() + 1, d2.getDate());
    }
    out.add(finalKey);
  }
  return [...out].sort();
}

/** 模板生成规则（与 ipc.RecurrenceRule 结构一致的判别联合，避免跨层依赖） */
export type RecurrenceRuleLike =
  | { kind: "weekly"; days: number[] }
  | { kind: "workdays" }
  | { kind: "monthly"; day: number }
  | { kind: "yearly"; m: number; d: number };

/** 包含某日的自然周（周一起始）7 个日期键 */
export function weekRangeContaining(key: string): string[] {
  const p = parseKey(key);
  if (!p) return [];
  const lead = (new Date(p.y, p.m - 1, p.d).getDay() + 6) % 7;
  const monday = new Date(p.y, p.m - 1, p.d - lead);
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return dateKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  });
}

// ── 导出（三档范围）与统计 ──

export type ExportRange =
  | { mode: "month"; y: number; m: number }
  | { mode: "year"; y: number }
  | { mode: "range"; start: string; end: string };

/** 范围内全部日期键（升序）；自定义起止倒置时为空（诚实输出空报告） */
export function rangeKeys(range: ExportRange): string[] {
  if (range.mode === "month") {
    const days = new Date(range.y, range.m, 0).getDate();
    return Array.from({ length: days }, (_, i) => dateKey(range.y, range.m, i + 1));
  }
  if (range.mode === "year") {
    const keys: string[] = [];
    for (let m = 1; m <= 12; m++) {
      const days = new Date(range.y, m, 0).getDate();
      for (let d = 1; d <= days; d++) keys.push(dateKey(range.y, m, d));
    }
    return keys;
  }
  const a = parseKey(range.start);
  const b = parseKey(range.end);
  if (!a || !b) return [];
  const t0 = new Date(a.y, a.m - 1, a.d).getTime();
  const t1 = new Date(b.y, b.m - 1, b.d).getTime();
  if (t1 < t0) return [];
  const keys: string[] = [];
  for (let t = t0; t <= t1; t += 86_400_000) {
    const dt = new Date(t);
    keys.push(dateKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()));
  }
  return keys;
}

export interface ExportStats {
  /** 有记录的天数 */
  days: number;
  items: number;
  done: number;
  doing: number;
  todo: number;
}

export function rangeStats(worklog: Worklog, range: ExportRange): ExportStats {
  const st: ExportStats = { days: 0, items: 0, done: 0, doing: 0, todo: 0 };
  for (const key of rangeKeys(range)) {
    const list = worklog[key];
    if (!list?.length) continue;
    st.days++;
    for (const e of list) {
      if (!e.text) continue;
      st.items++;
      st[e.status]++;
    }
  }
  return st;
}

export const WEEK_ZH = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"] as const;

/** 日期小节尾注：`国庆节·休` / `调休·班` / `周末` / `工作日`（详情 chip 与 XLSX 类型列共用） */
export function dayKindLabel(y: number, m: number, d: number): string {
  const { kind, holiday } = dayKind(y, m, d);
  if (kind === "off") return `${holiday?.name ?? ""}·休`;
  if (kind === "on") return `调休·班（${holiday?.name ?? ""}）`;
  return kind === "weekend" ? "周末" : "工作日";
}

function rangeLabel(range: ExportRange): string {
  if (range.mode === "month") return `${range.y}年${range.m}月`;
  if (range.mode === "year") return `${range.y}年`;
  return `${range.start} ~ ${range.end}`;
}

export function exportFileName(range: ExportRange): string {
  if (range.mode === "month") return `工作日志-${range.y}-${pad2(range.m)}.md`;
  if (range.mode === "year") return `工作日志-${range.y}.md`;
  const a = parseKey(range.start);
  const b = parseKey(range.end);
  if (!a || !b) return "工作日志.md";
  return `工作日志-${a.y}${pad2(a.m)}${pad2(a.d)}-${b.y}${pad2(b.m)}${pad2(b.d)}.md`;
}

const STATUS_SUFFIX: Record<CalStatus, string> = {
  done: "",
  doing: "（执行中）",
  todo: "（待办）",
};

/** 构建 Markdown 导出全文：统计头 → 逐日小节（升序，跳过无记录日）→
 *  逐条任务清单语法（已完成 `- [x]`，待办/执行中 `- [ ]` + 状态词）；
 *  categories 提供时，挂分类的条目行首加 `[分类名] ` 前缀 */
export function buildExport(
  worklog: Worklog,
  range: ExportRange,
  now = new Date(),
  categories?: CalendarCategoryInfo[],
): { fileName: string; content: string } {
  const stats = rangeStats(worklog, range);
  const lines: string[] = [
    `# 工作日志 ${rangeLabel(range)}`,
    "",
    `> 共记录 ${stats.days} 天 · ${stats.items} 条（已完成 ${stats.done} · 执行中 ${stats.doing} · 待办 ${stats.todo}）`,
    `> 导出于 ${dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())} · 由 X-Dir 工作日历生成`,
  ];
  for (const key of rangeKeys(range)) {
    const list = worklog[key];
    if (!list?.length) continue;
    const p = parseKey(key);
    if (!p) continue;
    const week = WEEK_ZH[(new Date(p.y, p.m - 1, p.d).getDay() + 6) % 7];
    lines.push("", `## ${p.m}月${p.d}日 ${week} · ${dayKindLabel(p.y, p.m, p.d)}`);
    for (const e of list) {
      if (!e.text) continue;
      const mark = e.status === "done" ? "- [x]" : "- [ ]";
      const cat = e.category ? categories?.find((c) => c.id === e.category)?.name : undefined;
      lines.push(`${mark} ${cat ? `[${cat}] ` : ""}${e.text}${STATUS_SUFFIX[e.status]}`);
    }
  }
  lines.push("");
  return { fileName: exportFileName(range), content: lines.join("\n") };
}
