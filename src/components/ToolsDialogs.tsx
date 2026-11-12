// 工具箱对话框（2026-10-17）：批量新建文件夹 / Excel 合并；2026-11-03 §4.9
// 完善批：Excel 合并清单化（拖动定序）+ 通用合并对话框（图片转 PDF/CSV/文本，
// 取代裸输入框）+ PDF 提取页/删除页对话框（页数回显 + 范围解析预演）。
// 表单行复用 np-bren-form/field/k 基类、分段选择走 np-seg（Seg 自 ImgDialogs
// 导出共用）、待处理清单 = FileQueue 共享组件（DragFileList 2026-11-03 抽出）、
// 预览行复用 np-bren-preview/row（§4.7 二级页面规范）；
// 编排（api + 任务登记）在 lib/operations.ts，名单预演纯函数在 lib/folderBatch，
// 页码范围解析预演纯函数在 lib/pdfOps（与 Rust parse_page_ranges 同口径）。
import { useEffect, useMemo, useState } from "react";
import { t, useT } from "../lib/i18n";
import { api, type FileEntry, type ListingFormat } from "../lib/ipc";
import { Button, Checkbox, DialogBody, DialogFooter, InputGroup, Slider, Switch } from "@blueprintjs/core";
import { ArrowRight } from "lucide-react";

import { FOLDER_BATCH_CAP, planFolders } from "../lib/folderBatch";
import { exportListingDefaultName, type ExportListingOptions } from "../lib/listing";
import { loadDialogPrefs, saveDialogPrefs } from "../lib/dialogPrefs";
import { AppIcon } from "./AppIcon";
import { NpSelect } from "./NpSelect";
import { Seg } from "./ImgDialogs";
import { PosGrid } from "./WmPosGrid";
import { DENSITY } from "../lib/tokens";
import { QueueSection, nameOf, pathsByNames } from "./FileQueue";
import { fileNameOf, isValidName, joinPath, parentPath, smartArchiveStem } from "../lib/path";
import {
  PDF_SPLIT_DEFAULT_RULE,
  BLANK_MODES,
  blankModeNeedsN,
  blankModeNeedsSpec,
  pagesToSpec,
  parsePageSpec,
  pdfPngDirName,
  pdfPngFileName,
  renderPdfSplitName,
  type PdfSplitMethod,
  type PdfSplitOptions,
  type PdfToPngOptions,
} from "../lib/pdfOps";
import type { PdfEncryptPayload } from "../lib/operations";

function FormRow({
  k,
  wide,
  off,
  children,
}: {
  k: string;
  /** 宽行：在 2 列参数网格中独占整行（长控件/多选项行使用） */
  wide?: boolean;
  /** 关联禁用整行降灰（§4.9 参数行关联禁用，np-bren-field.is-off） */
  off?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={"np-bren-field" + (wide ? " np-wide" : "") + (off ? " is-off" : "")}
    >
      <span className="np-bren-k">{k}</span>
      {children}
    </span>
  );
}

function Footer({
  okText,
  disabled,
  onOk,
  onCancel,
}: {
  okText: string;
  disabled?: boolean;
  onOk(): void;
  onCancel(): void;
}) {
  return (
    <DialogFooter
      actions={
        <>
          <Button size="small" onClick={onCancel}>
            {t("取消")}
          </Button>
          <Button size="small" intent="primary" disabled={disabled} onClick={onOk}>
            {okText}
          </Button>
        </>
      }
    />
  );
}

/** 批量新建文件夹：多行名单 / 序号模板两种输入，实时预演最终名
 *  （与现有项重名自动 "(2)"，非法名与名单内重名红色标出）；
 *  参数记忆（2026-11-09 P2）：方式/模板/起止序号随 settings.dialogPrefs */
