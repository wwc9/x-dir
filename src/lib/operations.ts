// 文件操作编排：冲突预检 → 对话框 → 入队（§6.7 冲突流程）
// V2：nativeFileOps 开启时走 IFileOperation，冲突由系统对话框处理，
// 此处跳过预检对话框（policy 传 rename 仅作原生失败回退时的兜底语义）。

import { api, type Policy } from "./ipc";
import { fileNameOf, isValidName, joinPath, parentPath } from "./path";
import { formatTime } from "./format";
import { montageOutputName } from "./imgOps";
import { useJobs } from "../stores/jobs";
import { useSettings } from "../stores/settings";
import { confirmDialog, useUi } from "../stores/ui";
import { useUndo } from "./undo";
import type { FileEntry } from "./ipc";

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
    // 移动可逆（移回原父目录）；复制是派生副本，不入撤销栈
    const onDone =
      mode === "move"
        ? ({ ok, cancelled }: { ok: boolean; cancelled: boolean }) => {
            if (ok && !cancelled) useUndo.getState().push({ kind: "move", sources, destDir });
          }
        : undefined;
    useJobs.getState().register(jobId, mode, destDir, sourceParents, onDone);
  } catch (e) {
    useUi.getState().toast(`操作失败：${String(e)}`, "error");
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
            title: "永久删除确认",
            message: `确定永久删除选中的 ${paths.length} 项吗？此操作不可恢复！`,
            kind: "danger",
            okText: "永久删除",
          }
        : {
            title: "删除确认",
            message: `确定把选中的 ${paths.length} 项移入回收站吗？`,
            kind: "warn",
            okText: "移入回收站",
            rememberLabel: "以后不再确认，直接移入回收站（可在设置 → 文件操作中恢复）",
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
    useUi.getState().toast(`删除失败：${String(e)}`, "error");
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
    title: spec?.title ?? (kind === "dir" ? "新建文件夹" : "新建文本文件"),
    initial: spec?.initial ?? (kind === "dir" ? "新建文件夹" : "新建文本文件.txt"),
    okText: "创建",
    validate: (v) => (isValidName(v) ? null : "名称含非法字符或为 Windows 保留名"),
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
    useUi.getState().toast(`创建失败：${String(e)}`, "error");
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
  if (variant === "files" && res.paths.length < 2 && !res.autoBlank) {
    useUi.getState().toast("至少选择 2 个文件，或启用空白页凑偶数", "error");
    return;
  }
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
    useUi.getState().toast(`合并失败：${String(e)}`, "error");
  }
}

/** 单个 PDF 拆分为单页文件，输出到 "<名称>_分页" 子文件夹 */
export async function splitPdf(entry: FileEntry, dir: string): Promise<void> {
  try {
    const count = await api.pdfPageCount(entry.path);
    const stem = fileNameOf(entry.path).replace(/\.pdf$/i, "");
    const outName = `${stem}_分页`;
    const ok = await confirmDialog({
      title: "PDF 拆分",
      message: `《${fileNameOf(entry.path)}》共 ${count} 页，将拆为 ${count} 个单页 PDF，存入"${outName}"文件夹。继续？`,
      okText: "拆分",
    });
    if (!ok) return;
    const { jobId } = await api.pdfSplit(entry.path, joinPath(dir, outName));
    useJobs.getState().register(jobId, "pdfsplit", joinPath(dir, outName), [dir]);
  } catch (e) {
    useUi.getState().toast(`拆分失败：${String(e)}`, "error");
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
    useUi.getState().toast(`加水印失败：${String(e)}`, "error");
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
    useUi.getState().toast(`提取失败：${String(e)}`, "error");
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
    useUi.getState().toast(`删页失败：${String(e)}`, "error");
  }
}

/** PDF 旋转（原地，全部页相对旋转；可反向旋转还原） */
export async function rotatePdf(entry: FileEntry, degrees: number): Promise<void> {
  try {
    const { jobId } = await api.pdfRotate(entry.path, degrees);
    useJobs.getState().register(jobId, "pdfrotate", null, [parentPath(entry.path) ?? ""]);
  } catch (e) {
    useUi.getState().toast(`旋转失败：${String(e)}`, "error");
  }
}

