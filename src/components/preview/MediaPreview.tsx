// 视频/音频预览：HTML5 media + asset protocol 流式直读，webview 内置解码器零依赖。
// 冷门编码（HEVC 等）解码失败走 onError 回落兜底卡。

import { Music } from "lucide-react";

import { DENSITY } from "../../lib/tokens";
import { AppIcon } from "../AppIcon";

export function MediaPreview({
  src,
  isAudio,
  onError,
}: {
  src: string;
  isAudio: boolean;
  onError(): void;
}) {
  if (isAudio) {
    return (
      <div className="np-pv-audio">
        <AppIcon icon={Music} size={DENSITY.iconLg} colorVar="--np-icon-audio" />
        <audio src={src} controls autoPlay onError={onError} />
      </div>
    );
  }
  return (
    <video
      className="np-pv-media"
      src={src}
      controls
      autoPlay
      playsInline
      onError={onError}
    />
  );
}
