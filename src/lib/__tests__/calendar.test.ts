// lib/calendar.ts 纯函数单测：月矩阵 / 班休查询 / 农历副标题与详情行 /
// 三档范围导出与统计。断言锚点均为已核对的真实历法事实（holiday-cn 官方
// 数据 + solarlunar 实算），改行为先改用例。
import { describe, expect, it } from "vitest";

import {
  buildExport,
  dayKind,
  dueDatesInRange,
  exportFileName,
  holidayOf,
  isWeekend,
  lunarLine,
  lunarSubtitle,
  monthMatrix,
  rangeKeys,
  rangeStats,
  weekRangeContaining,
  type Worklog,
} from "../calendar";

describe("monthMatrix（周一起始 6×7）", () => {
  it("2026-10：首行补 9 月尾（10-01 周四 → lead 3），恒 42 格", () => {
    const cells = monthMatrix(2026, 10);
    expect(cells).toHaveLength(42);
    expect(cells[0]).toEqual({ y: 2026, m: 10, d: 28, inMonth: false });
    expect(cells[3]).toEqual({ y: 2026, m: 10, d: 1, inMonth: true });
    expect(cells[41]).toEqual({ y: 2026, m: 10, d: 8, inMonth: false }); // 34 格 → 补 11-01..08
  });

  it("2024-02 闰月：29 天 + 首行 3 格前置（1-29..31），尾行补 12-01..10", () => {
    const cells = monthMatrix(2024, 2);
    expect(cells[0]).toEqual({ y: 2024, m: 2, d: 29, inMonth: false });
    expect(cells[2]).toEqual({ y: 2024, m: 2, d: 31, inMonth: false });
    expect(cells[3]).toEqual({ y: 2024, m: 2, d: 1, inMonth: true });
    expect(cells[41]).toEqual({ y: 2024, m: 2, d: 10, inMonth: false });
  });

  it("2024-12：12-01 周日 → lead 6（前置 11-25..30，11 月 30 天止）", () => {
    const cells = monthMatrix(2024, 12);
    expect(cells[5]).toEqual({ y: 2024, m: 12, d: 30, inMonth: false });
    expect(cells[6]).toEqual({ y: 2024, m: 12, d: 1, inMonth: true });
  });
});

describe("holidayOf（holidays.ts 唯一事实源）", () => {
  it("法定休日 / 调休班日 / 普通日 / 数据外年份", () => {
    expect(holidayOf(2026, 10, 1)).toEqual({ name: "国庆节", off: true });
    expect(holidayOf(2026, 10, 10)).toEqual({ name: "国庆节", off: false });
    expect(holidayOf(2026, 10, 12)).toBeNull();
    expect(holidayOf(2028, 1, 1)).toBeNull();
  });

  it("dayKind 四态", () => {
    expect(dayKind(2026, 10, 1).kind).toBe("off");
    expect(dayKind(2026, 10, 10).kind).toBe("on");
    expect(dayKind(2026, 10, 11).kind).toBe("weekend");
    expect(dayKind(2026, 10, 12).kind).toBe("work");
    expect(isWeekend(2026, 10, 11)).toBe(true);
    expect(isWeekend(2026, 10, 12)).toBe(false);
  });
});

describe("lunarSubtitle / lunarLine（solarlunar 实算锚点）", () => {
  it("传统节日 > 节气 > 公历纪念日 > 农历日", () => {
    expect(lunarSubtitle(2026, 9, 25)).toEqual({ text: "中秋节", tag: "fest" });
    expect(lunarSubtitle(2026, 2, 16)).toEqual({ text: "除夕", tag: "fest" }); // 下一天 = 正月初一
    expect(lunarSubtitle(2026, 11, 7)).toEqual({ text: "立冬", tag: "term" });
    expect(lunarSubtitle(2026, 3, 8)).toEqual({ text: "妇女节", tag: "solarfest" });
    expect(lunarSubtitle(2026, 10, 1)).toEqual({ text: "廿一", tag: "plain" });
  });

  it("初一显示农历月名", () => {
    expect(lunarSubtitle(2026, 10, 10)).toEqual({ text: "九月", tag: "plain" }); // 九月初一
    expect(lunarSubtitle(2026, 2, 17)).toEqual({ text: "春节", tag: "fest" }); // 正月初一（节日优先）
  });

  it("详情行：常规日带农历前缀，节日日直接用节日名，均带干支生肖年", () => {
    expect(lunarLine(2026, 10, 14)).toBe("农历初五 · 丙午马年");
    expect(lunarLine(2026, 9, 25)).toBe("中秋节 · 丙午马年");
    expect(lunarLine(2027, 10, 1)).toContain("丁未羊年");
  });
});

