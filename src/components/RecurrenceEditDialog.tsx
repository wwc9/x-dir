// 定期任务模板编辑对话框（2026-11-13 增强批）：有限档位规则（每周几 /
// 每工作日 / 每月 D 号 / 每年 M-D）+ 避开法定休日顺延 + 30 天预览。
// 模板生成式：保存即往后生成 90 天实例（gen 溯源防重，实例独立可改可删，
// 删掉的不再重生）。新增与编辑（templateId）共用本对话框。
import { useMemo, useState } from "react";
import { Button, DialogBody, DialogFooter, InputGroup, Switch } from "@blueprintjs/core";

import { useT } from "../lib/i18n";
import { useUi } from "../stores/ui";
import { useSettings } from "../stores/settings";
import { api, type RecurrenceRule, type RecurrenceTemplate, type WorkEntry } from "../lib/ipc";
import type { Worklog } from "../lib/calendar";
import {
  dateKey,
  dueDatesInRange,
  type RecurrenceRuleLike,
} from "../lib/calendar";
import { Seg } from "./ImgDialogs";
import { NpSelect } from "./NpSelect";

type Kind = RecurrenceRule["kind"];

/** 规则摘要（设置页列表与预览共用的人话句式） */
export function recurrenceSummary(rule: RecurrenceRule, postpone: boolean): string {
  const wd = ["一", "二", "三", "四", "五", "六", "日"];
  let base: string;
  if (rule.kind === "weekly") {
    base = rule.days.length
      ? `每周 ${rule.days.map((d) => wd[d]).join("、")}`
      : "每周（未选星期）";
  } else if (rule.kind === "workdays") {
    base = "每工作日（周一至五，自动避开法定休日、含调休班日）";
  } else if (rule.kind === "monthly") {
    base = `每月 ${rule.day} 号`;
  } else {
    base = `每年 ${rule.m} 月 ${rule.d} 日`;
  }
  return postpone && rule.kind !== "workdays" ? `${base} · 命中法定休日顺延` : base;
}

