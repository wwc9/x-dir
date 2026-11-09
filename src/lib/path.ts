// TS 侧路径工具（与 Rust fs/path.rs 行为一致，仅供 UI 层使用）

export function fileNameOf(path: string): string {
  return path.replace(/\\+$/, "").split("\\").pop() || path;
}

/// 父目录；盘符根（C:\）返回 null
export function parentPath(path: string): string | null {
  const trimmed = path.replace(/\\+$/, "");
  const idx = trimmed.lastIndexOf("\\");
  if (idx <= 0) return null;
  if (idx <= 2) return `${trimmed.slice(0, 2)}\\`;
  return trimmed.slice(0, idx);
}

export function isValidName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  const stem = name.split(".")[0];
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  return !reserved.test(stem);
}

/// 路径所在盘根（"E:\a\b" → "E:\"）；无法识别返回 null
export function driveRootOf(path: string): string | null {
  const m = /^([A-Za-z]):/.exec(path);
  return m ? `${m[1].toUpperCase()}:\\` : null;
}

/// 目录 + 名称拼路径（兼容盘符根 "C:\" 结尾的目录）
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("\\") ? `${dir}${name}` : `${dir}\\${name}`;
}

/** 路径列表同集合判定（剪贴板粘贴校验，2026-11-06）：系统 CF_HDROP 与应用内
 *  缓存比对——大小写不敏感（Windows 文件系统）、去尾反斜杠、顺序无关
 *  （Explorer 重排 HDROP 顺序是合法行为），集合相等才算同一内容 */
export function samePathList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, "");
  const sa = new Set(a.map(norm));
  return b.every((p) => sa.has(norm(p)));
}

/** 压缩包智能默认名干（不含扩展名，2026-11-08）：单对象 = 对象名（文件去
 *  扩展名、文件夹用全名），多对象 = 所在目录名；目录名不可用作文件名
 *  （盘根 "D:" / 非法字符）时回退「归档」。输入 items 取自压缩清单的路径
 *  + 对应 isDir 标记，dirName = 所在目录的目录名（无法解析传 null） */
export function smartArchiveStem(
  items: { name: string; isDir: boolean }[],
  dirName: string | null,
): string {
  if (items.length === 1) {
    const { name, isDir } = items[0];
    if (isDir) return name;
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
  }
  if (dirName && !dirName.includes(":") && isValidName(dirName)) return dirName;
  return "归档";
}
