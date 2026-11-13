// 工作日历整页（2026-11-13 新功能，design/calendar-plan.md §4）：占满顶栏以下
// 区域（np-menupage 壳，与定制页/全盘搜索页同构，整页互斥）。左 = 月视图
// （6×7 周一起始，首行单行收纳 日期+农历/节日+班休徽标，条目摘要带状态竖条），
// 右 = 当日条目编辑面板（状态三态 Seg + 自动保存）。数据在 Rust 端
// config/worklog.json（铁律 3：按月下发，前端不囤全量）；导出走
// worklogExport 对话框。键盘：方向键移格 / Enter 新增 / T 今天 / PgUp PgDn 翻月。
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button } from "@blueprintjs/core";
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";

import { useSettings } from "../stores/settings";
import { useUi } from "../stores/ui";
import { t, useT } from "../lib/i18n";
import { api, type WorkEntry } from "../lib/ipc";
import {
  dateKey,
  type Worklog,
  dayKind,
  holidayOf,
  lunarLine,
  lunarSubtitle,
  monthMatrix,
  type SubTag,
} from "../lib/calendar";
import { AppIcon, ic } from "./AppIcon";
import { Seg } from "./ImgDialogs";
import { DENSITY } from "../lib/tokens";

const TODAY = new Date();
const TODAY_KEY = dateKey(TODAY.getFullYear(), TODAY.getMonth() + 1, TODAY.getDate());

const STATUS_ORDER = ["todo", "doing", "done"] as const;

/** 日期单元格用真实日期（首尾行的越界 d 由 Date 自动翻月），统一以真实键存取 */
function realDate(cell: { y: number; m: number; d: number }): { ry: number; rm: number; rd: number; key: string } {
  const dt = new Date(cell.y, cell.m - 1, cell.d);
  const ry = dt.getFullYear();
  const rm = dt.getMonth() + 1;
  const rd = dt.getDate();
  return { ry, rm, rd, key: dateKey(ry, rm, rd) };
}