describe("rangeKeys / rangeStats", () => {
  const wl: Worklog = {
    "2026-10-09": [{ text: "a", status: "done" }, { text: "b", status: "doing" }],
    "2026-10-12": [{ text: "c", status: "done" }, { text: "", status: "done" }], // 空文本不计
    "2026-11-13": [{ text: "d", status: "todo" }],
  };

  it("月度/年度范围键数", () => {
    expect(rangeKeys({ mode: "month", y: 2026, m: 10 })).toHaveLength(31);
    expect(rangeKeys({ mode: "year", y: 2026 })).toHaveLength(365);
  });

  it("自定义范围：升序 / 单日 / 倒置为空 / 非法串为空", () => {
    expect(rangeKeys({ mode: "range", start: "2026-10-01", end: "2026-10-03" })).toHaveLength(3);
    expect(rangeKeys({ mode: "range", start: "2026-10-02", end: "2026-10-02" })).toHaveLength(1);
    expect(rangeKeys({ mode: "range", start: "2026-10-03", end: "2026-10-01" })).toHaveLength(0);
    expect(rangeKeys({ mode: "range", start: "bad", end: "2026-10-01" })).toHaveLength(0);
  });

  it("统计：天数按有记录日计，空文本条目不计数", () => {
    const st = rangeStats(wl, { mode: "month", y: 2026, m: 10 });
    expect(st).toEqual({ days: 2, items: 3, done: 2, doing: 1, todo: 0 });
    const nov = rangeStats(wl, { mode: "month", y: 2026, m: 11 });
    expect(nov).toEqual({ days: 1, items: 1, done: 0, doing: 0, todo: 1 });
  });
});

