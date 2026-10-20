// V2 真实图标的前端缓存（铁律 3：只请求可见行；本表只存 data URL 字符串，
// 真正的重活与 LRU 上限在 Rust 端，这里仅按可见窗口取回 + 有界去重）。
// miss 负缓存：取过但无图标的路径不再重复请求（--bench 假路径等），
// 避免滚动时 IPC 请求风暴推高 WebView2 私有内存。

import { create } from "zustand";

import { api } from "../lib/ipc";
import { extOf } from "../lib/fileIcons";
import { fileNameOf } from "../lib/path";

/** 前端侧表上限（超限整批清空重取；Rust 端另有 LRU 精细淘汰） */
const ICONS_MAX = 800;
/** 单次批量请求上限（对齐可见行窗口 + overscan） */
const BATCH_MAX = 48;
/** 合并抖动窗口：快速滚动时合并为一次 IPC */
const FLUSH_MS = 60;
/** miss 集合上限：超过即整体清空重试一轮（防止新文件永不取图标） */
const MISS_MAX = 2000;

interface IconsStore {
  icons: Record<string, string>;
  /** 扩展名 → 真实图标（仅限"同扩展名共享图标"的常规类型，Rust icon_key 同规则）。
   *  会话内任一文件取得图标后，其余同名扩展文件即可同步直渲染，零 IPC 零切换 */
  exts: Record<string, string>;
  /** immediate=true 跳过防抖直接发 IPC（目录数据到达时的首屏预热） */
  requestIcons(paths: string[], immediate?: boolean): void;
}

const pending = new Set<string>();
const missed = new Set<string>();
let timer: number | undefined;
let retryTimer: number | undefined;
/** miss 复活重试轮数（有界）：冷启动瞬时提取失败（SHGetFileInfo 偶发 None）会把
 *  真实路径永久拉黑、整会话无图标——2s 后重试一轮，至多 2 轮；假路径多打 2 批
 *  IPC 开销可忽略 */
const MISS_RETRY_ROUNDS = 2;
const MISS_RETRY_DELAY_MS = 2000;
let missedRetries = 0;

function flush() {
  const batch = [...pending].slice(0, BATCH_MAX);
  for (const p of batch) pending.delete(p);
  if (!batch.length) return;
  api
    .getFileIcons(batch)
    .then((map) => {
      // 无产出的路径进负缓存；集合超限时清空重试（新文件/临时失败可恢复）
      const missesNow: string[] = [];
      for (const p of batch) {
        if (!(p in map)) missesNow.push(p);
        missed.add(p);
      }
      if (missed.size > MISS_MAX) missed.clear();
      // miss 复活：负缓存出队重试（有界），冷启动瞬时提取失败自愈——
      // 必须在整批失败早退之前调度（整批皆 miss 同样需要重试）
      if (missesNow.length && missedRetries < MISS_RETRY_ROUNDS) {
        missedRetries += 1;
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          for (const p of missesNow) missed.delete(p);
          schedule(missesNow, true);
        }, MISS_RETRY_DELAY_MS);
      }
      if (!Object.keys(map).length) return;
      const s = useIcons.getState();
      const merged = { ...s.icons, ...map };
      const keys = Object.keys(merged);
      if (keys.length > ICONS_MAX) {
        for (const k of keys.slice(0, keys.length - ICONS_MAX)) delete merged[k];
      }
      // 扩展名级共享表：值冲突（目录名带点 / 特殊类型）即剔除该键回退路径表
      const exts = { ...s.exts };
      for (const p of Object.keys(map)) {
        const e = extOf(fileNameOf(p));
        if (!e) continue;
        if (e in exts && exts[e] !== map[p]) delete exts[e];
        else exts[e] = map[p];
      }
      useIcons.setState({ icons: merged, exts });
    })
    .catch(() => undefined);
}

function schedule(paths: string[], immediate = false) {
  const store = useIcons.getState().icons;
  for (const p of paths) {
    if (!(p in store) && !missed.has(p) && !pending.has(p)) {
      pending.add(p);
    }
  }
  if (immediate) {
    window.clearTimeout(timer);
    flush();
    return;
  }
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, FLUSH_MS);
}

export const useIcons = create<IconsStore>()(() => ({
  icons: {},
  exts: {},

  requestIcons(paths, immediate = false) {
    schedule(paths, immediate);
  },
}));
