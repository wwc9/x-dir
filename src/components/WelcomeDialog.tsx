// 欢迎引导（2026-11-25 用户需求「首次启动欢迎引导」）：首启一次性弹出的功能
// 亮点卡片——四个招牌能力 + 快捷键，任何关闭路径都落 welcomeSeen（不再自动
// 弹出）；设置 → 配置页「欢迎引导」可重开。
import { Button, Dialog, DialogBody, DialogFooter } from "@blueprintjs/core";
import { Columns2, Eye, Search, Sparkles, WandSparkles } from "lucide-react";

import { t } from "../lib/i18n";
import { DENSITY } from "../lib/tokens";
import { useSettings } from "../stores/settings";
import { useUi } from "../stores/ui";
import { AppIcon, ic } from "./AppIcon";

// 文案模块级 t() 定值（TAG_COLORS 同先例）：i18nCoverage 审计按字面量键扫描，
// 动态键会漏翻；语言切换随重载生效
const HIGHLIGHTS = [
  {
    icon: Columns2,
    title: t("多窗格自由分割"),
    desc: t("任意窗格横向 / 纵向分裂，布局方案一键切换"),
    kbd: "Ctrl+Shift+H / V",
  },
  {
    icon: Eye,
    title: t("空格快速预览"),
    desc: t("选中文件按空格即看，Office / PDF / 表格等 40+ 格式"),
    kbd: "Space",
  },
  {
    icon: Search,
    title: t("全盘秒搜"),
    desc: t("全盘文件名搜索，支持拼音与 ext: / size: / dm: 语法"),
    kbd: "Ctrl+Shift+F",
  },
  {
    icon: WandSparkles,
    title: t("右键菜单可定制"),
    desc: t("内置功能自由拖入右键菜单与窗格工具栏"),
    kbd: t("定制"),
  },
];

export function WelcomeDialog() {
  const open = useUi((s) => s.welcomeOpen);
  // 任何关闭路径（按钮/Esc/点外部）都标记已看过——首启不再自动弹出
  const close = () => {
    useUi.getState().closeWelcome();
    useSettings.getState().update({ welcomeSeen: true });
  };
  return (
    <Dialog
      isOpen={open}
      onClose={close}
      className="np-dialog np-welcomedlg"
      title={t("欢迎使用 X-Dir")}
      icon={ic(Sparkles)}
    >
      <DialogBody>
        <div className="np-welcome-grid">
          {HIGHLIGHTS.map((h) => (
            <div key={h.title} className="np-welcome-card">
              <span className="np-welcome-icon">
                <AppIcon icon={h.icon} size={DENSITY.iconLg} />
              </span>
              <span className="np-welcome-main">
                <span className="np-welcome-title">{h.title}</span>
                <span className="np-welcome-desc">{h.desc}</span>
                <span className="np-welcome-kbd np-kbd">{h.kbd}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="np-welcome-hint">
          {t("更多能力见右键「功能库…」与设置（快捷键清单、外观、性能模式一应俱全）")}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button intent="primary" onClick={close}>
          {t("开始使用")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
