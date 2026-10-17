import { useSettings } from "./settings";
import {
  GS_COL_DEFAULTS,
  clampGsColWidth,
  type GsColKey,
  type GsColWidths,
} from "../lib/columns";

// 窗格列表列宽已改为每窗格独立（2026-10-15）：寄存布局树 PaneNode.colWidths，
// 随工作区树持久化（读写在 components/FileList.tsx + stores/layout.ts）。
// settings.colWidths 保留为全局默认回落（旧档/未拖过列宽的窗格），不再被 UI 写入。

/* ── 全盘搜索结果列（寄存 settings.gsearchColWidths，与窗格列表互相独立）── */

export function useGsColWidths(): GsColWidths {
  return useSettings((s) => s.gsearchColWidths);
}

export function setGsColLive(key: GsColKey, w: number) {
  const cur = useSettings.getState().gsearchColWidths;
  useSettings.setState({ gsearchColWidths: { ...cur, [key]: clampGsColWidth(w, key) } });
}

export function commitGsCols() {
  useSettings.getState().update({ gsearchColWidths: useSettings.getState().gsearchColWidths });
}

export function resetGsCol(key: GsColKey) {
  const cur = useSettings.getState().gsearchColWidths;
  useSettings.getState().update({ gsearchColWidths: { ...cur, [key]: GS_COL_DEFAULTS[key] } });
}
