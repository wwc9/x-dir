// 文件操作编排：冲突预检 → 对话框 → 入队（§6.7 冲突流程）
// V2：nativeFileOps 开启时走 IFileOperation，冲突由系统对话框处理，
// 此处跳过预检对话框（policy 传 rename 仅作原生失败回退时的兜底语义）。

import { api, type Policy, type RenameOutcome } from "./ipc";
import type { ExportListingOptions } from "./listing";
import { fileNameOf, isValidName, joinPath, parentPath } from "./path";
import { montageOutputName } from "./imgOps";
import {
  pdfPngDirName,
  pdfPngFileName,
  type PdfToPngOptions,
  type PdfSplitOptions,
} from "./pdfOps";
import { useJobs } from "../stores/jobs";
import { usePanes } from "../stores/panes";
import { useSettings } from "../stores/settings";
import { confirmDialog, useUi } from "../stores/ui";
import { useUndo } from "./undo";
import type { FileEntry } from "./ipc";
import { t } from "./i18n";

/** 会话级冲突策略记忆：冲突对话框勾选「本会话内不再询问」后置位，
 *  后续传输遇到冲突直接套用（重启即失效，不落盘） */
let sessionConflictPolicy: Policy | null = null;

export async function transfer(
  sources: string[],
  destDir: string,
  mode: "copy" | "move",
): Promise<void> {
  if (!sources.length) return;
  try {
    const native = useSettings.getState().nativeFileOps;
    let policy: Policy = native ? "rename" : "skip";
    if (!native) {
      const conflicts = await api.checkConflicts(sources, destDir);
      if (conflicts.length) {
        if (sessionConflictPolicy) {
          policy = sessionConflictPolicy;
        } else {
          const result = await useUi.getState().openDialog<{
            action: Policy;
            remember: boolean;
          } | null>({
            type: "conflict",
            items: conflicts.map((c) => c.sourceName),
          });
          if (!result) return;
          policy = result.action;
          if (result.remember) sessionConflictPolicy = result.action;
        }
      }
    }
    const { jobId } =
      mode === "copy"
        ? await api.copyItems(sources, destDir, policy, native)
        : await api.moveItems(sources, destDir, policy, native);
    const sourceParents = sources
      .map((s) => parentPath(s))
      .filter((p): p is string => !!p);
    // 撤销入栈（2026-11-06 精确化）：job-done 的 items 携带成功项的精确
    // from→to 路径对（rename 策略 "(2)" 落点名、skip 排除项都对得上）——
    // copy 撤销 = 删除 to 副本、move 撤销 = to 移回 from 父目录；native
    // （IFileOperation）与部分成功无 items 时不入栈：宁可不可撤销不可错撤销
    const onDone = ({
      ok,
      cancelled,
      items,
    }: {
      ok: boolean;
      cancelled: boolean;
      items?: { from: string; to: string }[];
    }) => {
      if (!ok || cancelled || !items?.length) return;
      if (mode === "copy") {
        useUndo.getState().push({
          kind: "copy",
          sources,
          destDir,
          copies: items.map((i) => i.to),
        });
      } else {
        useUndo.getState().push({ kind: "move", destDir, pairs: items });
      }
    };
    useJobs.getState().register(jobId, mode, destDir, sourceParents, onDone);
  } catch (e) {
    useUi.getState().toast(t("操作失败：{e}", { e: String(e) }), "error");
  }
}

export async function deletePaths(
  paths: string[],
  confirmDelete: boolean,
  permanent = false,
): Promise<void> {
  if (!paths.length) return;
  // 永久删除不可恢复：无论"删除前确认"开关，一律 danger 确认，且不提供
  // "以后不再确认"（不可逆操作保留强制确认）；回收站删除可勾选直接关掉确认
  if (confirmDelete || permanent) {
    const ok = await confirmDialog(
      permanent
        ? {
            title: t("永久删除确认"),
            message: t("确定永久删除选中的 {n} 项吗？此操作不可恢复！", { n: paths.length }),
            kind: "danger",
            okText: t("永久删除"),
          }
        : {
            title: t("删除确认"),
            message: t("确定把选中的 {n} 项移入回收站吗？", { n: paths.length }),
            kind: "warn",
            okText: t("移入回收站"),
            rememberLabel: t("以后不再确认，直接移入回收站（可在设置 → 文件操作中恢复）"),
            onRemember: () => useSettings.getState().update({ confirmDelete: false }),
          },
    );
    if (!ok) return;
  }
  await enqueueDelete(paths, permanent);
}

/** 入队删除任务（不做确认）：删除入口与「解除占用后重试」共用——
 *  重试路径用户已在原始删除（及解除占用对话框）确认过，不再重复询问 */
