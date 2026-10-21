// 关于浮窗（顶栏信息钮 / 启动发现新版时自动弹出，Dialog 二级页按 §4.7）：
// 工具简介 + 开源地址 + 作者信息 + 更新检查（Gitee 优先，国内网络下载更快）。
// 更新数据流：lib/update.ts 拉仓库根 update.json 清单，结果存 useUi.updateCheck。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogBody, DialogFooter } from "@blueprintjs/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, Info, Link2, RefreshCw } from "lucide-react";

import { RELEASE_URLS, REPO_URLS, checkForUpdate, isUpdateAvailable } from "../lib/update";
import { useUi } from "../stores/ui";
import { ic } from "./AppIcon";
import { BrandLogo } from "./BrandLogo";

const APP_INTRO =
  "轻量级多窗格文件管理器：单窗口自由分割出任意数量的窗格，支持 Everything 式全盘秒搜（拼音检索）、空格快速预览、批量重命名、PDF 与图片批处理等内置工具箱；绿色便携，免费开源。";

export function AboutDialog() {
  const open = useUi((s) => s.aboutOpen);
  const check = useUi((s) => s.updateCheck);
  const [busy, setBusy] = useState(false);
  // 打开瞬间若尚未检查过（启动检查未跑完/失败残留 null），自动补一次
  const autoRan = useRef(false);

  const runCheck = () => {
    if (busy) return;
    setBusy(true);
    void checkForUpdate()
      .then((c) => useUi.getState().setUpdateCheck(c))
      .finally(() => setBusy(false));
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
      title="关于 X-Dir"
      icon={ic(Info)}
      canOutsideClickClose
      className="np-dialog"
      style={{ width: "var(--np-dialog-w)" }}
    >
      <DialogBody>
        <div className="np-about">
          <div className="np-about-head">
            <span className="np-logo">
              <BrandLogo />
            </span>
            <div className="np-about-id">
              <span className="np-about-name">X-Dir</span>
              <span className="np-about-ver">
                {check?.current ? `v${check.current}` : "版本信息获取中…"}
              </span>
            </div>
          </div>
          <div className="np-dialog-muted">{APP_INTRO}</div>

          {/* 更新区块：检查中 / 已最新 / 检查失败 / 发现新版本（四态） */}
          {busy && <div className="np-dialog-muted">正在检查更新…</div>}
          {!busy && !manifest && check !== null && (
            <div className="np-about-fail">
              <div>检查更新失败（双源均不可达）：</div>
              <div className="np-about-errors">
                {(check.errors.length ? check.errors : ["原因未知"]).map((e) => (
                  <div key={e}>· {e}</div>
                ))}
              </div>
              <div className="np-dialog-muted">
                可点下方开源地址在浏览器验证网络后重试。
              </div>
            </div>
          )}
          {!busy && manifest && !hasNew && (
            <div className="np-dialog-muted">当前已是最新版本。</div>
          )}
          {!busy && manifest && hasNew && (
            <div className="np-about-update">
              <div className="np-about-update-title">
                发现新版本 v{manifest.version}
                {manifest.pubDate ? `（${manifest.pubDate} 发布）` : ""}
              </div>
              {!!manifest.notes?.length && (
                <ul className="np-about-notes">
                  {manifest.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              <div className="np-dialog-muted">
                Gitee 在国内网络环境下访问与下载更快，建议优先选择。
              </div>
              <div className="np-about-actions">
                <Button
                  size="small"
                  intent="primary"
                  icon={ic(Download)}
                  onClick={() => void openUrl(RELEASE_URLS.gitee)}
                >
                  前往 Gitee 下载
                </Button>
                <Button
                  size="small"
                  icon={ic(Link2)}
                  onClick={() => void openUrl(RELEASE_URLS.github)}
                >
                  前往 GitHub 下载
                </Button>
              </div>
            </div>
          )}

          {/* 固定信息：作者 / 公众号 / 开源地址（完整 URL，可点直达仓库主页） */}
          <div className="np-props np-about-props">
            <AboutProp k="开发者" v="王文铖" />
            <AboutProp k="微信公众号" v="效率视界" />
            <div className="np-prop-row">
              <span className="np-prop-key">开源地址</span>
              <span className="np-prop-val np-about-srcs">
                <button
                  type="button"
                  className="np-linkbtn is-url"
                  data-tip={`在浏览器打开：${REPO_URLS.gitee}`}
                  onClick={() => void openUrl(REPO_URLS.gitee)}
                >
                  {REPO_URLS.gitee}
                </button>
                <button
                  type="button"
                  className="np-linkbtn is-url"
                  data-tip={`在浏览器打开：${REPO_URLS.github}`}
                  onClick={() => void openUrl(REPO_URLS.github)}
                >
                  {REPO_URLS.github}
                </button>
              </span>
            </div>
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
              检查更新
            </Button>
            <Button
              size="small"
              intent="primary"
              onClick={() => useUi.getState().closeAbout()}
            >
              关闭
            </Button>
          </>
        }
      />
    </Dialog>
  );
}

/** 信息行：复用属性对话框的 np-prop-* 布局（键定宽辅助色、值正文色） */
function AboutProp({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="np-prop-row">
      <span className="np-prop-key">{k}</span>
      <span className="np-prop-val np-ellipsis">{v}</span>
    </div>
  );
}

/** 顶栏关于钮的角标提示：有新版本时常亮 accent 圆点 */
export function AboutBadgeDot() {
  const hasNew = useUi((s) => s.aboutOpen === false && isUpdateAvailable(s.updateCheck));
  if (!hasNew) return null;
  return <span className="np-about-dot" aria-hidden />;
}
