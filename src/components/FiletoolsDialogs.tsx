// 文件工具对话框（2026-11-09 功能库「工具」组）：计算校验值 / 校验核对 /
// 修改时间与属性 / 文件分割。表单复用 np-bren-form/field 基类 + Seg（np-seg），
// 结果清单复用 np-dup-list 凹陷容器语言；哈希逐文件串行请求（行级渐进点亮，
// live 旗标防卸载后 setState）；参数随 settings.dialogPrefs 记忆（同 NewFoldersDialog）。
import { useEffect, useMemo, useState } from "react";
import { t, useT } from "../lib/i18n";
import { api, type FileEntry, type HashAlgo, type HashRow, type VerifyReport } from "../lib/ipc";
import { Button, DialogBody, DialogFooter, InputGroup } from "@blueprintjs/core";
import { Check, LoaderCircle, Minus, X } from "lucide-react";

import { loadDialogPrefs, saveDialogPrefs } from "../lib/dialogPrefs";
import { useUi } from "../stores/ui";
import { useJobs } from "../stores/jobs";
import { formatBytes } from "../lib/format";
import { parentPath } from "../lib/path";
import { AppIcon } from "./AppIcon";
import { Seg } from "./ImgDialogs";
import { NpSelect } from "./NpSelect";
import { DENSITY } from "../lib/tokens";

const ALGOS: { value: HashAlgo; label: string }[] = [
  { value: "md5", label: "MD5" },
  { value: "sha1", label: "SHA-1" },
  { value: "sha256", label: "SHA-256" },
  { value: "sha512", label: "SHA-512" },
];

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
  const t2 = useT();
  return (
    <DialogFooter
      actions={
        <>
          <Button size="small" onClick={onCancel}>
            {t2("取消")}
          </Button>
          <Button size="small" intent="primary" disabled={disabled} onClick={onOk}>
            {okText}
          </Button>
        </>
      }
    />
  );
}

/** 计算校验值：MD5/SHA-1/SHA-256/SHA-512 逐行点亮（大文件行内等待态），
 *  行点击复制单条；支持复制全部与保存 GNU SUMS 校验文件（无 BOM，md5sum 兼容） */
