// 全局热键录制纯函数（截图热键自定义，2026-10-30）：KeyboardEvent →
// tauri-plugin-global-shortcut 可解析的热键串（"Ctrl+Alt+A"）。
// 键名与修饰键序按 global-hotkey 0.8 parse 口径收窄到稳定子集：
// 字母 A-Z / 数字 0-9 / F1-F12（crate 只映射到 F12）/ 方向键（Up|Down|Left|
// Right）/ Space / Enter / Tab / 常用标点（, . / ; ' - = [ ] \ `）；
// 修饰键只认 Ctrl / Alt / Shift（Win 键被系统保留不收），且必须出现在主键
// 之前。裸字母数字会吞掉全局输入，一律拒绝；单独 F1-F12 允许。

/** 录制判定结果：ok = 得到完整组合；pending = 修饰键未齐/按下纯修饰键，
 *  继续等待；invalid = 组合不成立（原因供提示） */
export type HotkeyCapture =
  | { state: "ok"; combo: string }
  | { state: "pending" }
  | { state: "invalid"; reason: string };

/** 事件形状（供组件传 KeyboardEvent、单测传字面量） */
export interface HotkeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 纯修饰键按下（含 Dead 组合键中间态）：组合未完成 */
const PENDING_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "Dead"]);

/** 非字面量主键的显示名 = 解析名（crate 两侧都认，大小写不敏感） */
const KEY_ALIAS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
  Enter: "Enter",
  Tab: "Tab",
};

/** KeyboardEvent → 热键串判定（组合规则见文件头） */
export function captureHotkey(e: HotkeyEventLike): HotkeyCapture {
  if (PENDING_KEYS.has(e.key)) return { state: "pending" };
  let main: string | null = null;
  if (/^[a-z]$/i.test(e.key)) main = e.key.toUpperCase();
  else if (/^[0-9]$/.test(e.key)) main = e.key;
  else if (/^F([1-9]|1[0-2])$/.test(e.key)) main = e.key;
  else if (KEY_ALIAS[e.key]) main = KEY_ALIAS[e.key];
  else if (",./;'-=[]\\`".includes(e.key) && e.key.length === 1) main = e.key;
  if (!main) return { state: "invalid", reason: `不支持的按键「${e.key}」` };
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // 裸主键（非 F1-F12）会吞全局输入：字母/数字/标点必须带修饰键
  if (!mods.length && !/^F\d{1,2}$/.test(main)) {
    return { state: "invalid", reason: "需包含 Ctrl / Alt / Shift 修饰键（或单独使用 F1-F12）" };
  }
  return { state: "ok", combo: [...mods, main].join("+") };
}
