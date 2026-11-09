// 对话框参数记忆（2026-11-09 P2）：对话框确认时把参数子集写入
// settings.dialogPrefs[<对话框名>]，下次打开与内置默认浅合并作为初始值。
// 只收 primitive 值（string/number/boolean）；路径与密码类字段由调用方剔除、
// 永不入存。落 settings.json 走 §8 配置集中化（随导出/导入整体迁移）。
import { useSettings } from "../stores/settings";

export type DialogPrefs = Record<string, Record<string, unknown>>;

/** 脏档清洗：仅收两层且值为 string/number/boolean 的对象表 */
export function sanitizeDialogPrefs(v: unknown): DialogPrefs {
  const out: DialogPrefs = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [key, rec] of Object.entries(v as Record<string, unknown>)) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec as Record<string, unknown>)) {
      const ty = typeof val;
      if (ty === "string" || ty === "number" || ty === "boolean") clean[k] = val;
    }
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}

/** 内置默认 × 上次确认参数浅合并：磁盘缺字段回落默认，类型不符的键忽略
 *  （防旧档脏值破坏对话框初始态） */
export function mergeDialogPrefs<T extends object>(fallback: T, saved: unknown): T {
  const out: T = { ...fallback };
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return out;
  const rec = saved as Record<string, unknown>;
  for (const [k, fb] of Object.entries(fallback)) {
    const v = rec[k];
    if (v !== undefined && v !== null && typeof v === typeof fb) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** 读：某对话框的初始参数（settings 未加载完成时 = 纯内置默认） */
export function loadDialogPrefs<T extends object>(key: string, fallback: T): T {
  return mergeDialogPrefs(fallback, useSettings.getState().dialogPrefs?.[key]);
}

/** 写：对话框确认时记下本次参数子集（经 settings.update 800ms 防抖落盘） */
export function saveDialogPrefs(key: string, prefs: Record<string, unknown>): void {
  const s = useSettings.getState();
  s.update({ dialogPrefs: { ...s.dialogPrefs, [key]: prefs } });
}
