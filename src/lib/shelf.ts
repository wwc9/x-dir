// 暂存区（侧边栏下半）纯函数：路径去重 + 容量上限 + 展示类型推断。
// 状态本体在 settings.staging（跨会话保留），本模块不持有状态。

/** 暂存区容量上限：防病态拖入拖垮 settings.json 与渲染 */
export const SHELF_MAX = 200;

export interface ShelfAddResult {
  /** 去重 + 截断后的完整列表（直接回写 settings.staging） */
  items: string[];
  /** 本次实际新增条数 */
  added: number;
  /** 因重复或超限被忽略的条数 */
  skipped: number;
}

/** 追加暂存：按 Windows 路径语义大小写不敏感去重；超出上限的新路径整条忽略
 *  （保留先入的，语义可预期——"暂存区满了"比"悄悄挤掉旧项"不易丢文件） */
export function shelfAdd(
  current: string[],
  paths: string[],
  max: number = SHELF_MAX,
): ShelfAddResult {
  const key = (p: string) => p.toLowerCase();
  const seen = new Set(current.map(key));
  const items = [...current];
  let added = 0;
  let skipped = 0;
  for (const p of paths) {
    if (!p || seen.has(key(p))) {
      skipped++;
      continue;
    }
    if (items.length >= max) {
      skipped++;
      continue;
    }
    seen.add(key(p));
    items.push(p);
    added++;
  }
  return { items, added, skipped };
}

/** 移除单条（大小写不敏感匹配；未命中原样返回） */
export function shelfRemove(current: string[], path: string): string[] {
  const k = path.toLowerCase();
  return current.filter((x) => x.toLowerCase() !== k);
}

/** 暂存行展示类型推断：拖放载荷只带路径，无 isDir——按"无扩展名（含无点
 *  dotfile 除外）≈ 文件夹"启发；仅影响图标，不影响拖出/移除行为 */
export function shelfEntryIsDir(path: string): boolean {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return !name.includes(".");
}
