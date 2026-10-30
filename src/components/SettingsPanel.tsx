// 设置浮窗（TitleBar 齿轮唤起，Dialog 浮窗样式，2026-10-14 定案）：左侧分类导航 +
// 右侧内容页（自滚动）。分类：外观 / 浏览 / 文件操作 / 全盘搜索 / 着色规则 / 快捷键 /
// 配置；取值统一走 settings.update()（settings.json 集中化）；控件与行布局按 §4.7。
// 右键菜单已独立为整页（MenuEditorPage），不再归属设置分类。
import { useEffect, useState, Fragment, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import {
  Button,
  ButtonGroup,
  Dialog,
  DialogBody,
  InputGroup,
  Switch,
} from "@blueprintjs/core";
import {
  Camera,
  Download,
  Files,
  FolderOpen,
  Keyboard,
  Palette,
  Plus,
  Search,
  Settings,
  Tag,
  X,
} from "lucide-react";

import { api, type ColorRule, type SortKey, type TagColor, type ViewMode } from "../lib/ipc";
import { ZOOM_STEPS } from "../lib/zoom";
import { DENSITY } from "../lib/tokens";
import { SHORTCUT_GROUPS } from "../lib/shortcuts";
import { setThemeWithFx, useSettings } from "../stores/settings";
import { confirmDialog, useUi } from "../stores/ui";
import { AppIcon, ic } from "./AppIcon";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { NpSelect } from "./NpSelect";

const TAG_COLORS: { key: TagColor; label: string }[] = [
  { key: "red", label: "红" },
  { key: "orange", label: "橙" },
  { key: "yellow", label: "黄" },
  { key: "green", label: "绿" },
  { key: "blue", label: "蓝" },
  { key: "purple", label: "紫" },
];

const VIEW_LABELS: Record<ViewMode, string> = {
  list: "列表",
  details: "详细信息",
};
const SORT_LABELS: Record<SortKey, string> = {
  name: "名称",
  size: "大小",
  mtime: "修改时间",
  type: "类型",
};

/** 截图热键（旧版 5 个预设下拉已退役 2026-10-30：改 HotkeyRecorder 按键录制，
 *  支持任意 Ctrl/Alt/Shift 组合——预设只是无录制器时的权宜） */

const TABS = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "browse", label: "浏览", icon: FolderOpen },
  { id: "ops", label: "文件操作", icon: Files },
  { id: "search", label: "全盘搜索", icon: Search },
  { id: "shot", label: "截图", icon: Camera },
  { id: "rules", label: "着色规则", icon: Tag },
  { id: "keys", label: "快捷键", icon: Keyboard },
  { id: "config", label: "配置", icon: Download },
] as const;
type TabId = (typeof TABS)[number]["id"];
/** 顶栏按钮直达某分类（如"自定义右键命令"钮 → commands） */
export type SettingsTabId = TabId;

/** 统一行：左侧 标题+说明、右侧控件（分隔线由 .np-set-row 相邻规则绘制） */
function SetRow({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="np-set-row">
      <div className="np-set-info">
        <span className="np-set-label">{label}</span>
        {desc && <span className="np-set-desc">{desc}</span>}
      </div>
      {children}
    </div>
  );
}

