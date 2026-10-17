// 压缩包预览（M3）：内容清单虚拟列表（不解压），Rust 端 zip/tar/tar.gz/7z 列取。
// 行 = 条目类型图标（复用 fileIcons）+ 名称 + 大小；目录行弱化显示。

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Folder } from "lucide-react";

import { api, type ArchiveEntry } from "../../lib/ipc";
import { fileIcon } from "../../lib/fileIcons";
import { formatSize } from "../../lib/format";
import { DENSITY } from "../../lib/tokens";
import { AppIcon } from "../AppIcon";

export function ArchivePreview({
  path,
  onInfo,
  onError,
}: {
  path: string;
  /** 清单就绪后回报条目摘要（footer 展示） */
  onInfo(text: string): void;
  onError(message: string): void;
}) {
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const req = ++reqRef.current;
    setEntries(null);
    api
      .listArchive(path)
      .then((l) => {
        if (reqRef.current !== req) return;
        setEntries(l.entries);
        onInfo(`${l.total.toLocaleString()} 项${l.truncated ? "（已截断至 500）" : ""}`);
      })
      .catch((err) => {
        if (reqRef.current === req) onError(String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const virtualizer = useVirtualizer({
    count: entries?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DENSITY.rowH,
    overscan: DENSITY.overscan,
  });

  function RowIcon({ e }: { e: ArchiveEntry }) {
    if (e.isDir) return <AppIcon icon={Folder} size={DENSITY.iconMd} colorVar="--np-icon-folder" />;
    const spec = fileIcon(e.name, false, false);
    return <AppIcon icon={spec.icon} size={DENSITY.iconMd} colorVar={spec.colorVar} />;
  }

  return (
    <div ref={scrollRef} className="np-pv-ar">
      {!entries ? (
        <div className="np-pv-loading">
          <AppIcon icon={Folder} size={DENSITY.iconMd} colorVar="--np-icon-archive" />
        </div>
      ) : entries.length === 0 ? (
        <div className="np-pv-empty">（空压缩包）</div>
      ) : (
        <div className="np-pv-ar-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const e = entries[row.index];
            return (
              <div
                key={row.key}
                className={`np-pv-ar-row ${e.isDir ? "is-dir" : ""}`}
                style={{
                  position: "absolute",
                  insetInline: 0,
                  height: row.size,
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <RowIcon e={e} />
                <span className="np-ellipsis">{e.name}</span>
                <span className="np-pv-ar-size">{e.isDir ? "—" : formatSize(e)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
