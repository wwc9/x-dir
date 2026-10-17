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