export function SettingsPanel() {
  const t = useT();
  const s = useSettings();
  /** 浮窗开合与直达分类状态在 useUi；打开时同步当前 tab（顶栏/其余入口只 set 状态） */
  const settingsTab = useUi((st) => st.settingsTab);
  const [tab, setTab] = useState<TabId>(settingsTab ?? "appearance");
  const [quickRule, setQuickRule] = useState("");
  useEffect(() => {
    if (settingsTab) setTab(settingsTab);
  }, [settingsTab]);

  const setRule = (i: number, patch: Partial<ColorRule>) => {
    const rules = s.colorRules.map((r, j) => (j === i ? { ...r, ...patch } : r));
    s.update({ colorRules: rules });
  };

  /** 截图热键/开关变更：落盘并即时重注册（冲突经灵动岛回执提示） */
  const applyShotHotkey = (enabled: boolean, hotkey: string) => {
    s.update({ shotEnabled: enabled, shotHotkey: hotkey });
    api.shotRegisterHotkey(enabled, hotkey).catch((e) =>
      useUi.getState().toast(`截图热键未生效：${String(e)}`, "error"),
    );
  };

  return (
    <Dialog
      isOpen={settingsTab !== null}
      onClose={() => useUi.getState().closeSettings()}
      data-tip={t("设置")}
      icon={ic(Settings)}
      canOutsideClickClose
      className="np-dialog np-settingsdlg"
      style={{ width: "min(720px, 92vw)" }}
    >
      <DialogBody>
        <div className="np-settings">
      <nav className="np-settings-nav">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            className={`np-settings-nav-item ${tab === tb.id ? "is-on" : ""}`}
            onClick={() => setTab(tb.id)}
          >
            <AppIcon icon={tb.icon} size={DENSITY.iconSm} />
            <span className="np-ellipsis">{t(tb.label)}</span>
          </button>
        ))}
      </nav>
      <div className="np-settings-page">
        {tab === "appearance" && (
          <>
            <SetRow label={t("主题")} desc="跟随 Windows 深浅色自动切换，或固定浅色 / 深色">
              <ButtonGroup className="np-seg" size="small" variant="minimal">
                {(["system", "light", "dark"] as const).map((t) => (
                  <Button
                    key={t}
                    active={s.theme === t}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setThemeWithFx(t, {
                        x: r.left + r.width / 2,
                        y: r.top + r.height / 2,
                      });
                    }}
                  >
                    {t === "system" ? "跟随系统" : t === "light" ? "浅色" : "深色"}
                  </Button>
                ))}
              </ButtonGroup>
            </SetRow>
            <SetRow label={t("界面缩放")} desc="Ctrl +/−/0 或 Ctrl+滚轮，作用于全部界面">
              <NpSelect
                value={s.uiZoom}
                options={ZOOM_STEPS.map((z) => ({ value: z, label: `${Math.round(z * 100)}%` }))}
                onChange={(z) => s.update({ uiZoom: z })}
              />
            </SetRow>
            <SetRow label={t("真实文件图标")} desc="提取文件关联的系统图标，替代内置线性图标">
              <Switch
                checked={s.realIcons}
                onChange={(e) => s.update({ realIcons: e.currentTarget.checked })}
              />
            </SetRow>
          </>
        )}
        {tab === "browse" && (
          <>
            <SetRow label={t("新标签默认视图")} desc="新开标签页进入的显示模式">
              <NpSelect
                value={s.defaultView}
                options={(["details", "list"] as ViewMode[]).map((v) => ({
                  value: v,
                  label: t(VIEW_LABELS[v]),
                }))}
                onChange={(v) => s.update({ defaultView: v })}
              />
            </SetRow>
            <SetRow label={t("新标签默认排序")} desc="新开标签页的排序字段与方向">
              <span className="np-set-sort">
                <NpSelect
                  value={s.defaultSort.key}
                  options={(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({
                    value: k,
                    label: t(SORT_LABELS[k]),
                  }))}
                  onChange={(k) => s.update({ defaultSort: { ...s.defaultSort, key: k } })}
                />
                <NpSelect
                  value={s.defaultSort.dir}
                  options={[
                    { value: "asc", label: "升序" },
                    { value: "desc", label: "降序" },
                  ]}
                  onChange={(dir) => s.update({ defaultSort: { ...s.defaultSort, dir } })}
                />
              </span>
            </SetRow>
            <SetRow label={'"在终端打开"使用'} desc="右键菜单终端项调用的 Shell">
              <NpSelect
                value={s.terminal}
                options={[
                  { value: "powershell", label: "PowerShell" },
                  { value: "cmd", label: "CMD（命令提示符）" },
                ]}
                onChange={(t) => s.update({ terminal: t })}
              />
            </SetRow>
            <SetRow label={t("显示隐藏文件")} desc="列出带隐藏属性与点开头的文件">
              <Switch
                checked={s.showHidden}
                onChange={(e) => s.update({ showHidden: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("记忆目录选中集")}
              desc="离开目录时快照勾选，回到该目录自动恢复（Ctrl+A / Esc 等显式操作不受影响）"
            >
              <Switch
                checked={s.rememberSelection}
                onChange={(e) => s.update({ rememberSelection: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow label={t("启动时恢复上次会话")} desc="重启后还原窗格、标签与路径">
              <Switch
                checked={s.restoreLastSession}
                onChange={(e) => s.update({ restoreLastSession: e.currentTarget.checked })}
              />
            </SetRow>
          </>
        )}
        {tab === "ops" && (
          <>
            <SetRow label={t("删除前确认")} desc="删除到回收站前弹出确认框">
              <Switch
                checked={s.confirmDelete}
                onChange={(e) => s.update({ confirmDelete: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("系统进度与冲突框")}
              desc="复制 / 移动走 Windows 原生 IFileOperation（进度/冲突由系统承担，快操作系统不弹进度窗；关闭 = 灵动岛字节级进度 + 应用内冲突框）"
            >
              <Switch
                checked={s.nativeFileOps}
                onChange={(e) => s.update({ nativeFileOps: e.currentTarget.checked })}
              />
            </SetRow>
          </>
        )}
        {tab === "search" && (
          <>
            <SetRow label={t("预览面板")} desc="结果右侧内嵌文件预览，分隔条可拖宽">
              <Switch
                checked={s.gsearchPreview}
                onChange={(e) => s.update({ gsearchPreview: e.currentTarget.checked })}
              />
            </SetRow>
            <div className="np-set-hint">
              {t("索引模式（NTFS 秒搜）开关已移至「全盘搜索」面板底部状态条，点击指示签即可管理。")}
            </div>
          </>
        )}
        {tab === "shot" && (
          <>
            <SetRow label={t("截图快捷键")} desc="系统级全局热键，X-Dir 运行时任意界面可按（含游戏等全屏应用除外）">
              <Switch
                checked={s.shotEnabled}
                onChange={(e) => applyShotHotkey(e.currentTarget.checked, s.shotHotkey)}
              />
            </SetRow>
            <SetRow
              label="热键键位（自定义）"
              desc="点击后直接按下组合键录制；需含 Ctrl / Alt / Shift 修饰键（或单独 F1-F12），更改即时生效"
            >
              <HotkeyRecorder
                value={s.shotHotkey}
                disabled={!s.shotEnabled}
                onApply={(h) => applyShotHotkey(s.shotEnabled, h)}
                notify={(msg) => useUi.getState().toast(msg, "error")}
              />
            </SetRow>
            <SetRow label={t("立即试一次")} desc="直接开始一次截图（等同按下全局热键）">
              <Button minimal size="small" onClick={() => void api.shotBegin().catch(() => undefined)}>
                {t("截图…")}
              </Button>
            </SetRow>
            <div className="np-set-hint">
              {t(
                "截图支持框选 / 窗口识别 / 矩形·椭圆·箭头·画笔·马克笔·文字标注 / 马赛克与模糊 / 序号标记 / 滚动长截图 / 贴图（钉在屏幕上）/ 复制与保存；关闭 X-Dir 后热键失效。",
              )}
            </div>
          </>
        )}
        {tab === "rules" && (
          <>
            <div className="np-set-hint">
              {t("按规则给文件名着色，自上而下首个命中的规则生效（支持 *.ext 或名称包含）。")}
            </div>
            <div className="np-set-quickadd">
              <input
                className="np-set-quickadd-input"
                value={quickRule}
                spellCheck={false}
                placeholder={t("快速添加：输入规则文本回车确认（如 *.pdf 或 合同）")}
                onChange={(e) => setQuickRule(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const pattern = quickRule.trim();
                  if (!pattern) return;
                  const palette: TagColor[] = [
                    "red",
                    "orange",
                    "yellow",
                    "green",
                    "blue",
                    "purple",
                  ];
                  const color = palette[s.colorRules.length % palette.length];
                  s.update({ colorRules: [...s.colorRules, { pattern, color }] });
                  setQuickRule("");
                }}
              />
            </div>
            <div className="np-set-rules">
              {s.colorRules.map((r, i) => (
                <div key={i} className="np-set-rule">
                  <InputGroup
                    size="small"
                    value={r.pattern}
                    placeholder="*.zip"
                    spellCheck={false}
                    onChange={(e) => setRule(i, { pattern: e.target.value })}
                  />
                  <NpSelect
                    value={r.color}
                    options={TAG_COLORS.map((c) => ({ value: c.key, label: t(c.label) }))}
                    onChange={(color) => setRule(i, { color })}
                  />
                  <span
                    className="np-rule-dot"
                    style={{ background: `var(--np-tag-${r.color})` }}
                  />
                  <button
                    className="np-rule-del"
                    data-tip={t("删除规则")}
                    onClick={() =>
                      s.update({ colorRules: s.colorRules.filter((_, j) => j !== i) })
                    }
                  >
                    <AppIcon icon={X} size={DENSITY.iconXs} />
                  </button>
                </div>
              ))}
              {!s.colorRules.length && (
                <div className="np-set-rules-empty">{t("暂无规则")}</div>
              )}
            </div>
            <Button
              size="small"
              minimal
              icon={ic(Plus)}
              text={t("添加规则")}
              onClick={() =>
                s.update({
                  // 默认值（2026-10-22）：*.pdf + 红（审计场景高频起点）
                  colorRules: [...s.colorRules, { pattern: "*.pdf", color: "red" }],
                })
              }
            />
          </>
        )}
        {tab === "keys" &&
          SHORTCUT_GROUPS.map((g) => (
            <section key={g.title}>
              <div className="np-set-group-title">{t(g.title)}</div>
              {g.items.map((it) => {
                // 截图热键已支持自定义：清单里的键位是默认值，实际以设置当前值
                // 为准（关闭时显示未启用）
                const keys =
                  it.id === "shot-open"
                    ? [s.shotEnabled ? s.shotHotkey : "未启用"]
                    : it.keys;
                return (
                  <SetRow key={it.id} label={t(it.label)}>
                    <span className="np-kbds">
                      {keys.map((combo) => (
                        <span key={combo} className="np-kbd-combo">
                          {combo.split("+").map((seg, j) => (
                            <Fragment key={j}>
                              {j > 0 && <span className="np-kbd-plus">+</span>}
                              <kbd className="np-kbd">{seg}</kbd>
                            </Fragment>
                          ))}
                        </span>
                      ))}
                    </span>
                  </SetRow>
                );
              })}
            </section>
          ))}
        {tab === "config" && (
          <>
            <SetRow label={t("导出配置文件")} desc="打包设置与全部布局方案为单个 JSON">
              <Button minimal size="small" onClick={() => void onExportConfig()}>
                {t("导出…")}
              </Button>
            </SetRow>
            <SetRow label={t("导入配置文件")} desc="从导出的 JSON 恢复（覆盖当前设置与同名布局方案）">
              <Button minimal size="small" onClick={() => void onImportConfig()}>
                {t("导入…")}
              </Button>
            </SetRow>
          </>
        )}
        </div>
      </div>
      </DialogBody>
    </Dialog>
  );
}

/** 导出配置：原生保存对话框选路径 → Rust 打包 settings.json + 全部工作区 */
async function onExportConfig() {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: "导出 X-Dir 配置",
    defaultPath: "X-Dir-config.json",
    filters: [{ name: "X-Dir 配置", extensions: ["json"] }],
  });
  if (!path) return;
  try {
    const r = await api.exportConfig(path);
    useUi
      .getState()
      .toast(`配置已导出：${path}（含 ${r.workspaces} 个布局方案）`);
  } catch (e) {
    useUi.getState().toast(`导出失败：${String(e)}`, "error");
  }
}

/** 导入配置：选择导出 JSON → 确认覆盖 → 后端整体替换 settings.json + workspaces → 前端热重载 */
async function onImportConfig() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    title: "导入 X-Dir 配置",
    multiple: false,
    directory: false,
    filters: [{ name: "X-Dir 配置", extensions: ["json"] }],
  });
  if (typeof path !== "string" || !path) return;
  const ok = await confirmDialog({
    title: "导入配置",
    message: "导入将覆盖当前全部设置与同名布局方案（不可撤销），确定继续吗？",
    kind: "warn",
    okText: "导入",
  });
  if (!ok) return;
  try {
    const r = await api.importConfig(path);
    // 热重载：设置重读（主题/缩放/右键菜单即时生效），布局方案列表经事件刷新
    await useSettings.getState().load();
    window.dispatchEvent(new Event("xdir-workspaces-changed"));
    useUi
      .getState()
      .toast(`配置已导入（含 ${r.workspaces} 个布局方案）`);
  } catch (e) {
    useUi.getState().toast(`导入失败：${String(e)}`, "error");
  }
}
