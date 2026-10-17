// 批量新建文件夹（右键「批量新建文件夹」，2026-10-17）纯函数：两种输入模式
// 的名单解析与预演命名。预演命名与 Rust 端 create_dirs + jobs::pick::available_name
// 同语义（与磁盘/名单内重名 → "name (2)" 递增，文件夹同样按扩展名拆分处理）。
// 执行编排（对话框 → api.createDirs）在 lib/operations.ts。

import { isValidName } from "./path";

/** 单次创建上限（与 Rust create_dirs 上限一致） */
export const FOLDER_BATCH_CAP = 500;

export interface FolderPlanItem {
  /** 请求名（trim 后） */
  req: string;
  /** 预演后的最终名；error 非空时为 null */
  name: string | null;
  /** 非法名 / 名单内重名原因；null = 可建 */
  error: string | null;
}

/** 多行名单 → 请求名序列：逐行 trim、去空行；合法性交给 planFolders 统一判定 */
export function parseNameLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Windows 名称比较口径（大小写不敏感，与 fs/path.rs norm_key 同语义） */
function normKey(name: string): string {
  return name.trimEnd().toLowerCase();
}

/** "stem.ext" → ["stem", "ext"]（与 fs/path.rs split_ext 同语义：首点在首位或
 *  末位不算扩展名） */
function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i > 0 && i + 1 < name.length) return [name.slice(0, i), name.slice(i + 1)];
  return [name, ""];
}

/** 与已有集合冲突时的邻近名："name" → "name (2)" → …（与 jobs::pick 同款） */
function sidestep(name: string, used: Set<string>): string {
  if (!used.has(normKey(name))) return name;
  const [stem, ext] = splitExt(name);
  for (let n = 2; n < 10_000; n++) {
    const cand = ext ? `${stem} (${n}).${ext}` : `${stem} (${n})`;
    if (!used.has(normKey(cand))) return cand;
  }
  return `${stem} (副本)${ext ? `.${ext}` : ""}`;
}

/** 序号模板展开：{} 占位替换为起止序号（按止号位数补零）。
 *  模板不含 {} 时退化为单项（planFolders 会照常走判定） */
export function expandPattern(
  pattern: string,
  start: number,
  end: number,
): string[] {
  const pad = String(Math.max(end, 0)).length;
  const out: string[] = [];
  if (!pattern.includes("{}")) return pattern.trim() ? [pattern.trim()] : [];
  for (let i = start; i <= end && out.length < FOLDER_BATCH_CAP; i++) {
    out.push(pattern.replace("{}", String(i).padStart(pad, "0")));
  }
  return out;
}

/** 预演命名：非法名 / 名单内重名标 error；与磁盘已有项重名按 "(2)" 递增，
 *  预演名即 Rust 端实际落盘名（竞态由服务端 available_name 兜底） */
export function planFolders(
  mode: "lines" | "pattern",
  text: string,
  pattern: string,
  start: number,
  end: number,
  existing: string[],
): FolderPlanItem[] {
  const reqs =
    mode === "lines" ? parseNameLines(text) : expandPattern(pattern, start, end);
  const used = new Set(existing.map(normKey));
  const seen = new Set<string>();
  return reqs.slice(0, FOLDER_BATCH_CAP).map((raw) => {
    const req = raw.trim();
    if (!isValidName(req)) {
      return { req, name: null, error: "名称含非法字符或为 Windows 保留名" };
    }
    if (seen.has(normKey(req))) {
      return { req, name: null, error: "名单内重名" };
    }
    seen.add(normKey(req));
    const name = sidestep(req, used);
    used.add(normKey(name));
    return { req, name, error: null };
  });
}
