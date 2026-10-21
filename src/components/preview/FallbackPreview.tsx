// 兜底预览卡：无法直渲的类型（含 M2 前的 PDF、旧版二进制 office、rar、heic 等）
// 展示元信息 + 打开/所在文件夹动作，保证"看不了但有的点"。

import type { FileEntry } from "../../lib/ipc";
import { t } from "../../lib/i18n";
import { formatSize, formatTime } from "../../lib/format";
import { fileIcon, typeName } from "../../lib/fileIcons";
import { DENSITY } from "../../lib/tokens";
import { AppIcon } from "../AppIcon";

export function FallbackPreview({
  entry,
  note,
  onOpen,
  onReveal,
}: {
  entry: FileEntry;
  /** 特殊说明（如 pdf 待 M2 支持） */
  note?: string;
  onOpen(): void;
  onReveal(): void;
}) {
  const spec = fileIcon(entry.name, false, false);
  return (
    <div className="np-pv-fallback">
      <AppIcon icon={spec.icon} size={DENSITY.iconLg} colorVar={spec.colorVar} />
      <div className="np-pv-fallback-name np-ellipsis">{entry.name}</div>
      {note && <div className="np-pv-fallback-note">{note}</div>}
      <div className="np-pv-fallback-rows">
        <span className="np-pv-k">{t("类型")}</span>
        <span>{typeName(entry.name, entry.isDir)}</span>
        <span className="np-pv-k">{t("大小")}</span>
        <span>{formatSize(entry)}</span>
        <span className="np-pv-k">{t("修改时间")}</span>
        <span>{formatTime(entry.mtimeMs)}</span>
      </div>
      <div className="np-pv-fallback-actions">
        <button className="np-pv-btn" onClick={onOpen}>
          {t("打开")}
        </button>
        <button className="np-pv-btn" onClick={onReveal}>
          {t("打开所在文件夹")}
        </button>
      </div>
    </div>
  );
}