export function HashCalcDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("hashCalc", { algo: "sha256" as HashAlgo });
  const [algo, setAlgo] = useState<HashAlgo>(init.algo);
  const [rows, setRows] = useState<(HashRow & { pending?: boolean })[]>(() =>
    entries.map((e) => ({ path: e.path, name: e.name, hash: null, error: null, pending: true })),
  );
  const [busy, setBusy] = useState(true);

  // 算法切换 / 入场即逐文件串行哈希（行级 pending → done；live 防卸载竞态）
  useEffect(() => {
    let live = true;
    let idx = 0;
    setBusy(true);
    const step = (): void => {
      if (!live) return;
      if (idx >= entries.length) {
        live && setBusy(false);
        return;
      }
      const e = entries[idx];
      api
        .hashFiles([e.path], algo)
        .then((rs) => {
          if (!live) return;
          const r = rs[0];
          setRows((prev) =>
            prev.map((row, i) =>
              i === idx
                ? { path: r.path, name: r.name, hash: r.hash, error: r.error }
                : row,
            ),
          );
          idx += 1;
          step();
        })
        .catch((err) => {
          if (!live) return;
          setRows((prev) =>
            prev.map((row, i) =>
              i === idx ? { ...row, error: String(err), pending: false } : row,
            ),
          );
          idx += 1;
          step();
        });
    };
    setRows(
      entries.map((e) => ({
        path: e.path,
        name: e.name,
        hash: null,
        error: null,
        pending: true,
      })),
    );
    step();
    return () => {
      live = false;
    };
  }, [algo, entries]);

  const pickAlgo = (a: HashAlgo): void => {
    setAlgo(a);
    saveDialogPrefs("hashCalc", { algo: a });
  };

  const doneRows = rows.filter((r) => r.hash);
  const lineOf = (r: HashRow): string => (r.hash ? `${r.hash}  ${r.name}` : "");
  const copyAll = (): void =>
    void navigator.clipboard.writeText(doneRows.map(lineOf).join("\n"));

  const saveSums = (): void => {
    void (async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dir = entries[0] ? (parentPath(entries[0].path) ?? "") : "";
      const target = await save({
        defaultPath: `${dir}\\${algo.toUpperCase()}SUMS`,
        filters: [{ name: algo.toUpperCase(), extensions: [algo] }],
      });
      if (!target) return;
      try {
        const sums = `# X-Dir 校验清单（${algo}）\n${doneRows.map(lineOf).join("\n")}\n`;
        await api.saveSumsFile(target, sums);
        useUi.getState().toast(t2("校验文件已保存"));
      } catch (err) {
        useUi.getState().toast(`${t2("保存失败")}：${String(err)}`, "error");
      }
    })();
  };

  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <span className="np-bren-field">
            <span className="np-bren-k">{t2("算法")}</span>
            <Seg<HashAlgo> value={algo} onChange={pickAlgo} options={ALGOS} />
          </span>
        </div>
        <div className="np-dup-list">
          <div className="np-dialog-muted">
            {t2("共 {n} 个文件 · 点行复制单条校验值", { n: entries.length })}
          </div>
          {rows.map((r) => (
            <div
              key={r.path}
              className="np-ht-row"
              data-tip={r.hash ? `${r.hash}  ${r.name}` : r.error ?? undefined}
              onClick={() =>
                r.hash &&
                void navigator.clipboard
                  .writeText(lineOf(r))
                  .then(() => useUi.getState().toast(t2("校验值已复制")))
              }
            >
              {r.pending ? (
                <span className="np-ht-st">
                  <AppIcon icon={LoaderCircle} size={DENSITY.iconXs} />
                </span>
              ) : r.hash ? (
                <span className="np-ht-st np-ht-ok">
                  <AppIcon icon={Check} size={DENSITY.iconXs} />
                </span>
              ) : (
                <span className="np-ht-st np-ht-bad">
                  <AppIcon icon={X} size={DENSITY.iconXs} />
                </span>
              )}
              <span className="np-ht-name np-ellipsis">{r.name}</span>
              <span className="np-ht-hash">{r.hash ?? r.error ?? "…"}</span>
            </div>
          ))}
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              {t2("关闭")}
            </Button>
            <Button size="small" disabled={!doneRows.length || busy} onClick={copyAll}>
              {t2("复制全部")}
            </Button>
            <Button
              size="small"
              intent="primary"
              disabled={!doneRows.length || busy}
              onClick={saveSums}
            >
              {t2("保存校验文件")}
            </Button>
          </>
        }
      />
    </>
  );
}


