// 强调色预设（2026-11-25 用户需求「强调色自定义」）：浅/深两套取值成对——
// applier 只内联写 --np-accent-user / --np-accent-user-dark 两个用户变量，
// index.css 浅色块消费 -user、深色块消费 -user-dark（单变量不串主题）；
// --np-sel / --np-glass-hover 已改为 var(--np-accent) 的 color-mix 派生，
// 换强调色全链（143 处直用 + 33 处 color-mix）自动联动。
export interface AccentPreset {
  id: string;
  label: string;
  /** 浅色主题取值（--np-accent-user） */
  light: string;
  /** 深色主题取值（--np-accent-user-dark，偏亮保证深底对比与 fg #101010 可读） */
  dark: string;
}

export const DEFAULT_ACCENT_ID = "default";

/** default 的取值 = index.css 回退链字面量（vitest 锁定防漂移） */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "default", label: "默认蓝", light: "#3574f0", dark: "#5c9dff" },
  { id: "teal", label: "青碧", light: "#0e9c9c", dark: "#58c2c2" },
  { id: "green", label: "苔绿", light: "#2f9d55", dark: "#6fc788" },
  { id: "purple", label: "黛紫", light: "#7c5ce6", dark: "#a78dfa" },
  { id: "rose", label: "玫红", light: "#d35271", dark: "#ec8aa0" },
  { id: "orange", label: "琥珀", light: "#d97a22", dark: "#eda75e" },
  { id: "slate", label: "石墨", light: "#5c6779", dark: "#94a0b3" },
];

export function resolveAccent(id: string): AccentPreset {
  return ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0];
}
