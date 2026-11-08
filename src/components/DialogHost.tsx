import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  InputGroup,
  PopoverNext,
  Radio,
  RadioGroup,
  Switch,
  type Intent,
} from "@blueprintjs/core";
import { ArrowRight, ChevronDown, GripVertical, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";

import { formatBytes, formatSize, formatTime } from "../lib/format";
import { typeName } from "../lib/fileIcons";
import { api, type FileEntry, type FileLocks } from "../lib/ipc";
import {
  compileRegex,
  diffFragments,
  newOp,
  pickRenames,
  planRenames,
  REN_TEMPLATES,
  type CharCls,
  // CLS_NAMES 由 lib describeOp 使用；UI 类名清单见 CLS_DEFS
  removeClsRegex,
  type RenameOp,
  type RenameScope,
} from "../lib/batchRename";
import { enqueueDelete } from "../lib/operations";
import { AppIcon, ic } from "./AppIcon";
import {
  CompareDialog,
  DirSizeDialog,
  DuplicateDialog,
  EmptyScanDialog,
} from "./AnalyzeDialogs";
import {
  CompressDialog,
  ConvertDialog,
  MontageDialog,
  ResizeDialog,
  Seg,
  WatermarkDialog,
} from "./ImgDialogs";
import { NpSelect } from "./NpSelect";
import {
  MergeFilesDialog,
  NewFoldersDialog,
  PdfMergeDialog,
  PdfPagesDialog,
  PdfWatermarkDialog,
  XlsxMergeDialog,
} from "./ToolsDialogs";
import { DENSITY } from "../lib/tokens";
import { useUi, type DialogKind, type DialogSpec } from "../stores/ui";

/** 宽弹窗类型（§4.9 带/清单参数对话框，统一 680px）：分析类结果弹窗 +
 *  PDF 合并/水印/提取删页 + 通用合并 + Excel 合并 + 图片五件套（2026-11-03
 *  清单化后从 560 归入此组）；unlock 维持 560，其余走默认宽 */
const WIDE_TYPES = new Set<string>([
  "duplicates",
  "dirsizes",
  "compare",
  "emptyScan",
  "pdfMerge",
  "pdfWatermark",
  "pdfPages",
  "filesMerge",
  "xlsxMerge",
  "imgCompress",
  "imgWatermark",
  "imgConvert",
  "imgResize",
  "imgMontage",
]);

/** 提示级别 → 标题图标（标准化的唯一映射，新弹窗不许自定） */
const KIND_META: Record<DialogKind, { icon: typeof Info }> = {
  info: { icon: Info },
  warn: { icon: TriangleAlert },
  danger: { icon: OctagonAlert },
};

/** 确认按钮语义（2026-10-15 统一定案）：主操作 = accent（primary），
 *  危险操作 = danger；Blueprint 原生 warning 琥珀不在配色语言内，不再使用 */
const kindIntent = (kind: DialogKind): Intent =>
  kind === "danger" ? "danger" : "primary";

/** Promise 化对话框宿主：编排层不变（useUi.openDialog），渲染交给 Blueprint Dialog。
 *  confirm/alert 走统一提示样式（kind 图标 + intent 按钮）；input/conflict/properties 沿用各自表单体 */
export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const resolve = useUi((s) => s.resolveDialog);
  const close = () => resolve(null);
  // 「以后不再确认」勾选态：随弹窗开合复位（dialog 对象每次 openDialog 新建）
  const [remember, setRemember] = useState(false);
  useEffect(() => setRemember(false), [dialog]);
  const kind: DialogKind =
    dialog && (dialog.type === "confirm" || dialog.type === "alert")
      ? (dialog.kind ?? "info")
      : "info";

  const title =
    dialog?.type === "filesMerge"
      ? dialog.flavor === "images"
        ? "图片合并为 PDF"
        : dialog.flavor === "csv"
          ? "CSV 合并"
          : dialog.flavor === "zip"
            ? "压缩为 zip"
            : "文本合并"
      : dialog?.type === "pdfPages"
        ? dialog.mode === "extract"
          ? "PDF 提取页"
          : "PDF 删除页"
        : dialog?.type === "confirm"
      ? (dialog.title ?? "确认")
      : dialog?.type === "alert"
        ? (dialog.title ?? "提示")
        : dialog?.type === "input"
          ? dialog.title
          : dialog?.type === "conflict"
        ? "目标位置存在同名项"
        : dialog?.type === "duplicates"
          ? "重复文件"
          : dialog?.type === "dirsizes"
            ? "空间分析"
            : dialog?.type === "compare"
              ? "文件夹比较"
              : dialog?.type === "batchRename"
                ? "批量重命名"
                : dialog?.type === "emptyScan"
                  ? "空文件清理"
                  : dialog?.type === "newFolders"
                    ? "批量新建文件夹"
                    : dialog?.type === "pdfMerge"
                      ? "PDF 合并"
                      : dialog?.type === "pdfWatermark"
                        ? "PDF 加水印"
                        : dialog?.type === "xlsxMerge"
                          ? "Excel 合并"
                          : dialog?.type === "imgCompress"
                  ? "图片压缩"
                  : dialog?.type === "imgWatermark"
                    ? "图片水印"
                    : dialog?.type === "imgConvert"
                      ? "图片格式转换"
                      : dialog?.type === "imgResize"
                        ? "图片尺寸调整"
                        : dialog?.type === "imgMontage"
                          ? "宫格拼图"
                          : dialog?.type === "unlock"
                            ? "解除占用"
                            : dialog?.type === "properties"
                              ? "属性"
                              : "";
  // 标题图标：confirm/alert 按 kind；冲突预检固定警示；其余无图标
  const icon =
    dialog?.type === "confirm" || dialog?.type === "alert"
      ? ic(KIND_META[kind].icon, DENSITY.iconMd)
      : dialog?.type === "conflict"
        ? ic(TriangleAlert, DENSITY.iconMd)
        : undefined;

  return (
    <Dialog
      isOpen={!!dialog}
      onClose={close}
      title={title}
      icon={icon}
      canOutsideClickClose
      className="np-dialog"
      style={{
        width:
          dialog?.type === "batchRename"
            ? "min(1200px, 92vw)"
            : WIDE_TYPES.has(dialog?.type ?? "")
              ? "min(680px, 92vw)"
              : dialog?.type === "unlock"
                ? "min(560px, 92vw)"
                : "var(--np-dialog-w)",
      }}
    >
      {dialog?.type === "confirm" && (
        <>
          <DialogBody>
            <div className="np-dialog-muted">{dialog.message}</div>
            {dialog.rememberLabel && (
              <Checkbox
                className="np-dialog-remember"
                checked={remember}
                onChange={(e) => setRemember(e.currentTarget.checked)}
                label={dialog.rememberLabel}
              />
            )}
          </DialogBody>
          <DialogFooter
            actions={
              <>
                <Button size="small" onClick={close}>
                  {dialog.cancelText ?? "取消"}
                </Button>
                <Button
                  size="small"
                  intent={kindIntent(kind)}
                  onClick={() => {
                    if (remember && dialog.onRemember) dialog.onRemember();
                    resolve(true);
                  }}
                >
                  {dialog.okText ?? "确定"}
                </Button>
              </>
            }
          />
        </>
      )}

      {dialog?.type === "alert" && (
        <>
          <DialogBody>
            <div className="np-dialog-muted">{dialog.message}</div>
          </DialogBody>
          <DialogFooter
            actions={
              <Button
                size="small"
                intent={kindIntent(kind)}
                onClick={close}
              >
                {dialog.okText ?? "知道了"}
              </Button>
            }
          />
        </>
      )}

      {dialog?.type === "input" && (
        <InputDialog dialog={dialog} onDone={(v) => resolve(v)} />
      )}

      {dialog?.type === "conflict" && (
        <ConflictDialog items={dialog.items} onDone={(v) => resolve(v)} />
      )}

      {dialog?.type === "duplicates" && (
        <DuplicateDialog dir={dialog.dir} onDone={close} />
      )}

      {dialog?.type === "dirsizes" && (
        <DirSizeDialog dir={dialog.dir} onDone={close} />
      )}

      {dialog?.type === "compare" && (
        <CompareDialog a={dialog.a} b={dialog.b} onDone={close} />
      )}

      {dialog?.type === "batchRename" && (
        <BatchRenameDialog dialog={dialog} onDone={(v) => resolve(v)} />
      )}

      {dialog?.type === "emptyScan" && (
        <EmptyScanDialog dir={dialog.dir} onDone={close} />
      )}

      {dialog?.type === "newFolders" && (
        <NewFoldersDialog
          dir={dialog.dir}
          existing={dialog.existing}
          onDone={(v) => resolve(v)}
        />
      )}

      {dialog?.type === "xlsxMerge" && (
        <XlsxMergeDialog entries={dialog.entries} onDone={(v) => resolve(v)} />
      )}

      {dialog?.type === "filesMerge" && (
        <MergeFilesDialog
          flavor={dialog.flavor}
          entries={dialog.entries}
          onDone={(v) => resolve(v)}
        />
      )}

      {dialog?.type === "pdfPages" && (
        <PdfPagesDialog
          mode={dialog.mode}
          entry={dialog.entry}
          onDone={(v) => resolve(v)}
        />
      )}

      {dialog?.type === "pdfMerge" && (
        <PdfMergeDialog
          variant={dialog.variant}
          entries={dialog.entries}
          onDone={(v) => resolve(v)}
        />
      )}

      {dialog?.type === "pdfWatermark" && (
        <PdfWatermarkDialog entries={dialog.entries} onDone={(v) => resolve(v)} />
      )}

      {dialog?.type === "unlock" && (
        <UnlockDialog items={dialog.items} permanent={dialog.permanent} onDone={close} />
      )}

      {dialog?.type === "imgCompress" && (
        <CompressDialog entries={dialog.entries} onDone={(v) => resolve(v)} />
      )}
      {dialog?.type === "imgWatermark" && (
        <WatermarkDialog entries={dialog.entries} onDone={(v) => resolve(v)} />
      )}
      {dialog?.type === "imgConvert" && (
        <ConvertDialog entries={dialog.entries} onDone={(v) => resolve(v)} />
      )}
      {dialog?.type === "imgResize" && (
        <ResizeDialog entries={dialog.entries} onDone={(v) => resolve(v)} />
      )}
      {dialog?.type === "imgMontage" && (
        <MontageDialog entries={dialog.entries} onDone={(v) => resolve(v)} />
      )}

      {dialog?.type === "properties" && (
        <>
          <DialogBody>
            <div className="np-props">
              <Prop k={t("名称")} v={dialog.entry.name} />
              <Prop k={t("路径")} v={dialog.entry.path} />
              <Prop k={t("类型")} v={t(typeName(dialog.entry.name, dialog.entry.isDir))} />
              <Prop k={t("大小")} v={<SizeValue entry={dialog.entry} />} />
              <Prop k={t("修改时间")} v={formatTime(dialog.entry.mtimeMs)} />
              <Prop k={t("创建时间")} v={formatTime(dialog.entry.ctimeMs)} />
              <Prop
                k={t("属性")}
                v={
                  [
                    dialog.entry.attrs.readonly && "只读",
                    dialog.entry.attrs.hidden && "隐藏",
                    dialog.entry.attrs.system && "系统",
                  ]
                    .filter(Boolean)
                    .join("、") || "常规"
                }
              />
            </div>
          </DialogBody>
          <DialogFooter
            actions={<Button size="small" intent="primary" onClick={close}>{t("关闭")}</Button>}
          />
        </>
      )}
    </Dialog>
  );
}

