import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  InputGroup,
  Radio,
  RadioGroup,
  Switch,
  type Intent,
} from "@blueprintjs/core";
import { ArrowRight, CircleCheck, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";

import { formatBytes, formatSize, formatTime } from "../lib/format";
import { typeName } from "../lib/fileIcons";
import { api, type FileEntry, type FileLocks } from "../lib/ipc";
import {
  compileRegex,
  describeOp,
  diffFragments,
  newOp,
  pickRenames,
  planRenames,
  REN_TEMPLATES,
  type RenameOp,
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
            ? "min(980px, 92vw)"
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

const OP_TYPE_ITEMS: { type: RenameOp["type"]; label: string }[] = [
  { type: "replace", label: "替换（字面/正则）" },
  { type: "remove", label: "删除文本" },
  { type: "insert", label: "插入文本" },
  { type: "prefix", label: "添加前缀" },
  { type: "suffix", label: "添加后缀" },
  { type: "trim", label: "修剪首尾" },
  { type: "number", label: "加序号" },
  { type: "case", label: "大小写" },
  { type: "date", label: "文件日期" },
];

/* ③ 作用域口语化（下拉项带副标题解释，title 即下拉项 tooltip） */
const R_SCOPE_OPTS = [
  { value: "name", label: "只改主名", title: "保留 .docx 等扩展名不动" },
  { value: "nameExt", label: "整个名称", title: "主名和扩展名一起改" },
  { value: "ext", label: "只改扩展名", title: "如批量 jpg → png" },
] as const;

const R_CASE_OPTS = [
  { value: "upper", label: "全部大写" },
  { value: "lower", label: "全部小写" },
  { value: "title", label: "首字母大写" },
] as const;

const R_DATE_OPTS = [
  { value: "ymd", label: "2026-11-07" },
  { value: "ymdCompact", label: "20261107" },
  { value: "ymdHms", label: "2026-11-07_140509" },
] as const;

const R_PAD_OPTS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `${n} 位` }));

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
  const addOp = (type: RenameOp["type"]) =>
    setOpsList((l) => [...l, newOp({ type, ...(type === "case" ? { mode: "upper" as const } : {}) })]);
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
  /** 类型切换 = 换新默认参数（旧类型参数不迁移），保留作用域 */
  const changeType = (id: string, type: RenameOp["type"]) => {
    const cur = opsList.find((o) => o.id === id);
    if (!cur || cur.type === type) return;
    patchOp(id, newOp({ type, scope: cur.scope }) as Partial<RenameOp>);
  };

  /** 参数区：每个参数 = 中文标签 + 控件成对（np-rchain-pair），分类清晰 */
  const opParams = (op: RenameOp) => {
    switch (op.type) {
      case "replace":
        return (
          <>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("查找")}</span>
              <InputGroup
                size="small"
                value={op.find}
                placeholder={t("要查找的文字")}
                spellCheck={false}
                onChange={(e) => patchOp(op.id, { find: e.target.value } as Partial<RenameOp>)}
              />
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("替换为")}</span>
              <InputGroup
                size="small"
                value={op.replace}
                placeholder={op.regex ? t("$1 = 第 1 组") : t("新文字")}
                spellCheck={false}
                onChange={(e) => patchOp(op.id, { replace: e.target.value } as Partial<RenameOp>)}
              />
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("按")}</span>
              <Seg
                value={op.regex ? "regex" : "literal"}
                options={[
                  { value: "literal", label: t("文字") },
                  { value: "regex", label: t("表达式"), title: "正则表达式，替换串支持 $1 捕获组" },
                ]}
                onChange={(v) => patchOp(op.id, { regex: v === "regex" } as Partial<RenameOp>)}
              />
            </span>
            {op.regex && (
              <span className="np-rchain-pair">
                <NpSelect
                  value={"__rx__"}
                  options={[
                    { value: "__rx__", label: t("常用示例 ▾") },
                    { value: "\\s+", label: t("去空格（\\s+）") },
                    { value: "\\(.*?\\)", label: t("去括号内容") },
                    { value: "^\\d+[._-]", label: t("去序号前缀") },
                  ]}
                  onChange={(v) => {
                    if (v !== "__rx__") patchOp(op.id, { find: v } as Partial<RenameOp>);
                  }}
                />
              </span>
            )}
          </>
        );
      case "remove":
        return (
          <span className="np-rchain-pair">
            <span className="np-rchain-pair-k">{t("删除")}</span>
            <InputGroup
              size="small"
              value={op.find}
              placeholder={t("要删除的文字")}
              spellCheck={false}
              onChange={(e) => patchOp(op.id, { find: e.target.value } as Partial<RenameOp>)}
            />
          </span>
        );
      case "insert":
        return (
          <>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("内容")}</span>
              <InputGroup
                size="small"
                value={op.text}
                placeholder={t("要插入的文字")}
                spellCheck={false}
                onChange={(e) => patchOp(op.id, { text: e.target.value } as Partial<RenameOp>)}
              />
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("位置")}</span>
              <Seg
                value={op.position}
                options={[
                  { value: "start", label: t("最前") },
                  { value: "end", label: t("最后") },
                ]}
                onChange={(v) => patchOp(op.id, { position: v } as Partial<RenameOp>)}
              />
            </span>
          </>
        );
      case "prefix":
        return (
          <span className="np-rchain-pair">
            <span className="np-rchain-pair-k">{t("加在最前")}</span>
            <InputGroup
              size="small"
              value={op.text}
              placeholder={t("前缀文字")}
              spellCheck={false}
              onChange={(e) => patchOp(op.id, { text: e.target.value } as Partial<RenameOp>)}
            />
          </span>
        );
      case "suffix":
        return (
          <span className="np-rchain-pair">
            <span className="np-rchain-pair-k">{t("加在末尾")}</span>
            <InputGroup
              size="small"
              value={op.text}
              placeholder={t("后缀文字")}
              spellCheck={false}
              onChange={(e) => patchOp(op.id, { text: e.target.value } as Partial<RenameOp>)}
            />
          </span>
        );
      case "trim":
        return (
          <>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("去开头")}</span>
              <input
                className="np-bren-num"
                type="number"
                min={0}
                value={op.head}
                onChange={(e) =>
                  patchOp(op.id, { head: Math.max(0, Math.floor(Number(e.target.value) || 0)) } as Partial<RenameOp>)
                }
              />
              <span className="np-rchain-pair-k">{t("个字符")}</span>
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("去末尾")}</span>
              <input
                className="np-bren-num"
                type="number"
                min={0}
                value={op.tail}
                onChange={(e) =>
                  patchOp(op.id, { tail: Math.max(0, Math.floor(Number(e.target.value) || 0)) } as Partial<RenameOp>)
                }
              />
              <span className="np-rchain-pair-k">{t("个字符")}</span>
            </span>
          </>
        );
      case "number":
        return (
          <>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("位置")}</span>
              <Seg
                value={op.position}
                options={[
                  { value: "start", label: t("最前") },
                  { value: "end", label: t("最后") },
                ]}
                onChange={(v) => patchOp(op.id, { position: v } as Partial<RenameOp>)}
              />
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("从")}</span>
              <input
                className="np-bren-num"
                type="number"
                min={0}
                value={op.start}
                onChange={(e) =>
                  patchOp(op.id, { start: Math.max(0, Math.floor(Number(e.target.value) || 0)) } as Partial<RenameOp>)
                }
              />
              <span className="np-rchain-pair-k">{t("起")}</span>
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("位数")}</span>
              <NpSelect value={op.pad} options={R_PAD_OPTS} onChange={(pad) => patchOp(op.id, { pad } as Partial<RenameOp>)} />
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("分隔")}</span>
              <InputGroup
                size="small"
                value={op.separator}
                placeholder={t("-")}
                spellCheck={false}
                onChange={(e) => patchOp(op.id, { separator: e.target.value } as Partial<RenameOp>)}
              />
            </span>
          </>
        );
      case "case":
        return (
          <span className="np-rchain-pair">
            <span className="np-rchain-pair-k">{t("转成")}</span>
            <NpSelect
              value={op.mode}
              options={[...R_CASE_OPTS]}
              onChange={(mode) => patchOp(op.id, { mode } as Partial<RenameOp>)}
            />
          </span>
        );
      case "date":
        return (
          <>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("格式")}</span>
              <NpSelect
                value={op.format}
                options={[...R_DATE_OPTS]}
                onChange={(format) => patchOp(op.id, { format } as Partial<RenameOp>)}
              />
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("位置")}</span>
              <Seg
                value={op.position}
                options={[
                  { value: "start", label: t("最前") },
                  { value: "end", label: t("最后") },
                ]}
                onChange={(v) => patchOp(op.id, { position: v } as Partial<RenameOp>)}
              />
            </span>
            <span className="np-rchain-pair">
              <span className="np-rchain-pair-k">{t("分隔")}</span>
              <InputGroup
                size="small"
                value={op.separator}
                placeholder={t("_")}
                spellCheck={false}
                onChange={(e) => patchOp(op.id, { separator: e.target.value } as Partial<RenameOp>)}
              />
            </span>
          </>
        );
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
              {/* 添加规则 = 原生按钮直接追加默认类型（查找替换），类型在卡上
                  下拉更换——NpSelect 弹层在 Dialog 内对自动化/真实点击均有时序
                  不稳定，原生 button 已验证可靠 */}
              <button
                className="np-bren-chip"
                onClick={() => addOp("replace")}
              >
                ＋ {t("添加规则")}
              </button>
              <span className="np-dialog-muted">
                {opsList.length} {t("条规则")}
              </span>
            </div>
            {opsList.length === 0 ? (
              <div className="np-rchain-empty">
                <div>{t("还没有规则——点「添加规则」开始，规则按从上到下顺序生效。也可从常用任务开始：")}</div>
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
                    }`}
                    onPointerDown={(e) => {
                      // NpSelect/Button/输入交互不启动拖拽
                      if ((e.target as HTMLElement).closest(".np-select, button, input, .bp6-input-group, .np-seg")) return;
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
                    {/* 两行紧凑布局：行1 = 序号+类型+作用域+操作钮，行2 = 参数区，
                        行3 = 人话效果（describeOp 实时生成）；卡片可拖拽排序 */}
                    <div className="np-rchain-top">
                      <span className="np-rchain-idx" data-tip="拖动卡片可调整顺序">
                        {idx + 1}
                      </span>
                      <NpSelect
                        value={op.type}
                        options={OP_TYPE_ITEMS.map((x) => ({ value: x.type, label: x.label }))}
                        onChange={(type) => changeType(op.id, type)}
                      />
                      <NpSelect
                        value={op.scope}
                        options={R_SCOPE_OPTS.map((x) => ({ value: x.value, label: x.label, title: x.title }))}
                        onChange={(scope) => patchOp(op.id, { scope } as Partial<RenameOp>)}
                      />
                      <span className="np-rchain-sp" />
                      <button className="np-rchain-btn" data-tip="删除规则" onClick={() => removeOp(op.id)}>
                        <AppIcon icon={X} size={DENSITY.iconXs} />
                      </button>
                    </div>
                    <div className="np-rchain-params">{opParams(op)}</div>
                    <div className="np-rchain-plain">
                      <AppIcon icon={CircleCheck} size={DENSITY.iconXs} />
                      <span>{describeOp(op)}</span>
                    </div>
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
