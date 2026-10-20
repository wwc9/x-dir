// 应用更新检查（关于浮窗 + 启动静默检查）：仓库版本清单解析、版本号比较、
// 双源拉取（Gitee 优先——国内网络可达性好；GitHub 兜底）。纯函数配单测。
import { getVersion } from "@tauri-apps/api/app";

export const REPO_URLS = {
  gitee: "https://gitee.com/wwc9/x-dir",
  github: "https://github.com/wwc9/x-dir",
} as const;

/** 发行页（Release 附件随版本发布；gitee 在国内网络环境下载更快，UI 已注明） */
export const RELEASE_URLS = {
  gitee: `${REPO_URLS.gitee}/releases`,
  github: `${REPO_URLS.github}/releases`,
} as const;

/** 版本清单在仓库根 update.json，随版本发布一并更新（version/pubDate/notes）。
 *  Gitee 走 contents API（raw.giteeusercontent.com 302 落点无 Access-Control-Allow-Origin，
 *  WebView 内 fetch 会被 CORS 拦截；API v5 带 ACAO:*，内容 base64 编码）；GitHub raw 自带 ACAO:* */
const MANIFEST_URLS = [
  { source: "gitee", url: `${REPO_URLS.gitee}/api/v5/repos/wwc9/x-dir/contents/update.json?ref=main` },
  { source: "github", url: `${REPO_URLS.github.replace("github.com", "raw.githubusercontent.com")}/main/update.json` },
] as const;

export type UpdateSource = (typeof MANIFEST_URLS)[number]["source"];

/** 启动发现新版本后自动弹「关于」浮窗的延迟：让会话恢复/首帧先落地，不打断启动 */
export const UPDATE_PROMPT_DELAY_MS = 2000;

/** 仓库版本清单（update.json）；notes 为更新内容逐条列表 */
export interface UpdateManifest {
  version: string;
  pubDate?: string;
  notes?: string[];
}

/** 一次更新检查的结果（存 useUi.updateCheck；null = 尚未检查过） */
export interface UpdateCheck {
  current: string;
  /** 远端最新清单；双源都拉取失败为 null */
  manifest: UpdateManifest | null;
  /** 命中的拉取源（manifest 为 null 时为 null） */
  source: UpdateSource | null;
}

export function parseManifest(data: unknown): UpdateManifest | null {
  if (typeof data !== "object" || data === null) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.version !== "string" || !v.version.trim()) return null;
  const notes = Array.isArray(v.notes)
    ? v.notes.filter((n): n is string => typeof n === "string")
    : undefined;
  return {
    version: v.version.trim(),
    ...(typeof v.pubDate === "string" ? { pubDate: v.pubDate } : {}),
    ...(notes && notes.length ? { notes } : {}),
  };
}

/** base64 → UTF-8 文本（中文 notes 安全解码；容忍 Gitee 返回里的换行空白） */
function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** 响应体 → 清单：GitHub raw = 清单本体；Gitee contents API = { encoding, content } 信封 */
export function manifestFromPayload(data: unknown): UpdateManifest | null {
  if (typeof data !== "object" || data === null || !("content" in data)) {
    return parseManifest(data);
  }
  const v = data as Record<string, unknown>;
  if (typeof v.content !== "string") return null;
  try {
    const text = v.encoding === "base64" ? base64ToUtf8(v.content) : v.content;
    return parseManifest(JSON.parse(text));
  } catch {
    return null;
  }
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

/** 依次尝试双源拉取清单（单源超时/非 200/解析失败即换下一源），全败返回 null */
export async function fetchLatestManifest(
  timeoutMs = 6000,
): Promise<(UpdateManifest & { source: UpdateSource }) | null> {
  for (const { source, url } of MANIFEST_URLS) {
    try {
      const ctl = new AbortController();
      const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      window.clearTimeout(timer);
      if (!res.ok) continue;
      const manifest = manifestFromPayload(await res.json());
      if (manifest) return { ...manifest, source };
    } catch {
      // 网络失败/超时/JSON 解析失败：静默换源
    }
  }
  return null;
}

/** 完整检查：远端清单 + 当前版本号（getVersion 失败按空串，isUpdateAvailable 判 false） */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const [manifest, current] = await Promise.all([
    fetchLatestManifest(),
    getVersion().catch(() => ""),
  ]);
  return { current, manifest, source: manifest?.source ?? null };
}