function InputDialog({
  dialog,
  onDone,
}: {
  dialog: Extract<DialogSpec, { type: "input" }>;
  onDone(v: string | null): void;
}) {
  const [value, setValue] = useState(dialog.initial ?? "");
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    if (dialog.validate) {
      const msg = dialog.validate(value);
      if (msg) {
        setErr(msg);
        return;
      }
    }
    onDone(value);
  };
  return (
    <>
      <DialogBody>
        {dialog.label && <div className="np-dialog-muted">{dialog.label}</div>}
        <InputGroup
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onDone(null);
          }}
          onFocus={(e) => {
            const dot = value.lastIndexOf(".");
            e.target.setSelectionRange(0, dot > 0 ? dot : value.length);
          }}
          intent={err ? "danger" : undefined}
          spellCheck={false}
          size="small"
        />
        {err && <div className="np-dialog-error">{err}</div>}
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={() => onDone(null)}>
              {t("取消")}
            </Button>
            <Button size="small" intent="primary" onClick={submit}>
              {dialog.okText ?? "确定"}
            </Button>
          </>
        }
      />
    </>
  );
}

function ConflictDialog({
  items,
  onDone,
}: {
  items: string[];
  onDone(v: { action: "overwrite" | "skip" | "rename"; remember: boolean } | null): void;
}) {
  const [action, setAction] = useState<"overwrite" | "skip" | "rename">("skip");
  const [remember, setRemember] = useState(false);
  return (
    <>
      <DialogBody>
        <div className="np-conflict-list">
          {items.map((n, i) => (
            <div key={i} className="np-ellipsis">
              · {n}
            </div>
          ))}
        </div>
        {items.length > 1 && (
          <div className="np-dialog-muted">共 {items.length} 个冲突（将应用同一策略）</div>
        )}
        <RadioGroup
          selectedValue={action}
          onChange={(e) => setAction(e.currentTarget.value as typeof action)}
          className="np-conflict-radios"
        >
          <Radio value="overwrite" label={t("覆盖目标文件")} />
          <Radio value="skip" label={t("跳过这些文件")} />
          <Radio value="rename" label={t("保留两者（重命名为 “xxx (2).ext”）")} />
        </RadioGroup>
        <Switch
          className="np-conflict-remember"
          checked={remember}
          label={t("本会话内不再询问（后续冲突直接套用该策略）")}
          onChange={(e) => setRemember(e.currentTarget.checked)}
        />
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={() => onDone(null)}>
              {t("取消")}
            </Button>
            <Button size="small" intent="primary" onClick={() => onDone({ action, remember })}>
              {t("确定")}
            </Button>
          </>
        }
      />
    </>
  );
}

