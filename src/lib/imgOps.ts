// 图片处理（右键「图片处理」组，2026-10-15）纯函数：可解码扩展名、拼图输出名、
// 选项默认值。执行编排（对话框 → api → 任务登记）在 operations.ts，处理在 Rust
// src/img/mod.rs（旁写不覆盖，EXIF 方向先烘焙）。

/** 可解码图片扩展名（gif 仅解码首帧；与 Rust img_cmds::is_img 同口径） */
export const IMG_EXTS = "jpg,jpeg,png,bmp,tif,tiff,webp,ico,gif";

/** 宫格拼图输入下限/上限（2×2 起步，至 6×6） */
export const MONTAGE_MIN = 4;
export const MONTAGE_MAX = 36;

/** 拼图输出文件名：拼图_<yyyymmdd>_<hhmmss>.png（重名由 Rust 端 available_name 递增） */
export function montageOutputName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `拼图_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
}

/** 拼图画布尺寸预告（与 Rust montage_layout 同式，供对话框文案显示行列） */
export function montageGrid(count: number, cols: number): { rows: number; cols: number } {
  const rows = Math.ceil(count / cols);
  return { rows, cols };
}
