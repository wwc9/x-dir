// 设置浮窗（TitleBar 齿轮唤起，Dialog 浮窗样式，2026-10-14 定案）：左侧分类导航 +
// 右侧内容页（自滚动）。分类：外观 / 浏览 / 文件操作 / 全盘搜索 / 着色规则 / 快捷键 /
// 配置；取值统一走 settings.update()（settings.json 集中化）；控件与行布局按 §4.7。
// 右键菜单已独立为整页（MenuEditorPage），不再归属设置分类。
import { useEffect, useState, Fragment, type ReactNode } from "react";
import { t, useT } from "../lib/i18n";
import {
  Button,
  ButtonGroup,
  Dialog,
  DialogBody,
  InputGroup,
  Slider,
  Switch,
} from "@blueprintjs/core";
import {
  CalendarDays,
  Camera,
  ClipboardList,
  Download,
  Files,
  Gauge,
  FolderOpen,
  Keyboard,
  ImagePlus,
  Palette,
  Plus,
  Search,
  Settings,
  Tag,
  X,
} from "lucide-react";

import { api, type ColorRule, type SortKey, type SystemInfo, type TagColor, type ViewMode } from "../lib/ipc";
import { ZOOM_STEPS } from "../lib/zoom";
import { DENSITY } from "../lib/tokens";
import { SHORTCUT_GROUPS } from "../lib/shortcuts";
import { hotkeySpecs } from "../lib/hotkey";
import { setThemeWithFx, useSettings } from "../stores/settings";
import { confirmDialog, useUi } from "../stores/ui";
import { AppIcon, ic } from "./AppIcon";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { Seg } from "./ImgDialogs";
import { PERF_TABLE, detectTier, type PerfTier } from "../lib/perf";
import { NpSelect } from "./NpSelect";
import { GLASS_BGS, TAG_COLORS } from "../stores/settings";

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
  { id: "perf", label: "性能", icon: Gauge },
  { id: "browse", label: "浏览", icon: FolderOpen },
  { id: "ops", label: "文件操作", icon: Files },
  { id: "search", label: "全盘搜索", icon: Search },
  { id: "shot", label: "截图", icon: Camera },
  { id: "clip", label: "剪贴板", icon: ClipboardList },
  { id: "calendar", label: "日历", icon: CalendarDays },
  { id: "rules", label: "着色规则", icon: Tag },
  { id: "keys", label: "快捷键", icon: Keyboard },
  { id: "config", label: "配置", icon: Download },
] as const;
type TabId = (typeof TABS)[number]["id"];
/** 顶栏按钮直达某分类（如"自定义右键命令"钮 → commands） */
export type SettingsTabId = TabId;

/** 设备判定一次性拉取（模块级缓存）：外观页毛玻璃行与性能 tab 共用，每会话只拉一次 */
let perfInfoCache: { info: SystemInfo; remote: boolean } | null = null;
type PerfDetected = { tier: PerfTier; info: SystemInfo; remote: boolean };

/** 档位探测 hook：system_info + 远程会话一票判定（resolvePerf 的输入） */
function usePerfDetect(): PerfDetected | null {
  const [detected, setDetected] = useState<PerfDetected | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!perfInfoCache) {
        try {
          const [info, remote] = await Promise.all([
            api.systemInfo(),
            api.isRemoteSession(),
          ]);
          perfInfoCache = { info, remote };
        } catch {
          return;
        }
      }
      if (!alive || !perfInfoCache) return;
      setDetected({
        tier: detectTier(perfInfoCache.info, perfInfoCache.remote),
        info: perfInfoCache.info,
        remote: perfInfoCache.remote,
      });
    })();
    return () => {
      alive = false;
    };
  }, []);
  return detected;
}

/** 设备判定信息行（性能 tab）：展示硬件信号与自动判定结果 */
function PerfDeviceRow() {
  const t = useT();
  const detected = usePerfDetect();
  if (!detected) {
    return (
      <div className="np-set-row np-perf-device">
        <span className="np-set-label">{t("正在读取设备信息…")}</span>
      </div>
    );
  }
  // 设备摘要：CPU 主名（cpu 字符串自带「· N 线程」后缀，与独立线程数重复，裁掉）；
  // 全量文本流式换行展示，任何宽度都不截断
  const cpuName = detected.info.cpu.split(" · ")[0];
  const specs = [
    `${detected.info.cpuThreads} ${t("线程")}`,
    `${Math.round(detected.info.memoryGb)}GB ${t("内存")}`,
    detected.info.gpus[0] ?? t("未检出独立显卡"),
    cpuName,
    ...(detected.remote ? [t("远程会话")] : []),
  ].join(" · ");
  const tierText = detected.remote
    ? t("低性能档 · 远程会话")
    : detected.tier === "low"
      ? t("低性能档")
      : t("高性能档");
  return (
    <div className="np-set-row np-perf-device">
      <span className={`np-perf-tier is-${detected.remote ? "low" : detected.tier}`}>
        {tierText}
      </span>
      <span className="np-perf-specs">{specs}</span>
    </div>
  );
}

