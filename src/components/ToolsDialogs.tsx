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
import { api, type FileEntry } from "../lib/ipc";
import { Button, Checkbox, DialogBody, DialogFooter, InputGroup, Slider } from "@blueprintjs/core";
import { ArrowRight } from "lucide-react";

import { FOLDER_BATCH_CAP, planFolders } from "../lib/folderBatch";
import { AppIcon } from "./AppIcon";
import { Seg } from "./ImgDialogs";
import { DENSITY } from "../lib/tokens";
import { QueueSection, nameOf, pathsByNames } from "./FileQueue";
import { fileNameOf, isValidName, joinPath, parentPath, smartArchiveStem } from "../lib/path";
import { pagesToSpec, parsePageSpec } from "../lib/pdfOps";

function FormRow({
  k,
  wide,
  children,
}: {
  k: string;
  /** 宽行：在 2 列参数网格中独占整行（长控件/多选项行使用） */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={"np-bren-field" + (wide ? " np-wide" : "")}>
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
 *  （与现有项重名自动 "(2)"，非法名与名单内重名红色标出） */
export function NewFoldersDialog({
  dir,
  existing,
  onDone,
}: {
  dir: string;
  existing: string[];
  onDone(names: string[] | null): void;
}) {
  const [mode, setMode] = useState<"lines" | "pattern">("lines");
  const [text, setText] = useState("");
  const [pattern, setPattern] = useState("第{}章");
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(10);
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
        <div className="np-bren-form">
          <FormRow k="方式">
            <Seg<"lines" | "pattern">
              value={mode}
              onChange={setMode}
              options={[
                { value: "lines", label: "多行名单", title: "每行一个名称" },
                { value: "pattern", label: "序号模板", title: "{} 处按起止序号展开" },
              ]}
            />
          </FormRow>
        </div>
        {mode === "lines" ? (
          <textarea
            className="np-textarea"
            rows={7}
            value={text}
            placeholder={"每行一个文件夹名，如：\n项目立项\n需求评审\n开发阶段"}
            spellCheck={false}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div className="np-bren-form">
            <FormRow k="模板">
              <InputGroup
                size="small"
                value={pattern}
                placeholder={t("名称含 {} 占位符")}
                spellCheck={false}
                onChange={(e) => setPattern(e.target.value)}
              />
            </FormRow>
            <FormRow k="起始">
              <InputGroup
                size="small"
                value={String(start)}
                spellCheck={false}
                onChange={(e) => setStart(num(e.target.value, start))}
              />
            </FormRow>
            <FormRow k="结束">
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
                {p.error ?? p.name}
              </span>
            </div>
          ))}
          {!plan.length && (
            <div className="np-bren-row is-same">
              <span className="np-bren-new is-same">
                {mode === "lines" ? "在上方输入名称名单" : "模板需含 {} 占位符"}
              </span>
            </div>
          )}
        </div>
        <div className="np-dialog-muted">
          将在 {dir} 下创建 {okNames.length} 个文件夹（与现有项重名时自动加序号）
          {errCount > 0 && `，${errCount} 项非法或重名（红色标出）`}
          {plan.length > 200 && "（仅预览前 200 行）"}
          {okNames.length >= FOLDER_BATCH_CAP && `，单次上限 ${FOLDER_BATCH_CAP} 个`}
        </div>
      </DialogBody>
      <Footer
        okText={`创建（${okNames.length} 项）`}
        disabled={!okNames.length}
        onOk={() => onDone(okNames)}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** Excel 合并（2026-11-03 §4.9 对齐）：待处理清单拖动定序（表序/行序随清单）+
 *  模式（每源表一张目标表 / 纵向拼接去重复表头）+ 输出名与预览一次成形 */
export function XlsxMergeDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: { paths: string[]; mode: "sheets" | "rows"; name: string } | null): void;
}) {
  const t2 = useT();
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const [mode, setMode] = useState<"sheets" | "rows">("sheets");
  const [name, setName] = useState("合并表格.xlsx");
  const trimmed = name.trim();
  const valid = trimmed.length > 0;
  // 与 Rust 端同口径：缺 .xlsx 后缀时补上
  const withExt = trimmed.toLowerCase().endsWith(".xlsx") ? trimmed : `${trimmed}.xlsx`;
  const preview = joinPath(parentPath(entries[0]?.path ?? "") ?? "", withExt);
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
                { value: "sheets", label: "分表保留", title: "每个源工作表一张目标表" },
                { value: "rows", label: "纵向拼接", title: "全部行并入一张表，重复表头自动去除" },
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
                if (e.key === "Enter" && valid)
                  onDone({ paths: items, mode, name: withExt });
              }}
            />
          </FormRow>
        </div>
        <div className="np-dialog-muted">
          {t2(
            "按清单顺序合并 {n} 个工作簿（xlsx/xlsm/xls/xlsb/ods 均可读，统一输出 .xlsx），旁写新文件不覆盖原文件。",
            { n: entries.length },
          )}
          {t2("输出预览：{out}", { out: preview })}
        </div>
      </DialogBody>
      <Footer
        okText={t2("合并")}
        disabled={!valid}
        onOk={() => onDone({ paths: items, mode, name: withExt })}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** PDF 合并扩展对话框（2026-10-22）：
 *  files 变体 = 待合并清单（默认按名称自然序，行可拖动实时调整合并顺序——
 *  Pointer 事件实现：应用窗口注册了 OLE 拖放，HTML5 DnD 事件被拦截不可用）；
 *  folders 变体 = 选中的文件夹（各递归收集，各自输出 合并结果-<名>-<ts>.pdf，
 *  支持 1 个文件夹）。布局分区：合并顺序 → 输出 → 打印补页 → 输出预览 */
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
  const [autoBlank, setAutoBlank] = useState(false);
  const [blankFirst, setBlankFirst] = useState(false);
  const [name, setName] = useState("合并文档.pdf");
  const valid = byFolder || name.trim().length > 0;
  const output = parentOf(entries[0]?.path ?? '') + "\\" + (name.trim() || "合并文档.pdf");

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
          </>
        ) : (
          <QueueSection title={t2("合并顺序")} items={items} onChange={setItems} />
        )}
        <div className="np-pdfmform">
          {variant === "folders" && (
            <div className="np-dialog-muted" style={{ margin: 0 }}>
              {t2("每个选中的文件夹递归收集 PDF 与图片，各自输出 合并结果-<文件夹名>-<时间戳>.pdf")}
            </div>
          )}
          {variant === "files" && (
            <FormRow k={t2("输出名")}>
              <InputGroup
                size="small"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid)
                    onDone({ autoBlank, blankFirst, name, paths: items });
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
        <div className="np-dialog-muted">
          {variant === "files"
            ? t2("输出预览：{out}", { out: output })
            : t2("按文件夹分别合并：{n} 个范围，各组输出 合并结果-<文件夹名>-<时间戳>.pdf", {
                n: entries.length,
              })}
          {t2("；缺失或不可读的文件自动跳过，不覆盖原文件。")}
        </div>
      </DialogBody>
      <Footer
        okText={t2("合并")}
        disabled={!valid}
        onOk={() =>
          onDone({
            autoBlank,
            blankFirst,
            name,
            paths: byFolder ? entries.map((e) => e.path) : items,
          })
        }
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** 位置九宫格（3×3），选中点由 index.css 的 ::after 圆点承担 */
const WM_POS_CELLS: { value: string; tip: string }[] = [
  { value: "left-top", tip: "左上" },
  { value: "mid-top", tip: "中上" },
  { value: "right-top", tip: "右上" },
  { value: "left-mid", tip: "左中" },
  { value: "center", tip: "正中" },
  { value: "right-mid", tip: "右中" },
  { value: "left-bottom", tip: "左下" },
  { value: "mid-bottom", tip: "中下" },
  { value: "right-bottom", tip: "右下" },
];

function PosGrid({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="np-wm-grid">
      {WM_POS_CELLS.map((c) => (
        <button
          key={c.value}
          className={"np-wm-cell" + (value === c.value ? " on" : "")}
          data-tip={c.tip}
          onClick={() => onChange(c.value)}
        />
      ))}
    </div>
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
 *  输出名模板；占位符 chips 随输入框纵排 */
export function PdfWatermarkDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: PdfWatermarkSettings | null): void;
}) {
  const t2 = useT();
  const [text, setText] = useState("[原文件名]-[页码]");
  const [fontName, setFontName] = useState("heiti");
  const [fontSize, setFontSize] = useState(14);
  const [fontColor, setFontColor] = useState("black");
  const [position, setPosition] = useState("right-top");
  const [transparency, setTransparency] = useState(9);
  const [margin, setMargin] = useState(20);
  const [pageRange, setPageRange] = useState("all");
  const [pageNumberFormat, setPageNumberFormat] = useState("cn");
  const [datetimeFormat, setDatetimeFormat] = useState("cn");

  const [outName, setOutName] = useState("[原文件名]-水印");
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
      : nowDate.getFullYear() + "年" + mm2 + "月" + dd2 + "日";
  // 预览与 Rust 端同口径：目录 = 文件所在目录（parent_dir），name 无 .pdf 后缀时补上
  const renderedName =
    outName.split("[原文件名]").join(stemOf(firstPath))
      .split("[原文件夹名]").join(dirOf(firstPath))
      .split("[日期时间]").join(dtText) || "水印.pdf";
  const previewPath =
    dirOf(firstPath) +
    "\\" +
    (/\.pdf$/i.test(renderedName) ? renderedName : renderedName + ".pdf");
  const valid = text.trim().length > 0;
  // 九宫格与对角线共用 position 单一状态，互斥高亮（选对角线时九宫格全熄）
  const isDiag = position === "diag-main" || position === "diag-reverse";
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

          <span className="np-bren-k">{t2("字号（5–99）")}</span>
          <div className="np-wm-ctl">
            <InputGroup
              size="small"
              value={String(fontSize)}
              spellCheck={false}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) setFontSize(Math.min(99, Math.max(5, n)));
              }}
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

          <span className="np-bren-k">{t2("边距（像素）")}</span>
          <div className="np-wm-ctl">
            <InputGroup
              size="small"
              value={String(margin)}
              spellCheck={false}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) setMargin(Math.max(0, n));
              }}
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
              ]}
            />
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
        <div className="np-dialog-muted">
          {t2(
            "文字与输出名支持占位符，点击输入框下方的按钮即可插入；页码按「页码格式」渲染，[页面标签] 暂以页码代替。输出旁写 <名称>_水印.pdf，不覆盖原文件。",
          )}
          {t2("输出预览：{out}", { out: previewPath })}
        </div>
      </DialogBody>
      <Footer
        okText={t2("加水印")}
        disabled={!valid}
        onOk={() =>
          onDone({
            paths: items,
            text: text.trim(),
            fontName,
            fontSize,
            fontColor,
            position,
            transparency,
            margin,
            pageRange,
            pageNumberFormat,
            datetimeFormat,
          })
        }
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ─────────── 通用文件合并（2026-11-03 §4.9 对齐，取代裸输入框）───────────
// 图片合并转 PDF / CSV 合并 / 文本合并共用：清单拖动定序 + 输出名 + 预览。
// 三者此前只有一个输入文件名的 input 对话框，顺序既不可见也不可调。