export function CalendarPage() {
  const t = useT();
  const showLunar = useSettings((s) => s.calendarShowLunar);
  const calendarHotkey = useSettings((s) => s.calendarHotkey);
  const [y, setY] = useState(TODAY.getFullYear());
  const [m, setM] = useState(TODAY.getMonth() + 1);
  const [sel, setSel] = useState(TODAY_KEY);
  const [worklog, setWorklog] = useState<Worklog>({});
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const worklogRef = useRef<Worklog>({});
  const pendingRef = useRef<Map<string, WorkEntry[]>>(new Map());
  const saveTimer = useRef<number | undefined>(undefined);
  const lastEntryRef = useRef<HTMLTextAreaElement | null>(null);
  worklogRef.current = worklog;

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

  // 翻月：先冲刷上一月未落盘修改，再拉取新月数据（服务端值并入本地态）
  useEffect(() => {
    flushAll();
    let alive = true;
    void api
      .worklogGetMonth(y, m)
      .then((days) => {
        if (!alive) return;
        setWorklog((prev) => {
          const next = { ...prev };
          for (const d of days) next[d.date] = d.entries;
          return next;
        });
      })
      .catch((e) => useUi.getState().toast(String(e), "error"));
    return () => {
      alive = false;
    };
  }, [y, m, flushAll]);

  // 卸载兜底冲刷
  useEffect(() => () => flushAll(), [flushAll]);

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

  const stepMonth = useCallback(
    (delta: number) => {
      let nm = m + delta;
      let ny = y;
      if (nm < 1) {
        nm = 12;
        ny--;
      } else if (nm > 12) {
        nm = 1;
        ny++;
      }
      setY(ny);
      setM(nm);
    },
    [y, m],
  );

  const gotoOffset = useCallback((days: number) => {
    setSel((prev) => {
      const p = prev.split("-").map(Number);
      const dt = new Date(p[0], p[1] - 1, p[2] + days);
      const ny = dt.getFullYear();
      const nm = dt.getMonth() + 1;
      const nd = dt.getDate();
      setY(ny);
      setM(nm);
      return dateKey(ny, nm, nd);
    });
  }, []);

  const gotoToday = useCallback(() => {
    setY(TODAY.getFullYear());
    setM(TODAY.getMonth() + 1);
    setSel(TODAY_KEY);
  }, []);

  /** 新增一条（双击格子 / 悬停 ＋ / Enter），并聚焦其输入框 */
  const addEntry = useCallback(
    (key: string) => {
      setSel(key);
      const p = key.split("-").map(Number);
      setY(p[0]);
      setM(p[1]);
      const cur = worklogRef.current[key] ?? [];
      mutate(key, [...cur, { text: "", status: "done" }]);
      window.setTimeout(() => lastEntryRef.current?.focus(), 0);
    },
    [mutate],
  );

  // 页内键盘（输入控件聚焦时让位：textarea 内 Enter 是换行、方向键是移光标）
  const onPageKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
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

  const cells = monthMatrix(y, m);
  const selParts = sel.split("-").map(Number);
  const selDt = new Date(selParts[0], selParts[1] - 1, selParts[2]);
  const selEntries = worklog[sel] ?? [];
  const selOverdue = sel < TODAY_KEY;
  const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;
  let monthDays = 0;
  let monthDone = 0;
  for (const [k, list] of Object.entries(worklog)) {
    if (!k.startsWith(monthPrefix)) continue;
    monthDays++;
    monthDone += list.filter((e) => e.status === "done").length;
  }
  const kind = dayKind(selParts[0], selParts[1], selParts[2]);

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
          {t("系统级快捷键 {k} 唤起 · 方向键移格 · Enter 新增 · T 今天", {
            k: calendarHotkey,
          })}
        </span>
        <span className="np-cal-nav">
          <Button
            minimal
            size="small"
            icon={ic(ChevronLeft)}
            aria-label={t("上一月")}
            data-tip={t("上一月（PageUp）")}
            onClick={() => stepMonth(-1)}
          />
          <span className="np-cal-ym">
            {y}
            {t("年")}
            {m}
            {t("月")}
          </span>
          <Button
            minimal
            size="small"
            icon={ic(ChevronRight)}
            aria-label={t("下一月")}
            data-tip={t("下一月（PageDown）")}
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
          <div className="np-cal-card">
            <div className="np-cal-week">
              {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="np-cal-grid">
              {cells.map((cell, i) => {
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
                  wkend ? "is-wkend" : "",
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
                    {list.slice(0, 3).map((e, j) => (
                      <div
                        key={j}
                        className={e.status === "done" ? "np-cal-log is-done" : "np-cal-log"}
                      >
                        <i className={`np-cal-bar is-${e.status}`} />
                        <span className="np-cal-logtext">{e.text}</span>
                      </div>
                    ))}
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

          <aside className="np-cal-detail">
            <div className="np-cal-d1">
              {selParts[1]}
              {t("月")}
              {selParts[2]}
              {t("日")}
              <small>
                {" "}
                {t(
                  ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"][
                    (selDt.getDay() + 6) % 7
                  ],
                )}
              </small>
            </div>
            <div className="np-cal-d2">{lunarLine(selParts[0], selParts[1], selParts[2])}</div>
            <div className="np-cal-chips">
              {kind.kind === "off" && <span className="np-cal-chip is-off">{t("{n} · 休", { n: kind.holiday?.name ?? "" })}</span>}
              {kind.kind === "on" && (
                <span className="np-cal-chip is-on">{t("调休 · 班（{n}）", { n: kind.holiday?.name ?? "" })}</span>
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
                  statusLabel={statusLabel}
                  onChange={(next) => {
                    const list = [...selEntries];
                    list[i] = next;
                    mutate(sel, list);
                  }}
                  onRemove={() => {
                    const list = selEntries.filter((_, j) => j !== i);
                    mutate(sel, list);
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
        </div>
      </div>
    </section>
  );
}

/** 单条工作卡：状态三态 Seg + 悬停删除 + 自增高透明输入（已完成淡化/过期标红） */
function EntryCard({
  index,
  entry,
  overdue,
  statusLabel,
  onChange,
  onRemove,
  refLast,
}: {
  index: number;
  entry: WorkEntry;
  overdue: boolean;
  statusLabel: Record<(typeof STATUS_ORDER)[number], string>;
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
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
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
          onClick={onRemove}
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
    </div>
  );
}