/** 统一行：左侧 标题+说明、右侧控件（分隔线由 .np-set-row 相邻规则绘制） */
function SetRow({ label, desc, children, className }: { label: string; desc?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `np-set-row ${className}` : "np-set-row"}>
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
  /** 清理历史条目的天数输入（设置 → 剪贴板，2026-11-12 用户需求；0 = 全部） */
  const [clipClearDays, setClipClearDays] = useState(3);
  /** 工作日历分类新增（设置 → 日历，2026-11-13 增强批） */
  useEffect(() => {
    if (settingsTab) setTab(settingsTab);
  }, [settingsTab]);

  /** 清空最近 N 天剪贴板条目：确认弹窗 → 命令（置顶/收藏豁免）→ 回执条数 */
  const clearRecentClips = async () => {
    const days = Math.max(0, Math.min(3650, Math.floor(clipClearDays || 0)));
    const ok = await confirmDialog({
      title: t("清理历史条目"),
      message:
        days === 0
          ? t("确定清空全部非置顶、非收藏条目吗？删除后不可恢复。")
          : t("确定删除最近 {n} 天的非置顶、非收藏条目吗？删除后不可恢复。", { n: days }),
      kind: "warn",
      okText: t("清空"),
    });
    if (!ok) return;
    try {
      const n = await api.cliphistClearRecent(days);
      useUi
        .getState()
        .toast(n > 0 ? t("已清理 {n} 条历史条目", { n }) : t("没有可清理的条目"));
    } catch (e) {
      useUi.getState().toast(t("清理失败：{e}", { e: String(e) }), "error");
    }
  };

  const setRule = (i: number, patch: Partial<ColorRule>) => {
    const rules = s.colorRules.map((r, j) => (j === i ? { ...r, ...patch } : r));
    s.update({ colorRules: rules });
  };

  /** 截图热键/开关变更：落盘并即时重注册（冲突经灵动岛回执提示）。
   *  系统热键为全量重建（§3.7 hotkeys_sync）：任一热键变更都重发全部 */
  const applyShotHotkey = (enabled: boolean, hotkey: string) => {
    s.update({ shotEnabled: enabled, shotHotkey: hotkey });
    api.hotkeysSync(hotkeySpecs(useSettings.getState())).catch((e) =>
      useUi.getState().toast(t("截图热键未生效：{e}", { e: String(e) }), "error"),
    );
  };

  /** 剪贴板历史总开关：落盘 + 热键重注册 + 监听启停 */
  const applyClipEnabled = (enabled: boolean) => {
    s.update({ cliphistEnabled: enabled });
    const st = useSettings.getState();
    void api
      .hotkeysSync(hotkeySpecs(st))
      .catch((e) => useUi.getState().toast(t("剪贴板热键未生效：{e}", { e: String(e) }), "error"));
    void api.cliphistConfigure(enabled, st.cliphistCapacity, st.cliphistKeepDays).catch(
      () => undefined,
    );
  };

  /** 剪贴板呼出热键变更：落盘并全量重注册 */
  const applyClipHotkey = (hotkey: string) => {
    s.update({ cliphistHotkey: hotkey });
    api.hotkeysSync(hotkeySpecs(useSettings.getState())).catch((e) =>
      useUi.getState().toast(t("剪贴板热键未生效：{e}", { e: String(e) }), "error"),
    );
  };

  /** 工作日历启用开关：落盘并全量重注册（2026-11-13 新功能） */
  const applyCalendarEnabled = (enabled: boolean) => {
    s.update({ calendarEnabled: enabled });
    api.hotkeysSync(hotkeySpecs(useSettings.getState())).catch((e) =>
      useUi.getState().toast(t("日历热键未生效：{e}", { e: String(e) }), "error"),
    );
  };

  /** 工作日历呼出热键变更：落盘并全量重注册 */
  const applyCalendarHotkey = (hotkey: string) => {
    s.update({ calendarHotkey: hotkey });
    api.hotkeysSync(hotkeySpecs(useSettings.getState())).catch((e) =>
      useUi.getState().toast(t("日历热键未生效：{e}", { e: String(e) }), "error"),
    );
  };

  /** 容量/天数护栏变更：落盘并推送后端 */
  const applyClipLimits = (
    capacity: number,
    keepDays: number,
    excludeApps?: string,
    richText?: boolean,
  ) => {
    if (excludeApps !== undefined) s.update({ cliphistExcludeApps: excludeApps });
    else if (richText !== undefined) s.update({ cliphistRichText: richText });
    else s.update({ cliphistCapacity: capacity, cliphistKeepDays: keepDays });
    const st = useSettings.getState();
    void api
      .cliphistConfigure(
        st.cliphistEnabled,
        excludeApps !== undefined || richText !== undefined ? st.cliphistCapacity : capacity,
        excludeApps !== undefined || richText !== undefined ? st.cliphistKeepDays : keepDays,
        excludeApps ?? st.cliphistExcludeApps,
        richText ?? st.cliphistRichText,
      )
      .catch(() => undefined);
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
            <SetRow label={t("主题")} desc={t("跟随 Windows 深浅色自动切换，或固定浅色 / 深色")}>
              <ButtonGroup className="np-seg" size="small" variant="minimal">
                {(["system", "light", "dark"] as const).map((th) => (
                  <Button
                    key={th}
                    active={s.theme === th}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setThemeWithFx(th, {
                        x: r.left + r.width / 2,
                        y: r.top + r.height / 2,
                      });
                    }}
                  >
                    {th === "system" ? t("跟随系统") : th === "light" ? t("浅色") : t("深色")}
                  </Button>
                ))}
              </ButtonGroup>
            </SetRow>
            <SetRow label={t("界面缩放")} desc={t("Ctrl +/−/0 或 Ctrl+滚轮，作用于全部界面")}>
              <NpSelect
                value={s.uiZoom}
                options={ZOOM_STEPS.map((z) => ({ value: z, label: `${Math.round(z * 100)}%` }))}
                onChange={(z) => s.update({ uiZoom: z })}
              />
            </SetRow>
            <SetRow label={t("真实文件图标")} desc={t("提取文件关联的系统图标，替代内置线性图标")}>
              <Switch
                checked={s.realIcons}
                onChange={(e) => s.update({ realIcons: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("面板圆角")}
              desc={t("窗格、侧栏卡片、导航树、对话框等所有面板的统一圆角半径")}
            >
              <div className="np-set-slider">
                <Slider
                  min={0}
                  max={24}
                  stepSize={1}
                  labelValues={[]}
                  value={s.uiRadius}
                  onChange={(v) => s.update({ uiRadius: Array.isArray(v) ? v[0] : v })}
                />
                <span className="np-set-slider-val">{s.uiRadius} px</span>
              </div>
            </SetRow>
            <SetRow
              label={t("组件间隔")}
              desc={t("窗格之间及各卡片组件的间隔（设为 0 时窗格贴合，分隔条热区悬跨缝隙仍可拖拽）")}
            >
              <div className="np-set-slider">
                <Slider
                  min={0}
                  max={24}
                  stepSize={1}
                  labelValues={[]}
                  value={s.uiGap}
                  onChange={(v) => s.update({ uiGap: Array.isArray(v) ? v[0] : v })}
                />
                <span className="np-set-slider-val">{s.uiGap} px</span>
              </div>
            </SetRow>
            <SetRow
              label={t("窗口毛玻璃")}
              desc={t("画布铺柔和渐变，窗格与浮层实时模糊透出底色；低性能档默认关，可手动开启")}
            >
              {/* 2026-11-18 用户定案：与上方真实文件图标行同为开关（Switch），
                  替代关/开分段。2026-11-18 二次定案：放开低性能档禁用——
                  档位点击按预设切换（低配默认关），手动开关随时可用 */}
              <Switch
                checked={s.windowGlass === "on"}
                onChange={(e) => {
                  const m = e.currentTarget.checked ? "on" : "off";
                  s.update({ windowGlass: m });
                  useUi
                    .getState()
                    .toast(`${t("窗口毛玻璃")}：${m === "off" ? t("关") : t("开")}`);
                }}
              />
            </SetRow>
                        {/* 玻璃背景图案（2026-11-18 收敛：极光基座+自定义图片）：仅毛玻璃模式生效 */}
            {s.windowGlass === "on" && (
              <>
                <SetRow label={t("背景图案")} desc={t("毛玻璃画布的背景图案，任意图案下弹窗与霜面均可读")}>
                  <NpSelect
                    value={s.glassBg}
                    options={GLASS_BGS.map((x) => ({ value: x.key, label: t(x.label) }))}
                    onChange={(v) => s.update({ glassBg: v })}
                  />
                </SetRow>
                <SetRow
                  label={t("模糊强度")}
                  desc={t("玻璃卡片与浮层的实时模糊半径；0 = 不模糊，弹窗恒 40 保可读性")}
                >
                  <div className="np-set-slider">
                    <Slider
                      min={0}
                      max={48}
                      stepSize={1}
                      labelValues={[]}
                      value={s.glassBlur}
                      onChange={(v) => s.update({ glassBlur: Array.isArray(v) ? v[0] : v })}
                    />
                    <span className="np-set-slider-val">{s.glassBlur} px</span>
                  </div>
                </SetRow>
                <SetRow
                  label={t("霜面浓度")}
                  desc={t("玻璃卡片霜面的不透明度，越高越实、越低越透；弹窗与菜单恒强霜保可读性")}
                >
                  <div className="np-set-slider">
                    <Slider
                      min={20}
                      max={80}
                      stepSize={1}
                      labelValues={[]}
                      value={s.glassFrost}
                      onChange={(v) => s.update({ glassFrost: Array.isArray(v) ? v[0] : v })}
                    />
                    <span className="np-set-slider-val">{s.glassFrost} %</span>
                  </div>
                </SetRow>
                <SetRow
                  label={t("弹层模糊")}
                  desc={t("弹窗与菜单等浮层的模糊半径；菜单随弹窗按比例联动，8px 下限保可读")}
                >
                  <div className="np-set-slider">
                    <Slider
                      min={0}
                      max={64}
                      stepSize={1}
                      labelValues={[]}
                      value={s.glassPopBlur}
                      onChange={(v) => s.update({ glassPopBlur: Array.isArray(v) ? v[0] : v })}
                    />
                    <span className="np-set-slider-val">{s.glassPopBlur} px</span>
                  </div>
                </SetRow>
                <SetRow
                  label={t("弹层浓度")}
                  desc={t("弹窗与菜单等浮层的霜面浓度，越高越实；弹窗染色渐变按比例缩放")}
                >
                  <div className="np-set-slider">
                    <Slider
                      min={40}
                      max={95}
                      stepSize={1}
                      labelValues={[]}
                      value={s.glassPopFrost}
                      onChange={(v) => s.update({ glassPopFrost: Array.isArray(v) ? v[0] : v })}
                    />
                    <span className="np-set-slider-val">{s.glassPopFrost} %</span>
                  </div>
                </SetRow>
                {s.glassBg === "custom" && (
                  <>
                    <SetRow
                      label={t("自定义图片")}
                      desc={t("选择本机图片作为毛玻璃画布；路径持久化，移动原文件后需重新选择")}
                    >
                      <div className="np-set-pathline">
                        <span className="np-set-path">
                          {/* 反斜杠后插零宽空格：换行优先发生在路径分隔处，
                             扩展名不被截断（jpg 不再切成 j/pg） */}
                          {s.glassBgCustom
                            ? s.glassBgCustom.split("\\").join("\\\u200b")
                            : t("未选择图片")}
                        </span>
                        <Button
                          minimal
                          size="small"
                          icon={ic(ImagePlus)}
                          data-tip={t("选择背景图片")}
                          onClick={async () => {
                            const sel = await openFileDialog({
                              title: t("选择背景图片"),
                              multiple: false,
                              directory: false,
                              filters: [
                                {
                                  name: t("图片"),
                                  extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"],
                                },
                              ],
                            });
                            if (typeof sel === "string")
                              s.update({ glassBgCustom: sel, glassBgVeil: s.glassBgVeil });
                          }}
                        >
                          {t("选择图片")}
                        </Button>
                      </div>
                    </SetRow>
                    <SetRow
                      label={t("蒙版浓度")}
                      desc={t("叠加在自定义图片上的可读性蒙版（浅色蒙白雾、深色蒙夜幕）")}
                    >
                      <div className="np-set-slider">
                        <Slider
                          min={0}
                          max={60}
                          stepSize={1}
                          labelValues={[]}
                          value={s.glassBgVeil}
                          onChange={(v) => s.update({ glassBgVeil: Array.isArray(v) ? v[0] : v })}
                        />
                        <span className="np-set-slider-val">{s.glassBgVeil} %</span>
                      </div>
                    </SetRow>
                  </>
                )}
              </>
            )}
          </>
        )}
        {tab === "perf" && (
          <>
            <SetRow
              className="np-set-wrap"
              label={t("性能模式")}
              desc={t("「自动」按设备判定（远程会话/CPU/内存/显卡），切换即应用下表差异，可随时改回")}
            >
              <Seg<"auto" | "high" | "low">
                value={s.perfMode}
                onChange={(mode) => {
                  s.update({ perfMode: mode });
                  s.applyPerfMode(mode === "auto" ? s.perfTier : mode);
                }}
                options={[
                  { value: "auto", label: t("自动") },
                  { value: "high", label: t("高性能") },
                  { value: "low", label: t("低性能") },
                ]}
              />
            </SetRow>
            <PerfDeviceRow />
            <div className="np-perf-table" role="table">
              <div className="np-perf-tr np-perf-th" role="row">
                <span>{t("设置项")}</span>
                <span>{t("高性能")}</span>
                <span>{t("低性能")}</span>
              </div>
              {PERF_TABLE.map((row) => (
                <div className="np-perf-tr" role="row" key={row.label}>
                  <span className="np-perf-k">{t(row.label)}</span>
                  <span>{t(row.high)}</span>
                  <span>{t(row.low)}</span>
                </div>
              ))}
            </div>
            <div className="np-dialog-muted" style={{ marginTop: 10 }}>
              {t("切换模式会立即应用上表全部差异；自动档只按设备决定默认，之后各项仍可在对应设置页手动调整。")}
            </div>
          </>
        )}
        {tab === "browse" && (
          <>
            <SetRow label={t("新标签默认视图")} desc={t("新开标签页进入的显示模式")}>
              <NpSelect
                value={s.defaultView}
                options={(["details", "list"] as ViewMode[]).map((v) => ({
                  value: v,
                  label: t(VIEW_LABELS[v]),
                }))}
                onChange={(v) => s.update({ defaultView: v })}
              />
            </SetRow>
            <SetRow label={t("新标签默认排序")} desc={t("新开标签页的排序字段与方向")}>
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
                    { value: "asc", label: t("升序") },
                    { value: "desc", label: t("降序") },
                  ]}
                  onChange={(dir) => s.update({ defaultSort: { ...s.defaultSort, dir } })}
                />
              </span>
            </SetRow>
            <SetRow label={t('“在终端打开”使用')} desc={t("右键菜单终端项调用的 Shell")}>
              <NpSelect
                value={s.terminal}
                options={[
                  { value: "powershell", label: "PowerShell" },
                  { value: "cmd", label: t("CMD（命令提示符）") },
                ]}
                onChange={(t) => s.update({ terminal: t })}
              />
            </SetRow>
            <SetRow label={t("显示隐藏文件")} desc={t("列出带隐藏属性与点开头的文件")}>
              <Switch
                checked={s.showHidden}
                onChange={(e) => s.update({ showHidden: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("是否展示文件夹的大小")}
              desc={t("开启后文件夹行异步计算并显示递归体积（大文件夹稍后补齐，单文件夹上限 20 万文件）；关闭后大小列留空")}
            >
              <Switch
                checked={s.showFolderSize}
                onChange={(e) => s.update({ showFolderSize: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("记忆目录选中集")}
              desc={t("离开目录时快照勾选，回到该目录自动恢复（Ctrl+A / Esc 等显式操作不受影响）")}
            >
              <Switch
                checked={s.rememberSelection}
                onChange={(e) => s.update({ rememberSelection: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow label={t("启动时恢复上次会话")} desc={t("重启后还原窗格、标签与路径")}>
              <Switch
                checked={s.restoreLastSession}
                onChange={(e) => s.update({ restoreLastSession: e.currentTarget.checked })}
              />
            </SetRow>
          </>
        )}
        {tab === "ops" && (
          <>
            <SetRow
              label={t("删除前确认")}
              desc={t("删除到回收站前弹出确认框（默认直删；弹窗内勾选「以后不再确认」即关闭本开关）")}
            >
              <Switch
                checked={s.confirmDelete}
                onChange={(e) => s.update({ confirmDelete: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("关闭窗格前确认")}
              desc={t("关闭含标签的窗格前弹出确认框（弹窗内勾选「以后不再确认」即关闭本开关）")}
            >
              <Switch
                checked={s.confirmClosePane}
                onChange={(e) => s.update({ confirmClosePane: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("系统进度与冲突框")}
              desc={t("复制 / 移动走 Windows 原生 IFileOperation（进度/冲突由系统承担，快操作系统不弹进度窗；关闭 = 灵动岛字节级进度 + 应用内冲突框）")}
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
            <SetRow label={t("预览面板")} desc={t("结果右侧内嵌文件预览，分隔条可拖宽")}>
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
            <SetRow label={t("截图快捷键")} desc={t("系统级全局热键，X-Dir 运行时任意界面可按（含游戏等全屏应用除外）")}>
              <Switch
                checked={s.shotEnabled}
                onChange={(e) => applyShotHotkey(e.currentTarget.checked, s.shotHotkey)}
              />
            </SetRow>
            <SetRow
              label={t("热键键位（自定义）")}
              desc={t("点击后直接按下组合键录制；需含 Ctrl / Alt / Shift 修饰键（或单独 F1-F12），更改即时生效")}
            >
              <HotkeyRecorder
                value={s.shotHotkey}
                disabled={!s.shotEnabled}
                onApply={(h) => applyShotHotkey(s.shotEnabled, h)}
                notify={(msg) => useUi.getState().toast(msg, "error")}
              />
            </SetRow>
            <SetRow label={t("立即试一次")} desc={t("直接开始一次截图（等同按下全局热键）")}>
              <Button minimal size="small" onClick={() => void api.shotBegin().catch(() => undefined)}>
                {t("截图…")}
              </Button>
            </SetRow>
            <SetRow
              label={t("十字辅助线")}
              desc={t(
                "框选时跟随光标的水平/垂直全屏细线（确认选区后自动隐藏）；低配置电脑关闭可减少覆盖层的合成开销",
              )}
            >
              <Switch
                checked={s.shotCrosshair}
                onChange={(e) => s.update({ shotCrosshair: e.currentTarget.checked })}
              />
            </SetRow>
            <div className="np-set-hint">
              {t(
                "截图支持框选 / 窗口识别 / 矩形·椭圆·箭头·画笔·马克笔·文字标注 / 马赛克与模糊 / 序号标记 / 滚动长截图 / 贴图（钉在屏幕上）/ 复制与保存；关闭 X-Dir 后热键失效。",
              )}
            </div>
          </>
        )}
        {tab === "clip" && (
          <>
            <SetRow
              label={t("启用剪贴板历史")}
              desc={t("后台记录复制/剪切的文本·图片·文件，存本地 clipboard.db（不上传；关闭 X-Dir 后监听停止，历史保留）")}
            >
              <Switch
                checked={s.cliphistEnabled}
                onChange={(e) => applyClipEnabled(e.currentTarget.checked)}
              />
            </SetRow>
            <SetRow
              label={t("呼出热键（自定义）")}
              desc={t("系统级全局热键，任意界面可按；点击后直接按下组合键录制，更改即时生效")}
            >
              <HotkeyRecorder
                value={s.cliphistHotkey}
                disabled={!s.cliphistEnabled}
                onApply={(h) => applyClipHotkey(h)}
                notify={(msg) => useUi.getState().toast(msg, "error")}
              />
            </SetRow>
            <SetRow
              label={t("选中后直接粘贴")}
              desc={t("回写剪贴板后自动切回原窗口并模拟 Ctrl+V；对管理员权限窗口等场景失败时降级为仅复制")}
            >
              <Switch
                checked={s.cliphistDirectPaste}
                onChange={(e) => s.update({ cliphistDirectPaste: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow label={t("历史容量")} desc={t("超过上限自动删除最旧的未置顶条目")}>
              <NpSelect
                value={s.cliphistCapacity}
                options={[200, 500, 1000, 2000].map((v) => ({
                  value: v,
                  label: t("{n} 条", { n: v }),
                }))}
                onChange={(v) => applyClipLimits(v, s.cliphistKeepDays)}
              />
            </SetRow>
            <SetRow
              label={t("清理历史条目")}
              desc={t("删除最近 N 天的非置顶、非收藏条目（不可恢复）；填 0 = 清空全部")}
            >
              <span className="np-filext">
                <input
                  className="np-set-quickadd-input"
                  style={{ width: "64px" }}
                  value={clipClearDays}
                  inputMode="numeric"
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ""));
                    setClipClearDays(Number.isFinite(n) ? n : 0);
                  }}
                />
                <span style={{ fontSize: "var(--np-font-sm)", color: "var(--np-muted)" }}>
                  {t("天")}
                </span>
              </span>
              <Button
                minimal
                size="small"
                intent="danger"
                disabled={!s.cliphistEnabled}
                onClick={() => void clearRecentClips()}
              >
                {t("清空")}
              </Button>
            </SetRow>
            <SetRow
              label={t("排除应用")}
              desc={t("这些程序复制的内容不入库（进程名，逗号分隔，写 excel 或 excel.exe 均可）")}
            >
              <input
                className="np-set-quickadd-input"
                style={{ width: "240px" }}
                value={s.cliphistExcludeApps}
                spellCheck={false}
                onChange={(e) =>
                  applyClipLimits(s.cliphistCapacity, s.cliphistKeepDays, e.target.value)
                }
              />
            </SetRow>
            <SetRow
              label={t("富文本保真")}
              desc={t("记录文本条目的 HTML 格式，粘贴回 Word/浏览器/邮件保留加粗与颜色（纯文本粘贴不受影响）")}
            >
              <Switch
                checked={s.cliphistRichText}
                onChange={(e) =>
                  applyClipLimits(s.cliphistCapacity, s.cliphistKeepDays, undefined, e.currentTarget.checked)
                }
              />
            </SetRow>
            <SetRow label={t("保留天数")} desc={t("到期自动清理（置顶条目豁免）")}>
              <NpSelect
                value={s.cliphistKeepDays}
                options={[
                  { value: 7, label: t("7 天") },
                  { value: 30, label: t("30 天") },
                  { value: 90, label: t("90 天") },
                  { value: 0, label: t("永不清") },
                ]}
                onChange={(v) => applyClipLimits(s.cliphistCapacity, v)}
              />
            </SetRow>
            <SetRow label={t("备份导出")} desc={t("全部历史条目导出为 JSON（含图片/收藏/富文本）")}>
              <Button minimal size="small" onClick={() => void onCliphistExport()}>
                {t("导出…")}
              </Button>
            </SetRow>
            <SetRow label={t("备份导入")} desc={t("从备份 JSON 追加导入（保留收藏与时间戳）")}>
              <Button minimal size="small" onClick={() => void onCliphistImport()}>
                {t("导入…")}
              </Button>
            </SetRow>
            <div className="np-set-hint">
              {t(
                "浮窗内 ↑↓ 选择、Enter 直接粘贴、Ctrl+Enter 仅复制、Ctrl+P 置顶、Del 删除、Space 勾选多条合并粘贴、1-9 取条；≥3 字全文搜索、拼音首字母可查中文。",
              )}
            </div>
          </>
        )}
                {tab === "calendar" && (
          <>
            <SetRow
              label={t("启用工作日历")}
              desc={t("月视图记录每天的工作条目（待办/执行中/已完成），可按月度/年度/自定义范围导出 Markdown；数据存本地 worklog.json")}
            >
              <Switch
                checked={s.calendarEnabled}
                onChange={(e) => applyCalendarEnabled(e.currentTarget.checked)}
              />
            </SetRow>
            <SetRow
              label={t("呼出热键（自定义）")}
              desc={t("系统级全局热键，任意界面可按：聚焦主窗并打开工作日历；点击后直接按下组合键录制，更改即时生效")}
            >
              <HotkeyRecorder
                value={s.calendarHotkey}
                disabled={!s.calendarEnabled}
                onApply={(h) => applyCalendarHotkey(h)}
                notify={(msg) => useUi.getState().toast(msg, "error")}
              />
            </SetRow>
            <SetRow
              label={t("显示农历与节气")}
              desc={t("格子里日期旁以小字显示农历；传统节日与节气以彩色文字替代农历显示（法定节假日的班/休角标不受影响）")}
            >
              <Switch
                checked={s.calendarShowLunar}
                onChange={(e) => s.update({ calendarShowLunar: e.currentTarget.checked })}
              />
            </SetRow>
            <SetRow
              label={t("格子着色维度")}
              desc={t("按状态 = 绿/蓝/灰表达 已完成/执行中/待办；按分类 = 竖条改用任务分类的颜色")}
            >
              <Seg<"status" | "category">
                value={s.calendarColorBy}
                options={[
                  { value: "status", label: t("按状态") },
                  { value: "category", label: t("按分类") },
                ]}
                onChange={(v) => s.update({ calendarColorBy: v })}
              />
            </SetRow>
            <div className="np-set-hint">
              {t(
                "工作记录按日保存在程序目录 config/worklog.json（不上传，自动保留最近 3 份 .bak 备份），随「配置 → 导出/导入配置」打包迁移；关闭 X-Dir 后热键失效。",
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
                // 可自定义的系统级热键（截图/剪贴板）：清单里的键位是默认值，
                // 实际以设置当前值为准（关闭时显示未启用）
                const keys =
                  it.id === "shot-open"
                    ? [s.shotEnabled ? s.shotHotkey : t("未启用")]
                    : it.id === "cliphist-open"
                      ? [s.cliphistEnabled ? s.cliphistHotkey : t("未启用")]
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
            <SetRow label={t("开机自启")} desc={t("登录 Windows 后自动启动 X-Dir（写入当前程序路径，移动程序后需重新开启一次）")}>
              <Switch
                checked={s.autostart}
                onChange={async (e) => {
                  const on = e.currentTarget.checked;
                  s.update({ autostart: on });
                  try {
                    await api.autostartSet(on);
                  } catch (err) {
                    // 注册表写入失败（权限/杀软拦截）：回滚开关并提示
                    s.update({ autostart: !on });
                    useUi
                      .getState()
                      .toast(t("开机自启设置失败：{e}", { e: String(err) }), "error");
                  }
                }}
              />
            </SetRow>
            <SetRow
              label={t("打开配置保存位置")}
              desc={t("settings.json、布局方案与工作日志所在的集中配置文件夹（在资源管理器中定位）")}
            >
              <Button minimal size="small" onClick={() => void onOpenConfigFolder()}>
                {t("打开…")}
              </Button>
            </SetRow>
            <SetRow label={t("导出配置文件")} desc={t("打包设置与全部布局方案为单个 JSON")}>
              <Button minimal size="small" onClick={() => void onExportConfig()}>
                {t("导出…")}
              </Button>
            </SetRow>
            <SetRow label={t("导入配置文件")} desc={t("从导出的 JSON 恢复（覆盖当前设置与同名布局方案）")}>
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

/** 剪贴板历史导出（T3-3）：原生保存框 → cliphist_export */
async function onCliphistExport() {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: t("导出剪贴板备份"),
    defaultPath: "xdir-clipboard-backup.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;
  try {
    const n = await api.cliphistExport(path);
    useUi.getState().toast(t("已导出 {n} 条剪贴板历史", { n }));
  } catch (e) {
    useUi.getState().toast(t("导出失败：{e}", { e: String(e) }), "error");
  }
}

/** 剪贴板历史导入（T3-3）：原生打开框 → cliphist_import（追加） */
async function onCliphistImport() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    title: t("导入剪贴板备份"),
    multiple: false,
    directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof path !== "string" || !path) return;
  try {
    const n = await api.cliphistImport(path);
    useUi.getState().toast(t("已导入 {n} 条（追加）", { n }));
  } catch (e) {
    useUi.getState().toast(t("导入失败：{e}", { e: String(e) }), "error");
  }
}

/** 在资源管理器中定位集中配置文件夹（2026-11-15）：Rust 侧 opener reveal settings.json */
async function onOpenConfigFolder() {
  try {
    await api.openConfigFolder();
    useUi.getState().toast(t("已在资源管理器中定位配置文件（settings.json）"));
  } catch (e) {
    useUi.getState().toast(t("打开失败：{e}", { e: String(e) }), "error");
  }
}

/** 导出配置：原生保存对话框选路径 → Rust 打包 settings.json + 全部工作区 */
async function onExportConfig() {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: t("导出 X-Dir 配置"),
    defaultPath: "X-Dir-config.json",
    filters: [{ name: "X-Dir 配置", extensions: ["json"] }],
  });
  if (!path) return;
  try {
    const r = await api.exportConfig(path);
    useUi
      .getState()
      .toast(t("配置已导出：{path}（含 {n} 个布局方案）", { path, n: r.workspaces }));
  } catch (e) {
    useUi.getState().toast(t("导出失败：{e}", { e: String(e) }), "error");
  }
}

/** 导入配置：选择导出 JSON → 确认覆盖 → 后端整体替换 settings.json + workspaces → 前端热重载 */
async function onImportConfig() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    title: t("导入 X-Dir 配置"),
    multiple: false,
    directory: false,
    filters: [{ name: "X-Dir 配置", extensions: ["json"] }],
  });
  if (typeof path !== "string" || !path) return;
  const ok = await confirmDialog({
    title: t("导入配置"),
    message: t("导入将覆盖当前全部设置与同名布局方案（不可撤销），确定继续吗？"),
    kind: "warn",
    okText: t("导入"),
  });
  if (!ok) return;
  try {
    const r = await api.importConfig(path);
    // 热重载：设置重读（主题/缩放/右键菜单即时生效），布局方案列表经事件刷新
    await useSettings.getState().load();
    window.dispatchEvent(new Event("xdir-workspaces-changed"));
    // 开机自启重放（2026-11-15）：导入可能换档——注册表按新事实源拉齐
    void api
      .autostartSet(useSettings.getState().autostart)
      .catch(() => undefined);
    useUi
      .getState()
      .toast(t("配置已导入（含 {n} 个布局方案）", { n: r.workspaces }));
  } catch (e) {
    useUi.getState().toast(t("导入失败：{e}", { e: String(e) }), "error");
  }
}