describe("buildExport（任务清单语法三档范围）", () => {
  const wl: Worklog = {
    "2026-10-09": [
      { text: "国庆后收尾", status: "done" },
      { text: "启动 11 月专项排期", status: "doing" },
    ],
    "2026-10-14": [{ text: "核对底稿抽样", status: "todo" }],
    "2026-12-31": [{ text: "不在范围内的日子", status: "done" }],
  };

  it("月度档：统计头 + 逐日小节 + 任务语法 + 跳过无记录日", () => {
    const { fileName, content } = buildExport(wl, { mode: "month", y: 2026, m: 10 });
    expect(fileName).toBe("工作日志-2026-10.md");
    expect(content).toContain("# 工作日志 2026年10月");
    expect(content).toContain("共记录 2 天 · 3 条（已完成 1 · 执行中 1 · 待办 1）");
    expect(content).toContain("## 10月9日 星期五 · 工作日");
    expect(content).toContain("- [x] 国庆后收尾");
    expect(content).toContain("- [ ] 启动 11 月专项排期（执行中）");
    expect(content).toContain("- [ ] 核对底稿抽样（待办）");
    expect(content).not.toContain("10月10日"); // 无记录日不占篇幅
    expect(content).not.toContain("不在范围内");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("年度/自定义档文件名与范围标签", () => {
    expect(exportFileName({ mode: "year", y: 2026 })).toBe("工作日志-2026.md");
    expect(exportFileName({ mode: "range", start: "2026-10-01", end: "2026-10-31" })).toBe(
      "工作日志-20261001-20261031.md",
    );
    const r = buildExport(wl, { mode: "range", start: "2026-10-01", end: "2026-10-31" });
    expect(r.content).toContain("# 工作日志 2026-10-01 ~ 2026-10-31");
    expect(r.content).toContain("## 10月14日 星期三 · 工作日");
  });

  it("休日/调休/周末小节尾注", () => {
    const wl2: Worklog = {
      "2026-10-01": [{ text: "x", status: "done" }],
      "2026-10-10": [{ text: "y", status: "done" }],
      "2026-10-11": [{ text: "z", status: "done" }],
    };
    const r = buildExport(wl2, { mode: "month", y: 2026, m: 10 }).content;
    expect(r).toContain("## 10月1日 星期四 · 国庆节·休");
    expect(r).toContain("## 10月10日 星期六 · 调休·班（国庆节）");
    expect(r).toContain("## 10月11日 星期日 · 周末");
  });

  it("空范围（倒置区间）诚实输出零统计", () => {
    const r = buildExport(wl, { mode: "range", start: "2026-10-31", end: "2026-10-01" });
    expect(r.content).toContain("共记录 0 天 · 0 条");
    expect(r.content).not.toContain("## ");
  });

  it("分类前缀：categories 提供时挂分类条目行首加 [分类名] ", () => {
    const wlc: Worklog = {
      "2026-10-12": [
        { text: "带分类的活", status: "done", category: "work" },
        { text: "没分类的活", status: "done" },
      ],
    };
    const r = buildExport(wlc, { mode: "month", y: 2026, m: 10 }, new Date(), [
      { id: "work", name: "工作" },
    ]);
    expect(r.content).toContain("- [x] [工作] 带分类的活");
    expect(r.content).toContain("- [x] 没分类的活");
    // 不提供 categories 时不加前缀
    const r2 = buildExport(wlc, { mode: "month", y: 2026, m: 10 });
    expect(r2.content).not.toContain("[工作]");
  });
});

describe("dueDatesInRange（定期任务模板生成式规则引擎）", () => {
  it("weekly：每周一命中 2026-10 的四个周一", () => {
    expect(dueDatesInRange({ kind: "weekly", days: [0] }, "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
  });

  it("workdays：法定休日不含、调休班日含（10-10 周六班入选）", () => {
    const keys = dueDatesInRange({ kind: "workdays" }, "2026-10-01", "2026-10-31");
    expect(keys).not.toContain("2026-10-01"); // 国庆休
    expect(keys).not.toContain("2026-10-03"); // 休（周五）
    expect(keys).toContain("2026-10-10"); // 调休班日（周六）
    expect(keys).not.toContain("2026-10-11"); // 普通周六
    expect(keys).toHaveLength(18);
  });

  it("weekly + postponeHoliday：国庆周的三顺延到首个非法定休日（10-08），其余照旧", () => {
    expect(
      dueDatesInRange({ kind: "weekly", days: [2] }, "2026-10-01", "2026-10-31", {
        postponeHoliday: true,
      }),
    ).toEqual(["2026-10-08", "2026-10-14", "2026-10-21", "2026-10-28"]);
  });

  it("monthly：D 号超过当月天数时钳制到月末", () => {
    expect(dueDatesInRange({ kind: "monthly", day: 31 }, "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-31",
    ]);
    expect(dueDatesInRange({ kind: "monthly", day: 31 }, "2026-11-01", "2026-11-30")).toEqual([
      "2026-11-30",
    ]);
  });

  it("yearly：2-29 仅闰年生成；范围倒置为空", () => {
    expect(dueDatesInRange({ kind: "yearly", m: 2, d: 29 }, "2028-02-01", "2028-03-01")).toEqual([
      "2028-02-29",
    ]);
    expect(dueDatesInRange({ kind: "yearly", m: 2, d: 29 }, "2027-02-01", "2027-03-01")).toEqual([]);
    expect(dueDatesInRange({ kind: "weekly", days: [0] }, "2026-10-31", "2026-10-01")).toEqual([]);
  });

  it("weekRangeContaining：周一起始自然周", () => {
    expect(weekRangeContaining("2026-11-13")).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(weekRangeContaining("2026-11-09")[0]).toBe("2026-11-09"); // 周一自己
    expect(weekRangeContaining("2026-11-15")[6]).toBe("2026-11-15"); // 周日自己
  });
});