/** 校验核对：选中 .md5/.sha256 等校验文件 → 后端逐项哈希比对 → ✓/✗/缺失报告 */
export function HashVerifyDialog({ path, onDone }: { path: string; onDone(): void }) {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api.verifySumsFile(path).then(
      (r) => live && setReport(r),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const bad = report ? report.total - report.okCount : 0;
  return (
    <>
      <DialogBody>
        {error ? (
          <div className="np-list-error">{t("核对失败")}：{error}</div>
        ) : !report ? (
          <div className="np-pv-none">
            <span className="np-spin">
              <AppIcon icon={LoaderCircle} size={DENSITY.iconLg} />
            </span>
            {t("正在逐项哈希比对…")}
          </div>
        ) : (
          <div className="np-dup-list">
            <div className="np-dialog-muted">
              {t("算法 {algo} · {ok}/{total} 通过 · {bad} 项异常", {
                algo: report.algo.toUpperCase(),
                ok: report.okCount,
                total: report.total,
                bad,
              })}
            </div>
            {report.rows.map((r) => (
              <div key={r.name} className="np-ht-row" data-tip={`${r.expected}  ${r.name}`}>
                <span
                  className={`np-ht-st ${
                    r.status === "ok"
                      ? "np-ht-ok"
                      : r.status === "missing"
                        ? "np-ht-miss"
                        : "np-ht-bad"
                  }`}
                  data-tip={
                    r.status === "ok"
                      ? t("一致")
                      : r.status === "mismatch"
                        ? t("哈希不符")
                        : r.status === "missing"
                          ? t("文件缺失")
                          : t("读取失败")
                  }
                >
                  <AppIcon
                    icon={r.status === "ok" ? Check : r.status === "missing" ? Minus : X}
                    size={DENSITY.iconXs}
                  />
                </span>
                <span className="np-ht-name np-ellipsis">{r.name}</span>
                <span className="np-ht-hash np-ellipsis">{r.status === "ok" ? r.expected : (r.actual ?? "—")}</span>
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <Button size="small" onClick={onDone}>
            {t("关闭")}
          </Button>
        }
      />
    </>
  );
}

type TimeMode = "keep" | "now" | "custom" | "copyFirst";
type AttrMode = "keep" | "yes" | "no";

/** 修改时间与属性（对标 DOpus Set Attributes / TC Change attributes）：
 *  修改/访问时间四态 + 只读/隐藏位三态，复制首项 = 全部对齐首项当前值 */
export function TouchDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("fileTouch", {
    mtime: "keep" as TimeMode,
    atime: "keep" as "keep" | "now" | "same",
    readonly: "keep" as AttrMode,
    hidden: "keep" as AttrMode,
  });
  const [mtime, setMtime] = useState<TimeMode>(init.mtime);
  const [atime, setAtime] = useState<"keep" | "now" | "same">(
    init.atime === "same" ? "same" : init.atime === "now" ? "now" : "keep",
  );
  const [readonly, setReadonly] = useState<AttrMode>(init.readonly);
  const [hidden, setHidden] = useState<AttrMode>(init.hidden);
  const [customText, setCustomText] = useState<string>(() => toLocalInput(Date.now()));
  const [busy, setBusy] = useState(false);

  // 指定时间态才需要校验：datetime-local 值非法 → 内联红字（§4.9 口径）
  const invalid = mtime === "custom" && Number.isNaN(new Date(customText).getTime());

  const patchMode = (m: TimeMode): void => {
    setMtime(m);
    saveDialogPrefs("fileTouch", { mtime: m, atime, readonly, hidden });
  };
  const patchAtime = (m: "keep" | "now" | "same"): void => {
    setAtime(m);
    saveDialogPrefs("fileTouch", { mtime, atime: m, readonly, hidden });
  };
  const patchRo = (m: AttrMode): void => {
    setReadonly(m);
    saveDialogPrefs("fileTouch", { mtime, atime, readonly: m, hidden });
  };
  const patchHid = (m: AttrMode): void => {
    setHidden(m);
    saveDialogPrefs("fileTouch", { mtime, atime, readonly, hidden: m });
  };

  const apply = (): void => {
    setBusy(true);
    const base = new Date(customText).getTime();
    const firstMs = entries[0]?.mtimeMs ?? Date.now();
    const mtimeMs =
      mtime === "keep"
        ? null
        : mtime === "now"
          ? Date.now()
          : mtime === "copyFirst"
            ? firstMs
            : base;
    const atimeMs =
      atime === "keep"
        ? null
        : atime === "same"
          ? (mtimeMs ?? firstMs)
          : Date.now();
    api
      .setFileMeta(
        entries.map((e) => e.path),
        {
          mtimeMs,
          atimeMs,
          readonly: readonly === "keep" ? null : readonly === "yes",
          hidden: hidden === "keep" ? null : hidden === "yes",
        },
      )
      .then((r) => {
        if (r.applied) useUi.getState().toast(t2("已更新 {n} 项", { n: r.applied }));
        if (r.failed.length)
          useUi.getState().toast(
            `${t2("{n} 项失败", { n: r.failed.length })}：${r.failed[0].message}`,
            "error",
          );
        onDone();
      })
      .catch((e) => {
        useUi.getState().toast(`${t2("修改失败")}：${String(e)}`, "error");
        setBusy(false);
      });
  };

  return (
    <>
      <DialogBody>
        <div className="np-dialog-muted">
          {t2("共 {n} 项 · 保持 = 该项不动；复制首项 = 全部对齐首项当前值", {
            n: entries.length,
          })}
        </div>
        <div className="np-bren-form">
          <span className="np-bren-field">
            <span className="np-bren-k">{t2("修改时间")}</span>
            <Seg<TimeMode>
              value={mtime}
              onChange={patchMode}
              options={[
                { value: "keep", label: t2("保持") },
                { value: "now", label: t2("当前时刻") },
                { value: "custom", label: t2("指定") },
                { value: "copyFirst", label: t2("复制首项") },
              ]}
            />
          </span>
          {mtime === "custom" && (
            <span className="np-bren-field">
              <span className="np-bren-k">{t2("指定时间")}</span>
              <InputGroup
                type="datetime-local"
                size="small"
                value={customText}
                onChange={(e) => setCustomText(e.currentTarget.value)}
                intent={invalid ? "danger" : undefined}
              />
            </span>
          )}
          <span className="np-bren-field">
            <span className="np-bren-k">{t2("访问时间")}</span>
            <Seg<"keep" | "now" | "same">
              value={atime}
              onChange={patchAtime}
              options={[
                { value: "keep", label: t2("保持") },
                { value: "same", label: t2("跟随修改时间") },
                { value: "now", label: t2("当前时刻") },
              ]}
            />
          </span>
          <span className="np-bren-field">
            <span className="np-bren-k">{t2("只读")}</span>
            <Seg<AttrMode>
              value={readonly}
              onChange={patchRo}
              options={[
                { value: "keep", label: t2("保持") },
                { value: "yes", label: t2("设为只读") },
                { value: "no", label: t2("设为可写") },
              ]}
            />
          </span>
          <span className="np-bren-field">
            <span className="np-bren-k">{t2("隐藏")}</span>
            <Seg<AttrMode>
              value={hidden}
              onChange={patchHid}
              options={[
                { value: "keep", label: t2("保持") },
                { value: "yes", label: t2("设为隐藏") },
                { value: "no", label: t2("取消隐藏") },
              ]}
            />
          </span>
        </div>
        {invalid && (
          <div className="np-dialog-error">{t2("时间格式无效（示例 2026-11-09 14:30）")}</div>
        )}
      </DialogBody>
      <Footer okText={t2("应用")} disabled={invalid || busy} onOk={apply} onCancel={onDone} />
    </>
  );
}

/** datetime-local 显示值（本地时区 yyyy-MM-ddTHH:mm） */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(
    d.getHours(),
  )}:${p2(d.getMinutes())}`;
}

const PART_SIZES = [1, 10, 50, 100, 500, 1024];

/** 文件分割：部件大小选择 + 部件数预演，确认入任务引擎（.partNNN + .crc 清单） */
export function SplitDialog({
  entry,
  onDone,
}: {
  entry: FileEntry;
  onDone(): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("fileSplit", { partMb: 100 });
  const [partMb, setPartMb] = useState<number>(
    PART_SIZES.includes(init.partMb) ? init.partMb : 100,
  );
  const [busy, setBusy] = useState(false);
  const parts = useMemo(
    () => Math.max(1, Math.ceil(entry.size / (partMb * 1024 * 1024))),
    [entry.size, partMb],
  );
  const apply = (): void => {
    setBusy(true);
    saveDialogPrefs("fileSplit", { partMb });
    void (async () => {
      try {
        const { jobId } = await api.splitFile(entry.path, partMb);
        useJobs
          .getState()
          .register(jobId, "split", null, [parentPath(entry.path) ?? ""]);
        onDone();
      } catch (e) {
        useUi.getState().toast(`${t2("分割失败")}：${String(e)}`, "error");
        setBusy(false);
      }
    })();
  };
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <span className="np-bren-field">
            <span className="np-bren-k">{t2("部件大小")}</span>
            <NpSelect
              value={String(partMb)}
              onChange={(v) => setPartMb(Number(v))}
              options={PART_SIZES.map((mb) => ({
                value: String(mb),
                label: mb >= 1024 ? t2("{n} GB", { n: mb / 1024 }) : t2("{n} MB", { n: mb }),
              }))}
            />
          </span>
        </div>
        <div className="np-dialog-muted">
          {t2("共 {size} → 预计 {n} 个部件", {
            size: entry.isDir ? "—" : formatBytes(entry.size),
            n: parts,
          })}
          <br />
          {t2("输出预览：{name}.part001… + {name}.crc（SHA-256 完整性清单）", {
            name: entry.name,
          })}
        </div>
      </DialogBody>
      <Footer okText={t2("开始分割")} disabled={busy} onOk={apply} onCancel={onDone} />
    </>
  );
}