export function RecurrenceEditDialog({
  templateId,
  presetDay,
  onDone,
}: {
  templateId?: string;
  presetDay?: number;
  onDone: () => void;
}) {
  const t = useT();
  const templates = useSettings((s) => s.calendarRecurrence);
  const categories = useSettings((s) => s.calendarCategories);
  const editing = templateId ? templates.find((x) => x.id === templateId) : undefined;

  const [text, setText] = useState(editing?.text ?? "");
  const [status, setStatus] = useState<WorkEntry["status"]>(editing?.status ?? "done");
  const [category, setCategory] = useState(editing?.category ?? "");
  const [kind, setKind] = useState<Kind>(editing?.rule.kind ?? "weekly");
  const [weeklyDays, setWeeklyDays] = useState<number[]>(
    editing?.rule.kind === "weekly" ? editing.rule.days : [0],
  );
  const [monthlyDay, setMonthlyDay] = useState(
    editing?.rule.kind === "monthly" ? editing.rule.day : (presetDay ?? 1),
  );
  const [yearlyM, setYearlyM] = useState(editing?.rule.kind === "yearly" ? editing.rule.m : 1);
  const [yearlyD, setYearlyD] = useState(editing?.rule.kind === "yearly" ? editing.rule.d : 1);
  const [postpone, setPostpone] = useState(editing?.postponeHoliday ?? true);
  const [busy, setBusy] = useState(false);

  const rule: RecurrenceRule = useMemo(() => {
    if (kind === "weekly") return { kind: "weekly", days: weeklyDays };
    if (kind === "workdays") return { kind: "workdays" };
    if (kind === "monthly") return { kind: "monthly", day: Math.min(31, Math.max(1, monthlyDay || 1)) };
    return {
      kind: "yearly",
      m: Math.min(12, Math.max(1, yearlyM || 1)),
      d: Math.min(31, Math.max(1, yearlyD || 1)),
    };
  }, [kind, weeklyDays, monthlyDay, yearlyM, yearlyD]);

  const ruleLike: RecurrenceRuleLike = rule;
  const today = new Date();
  const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const plus90 = (() => {
    const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90);
    return dateKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  })();
  const preview = dueDatesInRange(ruleLike, todayKey, plus90, { postponeHoliday: postpone });

  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const tpl: RecurrenceTemplate = {
        id: editing?.id ?? `rt_${Date.now().toString(36)}`,
        text: text.trim(),
        status,
        category: category || undefined,
        rule,
        postponeHoliday: postpone,
        enabled: editing?.enabled ?? true,
      };
      const next = editing
        ? useSettings.getState().calendarRecurrence.map((x) => (x.id === editing.id ? tpl : x))
        : [...useSettings.getState().calendarRecurrence, tpl];
      useSettings.getState().update({ calendarRecurrence: next });

      // 生成式实例：往后 90 天，凡应生成且尚无同 gen 实例的日期补一条
      //（已删除/已改的实例不动——删除即永久跳过）
      const due = dueDatesInRange(ruleLike, todayKey, plus90, { postponeHoliday: postpone });
      const merged: Worklog = {};
      const monthKeys = new Set(due.map((k) => k.slice(0, 7)));
      for (const ym of monthKeys) {
        const [y, m] = ym.split("-").map(Number);
        try {
          for (const day of await api.worklogGetMonth(y, m)) merged[day.date] = day.entries;
        } catch {
          // 拉取失败按无记录处理（生成是追加语义，不会覆盖已有内容）
        }
      }
      let created = 0;
      for (const key of due) {
        const list = merged[key] ?? [];
        if (list.some((e) => e.gen === tpl.id)) continue;
        const entry: WorkEntry = {
          text: tpl.text,
          status: tpl.status,
          category: tpl.category,
          gen: tpl.id,
        };
        merged[key] = [...list, entry];
        created++;
      }
      for (const [key, list] of Object.entries(merged)) {
        if (list.some((e) => e.gen === tpl.id)) {
          await api.worklogSetDay(key, list).catch(() => undefined);
        }
      }
      useUi.getState().toast(
        editing
          ? `${t("模板已保存，新生成 {n} 条实例", { n: created })}`
          : `${t("模板已保存，生成 {n} 条实例（90 天内）", { n: created })}`,
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const wdNames = ["一", "二", "三", "四", "五", "六", "日"];
  const toggleWd = (d: number) =>
    setWeeklyDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );

  return (
    <>
      <DialogBody>
        <div className="np-bren-form is-cols">
        <div className="np-bren-field np-wide">
          <span className="np-bren-k">{t("内容")}</span>
          <span className="np-filext">
            <InputGroup
              small
              value={text}
              placeholder={t("例如：每周组会 / 月底结账 / 生日提醒")}
              spellCheck={false}
              onChange={(e) => setText(e.currentTarget.value)}
            />
          </span>
        </div>
        <div className="np-bren-field">
          <span className="np-bren-k">{t("状态")}</span>
          <Seg<WorkEntry["status"]>
            value={status}
            options={[
              { value: "todo", label: t("待办") },
              { value: "doing", label: t("执行中") },
              { value: "done", label: t("已完成") },
            ]}
            onChange={(v) => setStatus(v)}
          />
        </div>
        <div className="np-bren-field">
          <span className="np-bren-k">{t("分类")}</span>
          <NpSelect<string>
            className="np-cal-catsel"
            value={category}
            title={t("任务分类")}
            options={[
              { value: "", label: t("未分类") },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={(v) => setCategory(v)}
          />
        </div>
        <div className="np-bren-field">
          <span className="np-bren-k">{t("频率")}</span>
          <Seg<Kind>
            value={kind}
            options={[
              { value: "weekly", label: t("每周") },
              { value: "workdays", label: t("每工作日") },
              { value: "monthly", label: t("每月") },
              { value: "yearly", label: t("每年") },
            ]}
            onChange={(v) => setKind(v)}
          />
        </div>
        {kind === "weekly" && (
          <div className="np-bren-field">
            <span className="np-bren-k">{t("星期")}</span>
            <span className="np-cal-wdrow">
              {wdNames.map((n, d) => (
                <button
                  key={d}
                  className={weeklyDays.includes(d) ? "np-cal-wd is-on" : "np-cal-wd"}
                  onClick={() => toggleWd(d)}
                >
                  {n}
                </button>
              ))}
            </span>
          </div>
        )}
        {kind === "monthly" && (
          <div className="np-bren-field">
            <span className="np-bren-k">{t("每月几号")}</span>
            <span className="np-filext">
              <InputGroup
                small
                className="np-bren-num"
                value={String(monthlyDay)}
                onChange={(e) => setMonthlyDay(Number(e.currentTarget.value) || 1)}
              />
              <span className="np-cal-tilde">{t("号（月末自动钳制）")}</span>
            </span>
          </div>
        )}
        {kind === "yearly" && (
          <div className="np-bren-field">
            <span className="np-bren-k">{t("每年")}</span>
            <span className="np-filext">
              <InputGroup
                small
                className="np-bren-num"
                value={String(yearlyM)}
                onChange={(e) => setYearlyM(Number(e.currentTarget.value) || 1)}
              />
              <span className="np-cal-tilde">{t("月")}</span>
              <InputGroup
                small
                className="np-bren-num"
                value={String(yearlyD)}
                onChange={(e) => setYearlyD(Number(e.currentTarget.value) || 1)}
              />
              <span className="np-cal-tilde">{t("日")}</span>
            </span>
          </div>
        )}
        {kind !== "workdays" && (
          <div className="np-bren-field np-wide">
            <span className="np-bren-k">{t("法定休日")}</span>
            <Switch
              checked={postpone}
              onChange={(e) => setPostpone(e.currentTarget.checked)}
            />
            <span className="np-cal-tilde">{t("命中法定休日顺延到下一个工作日")}</span>
          </div>
        )}
      </div>

      <div className="np-dialog-note">
        <span className="np-dialog-note-row">
          {preview.length
            ? t("近 30 天将生成：{d}…（保存后往后 90 天逐日落位）", {
                d: preview.slice(0, 4).join("、"),
              })
            : t("按当前规则近 30 天无生成（检查星期/日期选择）")}
        </span>
        <span className="np-dialog-note-row">
          {t(
            "实例为普通条目（带模板溯源标记），可单独改文案/状态/删除；删除后不再重生。模板可在 设置 → 日历 管理。",
          )}
        </span>
      </div>
        <div className="np-dialog-error" hidden={!!text.trim()}>
          {t("请填写任务内容")}
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              {t("取消")}
            </Button>
            <Button size="small" intent="primary" disabled={!text.trim() || busy} onClick={() => void save()}>
              {t("保存模板并生成")}
            </Button>
          </>
        }
      />
    </>
  );
}