function Prop({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="np-prop-row">
      <span className="np-prop-key">{k}</span>
      <span className="np-prop-val np-ellipsis">{v}</span>
    </div>
  );
}

/** 解除占用（2026-11-01）：删除撞上占用失败的路径入场——查出占用进程，
 *  用户确认后远程关闭句柄并按原语义（回收站/永久）重删 */
function UnlockDialog({
  items,
  permanent,
  onDone,
}: {
  items: string[];
  permanent: boolean;
  onDone(): void;
}) {
  const [locks, setLocks] = useState<FileLocks[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .findFileLocks(items)
      .then((r) => {
        if (alive) setLocks(r);
      })
      .catch(() => {
        if (alive) setLocks([]);
      });
    return () => {
      alive = false;
    };
  }, [items]);

  const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

  const release = async () => {
    setBusy(true);
    const freed: string[] = [];
    const stuck: string[] = [];
    let truncated = false;
    for (const l of locks ?? []) {
      try {
        const r = await api.releaseFileLocks(l.path);
        truncated = truncated || r.truncated;
        (r.remaining.length ? stuck : freed).push(l.path);
      } catch {
        stuck.push(l.path);
      }
    }
    onDone();
    // 解除成功的立即按原语义重删（用户已在原始删除时确认过，不再重复询问）
    if (freed.length) void enqueueDelete(freed, permanent);
    if (stuck.length || truncated) {
      const parts: string[] = [];
      if (stuck.length) {
        parts.push(`仍被占用，未能解除：${stuck.map(baseName).join("、")}`);
      }
      if (truncated) parts.push("部分系统句柄无响应，可能仍有未解除的占用");
      useUi.getState().toast(parts.join("；"), "error");
    }
  };

  return (
    <>
      <DialogBody>
        <div className="np-dialog-muted">
          {permanent
            ? "以下文件正被其他程序占用，无法删除："
            : "以下文件正被其他程序占用，无法移入回收站："}
        </div>
        <div className="np-conflict-list">
          {locks === null ? (
            <div className="np-dialog-muted">正在查找占用进程…</div>
          ) : (
            locks.map((l) => (
              <div key={l.path} className="np-ellipsis">
                · {baseName(l.path)}
                {l.lockers.length > 0 && (
                  <> — {l.lockers.map((p) => p.name).join("、")}</>
                )}
              </div>
            ))
          )}
        </div>
        {locks !== null && locks.every((l) => l.lockers.length === 0) && (
          <div className="np-dialog-muted">
            未找到占用进程（可能是瞬时占用已释放，或系统级进程）。
          </div>
        )}
        {locks !== null && locks.some((l) => l.truncated) && (
          <div className="np-dialog-muted">
            部分系统句柄无响应，占用进程列表可能不完整。
          </div>
        )}
        <div className="np-dialog-muted">
          解除占用会强制关闭这些程序打开的文件句柄，对应程序未保存的内容可能丢失。
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              取消
            </Button>
            <Button
              size="small"
              intent="primary"
              disabled={busy || locks === null}
              onClick={() => void release()}
            >
              解除占用并重试
            </Button>
          </>
        }
      />
    </>
  );
}