export async function enqueueDelete(paths: string[], permanent: boolean): Promise<void> {
  if (!paths.length) return;
  try {
    const { jobId } = await api.deleteItems(paths, permanent);
    const sourceParents = paths
      .map((s) => parentPath(s))
      .filter((p): p is string => !!p);
    // 回收站删除可逆（还原）；永久删除不入撤销栈
    const onDone =
      permanent
        ? undefined
        : ({ ok, cancelled }: { ok: boolean; cancelled: boolean }) => {
            if (ok && !cancelled) useUndo.getState().push({ kind: "trash", paths });
          };
    useJobs.getState().register(jobId, "delete", null, sourceParents, onDone, permanent);
  } catch (e) {
    useUi.getState().toast(t("删除失败：{e}", { e: String(e) }), "error");
  }
}

/// 新建文件夹 / 文本文件的统一入口（右键菜单与全局工具栏共用）；
/// spec 可指定对话框标题与默认名（「新建」子菜单的办公格式用）
export async function createEntry(
  parentDir: string,
  kind: "dir" | "file",
  onDone: () => void,
  spec?: { title: string; initial: string },
): Promise<void> {
  const name = await useUi.getState().openDialog<string | null>({
    type: "input",
    title: spec?.title ?? (kind === "dir" ? t("新建文件夹") : t("新建文本文件")),
    initial: spec?.initial ?? (kind === "dir" ? t("新建文件夹") : t("新建文本文件.txt")),
    okText: t("创建"),
    validate: (v) => (isValidName(v) ? null : t("名称含非法字符或为 Windows 保留名")),
  });
  if (!name) return;
  try {
    if (kind === "dir") {
      await api.createDir(parentDir, name);
    } else {
      await api.createFile(parentDir, name);
    }
    // 新建可逆：撤销 = 移入回收站（仍可再还原）
    useUndo.getState().push({ kind: "newfolder", path: joinPath(parentDir, name) });
    onDone();
  } catch (e) {
    useUi.getState().toast(t("创建失败：{e}", { e: String(e) }), "error");
  }
}

/** 新建文件夹 Explorer 式（2026-11-11 用户定案）：不走弹窗——乐观插入合成行
 *  立即上屏并进入行内重命名（点击到出现零延迟，同 Explorer 体感），createDir
 *  在途；成功后软刷新 reconcile（真实条目同 path，合成行自动让位），失败撤
 *  合成行 + toast。重名自动 (2) 递增（同 Explorer 口径，大小写不敏感去重；
 *  existingNames = 调用方当前目录名清单，搜索/过滤态非全量由 Rust 端同名
 *  报错兜底） */
export async function createFolderInline(
  parentDir: string,
  existingNames: string[],
  tabId: string,
): Promise<void> {
  const names = new Set(existingNames.map((n) => n.toLowerCase()));
  let name = "新建文件夹";
  for (let n = 2; names.has(name.toLowerCase()) && n < 100; n += 1) {
    name = `新建文件夹 (${n})`;
  }
  const full = joinPath(parentDir, name);
  const now = Date.now();
  const synth: FileEntry = {
    name,
    path: full,
    isDir: true,
    size: 0,
    mtimeMs: now,
    ctimeMs: now,
    attrs: { hidden: false, system: false, readonly: false },
    py: null,
  };
  const panes = usePanes.getState();
  panes.setPendingNew(tabId, synth);
  panes.setEditing(tabId, full);
  try {
    await api.createDir(parentDir, name);
    // 新建可逆：撤销 = 移入回收站（与弹窗链路同 undo 结构）
    useUndo.getState().push({ kind: "newfolder", path: full });
    panes.bumpRefresh(tabId);
  } catch (e) {
    panes.setPendingNew(tabId, null);
    panes.setEditing(tabId, null);
    useUi.getState().toast(t("创建失败：{e}", { e: String(e) }), "error");
  }
}

/// ── PDF 处理（lopdf，走任务引擎）：合并 / 拆分单页 / 文字水印 ──

/** 按选中序合并为一个 PDF，输出到当前目录（同名覆盖） */
export async function mergePdfs(
  entries: FileEntry[],
  dir: string,
  variant: "files" | "folders",
): Promise<void> {
  // 文件夹混选：文件夹递归收集 pdf/图片；纯文件列表按顺序合并
  const res = await useUi.getState().openDialog<{
    autoBlank: boolean;
    blankFirst: boolean;
    name: string;
    paths: string[];
  } | null>({ type: "pdfMerge", variant, entries });
  if (!res) return;
  // 单项也合法（2026-11-11 用户定案取消 ≥2）：单图/单 PDF 合并 = 旁写重存
  const paths = res.paths;
  const byFolder = variant === "folders";
  const output = byFolder
    ? ""
    : joinPath(dir, res.name.toLowerCase().endsWith(".pdf") ? res.name : `${res.name.trim()}.pdf`);
  try {
    const { jobId } = await api.pdfMerge(
      paths,
      output,
      byFolder,
      res.autoBlank,
      res.autoBlank ? (res.blankFirst ? "第1页之前" : "最后1页之后") : undefined,
    );
    useJobs.getState().register(jobId, "pdfmerge", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("合并失败：{e}", { e: String(e) }), "error");
  }
}

