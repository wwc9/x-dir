// 水印位置九宫格（3×3 选点；2026-11-09 自 ToolsDialogs 抽出共享——PDF 加水印
// 与图片加水印两对话框同款位置控件，P2 统一参数口径）。选中态 = accent 实底
// 白点（index.css .np-wm-*）；disabled = 整组降灰（如平铺布局下位置不适用）。
export const WM_POS_CELLS: { value: string; tip: string }[] = [
  { value: "left-top", tip: "左上" },
  { value: "mid-top", tip: "中上" },
  { value: "right-top", tip: "右上" },
  { value: "left-mid", tip: "左中" },
  { value: "center", tip: "正中" },
  { value: "right-mid", tip: "右中" },
  { value: "left-bottom", tip: "左下" },
  { value: "mid-bottom", tip: "中下" },
  { value: "right-bottom", tip: "右下" },
];

export function PosGrid({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 整组禁用（关联参数不适用时降灰，同 Seg disabled 口径） */
  disabled?: boolean;
}) {
  return (
    <div className="np-wm-grid">
      {WM_POS_CELLS.map((c) => (
        <button
          key={c.value}
          className={"np-wm-cell" + (value === c.value ? " on" : "")}
          data-tip={c.tip}
          disabled={disabled}
          onClick={() => onChange(c.value)}
        />
      ))}
    </div>
  );
}