/** 大小行：文件即时显示；文件夹经 dir_sizes 异步求和（子项递归合计，
 *  200k 文件护栏与空间分析同源）；盘符根不扫全盘，维持 "—" */function SizeValue({ entry }: { entry: FileEntry }) {
  const [size, setSize] = useState<number | null>(null);
  const isDrive = /^[a-zA-Z]:\\?$/.test(entry.path);
  const scan = entry.isDir && !isDrive;
  useEffect(() => {
    if (!scan) return;
    let alive = true;
    api
      .dirSizes(entry.path)
      .then((rows) => {
        if (alive) setSize(rows.reduce((a, r) => a + r.size, 0));
      })
      .catch(() => {
        if (alive) setSize(-1); // 扫描失败回落 "—"
      });
    return () => {
      alive = false;
    };
  }, [scan, entry.path]);
  if (!entry.isDir) return <>{formatSize(entry)}</>;
  if (!scan || size === -1) return <>—</>;
  return <>{size === null ? "计算中…" : formatBytes(size)}</>;
}

/** 规则分类单一来源（2026-11-08 面板一定案）：4 大类 × 10 规则，添加规则 =
 *  两栏二级面板（左栏类目、右栏名称 + 词槽句式预览）；规则卡 = 语句卡
 *  （词槽句式即效果，逐槽渲染见 opSentence）。scope 预设给「替换扩展名」，
 *  卡上句式随 scope 自动切换（replace ext / suffix 整名） */
type RuleCat = "add" | "replace" | "remove" | "convert";
interface RuleDef {
  type: RenameOp["type"];
  name: string;
  s: string;
  scope?: RenameScope;
}
const RULE_GROUPS: { cat: RuleCat; name: string; rules: RuleDef[] }[] = [
  {
    cat: "add",
    name: "添加",
    rules: [
      { type: "prefix", name: "加前缀", s: "在最前面加 [文字]" },
      { type: "suffix", name: "加后缀", s: "在扩展名前加 [文字]" },
      { type: "insert", name: "插入文字", s: "在 [名称开头/末尾] 插入 [文字]" },
      { type: "number", name: "加序号", s: "在 [位置] 加编号，从 [1] 起、宽 [2 位]" },
      { type: "date", name: "加日期", s: "在 [位置] 加修改日期 [格式]" },
    ],
  },
  {
    cat: "replace",
    name: "替换",
    rules: [
      { type: "replace", name: "查找替换", s: "把 [文字] 替换为 [文字]，按 [文字/表达式]" },
      { type: "replace", name: "替换扩展名", s: "把扩展名 [jpg] 改为 [png]", scope: "ext" },
    ],
  },
  {
    cat: "remove",
    name: "删除",
    rules: [
      { type: "remove", name: "删除文字", s: "删除名称里所有的 [文字]" },
      { type: "removeCls", name: "删除指定字符", s: "删除 [勾选字符类型] 的字符，可切 [删除/保留]" },
      { type: "trim", name: "掐头去尾", s: "去掉开头 [2] 个、末尾 [1] 个字符" },
    ],
  },
  {
    cat: "convert",
    name: "转换",
    rules: [
      { type: "case", name: "大小写", s: "把英文字母 [全部改为大写/小写/首字母大写]" },
      { type: "chinese", name: "简繁转换", s: "把汉字 [简体→繁体 / 繁体→简体]" },
      { type: "pinyin", name: "转拼音", s: "把汉字转 [拼音首字母 / 全拼]" },
      { type: "cnNum", name: "中文数字", s: "把名称里的数字 [十二→12 / 12→十二]" },
      { type: "padNum", name: "补齐位数", s: "把名称里的数字补齐到 [N 位]" },
      { type: "arith", name: "数字加减乘除", s: "把名称里的数字 [加/减/乘/除] [2]" },
      { type: "dateFormat", name: "日期格式化", s: "把名称里的日期统一成 [2026-11-07]" },
    ],
  },
];
const RULE_TYPE_NAMES: Record<RenameOp["type"], string> = Object.fromEntries(
  RULE_GROUPS.flatMap((g) => g.rules)
    // replace 双条目（查找替换/替换扩展名）按 scope 区分，不进类型名映射
    .filter((r) => !(r.type === "replace"))
    .map((r) => [r.type, r.name]),
) as Record<RenameOp["type"], string>;

/* ③ 作用域口语化（下拉项带副标题解释，title 即下拉项 tooltip） */
const R_SCOPE_OPTS = [
  { value: "name", label: "只改主名", title: "保留 .docx 等扩展名不动" },
  { value: "nameExt", label: "整个名称", title: "主名和扩展名一起改" },
  { value: "ext", label: "只改扩展名", title: "如批量 jpg → png" },
] as const;

const R_CASE_OPTS = [
  { value: "upper", label: "全部改为大写" },
  { value: "lower", label: "全部改为小写" },
  { value: "title", label: "首字母大写" },
] as const;

const R_DATE_OPTS = [
  { value: "ymd", label: "2026-11-07" },
  { value: "ymdCompact", label: "20261107" },
  { value: "ymdHms", label: "2026-11-07_140509" },
] as const;

const R_PAD_OPTS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `${n} 位` }));

/** 字符类勾选定义（删除指定字符词槽面板行序） */
const CLS_DEFS: { key: CharCls; name: string }[] = [
  { key: "space", name: "空格" },
  { key: "digit", name: "数字" },
  { key: "hanzi", name: "汉字" },
  { key: "upper", name: "大写字母" },
  { key: "lower", name: "小写字母" },
  { key: "cnPunct", name: "中文符号" },
  { key: "enPunct", name: "英文符号" },
  { key: "illegal", name: "非法字符" },
];

/** 「删除指定字符」词槽：勾选面板内联在语句卡上（absolute 定位），
 *  点面板外收起；删除/保留双模式由卡上 Seg 切换 */