/** PDF 轻压缩（对象去重 + 重压缩），旁写 "<名称>_压缩.pdf" */
export async function compressPdfs(entries: FileEntry[], dir: string): Promise<void> {
  try {
    const { jobId } = await api.pdfCompress(entries.map((e) => e.path));
    useJobs.getState().register(jobId, "pdfcompress", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(`压缩失败：${String(e)}`, "error");
  }
}

/** 图片合并转 PDF（每图一页）：filesMerge 对话框（清单拖动定序 + 输出预览） */
export async function imagesToPdf(entries: FileEntry[], dir: string): Promise<void> {
  const res = await useUi.getState().openDialog<{ paths: string[]; name: string } | null>({
    type: "filesMerge",
    flavor: "images",
    entries,
  });
  if (!res) return;
  const output = joinPath(dir, res.name);
  try {
    const { jobId } = await api.imagesToPdf(res.paths, output);
    useJobs.getState().register(jobId, "imgtopdf", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(`合并失败：${String(e)}`, "error");
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
    useUi.getState().toast(`转换失败：${String(e)}`, "error");
  }
}

/** OOXML 隐私属性清理（作者/公司等），旁写 "<名称>_清洁.<ext>" */
export async function cleanOfficeMeta(entries: FileEntry[], dir: string): Promise<void> {
  try {
    const { jobId } = await api.cleanOfficeMeta(entries.map((e) => e.path));
    useJobs.getState().register(jobId, "cleanmeta", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(`清理失败：${String(e)}`, "error");
  }
}

/** Office 文档导出文本 TXT（旁写 <stem>.txt） */
export async function exportOfficeText(entries: FileEntry[], dir: string): Promise<void> {
  try {
    const { jobId } = await api.officeToText(entries.map((e) => e.path));
    useJobs.getState().register(jobId, "officetotext", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(`导出失败：${String(e)}`, "error");
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
    useUi.getState().toast(`转换失败：${String(e)}`, "error");
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
    useUi.getState().toast(`合并失败：${String(e)}`, "error");
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
    useUi.getState().toast(`合并失败：${String(e)}`, "error");
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
      useUi.getState().toast(`已创建 ${r.created.length} 个文件夹`);
    }
  } catch (e) {
    useUi.getState().toast(`创建失败：${String(e)}`, "error");
  }
}

/** Excel 合并（清单拖动定序，2026-11-03 §4.9）：模式 + 输出名 → 任务引擎（mergexlsx） */
export async function mergeXlsx(entries: FileEntry[], dir: string): Promise<void> {
  const plan = await useUi.getState().openDialog<
    { paths: string[]; mode: "sheets" | "rows"; name: string } | null
  >({ type: "xlsxMerge", entries });
  if (!plan) return;
  const output = joinPath(dir, plan.name);
  try {
    const { jobId } = await api.mergeXlsx(plan.paths, output, plan.mode);
    useJobs.getState().register(jobId, "mergexlsx", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(`合并失败：${String(e)}`, "error");
  }
}

/** 压缩为 zip（文件平铺、文件夹递归含顶层目录）：filesMerge 对话框
 *  （打包清单 + 输出名合法校验 + 预览，2026-11-03 §4.9 对齐） */
export async function zipEntries(entries: FileEntry[], dir: string): Promise<void> {
  const res = await useUi.getState().openDialog<{ paths: string[]; name: string } | null>({
    type: "filesMerge",
    flavor: "zip",
    entries,
  });
  if (!res) return;
  try {
    const { jobId } = await api.zipFiles(res.paths, joinPath(dir, res.name));
    useJobs.getState().register(jobId, "zip", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(`压缩失败：${String(e)}`, "error");
  }
}

/** 解压到此处（zip/7z）：每包解到所在目录下 `<包名>/` 子文件夹，走任务引擎 */
export async function extractArchives(sources: string[]): Promise<void> {
  if (!sources.length) return;
  const destDir = parentPath(sources[0]);
  if (!destDir) return;
  try {
    const { jobId } = await api.extractArchives(sources, destDir);
    const sourceParents = sources
      .map((s) => parentPath(s))
      .filter((p): p is string => !!p);
    useJobs.getState().register(jobId, "extract", destDir, sourceParents);
  } catch (e) {
    useUi.getState().toast(`解压失败：${String(e)}`, "error");
  }
}

/** 归类分组键：扩展名（无扩展名归"其他"）或修改年月（yyyy-MM） */
function organizeKey(e: FileEntry, mode: "ext" | "month"): string {
  if (mode === "month") {
    const d = new Date(e.mtimeMs);
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    return `${d.getFullYear()}-${m}`;
  }
  const i = e.name.lastIndexOf(".");
  return i > 0 ? e.name.slice(i + 1).toLowerCase() : "其他";
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
  const label = mode === "ext" ? "扩展名" : "年月";
  if (groups.size === 1 && files.length === entries.length) {
    useUi.getState().toast(`按${label}归类：全部对象已在同一组，无需移动`);
    return;
  }
  for (const [key, group] of groups) {
    try {
      // 已存在的分组目录直接复用（create_dir 撞同名时忽略）
      await api.createDir(dir, key).catch(() => undefined);
      await transfer(group.map((e) => e.path), joinPath(dir, key), "move");
    } catch (e) {
      useUi.getState().toast(`归组"${key}"失败：${String(e)}`, "error");
    }
  }
}

/** 导出文件清单（名称/类型/大小/修改时间 CSV；原生保存框选择位置） */
export async function exportListing(entries: FileEntry[], dir: string): Promise<void> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const target = await save({
    defaultPath: joinPath(dir, "文件清单.csv"),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!target) return;
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [
    "名称,类型,大小(字节),修改时间",
    ...entries.map((e) =>
      [
        esc(e.name),
        e.isDir ? "文件夹" : esc(e.name.split(".").pop()?.toUpperCase() ?? "文件"),
        e.isDir ? "" : String(e.size),
        formatTime(e.mtimeMs),
      ].join(","),
    ),
  ];
  try {
    await api.saveTextFile(target, rows.join("\r\n"));
    useUi.getState().toast("清单已导出");
  } catch (e) {
    useUi.getState().toast(`导出失败：${String(e)}`, "error");
  }
}

/** 批量重命名执行：逐项 rename（可逆，逐条入撤销栈），完成后刷新 */
export async function applyRenames(
  items: { path: string; newName: string }[],
  onDone: () => void,
): Promise<void> {
  let okCount = 0;
  for (const it of items) {
    try {
      await api.renameItem(it.path, it.newName);
      okCount += 1;
      const parent = parentPath(it.path);
      if (parent) {
        useUndo.getState().push({ kind: "rename", from: it.path, to: joinPath(parent, it.newName) });
      }
    } catch (e) {
      useUi.getState().toast(`重命名"${fileNameOf(it.path)}"失败：${String(e)}`, "error");
    }
  }
  if (okCount) {
    useUi.getState().toast(`已重命名 ${okCount} 项`);
    onDone();
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
    useUi.getState().toast(`压缩失败：${String(e)}`, "error");
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
  } | null>({ type: "imgWatermark", entries });
  if (!spec) return;
  const { paths, ...opts } = spec;
  try {
    const { jobId } = await api.imgWatermark(paths, opts);
    useJobs.getState().register(jobId, "imgwatermark", dir, [dir]);
  } catch (e) {
    useUi.getState().toast(`加水印失败：${String(e)}`, "error");
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
    useUi.getState().toast(`转换失败：${String(e)}`, "error");
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
    useUi.getState().toast(`缩放失败：${String(e)}`, "error");
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
    useUi.getState().toast(`拼图失败：${String(e)}`, "error");
  }
}
