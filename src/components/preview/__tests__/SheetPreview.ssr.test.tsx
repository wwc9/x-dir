// 表格预览行高切换 Seg 宿主回归测试（2026-11-25「单行换行宽松的组件不要挡住
// 表格的内容」）：无槽宿主必须渲染文档流工具行（np-pv-sheet-moderow），禁止
// 右上悬浮药丸（np-pv-sheet-bar）回归；portal 分支（QuickPreview footer 中央
// 槽）依赖真实 DOM 宿主，SSR 无法表达，由 CDP 真实窗口验收覆盖。
// 走 react-dom/server 静态渲染：行高模式此刻已持久化进 settings store
// （useSettings zustand 直读 DEFAULT_SETTINGS.pvSheetRowMode = "wrap"）。
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SheetPreview } from "../SheetPreview";

const SEC = {
  title: "Sheet1",
  text: "名称\t数量\n苹果\t3\n香蕉\t12\n",
  truncated: false,
  merges: [],
};

describe("SheetPreview 行高切换宿主", () => {
  it("无槽宿主渲染文档流工具行，不渲染悬浮条与 portal 段", () => {
    const html = renderToStaticMarkup(<SheetPreview sections={[SEC]} />);
    expect(html).toContain("np-pv-sheet-moderow");
    expect(html).not.toContain("np-pv-sheet-bar");
    expect(html).not.toContain("np-pv-sheet-modeseg");
  });

  it("工具行内为三档 Seg（单行/换行/宽松）", () => {
    const html = renderToStaticMarkup(<SheetPreview sections={[SEC]} />);
    expect(html).toContain("单行");
    expect(html).toContain("换行");
    expect(html).toContain("宽松");
  });
});
