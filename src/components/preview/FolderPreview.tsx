// 文件夹预览卡（Space / 全盘搜索预览共用）：直接子项数 + 递归体积（best-effort，
// 复用「空间分析」的 dir_sizes 通道与其上限护栏）。体积对大目录可能较慢：
// 先出子项数，体积异步补齐；条目切换即弃用旧响应（reqId 守卫）。

import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";

import { api, type DirSizeEntry, type FileEntry, type Sort } from "../../lib/ipc";
import { formatSize, formatTime } from "../../lib/format";
import { fileIcon } from "../../lib/fileIcons";
import { DENSITY } from "../../lib/tokens";
import { AppIcon } from "../AppIcon";

const NAME_ASC: Sort = { key: "name", dir: "asc" };

function sumSizes(entries: DirSizeEntry[]): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const e of entries) {
    bytes += e.size;
    files += e.files;
    if (!e.isDir) files += 1;
  }
  return { bytes, files };
}

/** 请求序号（模块级）：预览同一时刻只渲染一条，切换条目即弃用旧响应 */
let reqSeq = 0;

export function FolderPreview({
  entry,
  onOpen,
  onReveal,
  onInfo,
}: {
  entry: FileEntry;
  onOpen(): void;
  onReveal(): void;
  /** 元信息回传（宿主页脚展示，同压缩包清单的 onInfo） */
  onInfo(text: string): void;
}) {
  const spec = fileIcon(entry.name, true, false);
  const [children, setChildren] = useState<number | null>(null);
  const [size, setSize] = useState<{ bytes: number; files: number } | null>(null);
  const [sizing, setSizing] = useState(false);

  // onInfo 经 ref 中转：回调身份随宿主渲染变化，进 deps 会死循环（同 PreviewBody 惯例）
  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;

  useEffect(() => {
    const req = ++reqSeq;
    setChildren(null);
    setSize(null);
    setSizing(false);
    // 直接子项数：list_dir 只取 1 条拿 total（复用目录快照缓存，无额外全量 IO）
    api
      .listDir({ path: entry.path, sort: NAME_ASC, showHidden: false, offset: 0, limit: 1 })
      .then((r) => {
        if (reqSeq !== req) return;
        setChildren(r.total);
        onInfoRef.current(`${r.total.toLocaleString()} 项`);
      })
      .catch(() => undefined);
    // 递归体积：可能较慢（大目录），best-effort 异步补齐
    setSizing(true);
    api
      .dirSizes(entry.path)
      .then((entries) => {
        if (reqSeq !== req) return;
        setSize(sumSizes(entries));
        setSizing(false);
      })
      .catch(() => {
        if (reqSeq !== req) return;
        setSizing(false);
      });
  }, [entry.path]);

  return (
    <div className="np-pv-fallback">
      <AppIcon icon={spec.icon} size={DENSITY.iconLg} colorVar={spec.colorVar} />
      <div className="np-pv-fallback-name np-ellipsis">{entry.name}</div>
      <div className="np-pv-fallback-rows">
        <span className="np-pv-k">{t("类型")}</span>
        <span>{t("文件夹")}</span>
        <span className="np-pv-k">{t("直接子项")}</span>
        <span>{children === null ? "统计中…" : `${children.toLocaleString()} 项`}</span>
        <span className="np-pv-k">{t("总大小")}</span>
        <span>
          {size
            ? `${formatSize({ isDir: false, size: size.bytes })}（${size.files.toLocaleString()} 个文件）`
            : sizing
              ? "计算中…"
              : "—"}
        </span>
        <span className="np-pv-k">{t("修改时间")}</span>
        <span>{formatTime(entry.mtimeMs)}</span>
      </div>
      <div className="np-pv-fallback-actions">
        <button className="np-pv-btn" onClick={onOpen}>
          {t("打开文件夹")}
        </button>
        <button className="np-pv-btn" onClick={onReveal}>
          {t("打开所在位置")}
        </button>
      </div>
    </div>
  );
}
