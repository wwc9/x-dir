export function formatSize(
  entry: { isDir: boolean; size: number },
  folderSizePlaceholder = true,
): string {
  // 文件夹不计算体积：占位符「—」（settings.folderSizePlaceholder，默认开），
  // 关闭后留空（2026-11-17 用户定案）
  if (entry.isDir) return folderSizePlaceholder ? "—" : "";
  return formatBytes(entry.size);
}

/** 裸字节数 → 人类可读（目录体积求和等无 FileEntry 的场景） */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (u < units.length - 1) {
    // 升单位以「显示值」为准：一位小数四舍五入满 1024 即进位
    //（1048575 B 显示 1024.0 KB 是边界瑕疵，应为 1.0 MB）
    if (Number(u === 0 ? String(v) : v.toFixed(1)) < 1024) break;
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

export function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 耗时展示：<1s 显示毫秒，否则一位小数秒 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