export function NewFoldersDialog({
  dir,
  existing,
  onDone,
}: {
  dir: string;
  existing: string[];
  onDone(names: string[] | null): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("newFolders", { mode: "lines", pattern: t2("第{}章"), start: 1, end: 10 });
  const [mode, setMode] = useState<"lines" | "pattern">(
    init.mode === "pattern" ? "pattern" : "lines",
  );
  const [text, setText] = useState("");
  const [pattern, setPattern] = useState(init.pattern);
  const [start, setStart] = useState(init.start);
  const [end, setEnd] = useState(init.end);
  const plan = useMemo(
    () => planFolders(mode, text, pattern, start, end, existing),
    [mode, text, pattern, start, end, existing],
  );
  const okNames = plan.filter((p) => p.name).map((p) => p.name as string);
  const errCount = plan.length - okNames.length;
  const num = (v: string, fb: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 9999) : fb;
  };
  return (
    <>
      <DialogBody>
        <div className="np-bren-form is-cols">
          <FormRow k={t2("方式")}>
            <Seg<"lines" | "pattern">
              value={mode}
              onChange={setMode}
              options={[
                { value: "lines", label: t2("多行名单"), title: t2("每行一个名称") },
                { value: "pattern", label: t2("序号模板"), title: t2("{} 处按起止序号展开") },
              ]}
            />
          </FormRow>
        </div>
        {mode === "lines" ? (
          <textarea
            className="np-textarea"
            rows={7}
            value={text}
            placeholder={t2("每行一个文件夹名，如：\n项目立项\n需求评审\n开发阶段")}
            spellCheck={false}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div className="np-bren-form is-cols">
            <FormRow k={t2("模板")}>
              <InputGroup
                size="small"
                value={pattern}
                placeholder={t("名称含 {} 占位符")}
                spellCheck={false}
                onChange={(e) => setPattern(e.target.value)}
              />
            </FormRow>
            <FormRow k={t2("起始")}>
              <InputGroup
                size="small"
                value={String(start)}
                spellCheck={false}
                onChange={(e) => setStart(num(e.target.value, start))}
              />
            </FormRow>
            <FormRow k={t2("结束")}>
              <InputGroup
                size="small"
                value={String(end)}
                spellCheck={false}
                onChange={(e) => setEnd(num(e.target.value, end))}
              />
            </FormRow>
          </div>
        )}
        <div className="np-bren-preview">
          {plan.slice(0, 200).map((p, i) => (
            <div key={`${p.req}-${i}`} className="np-bren-row">
              <span className="np-bren-old np-ellipsis">{p.req}</span>
              <AppIcon
                icon={ArrowRight}
                size={DENSITY.iconXs}
                className="np-bren-arrow"
              />
              <span
                className={`np-bren-new np-ellipsis ${
                  p.error ? "is-err" : p.name === p.req ? "is-same" : "is-chg"
                }`}
              >
                {p.error ? t2(p.error) : p.name}
              </span>
            </div>
          ))}
          {!plan.length && (
            <div className="np-bren-row is-same">
              <span className="np-bren-new is-same">
                {mode === "lines" ? t2("在上方输入名称名单") : t2("模板需含 {} 占位符")}
              </span>
            </div>
          )}
        </div>
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {t2("将在 {dir} 下创建 {n} 个文件夹（与现有项重名时自动加序号）", {
              dir,
              n: okNames.length,
            })}
            {errCount > 0 && t2("，{n} 项非法或重名（红色标出）", { n: errCount })}
            {plan.length > 200 && t2("（仅预览前 200 行）")}
            {okNames.length >= FOLDER_BATCH_CAP &&
              t2("，单次上限 {n} 个", { n: FOLDER_BATCH_CAP })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("创建（{n} 项）", { n: okNames.length })}
        disabled={!okNames.length}
        onOk={() => {
          saveDialogPrefs("newFolders", { mode, pattern, start, end });
          onDone(okNames);
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** Excel 合并（2026-11-03 §4.9 对齐；2026-11-12 参数集扩展）：待处理清单
 *  拖动定序 + 模式（分表保留/纵向拼接）+ 工作表范围（仅可见/含隐藏）+
 *  表名规则（分表）+ 表头行数/去重/来源列（拼接，0 = 无表头）+ 输出名。
 *  关联禁用 = 整行降灰 + 控件真 disabled（§4.9，点不动的灰行才是有效信号）。
 *  全部源 xlsx/xlsm 且分表保留 = umya 保真通道（样式/合并格/列宽/冻结全留），
 *  其余 = 数据通道（值 + xlsx 源逐格样式迁移） */
export function XlsxMergeDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: {
    paths: string[];
    mode: "sheets" | "rows";
    sheetScope: "visible" | "all";
    nameRule: "smart" | "sheet" | "file";
    headerRows: number;
    dedupHeader: boolean;
    sourceCol: "none" | "file" | "fileSheet";
    name: string;
  } | null): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("xlsxMerge", {
    mode: "sheets",
    sheetScope: "visible",
    nameRule: "smart",
    headerRows: 1,
    dedupHeader: true,
    sourceCol: "none",
  });
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const [mode, setMode] = useState<"sheets" | "rows">(() =>
    init.mode === "rows" ? "rows" : "sheets",
  );
  const [scope, setScope] = useState<"visible" | "all">(() =>
    init.sheetScope === "all" ? "all" : "visible",
  );
  const [rule, setRule] = useState<"smart" | "sheet" | "file">(() =>
    init.nameRule === "sheet" || init.nameRule === "file" ? init.nameRule : "smart",
  );
  const [headText, setHeadText] = useState(String(init.headerRows ?? 1));
  const headerRows = Math.min(100, Math.max(0, Math.floor(Number(headText) || 0)));
  const [dedup, setDedup] = useState(() => init.dedupHeader !== false);
  const [srcCol, setSrcCol] = useState<"none" | "file" | "fileSheet">(() =>
    init.sourceCol === "file" || init.sourceCol === "fileSheet" ? init.sourceCol : "none",
  );
  const [name, setName] = useState(t2("合并表格.xlsx"));
  const trimmed = name.trim();
  const valid = trimmed.length > 0;
  // 与 Rust 端同口径：缺 .xlsx 后缀时补上
  const withExt = trimmed.toLowerCase().endsWith(".xlsx") ? trimmed : `${trimmed}.xlsx`;
  const preview = joinPath(parentPath(entries[0]?.path ?? "") ?? "", withExt);
  // 保真通道资格：全部源 xlsx/xlsm（xls/xlsb/ods 任一混入即数据通道）
  const fidelity = entries.every((e) => {
    const ext = fileNameOf(e.path).split(".").pop()?.toLowerCase() ?? "";
    return ext === "xlsx" || ext === "xlsm";
  });
  const submit = () => {
    saveDialogPrefs("xlsxMerge", {
      mode,
      sheetScope: scope,
      nameRule: rule,
      headerRows,
      dedupHeader: dedup,
      sourceCol: srcCol,
    });
    onDone({
      paths: items,
      mode,
      sheetScope: scope,
      nameRule: rule,
      headerRows,
      dedupHeader: dedup,
      sourceCol: srcCol,
      name: withExt,
    });
  };
  return (
    <>
      <DialogBody>
        <QueueSection title={t2("合并顺序")} items={items} onChange={setItems} />
        <div className="np-pdfmform">
          <FormRow k={t2("方式")} wide>
            {/* 显式泛型收窄：options 对象字面量会把 T 推宽成 string，直传 setMode 不兼容 */}
            <Seg<"sheets" | "rows">
              value={mode}
              onChange={setMode}
              options={[
                { value: "sheets", label: t2("分表保留"), title: t2("每个源工作表一张目标表") },
                { value: "rows", label: t2("纵向拼接"), title: t2("全部行并入一张表") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("工作表范围")} wide>
            <Seg<"visible" | "all">
              value={scope}
              onChange={setScope}
              options={[
                { value: "visible", label: t2("仅可见表"), title: t2("跳过隐藏与深度隐藏的工作表") },
                { value: "all", label: t2("含隐藏表"), title: t2("隐藏工作表一并并入") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("表名规则")} off={mode === "rows"}>
            <Seg<"smart" | "sheet" | "file">
              value={rule}
              onChange={setRule}
              disabled={mode === "rows"}
              options={[
                { value: "smart", label: t2("智能"), title: t2("单表文件 = 文件名，多表文件 = 文件名·表名") },
                { value: "sheet", label: t2("仅表名"), title: t2("目标表名 = 源工作表名，重名自动加序号") },
                { value: "file", label: t2("仅文件名"), title: t2("目标表名 = 源文件名，多表文件同名自动加序号") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("表头行数")} off={mode === "sheets"}>
            <InputGroup
              size="small"
              value={headText}
              spellCheck={false}
              disabled={mode === "sheets"}
              title={t2("源表前 N 行视为表头，0 = 无表头（全部按数据并入）")}
              onChange={(e) => setHeadText(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="1"
            />
          </FormRow>
          <FormRow k={t2("重复表头")} off={mode === "sheets" || headerRows === 0}>
            <Switch
              checked={dedup && headerRows > 0}
              disabled={mode === "sheets" || headerRows === 0}
              onChange={(e) => setDedup(e.currentTarget.checked)}
              innerLabel={t2("自动去除与首个文件相同的表头行")}
            />
          </FormRow>
          <FormRow k={t2("来源列")} off={mode === "sheets"}>
            <Seg<"none" | "file" | "fileSheet">
              value={srcCol}
              onChange={setSrcCol}
              disabled={mode === "sheets"}
              options={[
                { value: "none", label: t2("不添加"), title: t2("不插入来源标记列") },
                { value: "file", label: t2("文件名"), title: t2("首列插入来源文件名") },
                { value: "fileSheet", label: t2("文件名·表"), title: t2("首列插入来源文件名·工作表名") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("输出名")}>
            <InputGroup
              size="small"
              value={name}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) submit();
              }}
            />
          </FormRow>
        </div>
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {mode === "sheets" && fidelity
              ? t2("保真合并：样式、合并单元格、列宽、冻结窗格原样保留；输出为 .xlsx（.xlsm 的宏不迁移）。")
              : mode === "sheets"
                ? t2("数据合并：读出数值与文本后写入 .xlsx（xlsx/xlsm 源同步迁移单元格样式与合并单元格）。")
                : t2("拼接合并：全部行并入一张表，xlsx/xlsm 源逐格迁移样式与数字格式，日期保留真实日期。")}
          </span>
          <span className="np-dialog-note-row">
            {t2(
              "按清单顺序合并 {n} 个工作簿（xlsx/xlsm/xls/xlsb/ods 均可读，统一输出 .xlsx），旁写新文件不覆盖原文件。",
              { n: entries.length },
            )}
          </span>
          <span className="np-dialog-note-row np-dialog-note-path" title={preview}>
            {t2("输出预览：{out}", { out: preview })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("合并")}
        disabled={!valid}
        onOk={submit}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** Excel 拆分对话框（2026-11-12 新功能）：四模式——按工作表（批量支持，
 *  umya 保真通道整表剥离）/ 按行数 / 按列值 / 均分 N 份（三者单文件）。
 *  表清单与首行样本经 xlsx_sheet_info 异步拉取（选表 + 依据列选择器）；
 *  参数随 dialogPrefs 记忆，输出落 <stem>_拆分 子文件夹（可关直落源目录） */
type XlsxSheetMeta = {
  name: string;
  visible: boolean;
  rows: number | null;
  cols: number | null;
  firstRow: string[] | null;
};

/** 0 基列序号 → Excel 列字母（A…Z, AA…） */
function colLetter(i: number): string {
  let n = i;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const XLSX_SPLIT_MODES = [
  { value: "sheet", label: "按工作表" },
  { value: "rows", label: "按行数" },
  { value: "value", label: "按列值" },
  { value: "parts", label: "均分 N 份" },
] as const;

export function XlsxSplitDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: {
    paths: string[];
    mode: "sheet" | "rows" | "value" | "parts";
    sheetName?: string;
    rowsPerPart: number;
    colIndex: number;
    parts: number;
    includeHidden: boolean;
    skipEmpty: boolean;
    headerRows: number;
    subFolder: boolean;
  } | null): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("xlsxSplit", {
    mode: "sheet" as "sheet" | "rows" | "value" | "parts",
    sheetName: "",
    rowsPerPart: 1000,
    colIndex: 0,
    parts: 2,
    includeHidden: false,
    skipEmpty: false,
    headerRows: 1,
    subFolder: true,
  });
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const [mode, setMode] = useState<"sheet" | "rows" | "value" | "parts">(() =>
    XLSX_SPLIT_MODES.some((m) => m.value === init.mode) ? init.mode : "sheet",
  );  const [sheets, setSheets] = useState<XlsxSheetMeta[] | null>(null);
  const [infoErr, setInfoErr] = useState(false);
  const [sheetName, setSheetName] = useState<string>(() => init.sheetName ?? "");
  const [rowsText, setRowsText] = useState(String(init.rowsPerPart ?? 1000));
  const [colIndex, setColIndex] = useState(() => init.colIndex ?? 0);
  const [partsText, setPartsText] = useState(String(init.parts ?? 2));
  const [includeHidden, setIncludeHidden] = useState(() => !!init.includeHidden);
  const [skipEmpty, setSkipEmpty] = useState(() => !!init.skipEmpty);
  const [headText, setHeadText] = useState(String(init.headerRows ?? 1));
  const headerRows = Math.min(100, Math.max(0, Math.floor(Number(headText) || 0)));
  const [subFolder, setSubFolder] = useState(() => init.subFolder !== false);

  // 表清单（单文件拉取；批量按表拆分只需首文件语境展示，实际按各文件自身表清单执行）
  useEffect(() => {
    let alive = true;
    setSheets(null);
    setInfoErr(false);
    api
      .xlsxSheetInfo(entries[0]?.path ?? "")
      .then((r) => {
        if (alive) setSheets(r);
      })
      .catch(() => {
        if (alive) setInfoErr(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries[0]?.path]);

  const rowsPerPart = Math.max(1, Math.floor(Number(rowsText) || 0));
  const parts = Math.min(200, Math.max(1, Math.floor(Number(partsText) || 0)));
  const single = entries.length === 1;
  const rowLike = mode !== "sheet";
  const valid = rowLike ? single && rowsPerPart >= 1 && parts >= 1 : items.length > 0;
  const stem = fileNameOf(entries[0]?.path ?? "").replace(/\.[^.]+$/, "");
  const outDir = subFolder
    ? joinPath(parentPath(entries[0]?.path ?? "") ?? "", `${stem}_拆分`)
    : (parentPath(entries[0]?.path ?? "") ?? "");
  const example = {
    sheet: t2("{stem}_<表名>.xlsx（每表一份）", { stem }),
    rows: `${stem}_01.xlsx …`,
    value: t2("{stem}_<列值>.xlsx（每组一份）", { stem }),
    parts: `${stem}_第1份.xlsx …`,
  }[mode];
  const curSheet = sheets?.find((s) => s.name === sheetName) ?? sheets?.find((s) => s.visible) ?? sheets?.[0];
  const cols = curSheet?.firstRow ?? null;
  const submit = () => {
    saveDialogPrefs("xlsxSplit", {
      mode,
      rowsPerPart,
      colIndex,
      parts,
      includeHidden,
      skipEmpty,
      headerRows,
      subFolder,
    });
    onDone({
      paths: items,
      mode,
      sheetName: sheetName || undefined,
      rowsPerPart,
      colIndex: mode === "value" ? colIndex : 0,
      parts,
      includeHidden,
      skipEmpty,
      headerRows,
      subFolder,
    });
  };
  return (
    <>
      <DialogBody>
        <QueueSection title={t2("待拆分文件")} items={items} onChange={setItems} />
        <div className="np-pdfmform">
          <FormRow k={t2("拆分方式")} wide>
            <Seg<"sheet" | "rows" | "value" | "parts">
              value={mode}
              onChange={setMode}
              options={XLSX_SPLIT_MODES.map((m) => ({
                value: m.value,
                label: t2(m.label),
                title: t2(
                  {
                    sheet: "每个工作表导出为一个独立文件",
                    rows: "每 N 行数据导出为一个文件",
                    value: "按某列的取值分组，每组一个文件",
                    parts: "数据行平均分成 N 份",
                  }[m.value],
                ),
              }))}
            />
          </FormRow>
          <FormRow k={t2("工作表")} off={mode === "sheet"}>
            {mode === "sheet" ? (
              <span className="np-dialog-muted">{t2("按表拆分按各文件的表清单执行")}</span>
            ) : sheets === null && !infoErr ? (
              <span className="np-dialog-muted">{t2("读取中…")}</span>
            ) : infoErr || !sheets?.length ? (
              <span className="np-dialog-muted">{t2("无法读取工作簿")}</span>
            ) : (
              <NpSelect
                value={curSheet?.name ?? ""}
                options={sheets.map((s) => ({
                  value: s.name,
                  label:
                    s.name + (s.visible ? "" : t2("（隐藏）")) +
                    (s.rows != null ? ` · ${s.rows}` : ""),
                }))}
                onChange={(v) => {
                  setSheetName(v);
                  setColIndex(0);
                }}
              />
            )}
          </FormRow>
          <FormRow k={t2("含隐藏表")} off={mode !== "sheet"}>
            <Switch
              checked={includeHidden}
              disabled={mode !== "sheet"}
              onChange={(e) => setIncludeHidden(e.currentTarget.checked)}
              innerLabel={t2("隐藏工作表一并拆出")}
            />
          </FormRow>
          <FormRow k={t2("跳过空表")} off={mode !== "sheet"}>
            <Switch
              checked={skipEmpty}
              disabled={mode !== "sheet"}
              onChange={(e) => setSkipEmpty(e.currentTarget.checked)}
              innerLabel={t2("没有内容的表不产出文件")}
            />
          </FormRow>
          <FormRow k={t2("每份行数")} off={mode !== "rows"}>
            <InputGroup
              size="small"
              value={rowsText}
              spellCheck={false}
              onChange={(e) => setRowsText(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="1000"
            />
          </FormRow>
          <FormRow k={t2("依据列")} off={mode !== "value"}>
            {cols?.length ? (
              <NpSelect
                value={String(Math.min(colIndex, cols.length - 1))}
                options={cols.map((c, i) => ({
                  value: String(i),
                  label: `${colLetter(i)} · ${c || t2("（空）")}`,
                }))}
                onChange={(v) => setColIndex(Number(v))}
              />
            ) : (
              <span className="np-dialog-muted">{t2("先选择工作表")}</span>
            )}
          </FormRow>
          <FormRow k={t2("拆成份数")} off={mode !== "parts"}>
            <InputGroup
              size="small"
              value={partsText}
              spellCheck={false}
              onChange={(e) => setPartsText(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="2"
            />
          </FormRow>
          <FormRow k={t2("表头行数")} off={mode === "sheet"}>
            <InputGroup
              size="small"
              value={headText}
              spellCheck={false}
              disabled={mode === "sheet"}
              title={t2("每份顶部复制源表前 N 行，0 = 不带表头")}
              onChange={(e) => setHeadText(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="1"
            />
          </FormRow>
          <FormRow k={t2("输出位置")}>
            <Switch
              checked={subFolder}
              onChange={(e) => setSubFolder(e.currentTarget.checked)}
              innerLabel={t2("存入 <stem>_拆分 子文件夹")}
            />
          </FormRow>
        </div>
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {rowLike && !single
              ? t2("按行数/按列值/均分拆分仅支持单个文件——请只保留一个待拆分文件或改用「按工作表」。")
              : mode === "sheet"
                ? t2("按工作表拆分保真整表迁移（样式/合并单元格/列宽/冻结窗格），输出为 .xlsx。")
                : t2("数据级拆分：xlsx/xlsm 源逐格迁移样式与数字格式，日期保留真实日期，重名自动加序号。")}
          </span>
          <span className="np-dialog-note-row np-dialog-note-path" title={outDir}>
            {t2("输出预览：{out}", { out: `${joinPath(outDir, example)}` })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("拆分")}
        disabled={!valid}
        onOk={submit}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** PDF 合并扩展对话框（2026-10-22）：
 *  files 变体 = 待合并清单（默认按名称自然序，行可拖动实时调整合并顺序——
 *  Pointer 事件实现：应用窗口注册了 OLE 拖放，HTML5 DnD 事件被拦截不可用）；
 *  folders 变体 = 选中的文件夹（各递归收集，各自输出 合并结果-<名>-<ts>.pdf，
 *  支持 1 个文件夹）。布局分区：合并顺序 → 输出 → 打印补页 → 输出预览。
 *  2026-11-09 P1/P2：输出名三段校验（非空/合法名/同名冲突红字，Rust 端
 *  available_name 兜底）+ 智能默认名（单文件 = 文件名干、多文件 = 所在目录
 *  名，冲突 (2) 递增，手动改名冻结）+ 补页选项随 dialogPrefs 记忆 */
export function PdfMergeDialog({
  variant,
  entries,
  onDone,
}: {
  variant: "files" | "folders";
  entries: FileEntry[];
  onDone(v: {
    autoBlank: boolean;
    blankFirst: boolean;
    name: string;
    /** files 变体的合并顺序（拖动调整后）；folders 变体 = 文件夹路径 */
    paths: string[];
  } | null): void;
}) {
  const t2 = useT();
  const byFolder = variant === "folders";
  const parentOf = (p: string) => {
    const i = p.lastIndexOf("\\");
    return i > 0 ? p.slice(0, i) : "";
  };
  // 默认排序：名称（数字感知自然序，1 → 2 → 10）；拖行 = 实时调整合并顺序
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const init = loadDialogPrefs("pdfMerge", { autoBlank: false, blankFirst: false });
  const [autoBlank, setAutoBlank] = useState(init.autoBlank);
  const [blankFirst, setBlankFirst] = useState(init.blankFirst);
  const dir = parentOf(entries[0]?.path ?? "");
  const baseStem = useMemo(
    () =>
      smartArchiveStem(
        entries.map((e) => ({ name: nameOf(e.path), isDir: e.isDir })),
        dir ? fileNameOf(dir) : null,
        t2("合并文档"),
      ),
    [entries, dir],
  );
  const [name, setName] = useState(`${baseStem}.pdf`);
  // 用户手动改过名 = 冻结智能跟随（冲突递增不再覆写，同 zip 压缩口径）
  const [nameEdited, setNameEdited] = useState(false);
  // 同名冲突内联校验：列输出目录现有名（首屏 2000 条）
  const [existing, setExisting] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (byFolder || !dir) return;
    let live = true;
    api
      .listDir({
        path: dir,
        sort: { key: "name", dir: "asc" },
        showHidden: true,
        offset: 0,
        limit: 2000,
      })
      .then((r) => {
        if (live) setExisting(new Set(r.entries.map((e) => e.name.toLowerCase())));
      })
      .catch(() => {
        if (live) setExisting(null);
      });
    return () => {
      live = false;
    };
  }, [byFolder, dir]);
  useEffect(() => {
    if (byFolder || nameEdited) return;
    let cand = `${baseStem}.pdf`;
    let n = 2;
    while (existing?.has(cand.toLowerCase()) && n < 100) {
      cand = `${baseStem} (${n}).pdf`;
      n += 1;
    }
    setName(cand);
  }, [byFolder, nameEdited, baseStem, existing]);
  const trimmed = name.trim();
  const withExt = trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;
  const err = byFolder
    ? null
    : !trimmed
      ? t2("请输入文件名")
      : !isValidName(withExt)
        ? t2("名称含非法字符或为 Windows 保留名")
        : existing?.has(withExt.toLowerCase())
          ? t2("同名文件已存在，请换一个名字")
          : null;
  const valid = !err;
  const output = dir + "\\" + withExt;

  return (
    <>
      <DialogBody>
        {byFolder ? (
          <>
            <div className="np-pdfmsec">
              <span className="np-bren-k">{t2("合并范围")}</span>
            </div>
            <div className="np-pdfmlist">
              {entries.map((e) => (
                <div key={e.path} className="np-pdfmlist-item" title={e.path}>
                  <span className="np-pdfmlist-kind">{t2("文件夹")}</span>
                  <span className="np-ellipsis">{e.path}</span>
                </div>
              ))}
            </div>
            {/* 范围说明走表单外的独立 muted 行：放进 np-pdfmform 会成为双列
                网格项，长句以 max-content 撑爆标签轨（2026-11-11 审查修正） */}
            <div className="np-dialog-muted">
              {t2("每个选中的文件夹递归收集 PDF 与图片，各自输出 合并结果-<文件夹名>-<时间戳>.pdf")}
            </div>
          </>
        ) : (
          <QueueSection title={t2("合并顺序")} items={items} onChange={setItems} />
        )}
        <div className="np-pdfmform">
          {variant === "files" && (
            <FormRow k={t2("输出名")}>
              <InputGroup
                size="small"
                value={name}
                spellCheck={false}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid)
                    onDone({ autoBlank, blankFirst, name: withExt, paths: items });
                }}
              />
            </FormRow>
          )}
          <FormRow k={t2("空白页凑偶数")}>
            <Seg
              value={autoBlank ? "yes" : "no"}
              onChange={(v: "no" | "yes") => setAutoBlank(v === "yes")}
              options={[
                { value: "no", label: t2("否"), title: t2("保持原页数") },
                { value: "yes", label: t2("是"), title: t2("自动补 A4 空白页使总页数凑成偶数（审计底稿打印场景常用）") },
              ]}
            />
          </FormRow>
          {autoBlank && (
            <FormRow k={t2("空白页位置")}>
              <Seg
                value={blankFirst ? "first" : "last"}
                onChange={(v: "last" | "first") => setBlankFirst(v === "first")}
                options={[
                  { value: "last", label: t2("最后1页之后") },
                  { value: "first", label: t2("第1页之前") },
                ]}
              />
            </FormRow>
          )}
        </div>
        {err && <div className="np-dialog-error">{err}</div>}
        <div className="np-dialog-note">
          {variant === "files" ? (
            <span className="np-dialog-note-row np-dialog-note-path" title={output}>
              {t2("输出预览：{out}", { out: output })}
            </span>
          ) : (
            <span className="np-dialog-note-row">
              {t2("按文件夹分别合并：{n} 个范围，各组输出 合并结果-<文件夹名>-<时间戳>.pdf", {
                n: entries.length,
              })}
            </span>
          )}
          <span className="np-dialog-note-row">
            {t2("缺失或不可读的文件自动跳过，不覆盖原文件。")}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("合并")}
        disabled={!valid}
        onOk={() => {
          saveDialogPrefs("pdfMerge", { autoBlank, blankFirst });
          onDone({
            autoBlank,
            blankFirst,
            name: withExt,
            paths: byFolder ? entries.map((e) => e.path) : items,
          });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

export interface PdfWatermarkSettings {
  /** 待处理文件路径（拖动排序后的处理顺序） */
  paths: string[];
  text: string;
  fontName: string;
  fontSize: number;
  fontColor: string;
  position: string;
  transparency: number;
  margin: number;
  pageRange: string;
  pageNumberFormat: string;
  datetimeFormat: string;
}

/** PDF 加水印参数对话框（2026-10-23 用户定案：单列纵排 + 标签列/控件列
 *  分别左对齐，np-wm-form 网格）：水印文字 / 字体 / 字号 / 颜色 / 不透明度 /
 *  位置（九宫格+对角线合并互斥行）/ 边距 / 页面范围 / 页码与日期格式 /
 *  输出名模板；占位符 chips 随输入框纵排。
 *  2026-11-09 P1/P2 批：① 选对角线时字号/边距不生效 → 行禁用降灰（对齐
 *  「不适用参数行禁用」口径）；② 字号/边距改自由输入 + 即时校验红字（不再
 *  onChange 即 clamp，可清空重输），边距补上限 1000；③ 页面范围加「自定义」
 *  档（parsePageSpec 同口径预演，Rust 逐文档解析）；④ 输出文案与模板对齐 +
 *  同名 (2) 递增说明；⑤ 全部样式参数随 dialogPrefs 记忆 */
export function PdfWatermarkDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: PdfWatermarkSettings | null): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("pdfWatermark", {
    text: "[原文件名]-[页码]",
    fontName: "heiti",
    fontSize: 14,
    fontColor: "black",
    position: "right-top",
    transparency: 9,
    margin: 20,
    pageRange: "all",
    pageNumberFormat: "cn",
    datetimeFormat: "cn",
    outName: `[原文件名]-${t2("水印")}`,
  });
  const [text, setText] = useState(init.text);
  const [fontName, setFontName] = useState(init.fontName);
  const [fontSizeText, setFontSizeText] = useState(String(init.fontSize));
  const [fontColor, setFontColor] = useState(init.fontColor);
  const [position, setPosition] = useState(init.position);
  const [transparency, setTransparency] = useState(init.transparency);
  const [marginText, setMarginText] = useState(String(init.margin));
  const presetRange = ["all", "odd", "even"].includes(init.pageRange);
  const [pageRange, setPageRange] = useState(presetRange ? init.pageRange : "custom");
  const [spec, setSpec] = useState(presetRange ? "" : init.pageRange);
  const [pageNumberFormat, setPageNumberFormat] = useState(init.pageNumberFormat);
  const [datetimeFormat, setDatetimeFormat] = useState(init.datetimeFormat);
  const [outName, setOutName] = useState(init.outName);

  // 待处理清单（§4.9 置顶）：默认名称自然序，拖行调整处理顺序；
  // 输出预览取清单首项
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const firstPath = items[0] ?? "";
  const stemOf = (p: string) => {
    const i = p.lastIndexOf("\\");
    const stem = i > 0 ? p.slice(i + 1) : p;
    return stem.replace(/\.pdf$/i, "");
  };
  const dirOf = (p: string) => {
    const i = p.lastIndexOf("\\");
    return i > 0 ? p.slice(0, i) : p;
  };
  const nowDate = new Date();
  const mm2 = String(nowDate.getMonth() + 1).padStart(2, "0");
  const dd2 = String(nowDate.getDate()).padStart(2, "0");
  const dtText = datetimeFormat === "slash"
    ? nowDate.getFullYear() + "/" + mm2 + "/" + dd2
    : datetimeFormat === "dash"
      ? nowDate.getFullYear() + "-" + mm2 + "-" + dd2
      : nowDate.getFullYear() + t2("年") + mm2 + t2("月") + dd2 + t2("日");
  // 预览与 Rust 端同口径：目录 = 文件所在目录（parent_dir），name 无 .pdf 后缀时补上
  const renderedName =
    outName.split("[原文件名]").join(stemOf(firstPath))
      .split("[原文件夹名]").join(dirOf(firstPath))
      .split("[日期时间]").join(dtText) || t2("水印") + ".pdf";
  const previewPath =
    dirOf(firstPath) +
    "\\" +
    (/\.pdf$/i.test(renderedName) ? renderedName : renderedName + ".pdf");
  // 九宫格与对角线共用 position 单一状态，互斥高亮（选对角线时九宫格全熄）；
  // 对角线按对角线长缩放铺满，字号/边距不参与 → 行禁用降灰
  const isDiag = position === "diag-main" || position === "diag-reverse";
  // 字号/边距：自由输入 + 即时校验（不再 onChange 即 clamp），提交时钳制
  const fontSize = Number.parseInt(fontSizeText, 10);
  const fontSizeErr = isDiag
    ? null
    : !Number.isFinite(fontSize) || fontSize < 5 || fontSize > 99
      ? t2("字号需为 5–99 的整数")
      : null;
  const fontSizeOut = Number.isFinite(fontSize) ? Math.min(99, Math.max(5, fontSize)) : 14;
  const margin = Number.parseInt(marginText, 10);
  const marginErr = isDiag
    ? null
    : !Number.isFinite(margin) || margin < 0 || margin > 1000
      ? t2("边距需为 0–1000 的整数")
      : null;
  const marginOut = Number.isFinite(margin) ? Math.min(1000, Math.max(0, margin)) : 20;
  // 自定义页码范围：按清单首文件总页数预演（与提取页 parsePageSpec 同口径，
  // Rust 端逐文档解析并容忍页数差异）
  const isCustomRange = pageRange === "custom";
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    api.pdfPageCount(firstPath).then(
      (n) => live && setTotal(n),
      () => live && setTotal(-1),
    );
    return () => {
      live = false;
    };
  }, [firstPath]);
  const specParsed =
    isCustomRange && total !== null && total > 0 && spec.trim()
      ? parsePageSpec(spec, total)
      : null;
  const specErr = !isCustomRange
    ? null
    : !spec.trim()
      ? t2("请输入页码范围")
      : total === null
        ? null
        : total <= 0
          ? t2("页数读取失败（文件可能损坏或加密）")
          : specParsed?.error
            ? t2(specParsed.error)
            : specParsed && specParsed.pages.length === 0
              ? t2("页码范围为空")
              : null;
  const rangeOut = isCustomRange ? spec.trim() : pageRange;
  const valid = text.trim().length > 0 && !fontSizeErr && !marginErr && !specErr;
  const diagOpts: { value: string; label: string; title?: string }[] = [
    { value: "diag-main", label: t2("正对角线"), title: t2("文字沿左上→右下 45° 缩放铺满") },
    { value: "diag-reverse", label: t2("反对角线"), title: t2("文字沿右上→左下 45° 缩放铺满") },
  ];
  return (
    <>
      <DialogBody>
        <QueueSection title={t2("处理顺序")} items={items} onChange={setItems} />
        <div className="np-wm-form">
          <span className="np-bren-k">{t2("水印文字")}</span>
          <div className="np-wm-ctl">
            <InputGroup
              className="np-wm-fill"
              size="small"
              value={text}
              spellCheck={false}
              placeholder={t2("支持占位符，见下方说明")}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="np-wm-chips">
              {["[原文件名]", "[原文件夹名]", "[页码]", "[页面标签]", "[日期时间]"].map((ph) => (
                <button
                  key={ph}
                  className="np-wm-chip"
                  data-tip={t2("点击插入占位符")}
                  onClick={() => setText((v) => v + ph)}
                >
                  {ph}
                </button>
              ))}
            </div>
          </div>

          <span className="np-bren-k">{t2("字体")}</span>
          <div className="np-wm-ctl">
            <Seg
              value={fontName}
              onChange={setFontName}
              options={[
                { value: "kaiti", label: t2("楷体") },
                { value: "heiti", label: t2("黑体") },
                { value: "fangsong", label: t2("仿宋") },
                { value: "dengxian", label: t2("等线") },
              ]}
            />
          </div>

          <span className={"np-bren-k" + (isDiag ? " is-off" : "")}>
            {isDiag ? t2("字号（对角线不适用）") : t2("字号（5–99）")}
          </span>
          <div className={"np-wm-ctl" + (isDiag ? " is-off" : "")}>
            <InputGroup
              size="small"
              value={fontSizeText}
              spellCheck={false}
              disabled={isDiag}
              onChange={(e) => setFontSizeText(e.target.value)}
            />
          </div>

          <span className="np-bren-k">{t2("颜色")}</span>
          <div className="np-wm-ctl">
            <Seg
              value={fontColor}
              onChange={setFontColor}
              options={[
                { value: "black", label: t2("黑") },
                { value: "gray", label: t2("灰") },
                { value: "red", label: t2("红") },
                { value: "white", label: t2("白") },
                { value: "green", label: t2("绿") },
                { value: "yellow", label: t2("黄") },
                { value: "blue", label: t2("蓝") },
                { value: "purple", label: t2("紫") },
              ]}
            />
          </div>

          <span className="np-bren-k">{t2("不透明度（0–10）")}</span>
          <div className="np-wm-ctl">
            <Slider
              min={0}
              max={10}
              stepSize={1}
              labelValues={[0, 5, 10]}
              value={transparency}
              onChange={(v) => setTransparency(Array.isArray(v) ? v[0] : v)}
            />
          </div>

          <span className="np-bren-k">{t2("位置")}</span>
          <div className="np-wm-ctl">
            <div className="np-wm-pos">
              <PosGrid value={isDiag ? "" : position} onChange={setPosition} />
              <Seg value={position} onChange={setPosition} options={diagOpts} />
            </div>
          </div>

          <span className={"np-bren-k" + (isDiag ? " is-off" : "")}>
            {isDiag ? t2("边距（对角线不适用）") : t2("边距（pt，0–1000）")}
          </span>
          <div className={"np-wm-ctl" + (isDiag ? " is-off" : "")}>
            <InputGroup
              size="small"
              value={marginText}
              spellCheck={false}
              disabled={isDiag}
              onChange={(e) => setMarginText(e.target.value)}
            />
          </div>

          <span className="np-bren-k">{t2("页面范围")}</span>
          <div className="np-wm-ctl">
            <Seg
              value={pageRange}
              onChange={setPageRange}
              options={[
                { value: "all", label: t2("全部页面") },
                { value: "odd", label: t2("奇数页") },
                { value: "even", label: t2("偶数页") },
                { value: "custom", label: t2("自定义") },
              ]}
            />
            {isCustomRange && (
              <InputGroup
                className="np-wm-fill"
                size="small"
                value={spec}
                spellCheck={false}
                placeholder={t2("如 1-3,5,8-（8- 表示第 8 页到末页）")}
                onChange={(e) => setSpec(e.target.value)}
              />
            )}
          </div>

          <span className="np-bren-k">{t2("页码格式")}</span>
          <div className="np-wm-ctl">
            <Seg
              value={pageNumberFormat}
              onChange={setPageNumberFormat}
              options={[
                { value: "plain", label: "1" },
                { value: "dash", label: "-1-" },
                { value: "cn", label: t2("第1页") },
                { value: "frac", label: "1/6" },
                { value: "cnfrac", label: t2("第1页/共N页") },
              ]}
            />
          </div>

          <span className="np-bren-k">{t2("日期格式")}</span>
          <div className="np-wm-ctl">
            <Seg
              value={datetimeFormat}
              onChange={setDatetimeFormat}
              options={[
                { value: "cn", label: t2("yyyy年MM月dd日") },
                { value: "slash", label: "yyyy/MM/dd" },
                { value: "dash", label: "yyyy-MM-dd" },
              ]}
            />
          </div>

          <span className="np-bren-k">{t2("输出文件名")}</span>
          <div className="np-wm-ctl">
            <InputGroup
              className="np-wm-fill"
              size="small"
              value={outName}
              spellCheck={false}
              onChange={(e) => setOutName(e.target.value)}
            />
            <div className="np-wm-chips">
              {["[原文件名]", "[原文件夹名]", "[日期时间]"].map((ph) => (
                <button
                  key={ph}
                  className="np-wm-chip"
                  data-tip={t2("点击插入占位符")}
                  onClick={() => setOutName((v) => v + ph)}
                >
                  {ph}
                </button>
              ))}
            </div>
          </div>
        </div>
        {(fontSizeErr || marginErr || specErr) && (
          <div className="np-dialog-error">
            {[fontSizeErr, marginErr, specErr].filter(Boolean).join(t2("；"))}
          </div>
        )}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {t2(
              "文字与输出名支持占位符，点击输入框下方的按钮即可插入；页码按「页码格式」渲染，[页面标签] 暂以页码代替。输出按「输出文件名」模板旁写 PDF，同名自动 (2) 递增，不覆盖原文件。",
            )}
          </span>
          <span className="np-dialog-note-row np-dialog-note-path" title={previewPath}>
            {t2("输出预览：{out}", { out: previewPath })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("加水印")}
        disabled={!valid}
        onOk={() => {
          saveDialogPrefs("pdfWatermark", {
            text: text.trim(),
            fontName,
            fontSize: fontSizeOut,
            fontColor,
            position,
            transparency,
            margin: marginOut,
            pageRange: rangeOut,
            pageNumberFormat,
            datetimeFormat,
            outName,
          });
          onDone({
            paths: items,
            text: text.trim(),
            fontName,
            fontSize: fontSizeOut,
            fontColor,
            position,
            transparency,
            margin: marginOut,
            pageRange: rangeOut,
            pageNumberFormat,
            datetimeFormat,
          });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ─────────── 通用文件合并（2026-11-03 §4.9 对齐，取代裸输入框）───────────
// 图片合并转 PDF / CSV 合并 / 文本合并共用：清单拖动定序 + 输出名 + 预览。
// 三者此前只有一个输入文件名的 input 对话框，顺序既不可见也不可调。

/** 各合并口味的文案与输出扩展名（标题在 DialogHost 集中映射）；
 *  fallbackStem = 智能默认名的回退干（单/多对象目录名不可用时） */
const MERGE_FLAVORS = {
  csv: {
    queueTitle: "合并顺序",
    ok: "合并",
    defName: "合并表格.csv",
    fallbackStem: "合并表格",
    ext: "csv",
    note: "按清单顺序拼接全部行，重复表头自动去除，输出 UTF-8 BOM；不覆盖原文件。",
  },
  text: {
    queueTitle: "合并顺序",
    ok: "合并",
    defName: "合并文本.txt",
    fallbackStem: "合并文本",
    ext: "txt",
    note: "按清单顺序全文拼接，空行分隔，输出 UTF-8；不覆盖原文件。",
  },
  zip: {
    queueTitle: "打包清单",
    ok: "压缩",
    defName: "归档.zip",
    fallbackStem: "归档",
    ext: "zip",
    note: "文件平铺打包、文件夹含目录结构递归打包；输出旁写，不覆盖原文件。",
  },
} as const;

/** 压缩格式（仅 filesMerge zip flavor 用；zip = Deflate 进程内 / 7z = LZMA2
 *  经内嵌 7z.exe 可加密 / targz = tar+gzip 组合，Linux/macOS 互换） */
type CompressFormat = "zip" | "7z" | "targz";
const FORMAT_META: Record<
  CompressFormat,
  { ext: string; defName: string; note: string }
> = {
  zip: {
    ext: "zip",
    defName: "归档.zip",
    note: "Deflate 压缩；图片/视频/办公文档等已压缩格式自动直存（Store）提速；密码 = AES-256（接收方需 7-Zip/WinRAR/好压等解压）。",
  },
  "7z": {
    ext: "7z",
    defName: "归档.7z",
    note: "LZMA2 高压缩比（经内嵌 7-Zip）；可选 AES-256 密码，勾选后同时加密文件清单。",
  },
  targz: {
    ext: "tar.gz",
    defName: "归档.tar.gz",
    note: "tar + gzip 组合包，Linux / macOS 互换通用；文件夹结构完整保留。",
  },
};

export function MergeFilesDialog({
  flavor,
  entries,
  onDone,
}: {
  flavor: keyof typeof MERGE_FLAVORS;
  entries: FileEntry[];
  onDone(v: {
    paths: string[];
    name: string;
    format?: CompressFormat;
    password?: string;
    encryptHeader?: boolean;
  } | null): void;
}) {
  const t2 = useT();
  const cfg = MERGE_FLAVORS[flavor];
  const isZip = flavor === "zip";
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  // 压缩格式（仅 zip flavor）：zip = 进程内 Deflate、7z = 内嵌 7-Zip 可加密、
  // targz = tar+gzip 组合；切格式时默认名跟随，自定义名只换尾部扩展名；
  // 上次确认的格式与清单加密开关随 dialogPrefs 记忆（密码不入存）
  const zipInit = loadDialogPrefs("zipCompress", {
    format: "zip" as CompressFormat,
    encryptHeader: false,
  });
  const [format, setFormat] = useState<CompressFormat>(() =>
    zipInit.format === "7z" || zipInit.format === "targz" ? zipInit.format : "zip",
  );
  const [password, setPassword] = useState("");
  const [encryptHeader, setEncryptHeader] = useState(() => !!zipInit.encryptHeader);
  const meta = FORMAT_META[format];
  const ext = isZip ? meta.ext : cfg.ext;
  const note = isZip ? meta.note : cfg.note;
  const [name, setName] = useState<string>(t2(cfg.defName));
  // 用户手动改过名 = 冻结智能跟随（清单增删/冲突递增不再覆写）
  const [nameEdited, setNameEdited] = useState(false);

  function changeFormat(f: CompressFormat) {
    setFormat(f);
    if (f === "targz") {
      // tar.gz 无加密概念：清空密码与开关（zip/7z 间切换保留）
      setPassword("");
      setEncryptHeader(false);
    }
  }

  // 同名冲突内联校验（§4.9）：列输出目录现有名（首屏 2000 条；Rust 端
  // available_name 仍有全量兜底，旁写绝不静默覆盖）。
  // 2026-11-09 P1：自 zip 推广到全部 flavor（图片/CSV/文本合并此前无校验）
  const [existing, setExisting] = useState<Set<string> | null>(null);
  const dir = parentPath(entries[0]?.path ?? "");
  useEffect(() => {
    if (!dir) return;
    const outDir: string = dir;
    let live = true;
    api
      .listDir({
        path: outDir,
        sort: { key: "name", dir: "asc" },
        showHidden: true,
        offset: 0,
        limit: 2000,
      })
      .then((r) => {
        if (live) setExisting(new Set(r.entries.map((e) => e.name.toLowerCase())));
      })
      .catch(() => {
        if (live) setExisting(null);
      });
    return () => {
      live = false;
    };
  }, [dir]);

  // 智能默认名（2026-11-08 用户需求，2026-11-09 P1 推广全 flavor）：未手动改名
  // 时跟随清单——单对象 = 对象名（文件去扩展名）、多对象 = 所在目录名，回退
  // 各口味语义干；与现有名冲突自动 (2) 递增；格式切换换扩展名。手动改名即冻结
  const ext0 = isZip ? meta.ext : cfg.ext;
  useEffect(() => {
    if (nameEdited) return;
    const infos = items.map((p) => ({
      name: fileNameOf(p),
      isDir: entries.find((e) => e.path === p)?.isDir ?? false,
    }));
    const stem = smartArchiveStem(infos, dir ? fileNameOf(dir) : null, t2(cfg.fallbackStem));
    let cand = `${stem}.${ext0}`;
    let n = 2;
    while (existing?.has(cand.toLowerCase()) && n < 100) {
      cand = `${stem} (${n}).${ext0}`;
      n += 1;
    }
    setName(cand);
  }, [nameEdited, items, existing, ext0, dir, entries, cfg.fallbackStem]);

  const trimmed = name.trim();
  // 缺扩展名时补上（与 Rust 端落名同口径；返回值即最终文件名）
  const withExt = trimmed.toLowerCase().endsWith("." + ext)
    ? trimmed
    : `${trimmed}.${ext}`;
  // 输出名三段校验：非空 / Windows 合法名 / 同名冲突（红字内联）
  const err = !trimmed
    ? t2("请输入文件名")
    : !isValidName(withExt)
      ? t2("名称含非法字符或为 Windows 保留名")
      : existing?.has(withExt.toLowerCase())
        ? t2("同名文件已存在，请换一个名字")
        : null;
  const valid = !err && items.length > 0;
  const preview = dir ? joinPath(dir, withExt) : withExt;
  const payload = () => ({
    paths: items,
    name: withExt,
    ...(isZip
      ? {
          format,
          password:
            (format === "7z" || format === "zip") && password ? password : undefined,
          encryptHeader: format === "7z" && password ? encryptHeader : undefined,
        }
      : {}),
  });
  const submit = () => {
    // 压缩口味记忆格式与清单加密开关（密码永不入存）
    if (isZip) saveDialogPrefs("zipCompress", { format, encryptHeader });
    onDone(payload());
  };
  return (
    <>
      <DialogBody>
        <QueueSection title={t2(cfg.queueTitle)} items={items} onChange={setItems} />
        <div className="np-pdfmform">
          {isZip && (
            <FormRow k={t2("格式")} wide>
              <Seg
                value={format}
                options={[
                  { value: "zip", label: "zip" },
                  { value: "7z", label: "7z" },
                  { value: "targz", label: "tar.gz" },
                ]}
                onChange={(f) => changeFormat(f as CompressFormat)}
              />
            </FormRow>
          )}
          <FormRow k={t2("输出名")}>
            <InputGroup
              size="small"
              value={name}
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) submit();
              }}
            />
          </FormRow>
          {isZip && format !== "targz" && (
            <>
              <FormRow k={t2("密码")}>
                <InputGroup
                  size="small"
                  type="password"
                  value={password}
                  placeholder={t2("AES-256，留空 = 不加密")}
                  spellCheck={false}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </FormRow>
              {password && format === "7z" && (
                <FormRow k="" wide>
                  <Checkbox
                    checked={encryptHeader}
                    label={t2("同时加密文件清单（-mhe）")}
                    onChange={(e) => setEncryptHeader(e.currentTarget.checked)}
                  />
                </FormRow>
              )}
            </>
          )}
        </div>
        {err && <div className="np-dialog-error">{err}</div>}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">{t2(note)}</span>
          <span className="np-dialog-note-row np-dialog-note-path" title={preview}>
            {t2("输出预览：{out}", { out: preview })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2(cfg.ok)}
        disabled={!valid}
        onOk={submit}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ───────────── PDF 提取页 / 删除页（2026-11-03 §4.9 对齐）─────────────
// 此前是裸 input 对话框；现升级：文件与页数回显 + 页码范围解析预演
// （lib/pdfOps.parsePageSpec 与 Rust parse_page_ranges 同口径，错误文案
//  与提交后一致）+ 输出预览。Rust 端仍是最终校验。

export function PdfPagesDialog({
  mode,
  entry,
  onDone,
}: {
  mode: "extract" | "remove";
  entry: FileEntry;
  /** 成功 = 页码范围表达式（已客户端校验）；null = 取消 */
  onDone(v: string | null): void;
}) {
  const t2 = useT();
  const extract = mode === "extract";
  const [total, setTotal] = useState<number | null>(null);
  const [spec, setSpec] = useState("");
  useEffect(() => {
    let live = true;
    api.pdfPageCount(entry.path).then(
      (n) => live && setTotal(n),
      () => live && setTotal(-1),
    );
    return () => {
      live = false;
    };
  }, [entry.path]);

  const parsed =
    total !== null && total > 0 && spec.trim() ? parsePageSpec(spec, total) : null;
  const err = parsed && parsed.error ? parsed.error : null;
  const pages = parsed && !parsed.error ? parsed.pages : null;
  // 删除模式不允许删光全部页（补集为空无从另存）
  const wipeAll = !extract && pages !== null && pages.length >= (total ?? 0);
  const valid = pages !== null && !wipeAll;
  const stem = nameOf(entry.path).replace(/\.pdf$/i, "");
  const outName = stem + (extract ? t2("_提取") : t2("_删页")) + ".pdf";
  const preview = joinPath(parentPath(entry.path) ?? "", outName);
  const brief = pages ? pagesToSpec(pages) : "";

  return (
    <>
      <DialogBody>
        <div className="np-pdfmsec">
          <span className="np-bren-k">{t2("处理文件")}</span>
          <span className="np-dialog-muted">
            {total === null
              ? t2("正在读取页数…")
              : total > 0
                ? t2("共 {n} 页", { n: total })
                : t2("页数读取失败（文件可能损坏或加密）")}
          </span>
        </div>
        <div className="np-pdfmlist">
          <div className="np-pdfmlist-item" title={entry.path}>
            <span className="np-ellipsis np-pdfmlist-name">{nameOf(entry.path)}</span>
          </div>
        </div>
        <div className="np-pdfmform">
          <FormRow k={t2("页码范围")} wide>
            <InputGroup
              size="small"
              value={spec}
              spellCheck={false}
              placeholder={t2("如 1-3,5,8-（8- 表示第 8 页到末页）")}
              onChange={(e) => setSpec(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) onDone(spec.trim());
              }}
            />
          </FormRow>
        </div>
        {err && <div className="np-dialog-error">{err}</div>}
        {wipeAll && (
          <div className="np-dialog-error">{t2("至少保留 1 页，不能删除全部页面")}</div>
        )}
        <div className="np-dialog-note">
          {valid && total !== null && (
            <span className="np-dialog-note-row">
              {extract
                ? t2("将提取 {n} 页（{brief}）为新文件", { n: pages?.length, brief })
                : t2("将删除 {n} 页（{brief}），其余 {k} 页另存为新文件", {
                    n: pages?.length,
                    brief,
                    k: total - (pages?.length ?? 0),
                  })}
            </span>
          )}
          <span className="np-dialog-note-row np-dialog-note-path" title={preview}>
            {t2("输出预览：{out}", { out: preview })}
          </span>
          <span className="np-dialog-note-row">
            {extract
              ? t2("同名输出自动 (2) 递增。")
              : t2("原文件不动，同名输出自动 (2) 递增。")}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={extract ? t2("提取") : t2("删除并另存")}
        disabled={!valid}
        onOk={() => onDone(spec.trim())}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** 导出文件清单参数面板（2026-11-10 五次定案）：穿透子文件夹 / 导出内容
 *  （文件·文件夹·全部）/ 导出格式 / 文件名（内联校验），确认后由
 *  operations.runExportListing 直存当前文件夹（文件名随文件夹名回落）；
 *  穿透/内容/格式随 settings.dialogPrefs 记忆，文件名按目录现算不记忆 */
export function ExportListingDialog({
  entries,
  dir,
  onDone,
}: {
  entries: FileEntry[];
  dir: string;
  onDone(v: ExportListingOptions | null): void;
}) {
  const t2 = useT();
  const blank = entries.length === 0;
  // 格式不记忆（2026-11-10 用户定案）：每次打开恒默认 XLSX，记住的旧格式
  // 不反压默认；穿透/内容仍随 settings.dialogPrefs 记忆
  const prefs = loadDialogPrefs("exportListing", {
    recursive: blank,
    content: "all",
  });
  const [recursive, setRecursive] = useState(prefs.recursive === true);
  const [content, setContent] = useState<"all" | "files" | "dirs">(
    prefs.content === "files" || prefs.content === "dirs" ? prefs.content : "all",
  );
  const [fmt, setFmt] = useState<ListingFormat>("xlsx");
  const [name, setName] = useState(() => exportListingDefaultName(dir));
  const nameOk = isValidName(name.trim());
  return (
    <>
      <DialogBody>
        <div className="np-bren-form is-cols">
          <FormRow k={t2("穿透子文件夹")}>
            <Checkbox
              checked={recursive}
              onChange={(e) => setRecursive(e.currentTarget.checked)}
              label={t2("递归包含所有子文件夹内容")}
            />
          </FormRow>
          <FormRow k={t2("导出内容")}>
            <Seg<"all" | "files" | "dirs">
              value={content}
              onChange={setContent}
              options={[
                { value: "all", label: t2("文件和文件夹") },
                { value: "files", label: t2("仅文件") },
                { value: "dirs", label: t2("仅文件夹") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("导出格式")}>
            <Seg<ListingFormat>
              value={fmt}
              onChange={setFmt}
              options={[
                { value: "xlsx", label: "XLSX", title: t2("Excel 工作簿（默认）") },
                { value: "csv", label: "CSV", title: t2("表格数据，Excel 友好") },
                { value: "md", label: "Markdown", title: t2("人类可读表格") },
                { value: "txt", label: t2("纯文本"), title: t2("完整路径一行一个") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("文件名")}>
            <span className="np-filext">
              <InputGroup
                size="small"
                value={name}
                spellCheck={false}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
              <span className="np-dialog-muted">.{fmt}</span>
            </span>
          </FormRow>
        </div>
        {!nameOk && (
          <div className="np-dialog-error">
            {t2("名称含非法字符或为 Windows 保留名")}
          </div>
        )}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {blank
              ? t2(recursive
                  ? "导出当前文件夹（含子文件夹），直存 {dir}，重名自动 (2) 递增"
                  : "导出当前文件夹（仅直接子项），直存 {dir}，重名自动 (2) 递增", { dir })
              : t2("导出选中 {n} 项，直存 {dir}，重名自动 (2) 递增", {
                  n: entries.length,
                  dir,
                })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("导出")}
        disabled={!nameOk}
        onOk={() => {
          saveDialogPrefs("exportListing", { recursive, content });
          onDone({
            recursive,
            content,
            fmt,
            fileName: name.trim() || exportListingDefaultName(dir),
          });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** PDF 拆分参数面板（2026-11-10 参数化）：拆分方式（按页数 N / 按书签层级，
 *  行级关联禁用）+ 命名规则（占位符 [原文件名] [序号] [页码]）+ 存入子文件
 *  夹 Switch，确认后由 operations.runPdfSplit 入任务引擎；全部参数随
 *  settings.dialogPrefs 记忆 */
export function PdfSplitDialog({
  entry,
  dir,
  onDone,
}: {
  entry: FileEntry;
  dir: string;
  onDone(v: (PdfSplitOptions & { outDir: string }) | null): void;
}) {
  const t2 = useT();
  const prefs = loadDialogPrefs("pdfSplit", {
    method: "pages",
    nPages: 1,
    bookmarkLevel: 0,
    namingRule: PDF_SPLIT_DEFAULT_RULE,
    saveToFolder: false,
  });
  const [method, setMethod] = useState<PdfSplitMethod>(
    prefs.method === "bookmarks" ? "bookmarks" : "pages",
  );
  const num = (v: number, fb: number, min: number) =>
    Number.isFinite(v) && v >= min ? Math.floor(v) : fb;
  const [nPages, setNPages] = useState(num(Number(prefs.nPages), 1, 1));
  const [bookmarkLevel, setBookmarkLevel] = useState(
    num(Number(prefs.bookmarkLevel), 0, 0),
  );
  const [namingRule, setNamingRule] = useState(
    typeof prefs.namingRule === "string" && prefs.namingRule.trim()
      ? prefs.namingRule
      : PDF_SPLIT_DEFAULT_RULE,
  );
  const [saveToFolder, setSaveToFolder] = useState(prefs.saveToFolder === true);
  const stem = fileNameOf(entry.path).replace(/\.pdf$/i, "");
  const nameOk = isValidName(
    renderPdfSplitName(namingRule.trim() || PDF_SPLIT_DEFAULT_RULE, stem, 1, 1, 1).replace(
      /\.pdf$/i,
      "",
    ),
  );
  return (
    <>
      <DialogBody>
        <div className="np-bren-form is-cols">
          <FormRow k={t2("拆分方式")}>
            <Seg<PdfSplitMethod>
              value={method}
              onChange={setMethod}
              options={[
                { value: "pages", label: t2("按页数拆分") },
                { value: "bookmarks", label: t2("按书签拆分") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("每 N 页")} off={method !== "pages"}>
            <InputGroup
              size="small"
              value={String(nPages)}
              disabled={method !== "pages"}
              spellCheck={false}
              onChange={(e) => setNPages(num(Number(e.currentTarget.value), nPages, 1))}
            />
          </FormRow>
          <FormRow k={t2("书签层级")} off={method !== "bookmarks"}>
            <InputGroup
              size="small"
              value={String(bookmarkLevel)}
              disabled={method !== "bookmarks"}
              spellCheck={false}
              onChange={(e) =>
                setBookmarkLevel(num(Number(e.currentTarget.value), bookmarkLevel, 0))
              }
            />
          </FormRow>
          <FormRow k={t2("命名规则")} wide>
            <span className="np-filext">
              <InputGroup
                size="small"
                value={namingRule}
                spellCheck={false}
                onChange={(e) => setNamingRule(e.currentTarget.value)}
              />
              <span className="np-dialog-muted">.pdf</span>
            </span>
          </FormRow>
          <FormRow k={t2("存入子文件夹")} wide>
            <Checkbox
              checked={saveToFolder}
              onChange={(e) => setSaveToFolder(e.currentTarget.checked)}
              label={t2("按原文件名建子文件夹（批量拆分建议开启，避免文件混杂）")}
            />
          </FormRow>
        </div>
        {!nameOk && (
          <div className="np-dialog-error">
            {t2("命名规则渲染出的文件名含非法字符")}
          </div>
        )}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {t2("占位符：[原文件名] [序号] [页码]（起始-结束），自动补 .pdf；输出预演：")}
            {method === "pages"
              ? t2("每 {n} 页一份", { n: nPages })
              : t2("按书签层级 {l} 拆分，份量由书签决定", { l: bookmarkLevel })}
            {" → "}
            {renderPdfSplitName(namingRule.trim() || PDF_SPLIT_DEFAULT_RULE, stem, 1, 1, 1)} …
          </span>
          <span className="np-dialog-note-row np-dialog-note-path" title={dir}>
            {t2("直存 {dir}，重名自动 (2) 递增", { dir })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("拆分")}
        disabled={!nameOk}
        onOk={() => {
          saveDialogPrefs("pdfSplit", {
            method,
            nPages,
            bookmarkLevel,
            namingRule: namingRule.trim() || PDF_SPLIT_DEFAULT_RULE,
            saveToFolder,
          });
          onDone({
            method,
            nPages,
            bookmarkLevel,
            namingRule: namingRule.trim() || PDF_SPLIT_DEFAULT_RULE,
            saveToFolder,
            outDir: saveToFolder ? joinPath(dir, stem) : dir,
          });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ───────────── PDF 插入空白页（2026-11-11：12 模式 + 指定页码 + 间隔 N）─────────────
// 模式 8/9 露指定页码（parsePageSpec 同口径预演校验），10/11/12 露间隔 N；
// 输出名旁写 "<stem>_插页.pdf"。模式/N 随 dialogPrefs 记忆（页码是文档相关
// 输入，不记忆）。

export function PdfInsertBlankDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  /** 成功 = { 模式, 指定页码, 间隔 N }；null = 取消 */
  onDone(v: { mode: number; spec: string; n: number } | null): void;
}) {
  const t2 = useT();
  const prefs = loadDialogPrefs("pdfInsertBlank", { mode: 1, n: 2 });
  const [mode, setMode] = useState<number>(
    BLANK_MODES.some((m) => m.value === prefs.mode) ? Number(prefs.mode) : 1,
  );
  const [spec, setSpec] = useState("");
  const num = (v: unknown, fb: number) =>
    Number.isFinite(Number(v)) && Number(v) >= 2 && Number(v) <= 20
      ? Math.floor(Number(v))
      : fb;
  const [n, setN] = useState(num(prefs.n, 2));
  const needSpec = blankModeNeedsSpec(mode);
  const needN = blankModeNeedsN(mode);
  const stem = nameOf(entries[0]?.path ?? "").replace(/\.pdf$/i, "");
  const specParsed = needSpec && spec.trim() ? parsePageSpec(spec, 9999) : null;
  const specErr = needSpec
    ? !spec.trim()
      ? t2("请输入指定页码（如 1-3,5,8）")
      : specParsed?.error
        ? t2("页码表达式暂按 1–9999 预演：{e}（最终以文档真实页数校验）", { e: specParsed.error })
        : null
    : null;
  const valid = !specErr;
  // 模式人话提示（12 模式按类组一句）
  const blankHint = (() => {
    if (mode === 1 || mode === 2)
      return t2("总页数为奇数时在{pos}补 1 页；已为偶数则原样复制输出", {
        pos: mode === 1 ? t2("末尾") : t2("开头"),
      });
    if (blankModeNeedsSpec(mode))
      return t2("在指定页码{pos}各插 1 页 A4 空白页", { pos: mode === 8 ? t2("前") : t2("后") });
    if (mode === 12) return t2("每隔 {n} 页插 1 页 A4 空白页", { n });
    if (needN)
      return t2("总页数非 {n} 倍数时在{pos}补至倍数", {
        n,
        pos: mode === 10 ? t2("开头") : t2("末尾"),
      });
    const pos =
      mode === 3
        ? t2("第一页前")
        : mode === 4
          ? t2("第一页后")
          : mode === 5
            ? t2("最后一页后")
            : mode === 6
              ? t2("每页前")
              : t2("每页后");
    return t2("在{pos}插 1 页 A4 空白页", { pos });
  })();
  return (
    <>
      <DialogBody>
        <div className="np-pdfmsec">
          <span className="np-bren-k">{t2("处理文件")}</span>
          <span className="np-dialog-muted">
            {t2("选中 {n} 个 PDF，逐份旁写「<名称>_插页.pdf」，原文件不动", {
              n: entries.length,
            })}
          </span>
        </div>
        <div className="np-bren-form is-cols">
          <FormRow k={t2("插入模式")} wide>
            <NpSelect
              value={String(mode)}
              options={BLANK_MODES.map((m) => ({
                value: String(m.value),
                label: `${m.value} · ${t2(m.label)}`,
              }))}
              onChange={(v) => setMode(Number(v))}
            />
          </FormRow>
          {needSpec && (
            <FormRow k={t2("指定页码")} wide>
              <InputGroup
                size="small"
                value={spec}
                autoFocus
                spellCheck={false}
                placeholder={t2("如 1-3,5,8（按原文档页号）")}
                onChange={(e) => setSpec(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid) onDone({ mode, spec: spec.trim(), n });
                }}
              />
            </FormRow>
          )}
          {needN && (
            <FormRow k={t2("间隔 N")}>
              <InputGroup
                size="small"
                value={String(n)}
                onChange={(e) => setN(num(e.currentTarget.value, n))}
              />
            </FormRow>
          )}
        </div>
        {specErr && <div className="np-dialog-error">{specErr}</div>}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">{blankHint}</span>
          <span className="np-dialog-note-row np-dialog-note-path" title={`${stem}${t2("_插页")}.pdf`}>
            {t2("输出预览：{out}", { out: `${stem}${t2("_插页")}.pdf` })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("插入")}
        disabled={!valid}
        onOk={() => {
          saveDialogPrefs("pdfInsertBlank", { mode, n });
          onDone({ mode, spec: spec.trim(), n });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ───────────── PDF 转图片（2026-11-11：页范围 / DPI / 口令 / 子文件夹）─────────────
// 渲染在前端 pdf.js（回执后 operations.pdfToPngs 走本地任务通道推进度）；
// 口令不入 dialogPrefs 存档。

export function PdfToPngDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  /** 成功 = PdfToPngOptions；null = 取消 */
  onDone(v: PdfToPngOptions | null): void;
}) {
  const t2 = useT();
  const prefs = loadDialogPrefs("pdfToPng", { dpi: 150, saveToFolder: true });
  const num = (v: unknown, fb: number, min: number, max: number) =>
    Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max
      ? Math.floor(Number(v))
      : fb;
  const [startPage, setStartPage] = useState("");
  const [endPage, setEndPage] = useState("");
  const [dpi, setDpi] = useState(num(prefs.dpi, 150, 72, 600));
  const [userPassword, setUserPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [saveToFolder, setSaveToFolder] = useState(prefs.saveToFolder !== false);
  const dir = parentPath(entries[0]?.path ?? "");
  const stem = nameOf(entries[0]?.path ?? "").replace(/\.pdf$/i, "");
  const startNum = Number(startPage) || 0;
  const endNum = Number(endPage) || 0;
  const rangeErr =
    startNum > endNum && endNum > 0
      ? t2("起始页不能大于结束页")
      : startNum < 0 || endNum < 0
        ? t2("页码不能为负")
        : null;
  const valid = !rangeErr;
  return (
    <>
      <DialogBody>
        <div className="np-pdfmsec">
          <span className="np-bren-k">{t2("处理文件")}</span>
          <span className="np-dialog-muted">
            {t2("选中 {n} 个 PDF，逐页转 PNG（渲染由内置 pdf.js 完成）", {
              n: entries.length,
            })}
          </span>
        </div>
        <div className="np-bren-form is-cols">
          <FormRow k={t2("起始页")}>
            <InputGroup
              size="small"
              value={startPage}
              placeholder={t2("1")}
              spellCheck={false}
              onChange={(e) => setStartPage(e.target.value)}
            />
          </FormRow>
          <FormRow k={t2("结束页")}>
            <InputGroup
              size="small"
              value={endPage}
              placeholder={t2("到末页")}
              spellCheck={false}
              onChange={(e) => setEndPage(e.target.value)}
            />
          </FormRow>
          <FormRow k={t2("分辨率 DPI")}>
            <InputGroup
              size="small"
              value={String(dpi)}
              spellCheck={false}
              onChange={(e) => setDpi(num(e.currentTarget.value, dpi, 72, 600))}
            />
          </FormRow>
          <FormRow k={t2("开箱密码")} wide>
            <InputGroup
              size="small"
              type="password"
              value={userPassword}
              placeholder={t2("加密 PDF 时填写")}
              spellCheck={false}
              onChange={(e) => setUserPassword(e.target.value)}
            />
          </FormRow>
          <FormRow k={t2("权限密码")} wide>
            <InputGroup
              size="small"
              type="password"
              value={ownerPassword}
              placeholder={t2("仅权限加密时填写")}
              spellCheck={false}
              onChange={(e) => setOwnerPassword(e.target.value)}
            />
          </FormRow>
          <FormRow k={t2("独立子文件夹")} wide>
            <Checkbox
              checked={saveToFolder}
              onChange={(e) => setSaveToFolder(e.currentTarget.checked)}
              label={t2("每个源 PDF 的图片存进「<名称>_图片」子文件夹")}
            />
          </FormRow>
        </div>
        {rangeErr && <div className="np-dialog-error">{rangeErr}</div>}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {t2("DPI 越高越清晰（默认 150；72 屏显 / 300 印刷），页号文件名补零排序。")}
          </span>
          <span
            className="np-dialog-note-row np-dialog-note-path"
            title={saveToFolder
              ? `${pdfPngDirName(stem)}\\${pdfPngFileName(stem, 1, 1)} …`
              : `${pdfPngFileName(stem, 1, 1)} …`}
          >
            {t2("输出预览：{out}", {
              out: saveToFolder
                ? `${pdfPngDirName(stem)}\\${pdfPngFileName(stem, 1, 1)} …`
                : `${pdfPngFileName(stem, 1, 1)} …`,
            })}
            {dir ? t2("（存于 {dir}）", { dir }) : ""}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("转图片")}
        disabled={!valid}
        onOk={() => {
          saveDialogPrefs("pdfToPng", { dpi, saveToFolder });
          onDone({
            startPage: startNum,
            endPage: endNum,
            dpi,
            userPassword,
            ownerPassword,
            saveToFolder,
          });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ───────────── PDF 加密 / 解密（2026-11-11：口令 + 三权限位 / 权限密码）─────────────
// 加密 = AES-128（lopdf V4/R4 StdCF），perm* = true 即「禁止」对应权限
// （默认三禁止，与参数口径一致）；密码均不入 dialogPrefs 存档。

export function PdfEncryptDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  /** 成功 = 口令与权限开关组；null = 取消 */
  onDone(v: PdfEncryptPayload | null): void;
}) {
  const t2 = useT();
  const prefs = loadDialogPrefs("pdfEncrypt", {
    permPrint: true,
    permCopy: true,
    permEdit: true,
  });
  const [openPassword, setOpenPassword] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const bool = (v: unknown) => v === true;
  const [permPrint, setPermPrint] = useState(bool(prefs.permPrint));
  const [permCopy, setPermCopy] = useState(bool(prefs.permCopy));
  const [permEdit, setPermEdit] = useState(bool(prefs.permEdit));
  const stem = nameOf(entries[0]?.path ?? "").replace(/\.pdf$/i, "");
  const err =
    !openPassword.trim() && !editPassword.trim()
      ? t2("开箱密码与权限密码至少填写一个")
      : null;
  return (
    <>
      <DialogBody>
        <div className="np-pdfmsec">
          <span className="np-bren-k">{t2("处理文件")}</span>
          <span className="np-dialog-muted">
            {t2("选中 {n} 个 PDF，AES-128 加密后旁写「<名称>_加密.pdf」，原文件不动", {
              n: entries.length,
            })}
          </span>
        </div>
        <div className="np-bren-form is-cols">
          <FormRow k={t2("开箱密码")} wide>
            <InputGroup
              size="small"
              type="password"
              value={openPassword}
              autoFocus
              placeholder={t2("打开/查看所需口令")}
              spellCheck={false}
              onChange={(e) => setOpenPassword(e.target.value)}
            />
          </FormRow>
          <FormRow k={t2("权限密码")} wide>
            <InputGroup
              size="small"
              type="password"
              value={editPassword}
              placeholder={t2("所有者口令，空 = 沿用开箱密码")}
              spellCheck={false}
              onChange={(e) => setEditPassword(e.target.value)}
            />
          </FormRow>
          <FormRow k={t2("禁止打印")}>
            <Switch
              checked={permPrint}
              label={t2("开启后不允许打印")}
              onChange={(e) => setPermPrint(e.currentTarget.checked)}
            />
          </FormRow>
          <FormRow k={t2("禁止复制")}>
            <Switch
              checked={permCopy}
              label={t2("开启后不允许复制文本")}
              onChange={(e) => setPermCopy(e.currentTarget.checked)}
            />
          </FormRow>
          <FormRow k={t2("禁止编辑")}>
            <Switch
              checked={permEdit}
              label={t2("开启后不允许修改内容")}
              onChange={(e) => setPermEdit(e.currentTarget.checked)}
            />
          </FormRow>
        </div>
        {err && <div className="np-dialog-error">{err}</div>}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {t2("三个开关默认全开 = 禁止打印/复制/编辑（权限密码持有者不受限）。")}
          </span>
          <span className="np-dialog-note-row np-dialog-note-path" title={`${stem}${t2("_加密")}.pdf`}>
            {t2("输出预览：{out}", { out: `${stem}${t2("_加密")}.pdf` })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("加密")}
        disabled={!!err}
        onOk={() => {
          saveDialogPrefs("pdfEncrypt", { permPrint, permCopy, permEdit });
          onDone({ openPassword, editPassword, permPrint, permCopy, permEdit });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

export function PdfDecryptDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  /** 成功 = { 密码 }；null = 取消 */
  onDone(v: { password: string } | null): void;
}) {
  const t2 = useT();
  const [password, setPassword] = useState("");
  const stem = nameOf(entries[0]?.path ?? "").replace(/\.pdf$/i, "");
  const err = !password ? t2("请输入密码") : null;
  return (
    <>
      <DialogBody>
        <div className="np-pdfmsec">
          <span className="np-bren-k">{t2("处理文件")}</span>
          <span className="np-dialog-muted">
            {t2("选中 {n} 个 PDF，解除加密与限制后旁写「<名称>_解密.pdf」，原文件不动", {
              n: entries.length,
            })}
          </span>
        </div>
        <div className="np-bren-form is-cols">
          <FormRow k={t2("密码")} wide>
            <InputGroup
              size="small"
              type="password"
              value={password}
              autoFocus
              placeholder={t2("所有者/权限密码（开箱密码同样可解）")}
              spellCheck={false}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !err) onDone({ password });
              }}
            />
          </FormRow>
        </div>
        {err && <div className="np-dialog-error">{err}</div>}
        <div className="np-dialog-note">
          <span className="np-dialog-note-row">
            {t2("未加密的文件自动跳过并计入失败回执。")}
          </span>
          <span className="np-dialog-note-row np-dialog-note-path" title={`${stem}${t2("_解密")}.pdf`}>
            {t2("输出预览：{out}", { out: `${stem}${t2("_解密")}.pdf` })}
          </span>
        </div>
      </DialogBody>
      <Footer
        okText={t2("解密")}
        disabled={!!err}
        onOk={() => onDone({ password })}
        onCancel={() => onDone(null)}
      />
    </>
  );
}
