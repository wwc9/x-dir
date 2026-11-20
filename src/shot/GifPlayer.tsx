// GIF 结果窗 Canvas 播放器（2026-11-20 用户需求「预览要支持播放」）：原生
// <img> 动画无法暂停/恢复，改用 WebView2 内置 ImageDecoder 逐帧解码 +
// rAF 时间轴——暂停停在当前帧、恢复从当前帧继续（不重头），空格/按钮切换。
// 逐帧解码不缓存（长录制动辄上千帧，缓存位图会吃掉上 GB 内存；单帧 LZW
// 解码 2-10ms，15fps 播放预算充裕，循环回放每轮重新解码）。调用方以
// typeof ImageDecoder 探测可用性，缺失回退 <img> 分支。
import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export function GifPlayer({
  file,
  w,
  h,
  zoom,
  naturalCss,
  playing,
  onReady,
  onFrames,
}: {
  file: string;
  /** GIF 物理像素尺寸（canvas 画布 1:1，缩放走 CSS width） */
  w: number;
  h: number;
  /** 图的 CSS 观感宽 = 物理宽/DPI × 缩放（与 img 分支同口径） */
  zoom: number | null;
  naturalCss: number;
  playing: boolean;
  /** 首帧绘出回执（Rust 此时才 show，提前 show 闪黑屏） */
  onReady: () => void;
  /** 帧数回执（状态条展示） */
  onFrames: (n: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const idxRef = useRef(0);
  const remainRef = useRef(0);
  const dursRef = useRef<number[]>([]);
  const playRef = useRef(playing);
  playRef.current = playing;

  useEffect(() => {
    let dead = false;
    let raf = 0;
    let decoder: ImageDecoder | null = null;
    const durs = dursRef.current;
    void (async () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      try {
        const resp = await fetch(convertFileSrc(file));
        const buf = await resp.arrayBuffer();
        if (dead) return;
        decoder = new ImageDecoder({ data: buf, type: "image/gif" });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
        if (dead) return;
        if (count <= 0) {
          onReady();
          return;
        }
        onFrames(count);
        let painting = false;
        // 逐帧解码绘制（不缓存）：解码在飞时跳过本轮，下一拍补上
        const paint = async (i: number) => {
          if (painting || !decoder) return;
          painting = true;
          try {
            const { image } = await decoder.decode({ frameIndex: i });
            if (dead) {
              image.close();
              return;
            }
            // VideoFrame 时长 µs → ms；缺失按 100ms 兜底
            const dur = (image.duration ?? 100000) / 1000;
            durs[i] = dur;
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            image.close();
          } catch {
            // 单帧解码失败跳过（坏帧不阻塞时间轴）
          } finally {
            painting = false;
          }
        };
        // 首帧就绪回执（与 img onLoad 同口径：Rust 此时才 show）
        await paint(0);
        remainRef.current = durs[0] ?? 100;
        onReady();
        let last = performance.now();
        const tick = (t: number) => {
          if (dead) return;
          if (playRef.current) {
            let dt = t - last;
            if (dt > 1000) dt = 1000; // 后台节流回前台跳帧保护
            remainRef.current -= dt;
            let guard = 0;
            while (remainRef.current <= 0 && guard++ < count) {
              idxRef.current = (idxRef.current + 1) % count;
              remainRef.current += durs[idxRef.current] ?? 100;
            }
            void paint(idxRef.current);
          }
          last = t;
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        // 解码链路失败：至少回执 ready 放行显示（正常产物不会走到）
        if (!dead) onReady();
      }
    })();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      decoder?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      style={{ width: zoom === null ? undefined : naturalCss * zoom }}
    />
  );
}
