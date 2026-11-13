// 工作日历导出对话框（2026-11-13，design/calendar-plan.md §3.1-5/§4）：
// 三档范围（月度/年度/自定义日期区间）+ 统计预览 + np-dialog-note 收尾，
// 原生保存框导出 Markdown（任务清单语法，构建与统计在 lib/calendar.ts 纯函数）。
// 范围数据按需拉取：选中的月份跨度逐月 worklog_get_month 后在本地聚合。
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, DialogFooter } from "@blueprintjs/core";

import { useT } from "../lib/i18n";
import { useUi } from "../stores/ui";
import { api } from "../lib/ipc";
import {
  buildExport,
  dateKey,
  parseKey,
  rangeKeys,
  rangeStats,
  type ExportRange,
  type Worklog,
} from "../lib/calendar";
import { Seg } from "./ImgDialogs";

type Mode = "month" | "year" | "range";

/** 范围覆盖的年月清单（拉取用）：自定义区间按起止之间的月份跨度展开 */
function monthsOfRange(range: ExportRange): Array<[number, number]> {
  const keys = rangeKeys(range);
  if (!keys.length) return [];
  const set = new Set(keys.map((k) => k.slice(0, 7)));
  return [...set].map((ym) => {
    const [y, m] = ym.split("-").map(Number);
    return [y, m] as [number, number];
  });
}

/** 自定义档起止是否可导出（合法日期且不倒置） */
function rangeValid(start: string, end: string): boolean {
  const a = parseKey(start);
  const b = parseKey(end);
  if (!a || !b) return false;
  return rangeKeys({ mode: "range", start, end }).length > 0;
}

export function WorklogExportDialog({ onDone }: { onDone: () => void }) {
  const t = useT();
  const today = new Date();
  const [mode, setMode] = useState<Mode>("month");
  const [y, setY] = useState(today.getFullYear());
  const [m, setM] = useState(today.getMonth() + 1);
  const [yr, setYr] = useState(today.getFullYear());
  const [start, setStart] = useState(dateKey(today.getFullYear(), today.getMonth() + 1, 1));
  const [end, setEnd] = useState(
    dateKey(
      today.getFullYear(),
      today.getMonth() + 1,
      new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate(),
    ),
  );
  const [worklog, setWorklog] = useState<Worklog>({});
  const fetchSeq = useRef(0);

  const range: ExportRange = useMemo(() => {
    if (mode === "month") return { mode: "month", y, m };
    if (mode === "year") return { mode: "year", y: yr };
    return { mode: "range", start, end };
  }, [mode, y, m, yr, start, end]);

  const valid = mode !== "range" || rangeValid(start, end);

  // 按需拉取范围内的月份数据（自定义输入防抖 250ms，其余档位即时）
  useEffect(() => {
    const months = valid ? monthsOfRange(range) : [];
    const seq = ++fetchSeq.current;
    const timer = window.setTimeout(
      () => {
        void (async () => {
          const merged: Worklog = {};
          for (const [fy, fm] of months) {
            try {
              for (const day of await api.worklogGetMonth(fy, fm)) {
                merged[day.date] = day.entries;
              }
            } catch {
              // 单月拉取失败：该月按无记录参与统计（导出属只读操作，不阻断）
            }
          }
          if (fetchSeq.current === seq) setWorklog(merged);
        })();
      },
      mode === "range" ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, y, m, yr, start, end, valid]);

  const stats = rangeStats(worklog, range);
  const preview = buildExport(worklog, range);

  const doExport = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: t("导出工作记录"),
      defaultPath: preview.fileName,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    try {
      await api.saveTextFile(path, preview.content);
      useUi.getState().toast(t("已导出 {f}", { f: preview.fileName }));
      onDone();
    } catch (e) {
      useUi.getState().toast(t("导出失败：{e}", { e: String(e) }), "error");
    }
  };

  const monthStep = (d: number) => {
    let nm = m + d;
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
  };

  return (
    <>
      <div className="np-bren-form is-cols np-cal-expform">
        <div className="np-bren-field">
          <span className="np-bren-k">{t("范围")}</span>
          <Seg<Mode>
            value={mode}
            options={[
              { value: "month", label: t("月度") },
              { value: "year", label: t("年度") },
              { value: "range", label: t("自定义") },
            ]}
            onChange={(v) => setMode(v)}
          />
        </div>
        {mode === "month" && (
          <div className="np-bren-field">
            <span className="np-bren-k">{t("月份")}</span>
            <span className="np-cal-expctl">
              <Button minimal size="small" data-tip={t("上一月")} onClick={() => monthStep(-1)}>
                ‹
              </Button>
              <span className="np-cal-explabel">
                {y}
                {t("年")}
                {m}
                {t("月")}
              </span>
              <Button minimal size="small" data-tip={t("下一月")} onClick={() => monthStep(1)}>
                ›
              </Button>
            </span>
          </div>
        )}
        {mode === "year" && (
          <div className="np-bren-field">
            <span className="np-bren-k">{t("年度")}</span>
            <Seg<number>
              value={yr}
              options={[2024, 2025, 2026, 2027].map((v) => ({ value: v, label: String(v) }))}
              onChange={(v) => setYr(v)}
            />
          </div>
        )}
        {mode === "range" && (
          <div className="np-bren-field np-wide">
            <span className="np-bren-k">{t("区间")}</span>
            <span className="np-filext np-cal-expctl">
              <input
                className="np-cal-dateinput"
                value={start}
                placeholder="2026-11-01"
                spellCheck={false}
                onChange={(e) => setStart(e.currentTarget.value.trim())}
              />
              <span className="np-cal-tilde">~</span>
              <input
                className="np-cal-dateinput"
                value={end}
                placeholder="2026-11-30"
                spellCheck={false}
                onChange={(e) => setEnd(e.currentTarget.value.trim())}
              />
            </span>
          </div>
        )}
      </div>

      <div className="np-cal-expstats">
        <div>
          <b>{stats.days}</b>
          <span>{t("记录天数")}</span>
        </div>
        <div>
          <b>{stats.items}</b>
          <span>{t("条目数")}</span>
        </div>
        <div>
          <b className="np-cal-stat-done">{stats.done}</b>
          <span>{t("已完成")}</span>
        </div>
        <div>
          <b className="np-cal-stat-doing">{stats.doing}</b>
          <span>{t("执行中")}</span>
        </div>
        <div>
          <b>{stats.todo}</b>
          <span>{t("待办")}</span>
        </div>
      </div>

      <div className="np-dialog-note">
        <span className="np-dialog-note-row">
          {t(
            "内容结构：统计摘要 → 按日期升序逐日小节（节假日标注）→ 逐条工作；已完成以「- [x]」导出，待办/执行中以「- [ ]」+ 状态词导出。范围外无记录日期不占篇幅。",
          )}
        </span>
        <span className="np-dialog-note-row np-dialog-note-path">
          {valid
            ? t("输出预览：{p}", { p: `文档\\${preview.fileName}` })
            : t("输出预览：填入有效起止日期后自动生成文件名")}
        </span>
      </div>
      <div className="np-dialog-error" hidden={valid}>
        {t("起止日期无效或倒置（格式 yyyy-MM-dd）")}
      </div>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              {t("取消")}
            </Button>
            <Button
              size="small"
              intent="primary"
              disabled={!valid}
              onClick={() => void doExport()}
            >
              {t("导出 Markdown")}
            </Button>
          </>
        }
      />
    </>
  );
}
