// 应用更新检查（关于浮窗 + 启动静默检查）。清单拉取在 Rust 侧（api.fetchUpdateManifest，
// PowerShell 双源直取仓库根 update.json）——WebView 内 fetch 不可靠：Gitee API 匿名调用
// 被 WAF 以 "403 rate limit" 拒绝、GitHub raw 受 WebView2 代理态影响超时，禁改回前端 fetch。
// 本模块只做版本比较与更新判定（纯函数配单测）。
import { getVersion } from "@tauri-apps/api/app";

import { api, type UpdateManifestDto } from "./ipc";

export const REPO_URLS = {
  gitee: "https://gitee.com/wwc9/x-dir",
  github: "https://github.com/wwc9/x-dir",
} as const;

/** 发行页（Release 附件随版本发布；gitee 在国内网络环境下载更快，UI 已注明） */
export const RELEASE_URLS = {
  gitee: `${REPO_URLS.gitee}/releases`,
  github: `${REPO_URLS.github}/releases`,
} as const;

/** 启动发现新版本后自动弹「关于」浮窗的延迟：让会话恢复/首帧先落地，不打断启动 */
export const UPDATE_PROMPT_DELAY_MS = 2000;

export type UpdateManifest = UpdateManifestDto;

/** 一次更新检查的结果（存 useUi.updateCheck；null = 尚未检查过） */
export interface UpdateCheck {
  current: string;
  /** 远端最新清单；双源都拉取失败为 null */
  manifest: UpdateManifest | null;
  /** 命中的拉取源："Gitee" | "GitHub"（manifest 为 null 时为 null） */
  source: string | null;
  /** 逐源失败原因（如 "Gitee：HTTP 403"）；有清单命中时为空数组 */
  errors: string[];
}

/** 三段式版本号比较（"v" 前缀容忍、缺段按 0、非数字段字符串兜底）：
 *  a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const seg = (v: string) =>
    v
      .replace(/^[vV]/, "")
      .split(".")
      .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  const [sa, sb] = [seg(a), seg(b)];
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const [x, y] = [sa[i] ?? 0, sb[i] ?? 0];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

/** 是否存在新版本（current 缺失时视为无法判定，返回 false 防误报） */
export function isUpdateAvailable(check: UpdateCheck | null): boolean {
  return (
    !!check?.manifest &&
    !!check.current &&
    compareVersions(check.manifest.version, check.current) > 0
  );
}

/** 完整检查：Rust 侧拉清单 + 当前版本号（getVersion 失败按空串，isUpdateAvailable 判 false） */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const [result, current] = await Promise.all([
    api.fetchUpdateManifest().catch(() => ({ manifest: null, errors: ["IPC 调用失败"] })),
    getVersion().catch(() => ""),
  ]);
  return {
    current,
    manifest: result.manifest,
    source: result.manifest?.source ?? null,
    errors: result.errors,
  };
}