/** 各合并口味的文案与输出扩展名（标题在 DialogHost 集中映射） */
const MERGE_FLAVORS = {
  images: {
    queueTitle: "合并顺序",
    ok: "合并",
    defName: "合并图片.pdf",
    ext: "pdf",
    note: "每张图片一页，按清单顺序合成 PDF（PNG/JPEG 均可）；输出旁写，不覆盖原文件。",
  },
  csv: {
    queueTitle: "合并顺序",
    ok: "合并",
    defName: "合并表格.csv",
    ext: "csv",
    note: "按清单顺序拼接全部行，重复表头自动去除，输出 UTF-8 BOM；不覆盖原文件。",
  },
  text: {
    queueTitle: "合并顺序",
    ok: "合并",
    defName: "合并文本.txt",
    ext: "txt",
    note: "按清单顺序全文拼接，空行分隔，输出 UTF-8；不覆盖原文件。",
  },
  zip: {
    queueTitle: "打包清单",
    ok: "压缩",
    defName: "归档.zip",
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
  // targz = tar+gzip 组合；切格式时默认名跟随，自定义名只换尾部扩展名
  const [format, setFormat] = useState<CompressFormat>("zip");
  const [password, setPassword] = useState("");
  const [encryptHeader, setEncryptHeader] = useState(false);
  const meta = FORMAT_META[format];
  const ext = isZip ? meta.ext : cfg.ext;
  const note = isZip ? meta.note : cfg.note;
  const [name, setName] = useState<string>(cfg.defName);
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
  // zip_files 仍有 E_EXISTS 全量兜底，旁写绝不静默覆盖）
  const [existing, setExisting] = useState<Set<string> | null>(null);
  const dir = parentPath(entries[0]?.path ?? "");
  useEffect(() => {
    if (!isZip || !dir) return;
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
  }, [isZip, dir]);

  // 智能默认名（2026-11-08 用户需求）：压缩 flavor 下未手动改名时跟随清单——
  // 单对象 = 对象名（文件去扩展名）、多对象 = 所在目录名；与现有名冲突自动
  // (2) 递增；格式切换换扩展名。用户一旦手动改名即冻结
  useEffect(() => {
    if (!isZip || nameEdited) return;
    const infos = items.map((p) => ({
      name: fileNameOf(p),
      isDir: entries.find((e) => e.path === p)?.isDir ?? false,
    }));
    const stem = smartArchiveStem(infos, dir ? fileNameOf(dir) : null);
    let cand = `${stem}.${FORMAT_META[format].ext}`;
    let n = 2;
    while (existing?.has(cand.toLowerCase()) && n < 100) {
      cand = `${stem} (${n}).${FORMAT_META[format].ext}`;
      n += 1;
    }
    setName(cand);
  }, [isZip, nameEdited, items, existing, format, dir, entries]);

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
                if (e.key === "Enter" && valid) onDone(payload());
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
        <div className="np-dialog-muted">
          {t2(note)}
          {t2("输出预览：{out}", { out: preview })}
        </div>
      </DialogBody>
      <Footer
        okText={t2(cfg.ok)}
        disabled={!valid}
        onOk={() => onDone(payload())}
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
  const outName = stem + (extract ? "_提取.pdf" : "_删页.pdf");
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
        <div className="np-dialog-muted">
          {valid && total !== null && (
            <>
              {extract
                ? t2("将提取 {n} 页（{brief}）为新文件", { n: pages?.length, brief })
                : t2("将删除 {n} 页（{brief}），其余 {k} 页另存为新文件", {
                    n: pages?.length,
                    brief,
                    k: total - (pages?.length ?? 0),
                  })}
              <br />
            </>
          )}
          {t2("输出预览：{out}", { out: preview })}
          {!extract && t2("；原文件不动。")}
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