function ClsSlot({ op, onPatch }: { op: Extract<RenameOp, { type: "removeCls" }>; onPatch: (p: Partial<RenameOp>) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // 面板 portal 到 body（规则列滚动容器会裁剪内联浮层），内外两个 ref 都放行
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  const toggle = () => {
    if (!open) {
      const b = wrapRef.current?.getBoundingClientRect();
      if (b) {
        // 视口下方放不下（面板高 ~340px）则向上翻
        const below = window.innerHeight - b.bottom;
        setPos({
          top: below > 360 ? b.bottom + 6 : Math.max(8, b.top - 352),
          left: Math.min(b.left, window.innerWidth - 244),
        });
      }
    }
    setOpen(!open);
  };
  const names = CLS_DEFS.filter((d) => op.cls.includes(d.key)).map((d) => d.name);
  const reSrc = removeClsRegex(op.cls, op.keep);
  return (
    <span className="np-rs-clswrap" ref={wrapRef}>
      <button
        className={`np-select np-rs-clsbtn${open ? " is-open" : ""}`}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
      >
        {names.length ? names.join("、") : t("未勾选字符类型")}
        <span className="np-select-chev">{ic(ChevronDown)}</span>
      </button>
      {open &&
        createPortal(
          <div
            className="np-rs-clspanel"
            ref={panelRef}
            style={pos ? { position: "fixed", top: pos.top, left: pos.left } : undefined}
            onClick={(e) => e.stopPropagation()}
          >
            {CLS_DEFS.map((d) => (
              <label key={d.key} className="np-rs-ck">
                <input
                  type="checkbox"
                  checked={op.cls.includes(d.key)}
                  onChange={(e) => {
                    const set = new Set(op.cls);
                    if (e.currentTarget.checked) set.add(d.key);
                    else set.delete(d.key);
                    onPatch({ cls: [...set] } as Partial<RenameOp>);
                  }}
                />
                {t(d.name)}
              </label>
            ))}
            <div className="np-rs-ft">
              <Seg
                value={op.keep ? "keep" : "remove"}
                options={[{ value: "remove", label: t("删除") }, { value: "keep", label: t("保留") }]}
                onChange={(v) => onPatch({ keep: v === "keep" } as Partial<RenameOp>)}
              />
            </div>
            <div className="np-rs-prev">
              {reSrc ? (op.keep ? t("将删除未勾选类型") : t("将删除勾选类型")) : t("未勾选任何类型，名称不变")}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
/** 批量重命名（2026-11-07 用户定案参考 Smart File Renamer 布局）：
 *  左 = 大预览表（行级勾选参与 + 只看变更），右 = 规则链（9 种规则类型
 *  可堆叠/排序/删除/独立作用域，按序生效实时预览）。规则引擎在
 *  lib/batchRename.ts（planRenames op 链式范式，同 Advanced Renamer） */
function BatchRenameDialog({
  dialog,
  onDone,
}: {
  dialog: Extract<DialogSpec, { type: "batchRename" }>;
  onDone(v: { path: string; newName: string }[] | null): void;
}) {
  const [opsList, setOpsList] = useState<RenameOp[]>([]);
  const [onlyChanged, setOnlyChanged] = useState(false);
  // 预览行勾选：显式全选集（打开时全部参与；取消勾选的行不被应用）
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(dialog.entries.map((e) => e.path)),
  );
  const plan = useMemo(() => planRenames(dialog.entries, opsList), [dialog.entries, opsList]);
  const todo = useMemo(() => pickRenames(plan, picked), [plan, picked]);
  const errorCount = plan.filter((i) => i.changed && i.error).length;
  const changedCount = plan.filter((i) => i.changed).length;
  const shown = onlyChanged ? plan.filter((i) => i.changed) : plan;
  const regexInvalid = opsList.some(
    (o) => o.enabled && o.type === "replace" && o.regex && !!o.find && !compileRegex(o.find),
  );
  const allSel = plan.length > 0 && plan.every((i) => picked.has(i.path));
  const toggleAll = () =>
    setPicked(allSel ? new Set<string>() : new Set(plan.map((i) => i.path)));
  const togglePick = (path: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  const addRule = (def: { type: RenameOp["type"]; scope?: RenameScope }) =>
    setOpsList((l) => [...l, newOp({ type: def.type, ...(def.scope ? { scope: def.scope } : {}) })]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelCat, setPanelCat] = useState<RuleCat>("add");
  const patchOp = (id: string, p: Partial<RenameOp>) =>
    setOpsList((l) => l.map((o) => (o.id === id ? ({ ...o, ...p } as RenameOp) : o)));
  const removeOp = (id: string) => setOpsList((l) => l.filter((o) => o.id !== id));
  /** 指针拖拽排序会话：规则卡 onPointerDown 记起点 → window pointermove
   *  位移超 4px 进拖拽态（源卡半透明 + elementsFromPoint 命中卡片显示
   *  accent 上缘指示线）→ pointerup 落位。拖拽中 onClickCapture 吞落点
   *  补发 click（防 NpSelect/输入交互误触） */
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  /** 词槽作用域（语句卡句尾「作用于」；替换扩展名卡不带此槽） */
  const scopeSlot = (op: RenameOp) => (
    <NpSelect
      value={op.scope}
      options={[...R_SCOPE_OPTS]}
      onChange={(scope) => patchOp(op.id, { scope } as Partial<RenameOp>)}
    />
  );

  /** 卡头类型词：replace 按 scope 区分双条目（ext = 替换扩展名专用句式卡） */
  const typeNameOf = (op: RenameOp) =>
    op.type === "replace"
      ? t(op.scope === "ext" ? "替换扩展名" : "查找替换")
      : t(RULE_TYPE_NAMES[op.type]);

  /** 语句卡：整条规则 = 一句话，参数以词槽内嵌句中（2026-11-08 用户定案）。
   *  句式随参数自动切换：replace 表达式模式 / suffix 整名作用域 / trim 填 0
   *  段消失；加序号恒主名（句尾省作用于槽）；替换扩展名（scope=ext）专用句 */
  const opSentence = (op: RenameOp) => {
    switch (op.type) {
      case "replace": {
        if (op.scope === "ext")
          return [
            "把扩展名",
            <InputGroup key="f" size="small" value={op.find} placeholder={t("jpg")} spellCheck={false}
              onChange={(e) => patchOp(op.id, { find: e.target.value } as Partial<RenameOp>)} />,
            "改为",
            <InputGroup key="r" size="small" value={op.replace} placeholder={t("png")} spellCheck={false}
              onChange={(e) => patchOp(op.id, { replace: e.target.value } as Partial<RenameOp>)} />,
          ];
        const find = (
          <InputGroup size="small" value={op.find} placeholder={op.regex ? t("\s+") : t("要查找的文字")} spellCheck={false}
            onChange={(e) => patchOp(op.id, { find: e.target.value } as Partial<RenameOp>)} />
        );
        const rep = (
          <InputGroup size="small" value={op.replace} placeholder={op.regex ? t("$1 = 第 1 组") : t("新文字")} spellCheck={false}
            onChange={(e) => patchOp(op.id, { replace: e.target.value } as Partial<RenameOp>)} />
        );
        const mode = (
          <Seg value={op.regex ? "regex" : "literal"}
            options={[{ value: "literal", label: t("文字") }, { value: "regex", label: t("表达式"), title: "正则表达式，替换串支持 $1 捕获组" }]}
            onChange={(v) => patchOp(op.id, { regex: v === "regex" } as Partial<RenameOp>)} />
        );
        return op.regex
          ? ["用正则", find, "匹配并替换为", rep, "，模式", mode, "，作用于", scopeSlot(op)]
          : [
            <span key="s1">把</span>, find, <span key="s2">替换为</span>, rep, <span key="s3">，按</span>, mode, <span key="s4">匹配，作用于</span>, scopeSlot(op),
          ];
      }
      case "remove":
        return [
          "删除名称里所有的",
          <InputGroup key="f" size="small" value={op.find} placeholder={t("要删除的文字")} spellCheck={false}
            onChange={(e) => patchOp(op.id, { find: e.target.value } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "insert":
        return [
          "在",
          <NpSelect key="p" value={op.position} options={[{ value: "start", label: t("名称开头") }, { value: "end", label: t("名称末尾") }]}
            onChange={(v) => patchOp(op.id, { position: v } as Partial<RenameOp>)} />,
          "插入",
          <InputGroup key="t" size="small" value={op.text} placeholder={t("要插入的文字")} spellCheck={false}
            onChange={(e) => patchOp(op.id, { text: e.target.value } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "prefix":
        return [
          "在最前面加",
          <InputGroup key="t" size="small" value={op.text} placeholder={t("前缀文字")} spellCheck={false}
            onChange={(e) => patchOp(op.id, { text: e.target.value } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "suffix":
        return [
          op.scope === "name" ? "在扩展名前加" : "在末尾加",
          <InputGroup key="t" size="small" value={op.text} placeholder={t("后缀文字")} spellCheck={false}
            onChange={(e) => patchOp(op.id, { text: e.target.value } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "trim": {
        const head = (
          <input key="h" className="np-bren-num" type="number" min={0} value={op.head}
            onChange={(e) => patchOp(op.id, { head: Math.max(0, Math.floor(Number(e.target.value) || 0)) } as Partial<RenameOp>)} />
        );
        const tail = (
          <input key="t" className="np-bren-num" type="number" min={0} value={op.tail}
            onChange={(e) => patchOp(op.id, { tail: Math.max(0, Math.floor(Number(e.target.value) || 0)) } as Partial<RenameOp>)} />
        );
        const segs: React.ReactNode[] = [];
        if (op.head > 0) segs.push("去掉开头", head, "个");
        if (op.tail > 0) segs.push(op.head > 0 ? "、末尾" : "去掉末尾", tail, "个字符");
        if (!segs.length) segs.push("去掉开头", head, "个、末尾", tail, "个字符");
        return [...segs, "，作用于", scopeSlot(op)];
      }
      case "number": {
        const pad = Math.min(Math.max(op.pad, 1), 6);
        const n1 = String(op.start).padStart(pad, "0");
        const n2 = String(op.start + 1).padStart(pad, "0");
        return [
          "在",
          <NpSelect key="p" value={op.position} options={[{ value: "start", label: t("名称开头") }, { value: "end", label: t("扩展名前") }]}
            onChange={(v) => patchOp(op.id, { position: v } as Partial<RenameOp>)} />,
          "加编号，从",
          <input key="s" className="np-bren-num" type="number" min={0} value={op.start}
            onChange={(e) => patchOp(op.id, { start: Math.max(0, Math.floor(Number(e.target.value) || 0)) } as Partial<RenameOp>)} />,
          "起、宽",
          <NpSelect key="w" value={op.pad} options={R_PAD_OPTS} onChange={(pad) => patchOp(op.id, { pad } as Partial<RenameOp>)} />,
          <span key="pv" className="np-rs-prev">（{op.separator || ""}{n1}、{op.separator || ""}{n2}…）</span>,
          "，分隔符",
          <InputGroup key="sep" className="np-rs-narrow" size="small" value={op.separator} spellCheck={false}
            onChange={(e) => patchOp(op.id, { separator: e.target.value } as Partial<RenameOp>)} />,
        ];
      }
      case "case":
        return [
          "把英文字母",
          <NpSelect key="m" value={op.mode} options={[...R_CASE_OPTS]} onChange={(mode) => patchOp(op.id, { mode } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "date":
        return [
          "在",
          <NpSelect key="p" value={op.position} options={[{ value: "start", label: t("名称开头") }, { value: "end", label: t("名称末尾") }]}
            onChange={(v) => patchOp(op.id, { position: v } as Partial<RenameOp>)} />,
          "加修改日期",
          <NpSelect key="f" value={op.format} options={[...R_DATE_OPTS]} onChange={(format) => patchOp(op.id, { format } as Partial<RenameOp>)} />,
          "，分隔符",
          <InputGroup key="sep" className="np-rs-narrow" size="small" value={op.separator} spellCheck={false}
            onChange={(e) => patchOp(op.id, { separator: e.target.value } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "chinese":
        return [
          <span key="s1">把汉字</span>,
          <NpSelect key="m" value={op.mode} options={[{ value: "s2t", label: t("简体 → 繁体") }, { value: "t2s", label: t("繁体 → 简体") }]}
            onChange={(mode) => patchOp(op.id, { mode } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "pinyin":
        return [
          <span key="s1">把汉字转</span>,
          <NpSelect key="m" value={op.mode} options={[{ value: "initials", label: t("拼音首字母") }, { value: "full", label: t("全拼") }]}
            onChange={(mode) => patchOp(op.id, { mode } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "cnNum":
        return [
          <span key="s1">把名称里的数字</span>,
          <NpSelect key="m" value={op.mode} options={[{ value: "toArabic", label: t("十二 → 12") }, { value: "toChinese", label: t("12 → 十二") }]}
            onChange={(mode) => patchOp(op.id, { mode } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "padNum":
        return [
          <span key="s1">把名称里的数字补齐到</span>,
          <NpSelect key="w" value={op.width} options={R_PAD_OPTS.filter((o) => o.value >= 2)} onChange={(width) => patchOp(op.id, { width } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "arith":
        return [
          <span key="s1">把名称里的数字</span>,
          <Seg key="a" value={op.arith}
            options={[{ value: "add", label: t("加") }, { value: "sub", label: t("减") }, { value: "mul", label: t("乘") }, { value: "div", label: t("除") }]}
            onChange={(v) => patchOp(op.id, { arith: v } as Partial<RenameOp>)} />,
          <input key="v" className="np-bren-num" type="number" value={op.value}
            onChange={(e) => patchOp(op.id, { value: Number(e.target.value) || 0 } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
      case "dateFormat":
        return [
          <span key="s1">把名称里的日期统一成</span>,
          <NpSelect key="f" value={op.format}
            options={[{ value: "ymd", label: t("2026-11-07") }, { value: "ymdCompact", label: t("20261107") }, { value: "cn", label: t("2026年11月7日") }]}
            onChange={(format) => patchOp(op.id, { format } as Partial<RenameOp>)} />,
          "，作用于", scopeSlot(op),
        ];
       case "removeCls":
        return [
          op.keep ? <span key="s1">只保留名称里的</span> : <span key="s1">删除名称里的</span>,
          <ClsSlot key="slot" op={op} onPatch={(p) => patchOp(op.id, p)} />,
          <span key="s2">的字符</span>,
          "，作用于", scopeSlot(op),
        ];
    }
  };

  return (
    <>
      <DialogBody>
        <div className="np-bren2">
          <div className="np-bren-preview2">
            {/* ① 常用任务 chips：一键生成整条规则链（参数可在卡上继续微调） */}
            <div className="np-bren-tasks">
              <span className="np-bren-tasks-lab">{t("常用任务：")}</span>
              {REN_TEMPLATES.map((tp) => (
                <button
                  key={tp.id}
                  className="np-bren-chip"
                  data-tip={tp.desc}
                  onClick={() => setOpsList(tp.build())}
                >
                  {t(tp.label)}
                </button>
              ))}
            </div>
            <div className="np-bren-head">
              <input
                type="checkbox"
                checked={allSel}
                onChange={toggleAll}
                aria-label={t("全选")}
                data-tip={t("全选 / 全不选")}
              />
              <span className="np-bren-old">{t("原名")}</span>
              <span className="np-bren-new">{t("新名（改动片段高亮）")}</span>
              <Switch
                checked={onlyChanged}
                label={t("只看变更")}
                onChange={(e) => setOnlyChanged(e.currentTarget.checked)}
              />
            </div>
            <div className="np-bren-list">
              {shown.slice(0, 200).map((i) => {
                const frag = i.changed && !i.error ? diffFragments(i.oldName, i.newName) : null;
                return (
                <div key={i.path} className={`np-bren-row ${picked.has(i.path) ? "" : "is-skip"}`}>
                  <input
                    type="checkbox"
                    checked={picked.has(i.path)}
                    onChange={() => togglePick(i.path)}
                    aria-label={t("参与改名")}
                  />
                  <span className="np-bren-old np-ellipsis" title={i.oldName}>
                    {i.oldName}
                  </span>
                  <AppIcon icon={ArrowRight} size={DENSITY.iconXs} className="np-bren-arrow" />
                  <span
                    className={`np-bren-new np-ellipsis ${
                      i.error ? "is-err" : i.changed ? "is-chg" : "is-same"
                    }`}
                    title={i.error ?? i.newName}
                  >
                    {i.error ??
                      (frag ? (
                        <>
                          {frag.pre}
                          {frag.mid && <span className="np-bren-diff">{frag.mid}</span>}
                          {frag.post}
                        </>
                      ) : (
                        i.newName
                      ))}
                  </span>
                </div>
                );
              })}
            </div>
          </div>
          <div className="np-rchain">
            <div className="np-rchain-bar">
              {/* 添加规则 = 两栏二级分类面板（面板一定案 2026-11-08）：左栏四大类、
                  右栏名称 + 词槽句式预览；点规则即加链尾并收面板。常用任务 chips
                  保留在预览列栏顶，高频操作零层级直达 */}
              <PopoverNext
                isOpen={panelOpen}
                onInteraction={setPanelOpen}
                placement="bottom-start"
                arrow={false}
                content={
                  <div className="np-rp">
                    <div className="np-rp-head">
                      <span className="np-rp-t">{t("添加规则")}</span>
                      <span className="np-rp-d">{t("按分类选择 · 点规则加入链尾")}</span>
                    </div>
                    <div className="np-rp-body">
                      <div className="np-rp-rail">
                        {RULE_GROUPS.map((g) => (
                          <div
                            key={g.cat}
                            className={`np-rp-cat ${panelCat === g.cat ? "is-on" : ""}`}
                            onClick={() => setPanelCat(g.cat)}
                          >
                            <span className={`np-rp-dot is-${g.cat}`} />
                            {t(g.name)}
                            <span className="np-rp-n">{g.rules.length}</span>
                          </div>
                        ))}
                      </div>
                      <div className="np-rp-list">
                        {(RULE_GROUPS.find((g) => g.cat === panelCat) ?? RULE_GROUPS[0]).rules.map((r) => (
                          <div
                            key={r.name}
                            className="np-rp-item"
                            onClick={() => {
                              addRule(r);
                              setPanelOpen(false);
                            }}
                          >
                            <div className="np-rp-n2">{t(r.name)}</div>
                            <div className="np-rp-s">{r.s}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                }
              >
                <Button
                  minimal
                  size="small"
                  className={`np-select${panelOpen ? " is-open" : ""}`}
                  text={`＋ ${t("添加规则")}`}
                  rightIcon={<span className="np-select-chev">{ic(ChevronDown)}</span>}
                />
              </PopoverNext>
              <span className="np-dialog-muted">
                {opsList.length} {t("条规则")}
              </span>
            </div>
            {opsList.length === 0 ? (
              <div className="np-rchain-empty">
                <div>{t("还没有规则——点「添加规则」从分类面板选择，规则按从上到下顺序生效。也可从常用任务开始：")}</div>
                <div className="np-rchain-tpl">
                  {REN_TEMPLATES.slice(0, 4).map((tp) => (
                    <button
                      key={tp.id}
                      className="np-rchain-tpl-btn"
                      data-tip={tp.desc}
                      onClick={() => setOpsList(tp.build())}
                    >
                      <span>{t(tp.label)}</span>
                      <span className="np-rchain-tpl-d">{t(tp.desc)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="np-rchain-list">
                {opsList.map((op, idx) => (
                  <div
                    key={op.id}
                    className={`np-rchain-item ${dragId === op.id ? "is-drag" : ""} ${
                      overIdx === idx && dragId !== null && dragId !== op.id ? "is-over" : ""
                    } ${op.enabled ? "" : "is-off"}`}
                    onPointerDown={(e) => {
                      // React portal 冒泡防护（2026-11-08 用户报「下拉点击不生效」根因）：
                      // 卡内 NpSelect 弹层 DOM 上挂在 body 下，合成事件却沿 React 树
                      // 冒泡到卡片——contains 不为真即弹层来源，放行不进拖拽；否则
                      // setPointerCapture 吞掉 pointerup，菜单项 onClick 永不触发
                      if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
                      // NpSelect/Button/输入/Blueprint 控件（Switch 开关等 .bp6-control
                      // 指示器是 span，漏排会把开关点击吞成拖拽）不启动拖拽
                      if ((e.target as HTMLElement).closest(".np-select, button, input, .bp6-input-group, .np-seg, .bp6-control, .np-rs-clspanel")) return;
                      dragRef.current = { id: op.id, moved: false };
                      setDragId(op.id);
                      // setPointerCapture：后续 move/up 强制派发给卡片（工作区排序同款，
                      // window 监听在 WebView2 下 pointerup 不可靠）
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      const d = dragRef.current;
                      if (!d || d.id !== op.id) return;
                      if (!d.moved && e.buttons === 0) return;
                      d.moved = true;
                      const cards = [...document.querySelectorAll(".np-rchain-item")];
                      const hit = cards.findIndex((c) => {
                        const b = c.getBoundingClientRect();
                        return e.clientY >= b.top && e.clientY <= b.bottom;
                      });
                      setOverIdx(hit >= 0 ? hit : null);
                    }}
                    onPointerUp={(e) => {
                      const target = overIdx;
                      setDragId(null);
                      setOverIdx(null);
                      dragRef.current = null;
                      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
                      if (target === null || target === idx) return;
                      setOpsList((l) => {
                        const c = [...l];
                        const [m] = c.splice(idx, 1);
                        c.splice(target, 0, m);
                        return c;
                      });
                    }}
                  >
                    {/* 语句卡：行1 = 把手+序号+类型词+启用开关+删除；行2 = 词槽句式
                        （句子即效果，无独立效果行）；停用卡整卡淡显 */}
                    <div className="np-rs-head">
                      <span className="np-rs-grip" data-tip="拖动卡片可调整顺序">
                        <AppIcon icon={GripVertical} size={DENSITY.iconXs} />
                      </span>
                      <span className="np-rs-idx">{idx + 1}</span>
                      <span className="np-rs-type">{typeNameOf(op)}</span>
                      {!op.enabled && <span className="np-rs-off">{t("已停用")}</span>}
                      <span className="np-rchain-sp" />
                      <Switch
                        checked={op.enabled}
                        onChange={(e) => patchOp(op.id, { enabled: e.currentTarget.checked } as Partial<RenameOp>)}
                      />
                      <button className="np-rchain-btn" data-tip="删除规则" onClick={() => removeOp(op.id)}>
                        <AppIcon icon={X} size={DENSITY.iconXs} />
                      </button>
                    </div>
                    <div className="np-rs">{opSentence(op)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {regexInvalid && (
          <div className="np-dialog-error">
            {t("正则表达式无效，请修正后重试（无效规则暂被跳过）。")}
          </div>
        )}
        <div className="np-dialog-muted">
          已变更 {changedCount} / 共 {dialog.entries.length} 项
          {picked.size < dialog.entries.length && `，${dialog.entries.length - picked.size} 项已取消勾选`}
          {errorCount > 0 && `，${errorCount} 项冲突或非法（红色标出）`}
          {plan.length > 200 && "（仅预览前 200 行）"}
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={() => onDone(null)}>
              {t("取消")}
            </Button>
            <Button
              size="small"
              intent="primary"
              disabled={!todo.length}
              onClick={() => onDone(todo)}
            >
              应用（{todo.length} 项）
            </Button>
          </>
        }
      />
    </>
  );
}
