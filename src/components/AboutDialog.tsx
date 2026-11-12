// 关于浮窗（顶栏信息钮 / 启动发现新版时自动弹出，Dialog 二级页按 §4.7）：
// 工具简介 + 开源地址 + 作者信息 + 更新检查（Gitee 优先，国内网络下载更快）。
// 更新数据流：lib/update.ts 拉仓库根 update.json 清单，结果存 useUi.updateCheck。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../lib/i18n";
import { Button, Dialog, DialogBody, DialogFooter } from "@blueprintjs/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, Info, Link2, RefreshCw } from "lucide-react";

import { RELEASE_URLS, REPO_URLS, checkForUpdate, groupNotes, isUpdateAvailable } from "../lib/update";
import { api, type SystemInfo } from "../lib/ipc";
import { useUi } from "../stores/ui";
import { ic } from "./AppIcon";
import { BrandLogo } from "./BrandLogo";

const APP_INTRO =
  "轻量级多窗格文件管理器：单窗口自由分割出任意数量的窗格，支持 Everything 式全盘秒搜（拼音检索）、空格快速预览、批量重命名、PDF 与图片批处理等内置工具箱；绿色便携，免费开源。";

/** 运行环境探针（2026-11-05 远程排障引入）：UA 里的 Edg/ 即 WebView2 运行时
 *  版本（Evergreen 随系统更新，老版本是渲染异常的第一嫌疑项），Chrome/ 主版本
 *  决定 CSS 特性可用面（color-mix/oklch 需 ≥111）。排查异机渲染问题时先看这里 */
function engineInfo(): string {
  const ua = navigator.userAgent;
  const edg = /Edg\/([\d.]+)/.exec(ua)?.[1];
  const chrome = /Chrome\/(\d+)/.exec(ua)?.[1];
  if (edg && chrome) return `WebView2 ${edg} · Chromium ${chrome}`;
  if (chrome) return `Chromium ${chrome}`;
  return t("未知");
}

/** 设备配置（2026-11-06）：关于弹窗打开时拉一次——弱核显/内存紧张/老系统
 *  是渲染与性能类反馈的第一判断依据（截图卡顿/文字消失等案例的排障入口） */
