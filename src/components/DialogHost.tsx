import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  InputGroup,
  Radio,
  RadioGroup,
  Switch,
  type Intent,
} from "@blueprintjs/core";
import { ArrowRight, Info, OctagonAlert, TriangleAlert } from "lucide-react";

import { formatBytes, formatSize, formatTime } from "../lib/format";
import { typeName } from "../lib/fileIcons";
import { api, type FileEntry } from "../lib/ipc";
import { DEFAULT_RULE, pickRenames, planRenames, type RenameRule } from "../lib/batchRename";
import { AppIcon, ic } from "./AppIcon";
import { CompareDialog, DirSizeDialog, DuplicateDialog } from "./AnalyzeDialogs";
import {
  CompressDialog,
  ConvertDialog,
  MontageDialog,
  ResizeDialog,
  WatermarkDialog,
} from "./ImgDialogs";
import { NpSelect } from "./NpSelect";
import { DENSITY } from "../lib/tokens";
import { useUi, type DialogKind, type DialogSpec } from "../stores/ui";

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
  const kind: DialogKind =
    dialog && (dialog.type === "confirm" || dialog.type === "alert")
      ? (dialog.kind ?? "info")
      : "info";

  const title =
    dialog?.type === "confirm"
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
          dialog?.type === "duplicates" ||
          dialog?.type === "dirsizes" ||
          dialog?.type === "compare"
            ? "min(680px, 92vw)"
            : dialog?.type.startsWith("img")
              ? "min(560px, 92vw)"
              : "var(--np-dialog-w)",
      }}
    >
      {dialog?.type === "confirm" && (
        <>
          <DialogBody>
            <div className="np-dialog-muted">{dialog.message}</div>
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
                  onClick={() => resolve(true)}
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

      {dialog?.type === "imgCompress" && (
        <CompressDialog
          count={dialog.entries.length}
          onDone={(v) => {
            resolve(v);
          }}
        />
      )}
      {dialog?.type === "imgWatermark" && (
        <WatermarkDialog count={dialog.entries.length} onDone={(v) => resolve(v)} />
      )}
      {dialog?.type === "imgConvert" && (
        <ConvertDialog count={dialog.entries.length} onDone={(v) => resolve(v)} />
      )}
      {dialog?.type === "imgResize" && (
        <ResizeDialog count={dialog.entries.length} onDone={(v) => resolve(v)} />
      )}
      {dialog?.type === "imgMontage" && (
        <MontageDialog count={dialog.entries.length} onDone={(v) => resolve(v)} />
      )}

      {dialog?.type === "properties" && (
        <>
          <DialogBody>
            <div className="np-props">
              <Prop k="名称" v={dialog.entry.name} />
              <Prop k="路径" v={dialog.entry.path} />
              <Prop k="类型" v={typeName(dialog.entry.name, dialog.entry.isDir)} />
              <Prop k="大小" v={<SizeValue entry={dialog.entry} />} />
              <Prop k="修改时间" v={formatTime(dialog.entry.mtimeMs)} />
              <Prop k="创建时间" v={formatTime(dialog.entry.ctimeMs)} />
              <Prop
                k="属性"
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
            actions={<Button size="small" intent="primary" onClick={close}>关闭</Button>}
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
              取消
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
          <Radio value="overwrite" label="覆盖目标文件" />
          <Radio value="skip" label="跳过这些文件" />
          <Radio value="rename" label="保留两者（重命名为 “xxx (2).ext”）" />
        </RadioGroup>
        <Switch
          className="np-conflict-remember"
          checked={remember}
          label="本会话内不再询问（后续冲突直接套用该策略）"
          onChange={(e) => setRemember(e.currentTarget.checked)}
        />
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={() => onDone(null)}>
              取消
            </Button>
            <Button size="small" intent="primary" onClick={() => onDone({ action, remember })}>
              确定
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

/** 大小行：文件即时显示；文件夹经 dir_sizes 异步求和（子项递归合计，
 *  200k 文件护栏与空间分析同源）；盘符根不扫全盘，维持 "—" */
function SizeValue({ entry }: { entry: FileEntry }) {
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

const SEQ_PAD_OPTS = [1, 2, 3, 4].map((n) => ({ value: n, label: `${n} 位` }));

/** 批量重命名：查找替换 + 前后缀 + 可选序号，实时预览（规则引擎在 lib/batchRename） */
function BatchRenameDialog({
  dialog,
  onDone,
}: {
  dialog: Extract<DialogSpec, { type: "batchRename" }>;
  onDone(v: { path: string; newName: string }[] | null): void;
}) {
  const [rule, setRule] = useState<RenameRule>(DEFAULT_RULE);
  const plan = useMemo(() => planRenames(dialog.entries, rule), [dialog.entries, rule]);
  const todo = pickRenames(plan);
  const errorCount = plan.filter((i) => i.changed && i.error).length;
  const changedCount = plan.filter((i) => i.changed).length;
  const patch = (p: Partial<RenameRule>) => setRule((r) => ({ ...r, ...p }));
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <span className="np-bren-field">
            <span className="np-bren-k">查找</span>
            <InputGroup
              size="small"
              value={rule.find}
              placeholder="留空 = 不替换"
              spellCheck={false}
              onChange={(e) => patch({ find: e.target.value })}
            />
          </span>
          <span className="np-bren-field">
            <span className="np-bren-k">替换为</span>
            <InputGroup
              size="small"
              value={rule.replace}
              spellCheck={false}
              onChange={(e) => patch({ replace: e.target.value })}
            />
          </span>
          <span className="np-bren-field">
            <span className="np-bren-k">前缀</span>
            <InputGroup
              size="small"
              value={rule.prefix}
              spellCheck={false}
              onChange={(e) => patch({ prefix: e.target.value })}
            />
          </span>
          <span className="np-bren-field">
            <span className="np-bren-k">后缀</span>
            <InputGroup
              size="small"
              value={rule.suffix}
              spellCheck={false}
              onChange={(e) => patch({ suffix: e.target.value })}
            />
          </span>
        </div>
        <div className="np-bren-form">
          <span className="np-bren-field">
            {/* Switch v6 无 small 档，默认即紧凑（AGENTS §4.4） */}
            <Switch
              checked={rule.useSeq}
              label="加序号"
              onChange={(e) => patch({ useSeq: e.currentTarget.checked })}
            />
          </span>
          <span className="np-bren-field">
            <span className="np-bren-k">起始</span>
            <InputGroup
              size="small"
              value={String(rule.seqStart)}
              disabled={!rule.useSeq}
              spellCheck={false}
              onChange={(e) => {
                const n = Number(e.target.value);
                patch({ seqStart: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1 });
              }}
            />
          </span>
          <span className="np-bren-field">
            <span className="np-bren-k">位数</span>
            <NpSelect
              value={rule.seqPad}
              options={SEQ_PAD_OPTS}
              onChange={(seqPad) => patch({ seqPad })}
            />
          </span>
        </div>
        <div className="np-bren-preview">
          {plan.slice(0, 200).map((i) => (
            <div key={i.path} className="np-bren-row">
              <span className="np-bren-old np-ellipsis">{i.oldName}</span>
              <AppIcon
                icon={ArrowRight}
                size={DENSITY.iconXs}
                className="np-bren-arrow"
              />
              <span
                className={`np-bren-new np-ellipsis ${
                  i.error ? "is-err" : i.changed ? "is-chg" : "is-same"
                }`}
              >
                {i.error ?? i.newName}
              </span>
            </div>
          ))}
        </div>
        <div className="np-dialog-muted">
          已变更 {changedCount} / 共 {dialog.entries.length} 项
          {errorCount > 0 && `，${errorCount} 项冲突或非法（红色标出）`}
          {plan.length > 200 && "（仅预览前 200 行）"}
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={() => onDone(null)}>
              取消
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