/** 执行 PDF 拆分（2026-11-10 参数面板定案）：saveToFolder = 存进源文件名
 *  子文件夹（避免多文件拆分混在一起），否则直存所在目录；重名 (2) 递增 */
export async function runPdfSplit(
  entry: FileEntry,
  dir: string,
  opts: PdfSplitOptions,
): Promise<void> {
  try {
    const stem = fileNameOf(entry.path).replace(/\.pdf$/i, "");
    const outDir = opts.saveToFolder ? joinPath(dir, stem) : dir;
    const { jobId } = await api.pdfSplit(
      entry.path,
      outDir,
      opts.method,
      opts.nPages,
      opts.bookmarkLevel,
      opts.namingRule,
      opts.saveToFolder,
    );
    useJobs.getState().register(jobId, "pdfsplit", outDir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("拆分失败：{e}", { e: String(e) }), "error");
  }
}

/** 文字水印（参数化 + 待处理清单可拖动排序），旁写 "<名称>_水印.pdf"，不改原文件 */
export async function watermarkPdfs(entries: FileEntry[], dir: string): Promise<void> {
  if (!entries.length) return;
  const opts = await useUi.getState().openDialog<
    | {
        paths: string[];
        text: string;
        outName: string;
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
    | null
  >({ type: "pdfWatermark", entries });
  if (!opts) return;
  try {
    // paths = 清单拖动排序后的处理顺序
    const { jobId } = await api.pdfWatermark(opts);
    useJobs.getState().register(jobId, "pdfwatermark", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("加水印失败：{e}", { e: String(e) }), "error");
  }
}

// ── 办公批处理（2026-10-14）：PDF 页级编辑 / 图片转 PDF / Office 三件 / 表格文本 / 整理 ──

/** PDF 提取页：pdfPages 对话框（页数回显 + 范围解析预演）→ 旁写 "<名称>_提取.pdf"；
 *  Rust 端对真实页数做最终校验 */
export async function extractPdfPages(entry: FileEntry, dir: string): Promise<void> {
  const spec = await useUi.getState().openDialog<string | null>({
    type: "pdfPages",
    mode: "extract",
    entry,
  });
  if (!spec) return;
  const stem = fileNameOf(entry.path).replace(/\.pdf$/i, "");
  try {
    const { jobId } = await api.pdfExtractPages(entry.path, spec, joinPath(dir, `${stem}_提取.pdf`));
    useJobs.getState().register(jobId, "pdfextract", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("提取失败：{e}", { e: String(e) }), "error");
  }
}

/** PDF 删除页：spec 指定的页被移除 → 旁写 "<名称>_删页.pdf"，原文件不动 */
export async function removePdfPages(entry: FileEntry, dir: string): Promise<void> {
  const spec = await useUi.getState().openDialog<string | null>({
    type: "pdfPages",
    mode: "remove",
    entry,
  });
  if (!spec) return;
  const stem = fileNameOf(entry.path).replace(/\.pdf$/i, "");
  try {
    const { jobId } = await api.pdfRemovePages(entry.path, spec, joinPath(dir, `${stem}_删页.pdf`));
    useJobs.getState().register(jobId, "pdfremove", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("删页失败：{e}", { e: String(e) }), "error");
  }
}

/** PDF 旋转（原地，全部页相对旋转；可反向旋转还原） */
export async function rotatePdf(entry: FileEntry, degrees: number): Promise<void> {
  try {
    const { jobId } = await api.pdfRotate(entry.path, degrees);
    useJobs.getState().register(jobId, "pdfrotate", null, [parentPath(entry.path) ?? ""]);
  } catch (e) {
    useUi.getState().toast(t("旋转失败：{e}", { e: String(e) }), "error");
  }
}

/** PDF 轻压缩（对象去重 + 重压缩），旁写 "<名称>_压缩.pdf" */
export async function compressPdfs(entries: FileEntry[], dir: string): Promise<void> {
  try {
    const { jobId } = await api.pdfCompress(entries.map((e) => e.path));
    useJobs.getState().register(jobId, "pdfcompress", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("压缩失败：{e}", { e: String(e) }), "error");
  }
}

// ── 插入空白页 / 加密 / 解密 / 转图片（2026-11-11 功能库 PDF 组扩充）──

/** PDF 插入空白页：参数面板（12 模式）→ 任务引擎，旁写 "<名称>_插页.pdf" */
export async function insertBlankPages(entries: FileEntry[], dir: string): Promise<void> {
  if (!entries.length) return;
  const opts = await useUi
    .getState()
    .openDialog<{ mode: number; spec: string; n: number } | null>({
      type: "pdfInsertBlank",
      entries,
    });
  if (!opts) return;
  try {
    const { jobId } = await api.pdfInsertBlank(
      entries.map((e) => e.path),
      opts.mode,
      opts.spec.trim(),
      opts.n,
    );
    useJobs.getState().register(jobId, "pdfinsertblank", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("插入空白页失败：{e}", { e: String(e) }), "error");
  }
}

export interface PdfEncryptPayload {
  openPassword: string;
  editPassword: string;
  permPrint: boolean;
  permCopy: boolean;
  permEdit: boolean;
}

/** PDF AES-128 加密：参数面板 → 任务引擎，旁写 "<名称>_加密.pdf" */
export async function encryptPdfs(entries: FileEntry[], dir: string): Promise<void> {
  if (!entries.length) return;
  const opts = await useUi.getState().openDialog<PdfEncryptPayload | null>({
    type: "pdfEncrypt",
    entries,
  });
  if (!opts) return;
  try {
    const { jobId } = await api.pdfEncrypt(
      entries.map((e) => e.path),
      opts.openPassword,
      opts.editPassword,
      opts.permPrint,
      opts.permCopy,
      opts.permEdit,
    );
    useJobs.getState().register(jobId, "pdfencrypt", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("加密失败：{e}", { e: String(e) }), "error");
  }
}

/** PDF 解密：密码面板 → 任务引擎，旁写 "<名称>_解密.pdf"（原文件不动） */
export async function decryptPdfs(entries: FileEntry[], dir: string): Promise<void> {
  if (!entries.length) return;
  const opts = await useUi.getState().openDialog<{ password: string } | null>({
    type: "pdfDecrypt",
    entries,
  });
  if (!opts) return;
  try {
    const { jobId } = await api.pdfDecrypt(
      entries.map((e) => e.path),
      opts.password,
    );
    useJobs.getState().register(jobId, "pdfdecrypt", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("解密失败：{e}", { e: String(e) }), "error");
  }
}

/** PDF 转图片（PNG）：前端 pdf.js 逐页渲染（宽松协议唯一可行的渲染器——
 *  pdfium/mupdf/poppler 全是 AGPL/GPL 红线），Rust 端 write_png_b64 只做
 *  安全落盘。进度走本地任务通道（负数 jobId，island/任务面板共用 UI） */
export async function pdfToPngs(entries: FileEntry[], dir: string): Promise<void> {
  if (!entries.length) return;
  const opts = await useUi.getState().openDialog<PdfToPngOptions | null>({
    type: "pdfToPng",
    entries,
  });
  if (!opts) return;
  const [{ loadPdfjs, pdfjsDocParams }, { convertFileSrc }] = await Promise.all([
    import("./pdfjs"),
    import("@tauri-apps/api/core"),
  ]);
  const pdfjs = await loadPdfjs();
  const jobs = useJobs.getState();
  const jobId = jobs.registerLocal("pdftopng", dir, [dir]);
  jobs.updateLocal(jobId, { totalFiles: entries.length });
  const failed: { path: string; message: string }[] = [];
  // 渲染口令：开箱/权限任填其一（pdf.js 两把钥匙都收）
  const password = opts.userPassword || opts.ownerPassword || undefined;
  try {
    let done = 0;
    for (const e of entries) {
      if (useJobs.getState().isLocalCancelled(jobId)) {
        useJobs.getState().finishLocal(jobId, false, { cancelled: true });
        return;
      }
      const name = fileNameOf(e.path);
      useJobs.getState().updateLocal(jobId, { currentPath: name });
      try {
        const task = pdfjs.getDocument(pdfjsDocParams({ url: convertFileSrc(e.path) }, password));
        const doc = await task.promise;
        const total = doc.numPages;
        const start = Math.max(1, Math.min(opts.startPage || 1, total));
        const end = Math.min(opts.endPage || total, total);
        const stem = name.replace(/\.pdf$/i, "");
        const outDir = opts.saveToFolder
          ? await api.ensureAvailableDir(joinPath(dir, pdfPngDirName(stem)))
          : dir;
        for (let n = start; n <= end; n++) {
          if (useJobs.getState().isLocalCancelled(jobId)) {
            task.destroy();
            useJobs.getState().finishLocal(jobId, false, { cancelled: true });
            return;
          }
          useJobs.getState().updateLocal(jobId, {
            currentPath: `${name} 第 ${n - start + 1}/${end - start + 1} 页`,
          });
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: opts.dpi / 72 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          await page.render({ canvas, viewport }).promise;
          const dataUrl = canvas.toDataURL("image/png");
          await api.writePngFile(
            joinPath(outDir, pdfPngFileName(stem, n, total)),
            dataUrl.slice(dataUrl.indexOf(",") + 1),
          );
          canvas.width = 0;
          canvas.height = 0;
        }
        task.destroy();
      } catch (err) {
        const msg = String(err);
        failed.push({
          path: e.path,
          message:
            err instanceof Error && err.name === "PasswordException"
              ? t("需要密码或密码错误（PDF 已加密）")
              : msg,
        });
      }
      done += 1;
      useJobs.getState().updateLocal(jobId, { doneFiles: done });
    }
    if (failed.length) {
      useJobs.getState().finishLocal(jobId, false, { failed });
    } else {
      useJobs.getState().finishLocal(jobId, true, { note: `${done} 个文件` });
    }
  } catch (err) {
    useJobs
      .getState()
      .finishLocal(jobId, false, { failed: [{ path: "", message: String(err) }] });
  }
}

/** Office/WPS COM 转 PDF（旁写 <stem>.pdf），逐文件进度 */
export async function officeToPdf(entries: FileEntry[], dir: string): Promise<void> {
  const ok = await confirmDialog({
    title: "转为 PDF",
    message: `把选中的 ${entries.length} 个文档转为 PDF（旁写到当前目录）？需要已安装 Microsoft Office 或 WPS，转换由其完成。`,
    okText: "转换",
  });
  if (!ok) return;
  try {
    const { jobId } = await api.officeToPdf(entries.map((e) => e.path));
    useJobs.getState().register(jobId, "officetopdf", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("转换失败：{e}", { e: String(e) }), "error");
  }
}

/** OOXML 隐私属性清理（作者/公司等），旁写 "<名称>_清洁.<ext>" */
export async function cleanOfficeMeta(entries: FileEntry[], dir: string): Promise<void> {
  try {
    const { jobId } = await api.cleanOfficeMeta(entries.map((e) => e.path));
    useJobs.getState().register(jobId, "cleanmeta", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("清理失败：{e}", { e: String(e) }), "error");
  }
}

/** Office 文档导出文本 TXT（旁写 <stem>.txt） */
export async function exportOfficeText(entries: FileEntry[], dir: string): Promise<void> {
  try {
    const { jobId } = await api.officeToText(entries.map((e) => e.path));
    useJobs.getState().register(jobId, "officetotext", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("导出失败：{e}", { e: String(e) }), "error");
  }
}

/** 文本/表格编码转换（旁写 <名称><后缀>.<ext>） */
export async function convertEncoding(
  entries: FileEntry[],
  target: "utf8bom" | "utf8" | "gbk",
): Promise<void> {
  try {
    const { jobId } = await api.convertEncoding(entries.map((e) => e.path), target);
    useJobs.getState().register(jobId, "convertenc", null, entries.map((e) => parentPath(e.path) ?? ""));
  } catch (e) {
    useUi.getState().toast(t("转换失败：{e}", { e: String(e) }), "error");
  }
}

/** CSV/TSV 合并（去重复表头，输出 UTF-8 BOM）：filesMerge 对话框定序定名 */
export async function mergeCsvs(entries: FileEntry[], dir: string): Promise<void> {
  const res = await useUi.getState().openDialog<{ paths: string[]; name: string } | null>({
    type: "filesMerge",
    flavor: "csv",
    entries,
  });
  if (!res) return;
  try {
    const { jobId } = await api.mergeCsv(res.paths, joinPath(dir, res.name));
    useJobs.getState().register(jobId, "mergecsv", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("合并失败：{e}", { e: String(e) }), "error");
  }
}

/** 文本合并（全文拼接，空行分隔）：filesMerge 对话框定序定名 */
export async function mergeTexts(entries: FileEntry[], dir: string): Promise<void> {
  const res = await useUi.getState().openDialog<{ paths: string[]; name: string } | null>({
    type: "filesMerge",
    flavor: "text",
    entries,
  });
  if (!res) return;
  try {
    const { jobId } = await api.mergeTexts(res.paths, joinPath(dir, res.name));
    useJobs.getState().register(jobId, "mergetexts", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("合并失败：{e}", { e: String(e) }), "error");
  }
}

/** 批量新建文件夹（右键"批量新建文件夹"）：对话框预演（lib/folderBatch 纯函数）
 *  → api.createDirs；Rust 端与磁盘重名自动 "(2)"，名单内重名/非法名逐条报错 */
export async function createFolders(
  dir: string,
  existing: string[],
  onDone: () => void,
): Promise<void> {
  const names = await useUi.getState().openDialog<string[] | null>({
    type: "newFolders",
    dir,
    existing,
  });
  if (!names?.length) return;
  try {
    const r = await api.createDirs(dir, names);
    onDone();
    if (r.failed.length) {
      const f = r.failed[0];
      useUi
        .getState()
        .toast(
          `${r.failed.length} 个名称未能创建：${f.name}（${f.message}）`,
          "error",
        );
    } else {
      useUi.getState().toast(t("已创建 {n} 个文件夹", { n: r.created.length }));
    }
  } catch (e) {
    useUi.getState().toast(t("创建失败：{e}", { e: String(e) }), "error");
  }
}

/** Excel 合并（清单拖动定序，2026-11-03 §4.9；2026-11-12 参数集扩展）：
 *  模式/工作表范围/表名规则/表头去重/来源列 → 任务引擎（mergexlsx） */
export async function mergeXlsx(entries: FileEntry[], dir: string): Promise<void> {
  const plan = await useUi.getState().openDialog<
    {
      paths: string[];
      mode: "sheets" | "rows";
      sheetScope: "visible" | "all";
      nameRule: "smart" | "sheet" | "file";
      headerRows: number;
      dedupHeader: boolean;
      sourceCol: "none" | "file" | "fileSheet";
      name: string;
    } | null
  >({ type: "xlsxMerge", entries });
  if (!plan) return;
  const output = joinPath(dir, plan.name);
  try {
    const { jobId } = await api.mergeXlsx(plan.paths, output, plan.mode, {
      sheetScope: plan.sheetScope,
      nameRule: plan.nameRule,
      headerRows: plan.headerRows,
      dedupHeader: plan.dedupHeader,
      sourceCol: plan.sourceCol,
    });
    useJobs.getState().register(jobId, "mergexlsx", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("合并失败：{e}", { e: String(e) }), "error");
  }
}

/** Excel 拆分（2026-11-12 新功能）：按表/按行数/按列值/均分 N 份，
 *  表清单由对话框异步拉取；输出到 <stem>_拆分 子文件夹或源目录 */
export async function splitXlsx(entries: FileEntry[], dir: string): Promise<void> {
  const plan = await useUi.getState().openDialog<
    {
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
    } | null
  >({ type: "xlsxSplit", entries });
  if (!plan) return;
  try {
    const { jobId } = await api.splitXlsx(plan.paths, plan.mode, {
      sheetName: plan.sheetName,
      rowsPerPart: plan.rowsPerPart,
      colIndex: plan.colIndex,
      parts: plan.parts,
      includeHidden: plan.includeHidden,
      skipEmpty: plan.skipEmpty,
      headerRows: plan.headerRows,
      subFolder: plan.subFolder,
    });
    useJobs.getState().register(jobId, "xlsxsplits", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("拆分失败：{e}", { e: String(e) }), "error");
  }
}

/** 压缩为 zip（文件平铺、文件夹递归含顶层目录）：filesMerge 对话框
 *  （打包清单 + 输出名合法校验 + 预览，2026-11-03 §4.9 对齐） */
export async function zipEntries(entries: FileEntry[], dir: string): Promise<void> {
  const res = await useUi.getState().openDialog<{
    paths: string[];
    name: string;
    format?: "zip" | "7z" | "targz";
    password?: string;
    encryptHeader?: boolean;
  } | null>({
    type: "filesMerge",
    flavor: "zip",
    entries,
  });
  if (!res) return;
  try {
    const { jobId } = await api.zipFiles(
      res.paths,
      joinPath(dir, res.name),
      res.format ?? "zip",
      res.password,
      res.encryptHeader,
    );
    useJobs.getState().register(jobId, "zip", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("压缩失败：{e}", { e: String(e) }), "error");
  }
}

/** 解压到压缩包所在目录（右键「解压到此处」/预览面板「解压到此处」） */
export async function extractArchives(sources: string[], password?: string): Promise<void> {
  const destDir = sources.length ? parentPath(sources[0]) : "";
  if (!destDir) return;
  await extractArchivesTo(sources, destDir, password);
}

/** 解压到指定目录（右键「解压到…」/预览面板「解压到…」）：多文件包解到
 *  `<dest>/<包名>/` 子文件夹，gz/xz/bz2 单文件流旁写内层名，走任务引擎。
 *  加密包解压失败（reason=password）时弹密码框带密码重试一次（重试仍失败
 *  不再循环） */
export async function extractArchivesTo(
  sources: string[],
  destDir: string,
  password?: string,
): Promise<void> {
  if (!sources.length || !destDir) return;
  try {
    const { jobId } = await api.extractArchives(sources, destDir, password);
    const sourceParents = sources
      .map((s) => parentPath(s))
      .filter((p): p is string => !!p);
    useJobs.getState().register(jobId, "extract", destDir, sourceParents, (d) => {
      const needPw = d.failed?.some((f) => f.reason === "password");
      if (needPw && !password) {
        void promptExtractPassword(sources, destDir);
      }
    });
  } catch (e) {
    useUi.getState().toast(t("解压失败：{e}", { e: String(e) }), "error");
  }
}

/** 「解压到…」目标目录选择：记忆上次目标（settings.extractDestDir），
 *  原生目录对话框默认落上次位置 */
export async function pickExtractDestDir(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const remembered = useSettings.getState().extractDestDir ?? undefined;
  const sel = await open({
    title: "解压到…",
    multiple: false,
    directory: true,
    defaultPath: remembered,
  });
  if (typeof sel !== "string" || !sel) return null;
  if (sel !== remembered) {
    useSettings.getState().update({ extractDestDir: sel });
  }
  return sel;
}

/** 解压密码输入（np-input 掩码框）：确认后带密码重跑同一批解压（同目标） */
async function promptExtractPassword(sources: string[], destDir: string): Promise<void> {
  const pwd = await useUi.getState().openDialog<string | null>({
    type: "input",
    title: t("压缩包已加密"),
    label: t("输入解压密码后重试（密码错误将再次提示）"),
    okText: t("解压"),
    mask: true,
  });
  if (!pwd) return;
  await extractArchivesTo(sources, destDir, pwd);
}

/** 归类分组键：扩展名（无扩展名归"其他"）或修改年月（yyyy-MM） */
function organizeKey(e: FileEntry, mode: "ext" | "month"): string {
  if (mode === "month") {
    const d = new Date(e.mtimeMs);
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    return `${d.getFullYear()}-${m}`;
  }
  const i = e.name.lastIndexOf(".");
  return i > 0 ? e.name.slice(i + 1).toLowerCase() : t("其他");
}

/** 按规则归类：选中文件分组建子文件夹并移入（移动走既有冲突流程与撤销栈） */
export async function organizeEntries(entries: FileEntry[], dir: string, mode: "ext" | "month"): Promise<void> {
  const files = entries.filter((e) => !e.isDir);
  if (!files.length) return;
  const groups = new Map<string, FileEntry[]>();
  for (const e of files) {
    const k = organizeKey(e, mode);
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  }
  const label = mode === "ext" ? t("扩展名") : t("年月");
  if (groups.size === 1 && files.length === entries.length) {
    useUi.getState().toast(t("按{label}归类：全部对象已在同一组，无需移动", { label: t(label) }));
    return;
  }
  for (const [key, group] of groups) {
    try {
      // 已存在的分组目录直接复用（create_dir 撞同名时忽略）
      await api.createDir(dir, key).catch(() => undefined);
      await transfer(group.map((e) => e.path), joinPath(dir, key), "move");
    } catch (e) {
      useUi
        .getState()
        .toast(t("归组“{key}”失败：{e}", { key, e: String(e) }), "error");
    }
  }
}

/** 执行导出文件清单（2026-11-10 参数面板定案）：免保存框直写当前文件夹，
 *  文件名/穿透/内容筛选/格式由面板给定，重名 "(2)" 递增；toast 回执实际落点 */
export async function runExportListing(
  entries: FileEntry[],
  dir: string,
  opts: ExportListingOptions,
): Promise<void> {
  try {
    const r = await api.exportListing(
      entries.map((e) => e.path),
      dir,
      opts.fileName,
      opts.fmt,
      opts.content,
      opts.recursive,
    );
    const name = fileNameOf(r.path);
    useUi.getState().toast(t("清单已导出：{name}（{n} 项）", { name, n: r.count }));
  } catch (e) {
    useUi.getState().toast(t("导出失败：{e}", { e: String(e) }), "error");
  }
}

/** 行尾转换（字节级重写不改编码，旁写 *_crlf/_lf.ext；入任务引擎） */
export async function convertEol(entries: FileEntry[], to: "crlf" | "lf"): Promise<void> {
  try {
    const { jobId } = await api.convertEol(entries.map((e) => e.path), to);
    useJobs.getState().register(
      jobId,
      "converteol",
      null,
      entries.map((e) => parentPath(e.path) ?? ""),
    );
  } catch (e) {
    useUi.getState().toast(t("行尾转换失败：{e}", { e: String(e) }), "error");
  }
}

/** 同目录旁建 NTFS 链接（硬链接/符号链接逐项执行，失败逐条提示不中断） */
export async function createLinks(
  entries: FileEntry[],
  hard: boolean,
  onDone: () => void,
): Promise<void> {
  let ok = 0;
  const dirs = new Set<string>();
  for (const e of entries) {
    try {
      await api.createLink(e.path, hard ? "hard" : "symlink");
      ok += 1;
      const par = parentPath(e.path);
      if (par) dirs.add(par);
    } catch (err) {
      useUi
        .getState()
        .toast(
          t("创建链接“{name}”失败：{e}", { name: e.name, e: String(err) }),
          "error",
        );
    }
  }
  if (ok) {
    useUi.getState().toast(t("已创建 {n} 个链接", { n: ok }));
    onDone();
  }
}

/** 合并分割部件（.crc 清单自动验签；入任务引擎） */
export async function combineParts(paths: string[]): Promise<void> {
  try {
    const { jobId } = await api.combineParts(paths);
    const dirs = new Set<string>();
    for (const p of paths) {
      const par = parentPath(p);
      if (par) dirs.add(par);
    }
    useJobs.getState().register(jobId, "combine", null, [...dirs]);
  } catch (e) {
    useUi.getState().toast(t("合并失败：{e}", { e: String(e) }), "error");
  }
}

/** 批量重命名执行（2026-11-09 批量化）：一次 rename_items IPC 顺序执行整批
 *  （替代逐条 rename_item 串行往返），失败项聚合回执；撤销记录 = 整批成功项
 *  合并为一个条目（一次 Ctrl+Z 全撤，编辑器惯例） */
export async function applyRenames(
  items: { path: string; newName: string }[],
  onDone: () => void,
): Promise<void> {
  let results: RenameOutcome[];
  try {
    results = await api.renameItems(items);
  } catch (e) {
    useUi.getState().toast(t("批量重命名失败：{e}", { e: String(e) }), "error");
    return;
  }
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (ok.length) {
    // 撤销记录：from 源原路径、to 实际落点（Rust 回执直供，含大小写折叠语义）
    useUndo.getState().push({
      kind: "rename",
      ops: ok.map((r) => ({ from: r.from, to: r.to })),
    });
    useUi.getState().toast(
      failed.length
        ? `已重命名 ${ok.length} 项 · ${failed.length} 项失败：${failed[0].name} ${failed[0].message}`
        : `已重命名 ${ok.length} 项`,
      failed.length ? "error" : "info",
    );
    // 同目录他窗格零防抖同步（批量重命名可在跨目录清单上执行，逐父目录去重）
    const dirs = [
      ...new Set(items.map((it) => parentPath(it.path)).filter((d): d is string => !!d)),
    ];
    if (dirs.length) usePanes.getState().bumpAffected(dirs);
    onDone();
  } else if (failed.length) {
    useUi.getState().toast(
      `重命名失败：${failed[0].name} ${failed[0].message}`,
      "error",
    );
  }
}

// ────────────────────────── 图片处理（2026-10-15） ──────────────────────────
// 五件套（压缩/水印/格式转换/尺寸调整/宫格拼图）：对话框（§4.9 三段式，2026-11-03
// 清单化——处理顺序随清单拖动）在 ImgDialogs.tsx，这里只做「开对话框 → api 入
// 任务引擎 → 登记」。全部旁写不覆盖原文件。

/** 图片压缩（Auto/JPEG/PNG8/无损优化） */
export async function imgCompress(entries: FileEntry[], dir: string): Promise<void> {
  const spec = await useUi.getState().openDialog<{
    paths: string[];
    target: 0 | 1 | 2 | 3;
    quality: number;
  } | null>({ type: "imgCompress", entries });
  if (!spec) return;
  try {
    const { jobId } = await api.imgCompress(spec.paths, spec.target, spec.quality);
    useJobs.getState().register(jobId, "imgcompress", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("压缩失败：{e}", { e: String(e) }), "error");
  }
}

/** 图片水印（文字/贴图 × 平铺/角标） */
export async function imgWatermark(entries: FileEntry[], dir: string): Promise<void> {
  const spec = await useUi.getState().openDialog<{
    paths: string[];
    imagePath: string;
    text: string;
    tile: boolean;
    opacity: number;
    scaleDiv: number;
    color: string;
    pos: string;
  } | null>({ type: "imgWatermark", entries });
  if (!spec) return;
  const { paths, ...opts } = spec;
  try {
    const { jobId } = await api.imgWatermark(paths, opts);
    useJobs.getState().register(jobId, "imgwatermark", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("加水印失败：{e}", { e: String(e) }), "error");
  }
}

/** 图片格式转换（PNG/JPEG/BMP/TIFF/ICO/WebP） */
export async function imgConvert(entries: FileEntry[], dir: string): Promise<void> {
  const spec = await useUi.getState().openDialog<{
    paths: string[];
    target: 0 | 1 | 2 | 3 | 4 | 5;
    quality: number;
    bakeExif: boolean;
  } | null>({ type: "imgConvert", entries });
  if (!spec) return;
  try {
    const { jobId } = await api.imgConvert(
      spec.paths,
      spec.target,
      spec.quality,
      spec.bakeExif,
    );
    useJobs.getState().register(jobId, "imgconvert", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("转换失败：{e}", { e: String(e) }), "error");
  }
}

/** 图片尺寸调整（百分比/指定宽/指定高） */
export async function imgResize(entries: FileEntry[], dir: string): Promise<void> {
  const spec = await useUi.getState().openDialog<{
    paths: string[];
    mode: 0 | 1 | 2;
    value: number;
    lanczos: boolean;
    onlyDown: boolean;
  } | null>({ type: "imgResize", entries });
  if (!spec) return;
  try {
    const { jobId } = await api.imgResize(
      spec.paths,
      spec.mode,
      spec.value,
      spec.lanczos,
      spec.onlyDown,
    );
    useJobs.getState().register(jobId, "imgresize", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("缩放失败：{e}", { e: String(e) }), "error");
  }
}

/** 宫格拼图：多图 → 单张网格画布（输出到首图所在目录） */
export async function imgMontage(entries: FileEntry[], dir: string): Promise<void> {
  const spec = await useUi.getState().openDialog<{
    paths: string[];
    cols: number;
    cell: number;
    gap: number;
    cover: boolean;
    bg: 0 | 1 | 2;
    png: boolean;
  } | null>({ type: "imgMontage", entries });
  if (!spec) return;
  const { paths, ...opts } = spec;
  const output = joinPath(dir, montageOutputName(new Date()));
  try {
    const { jobId } = await api.imgMontage(paths, { ...opts, output });
    useJobs.getState().register(jobId, "imgmontage", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(t("拼图失败：{e}", { e: String(e) }), "error");
  }
}