function useSystemInfo(open: boolean): SystemInfo | null {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .systemInfo()
      .then((r) => {
        if (alive) setInfo(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);
  return info;
};

export function AboutDialog() {
  const open = useUi((s) => s.aboutOpen);
  const check = useUi((s) => s.updateCheck);
  const [busy, setBusy] = useState(false);
  // 一键覆盖更新（2026-11-11）：Tauri updater 插件——检查 latest.json → 下载
  // 签名安装包 → 静默安装同路径 → 自动重启（无卸载界面，配置/固定图标保留）。
  // latest.json 尚未随发布上传时本通道报错，回落手动下载按钮
  const [inPlace, setInPlace] = useState<null | {
    phase: "check" | "download" | "install";
    pct: number;
  }>(null);
  // 打开瞬间若尚未检查过（启动检查未跑完/失败残留 null），自动补一次
  const autoRan = useRef(false);
  const sys = useSystemInfo(open);

  const runCheck = () => {
    if (busy) return;
    setBusy(true);
    void checkForUpdate()
      .then((c) => useUi.getState().setUpdateCheck(c))
      .finally(() => setBusy(false));
  };

  const inPlaceUpdate = async (): Promise<void> => {
    setInPlace({ phase: "check", pct: 0 });
    try {
    const { check: checkUpdate } = await import("@tauri-apps/plugin-updater");
      const update = await checkUpdate();
      if (!update) {
        useUi.getState().toast(t("应用内更新通道不可用，请手动下载"), "error");
        setInPlace(null);
        return;
      }
      // 看门狗（2026-11-12 用户反馈「更新后未自动重开、无提示」）：NSIS /R 自启
      // 兜底——下载前先拉起分离进程，等安装器退出后确保新版重启（/R 成功时检测
      // 到实例即静默退出绝不多开）；重启后的「已更新到」回执由 app-updated 事件
      // （Rust 启动版本比对，App.tsx 监听）承担。失败静默——仅兜底，不阻断更新
      void api.spawnUpdateWatchdog(update.version).catch(() => undefined);
      let total = 0;
      let got = 0;
      setInPlace({ phase: "download", pct: 0 });
      await update.downloadAndInstall((ev) => {        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total > 0) {
            setInPlace({
              phase: "download",
              pct: Math.min(100, Math.round((got / total) * 100)),
            });
          }
        } else if (ev.event === "Finished") {
          setInPlace({ phase: "install", pct: 100 });
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      useUi.getState().toast(t("自动更新失败：{e}", { e: String(e) }), "error");
      setInPlace(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (useUi.getState().updateCheck === null && !autoRan.current) {
      autoRan.current = true;
      runCheck();
    }
  }, [open]);

  const hasNew = isUpdateAvailable(check);
  const manifest = check?.manifest ?? null;

  return (
    <Dialog
      isOpen={open}
      onClose={() => useUi.getState().closeAbout()}
      title={t("关于 X-Dir")}
      icon={ic(Info)}
      canOutsideClickClose
      className="np-dialog"
      style={{ width: "min(680px, 92vw)" }}
    >
      <DialogBody>
        {/* 左右分栏（2026-11-06 用户需求）：左 = 身份/简介/固定信息/设备环境，
            右 = 更新区块——更新日志再长也只在右栏内滚动，不再撑爆弹窗高度 */}
        <div className="np-about">
          <div className="np-about-main">
            <div className="np-about-head">
              <span className="np-logo">
                <BrandLogo />
              </span>
              <div className="np-about-id">
                <span className="np-about-name">X-Dir</span>
                <span className="np-about-ver">
                  {check?.current ? `v${check.current}` : t("版本信息获取中…")}
                </span>
              </div>
            </div>
            <div className="np-dialog-muted">{t(APP_INTRO)}</div>

            {/* 固定信息：作者 / 公众号 / 开源地址（完整 URL，可点直达仓库主页） */}
            <div className="np-props np-about-props">
              <AboutProp k={t("开发者")} v="王文铖" />
              <AboutProp k={t("微信公众号")} v="效率视界" />
              <div className="np-prop-row">
                <span className="np-prop-key">{t("开源地址")}</span>
                <span className="np-prop-val np-about-srcs">
                  <button
                    type="button"
                    className="np-linkbtn is-url"
                    data-tip={t("在浏览器打开：{u}", { u: REPO_URLS.gitee })}
                    onClick={() => void openUrl(REPO_URLS.gitee)}
                  >
                    {REPO_URLS.gitee}
                  </button>
                  <button
                    type="button"
                    className="np-linkbtn is-url"
                    data-tip={t("在浏览器打开：{u}", { u: REPO_URLS.github })}
                    onClick={() => void openUrl(REPO_URLS.github)}
                  >
                    {REPO_URLS.github}
                  </button>
                </span>
              </div>
            </div>

            {/* 设备环境（2026-11-06 独立分区）：引擎 + OS/CPU/内存/GPU——异机排障
                （渲染异常/性能问题）先看这里判断配置档次；拉取失败静默隐藏整区
                （探针不阻塞主体），仅剩引擎行 */}
            <div className="np-about-sys">
              <div className="np-about-update-title">{t("设备环境")}</div>
              <div className="np-props np-about-props">
                <AboutProp k={t("运行环境")} v={engineInfo()} wrap />
                {sys && (
                  <>
                    <AboutProp k={t("操作系统")} v={sys.os} wrap />
                    <AboutProp k={t("处理器")} v={sys.cpu} wrap />
                    <AboutProp k={t("内存")} v={`${sys.memoryGb} GB`} wrap />
                    {/* 显卡逐行展示（多卡各占一行），不省略 */}
                    <AboutProp
                      k={t("显卡")}
                      v={sys.gpus.map((g) => <div key={g}>{g}</div>)}
                      wrap
                    />
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 更新区块：检查中 / 已最新 / 检查失败 / 发现新版本（四态） */}
          <div className="np-about-side">
            {busy && <div className="np-dialog-muted">{t("正在检查更新…")}</div>}
            {!busy && !manifest && check !== null && (
              <div className="np-about-fail">
                <div>{t("检查更新失败（双源均不可达）：")}</div>
                <div className="np-about-errors">
                  {(check.errors.length ? check.errors : [t("原因未知")]).map((e) => (
                    <div key={e}>· {e}</div>
                  ))}
                </div>
                <div className="np-dialog-muted">
                  {t("可点左侧开源地址在浏览器验证网络后重试。")}
                </div>
              </div>
            )}
            {!busy && manifest && !hasNew && (
              <div className="np-dialog-muted">{t("当前已是最新版本。")}</div>
            )}
            {!busy && manifest && hasNew && (
              <div className="np-about-update">
                <div className="np-about-update-title">
                  {t("发现新版本")} v{manifest.version}
                  {manifest.pubDate ? t("（{d} 发布）", { d: manifest.pubDate }) : ""}
                </div>
                {(() => {
                  // 分类分节（2026-11-12 用户定案「面板与 Release 描述一致」）：
                  // notes 前缀标签分组 → ✨新增/⚡改进/🐛修复 三段，与发行说明同构；
                  // 条目「——」前短标题加粗对应 Release 加粗口径
                  const secs = groupNotes(manifest.notes);
                  if (!secs.length) return null;
                  return (
                    <div className="np-about-notes">
                      {secs.map((sec) => (
                        <div key={sec.title} className="np-about-note-sec">
                          <div className="np-about-note-head">{t(sec.title)}</div>
                          <ul>
                            {sec.items.map((n, i) => {
                              const dash = n.indexOf("——");
                              return (
                                <li key={i}>
                                  {dash > 0 ? (
                                    <>
                                      <span className="np-about-note-t">{n.slice(0, dash)}</span>
                                      {n.slice(dash)}
                                    </>
                                  ) : (
                                    n
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div className="np-dialog-muted">
                  {t("Gitee 在国内网络环境下访问与下载更快，建议优先选择。")}
                </div>
                <div className="np-about-actions">
                  <Button
                    size="small"
                    intent="primary"
                    icon={ic(Download)}
                    loading={!!inPlace}
                    onClick={() => void inPlaceUpdate()}
                  >
                    {inPlace
                      ? inPlace.phase === "download"
                        ? t("下载中 {p}%", { p: inPlace.pct })
                        : inPlace.phase === "install"
                          ? t("安装中，完成后自动重启…")
                          : t("正在检查…")
                      : t("一键更新（自动安装）")}
                  </Button>
                  <Button
                    size="small"
                    icon={ic(Download)}
                    onClick={() => void openUrl(RELEASE_URLS.gitee)}
                  >
                    {t("前往 Gitee 下载")}
                  </Button>
                  <Button
                    size="small"
                    icon={ic(Link2)}
                    onClick={() => void openUrl(RELEASE_URLS.github)}
                  >
                    {t("前往 GitHub 下载")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button
              size="small"
              icon={ic(RefreshCw)}
              disabled={busy}
              onClick={runCheck}
            >
              {t("检查更新")}
            </Button>
            <Button
              size="small"
              intent="primary"
              onClick={() => useUi.getState().closeAbout()}
            >
              {t("关闭")}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}

/** 信息行：复用属性对话框的 np-prop-* 布局（键定宽辅助色、值正文色）；
 *  wrap = 值折行完整展示不省略（设备环境排障信息截断即失效，2026-11-06） */
function AboutProp({ k, v, wrap }: { k: string; v: ReactNode; wrap?: boolean }) {
  return (
    <div className="np-prop-row">
      <span className="np-prop-key">{k}</span>
      {wrap ? (
        <div className="np-prop-val np-about-valwrap">{v}</div>
      ) : (
        <span className="np-prop-val np-ellipsis">{v}</span>
      )}
    </div>
  );
}

/** 顶栏关于钮的角标提示：有新版本时常亮 accent 圆点 */
export function AboutBadgeDot() {
  const hasNew = useUi((s) => s.aboutOpen === false && isUpdateAvailable(s.updateCheck));
  if (!hasNew) return null;
  return <span className="np-about-dot" aria-hidden />;
}
