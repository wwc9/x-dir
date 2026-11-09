// 图片处理五件套对话框（2026-10-15；2026-11-03 §4.9 完善批对齐水印对话框）：
// 压缩 / 水印 / 格式转换 / 尺寸调整 / 宫格拼图。三段式统一：
// ① 待处理清单置顶（FileQueue 拖动定序，处理顺序随清单）；
// ② 参数区（np-bren-form / np-pdfmform.np-two-col，不适用参数行禁用降灰）；
// ③ 说明收尾（旁写规则 + 输出预览）+ Footer（校验不过即禁用主操作，内联提示）。
// 表单行复用 np-bren-form/field/k 基类，分段选择走 np-seg（§4.7）；
// 编排（api + 任务登记）在 lib/operations.ts，处理后端在 src/img/mod.rs。
// 2026-11-09 P2 批：全部对话框参数随 settings.dialogPrefs 记忆（确认时写回，
// 路径/密码类不入存）——压缩/转换质量加「自定义」档（滑杆 1–100）；压缩智能
// 策略遇纯 PNG 清单禁用质量行（PNG8 路径不读质量）；水印补颜色 8 色板 +
// 九宫格角标位置（与 PDF 水印同源口径，Rust img::stamp_at_pos）+ 不透明度
// 统一 0–10 滑杆（payload 仍为百分比 10–100）；宫格拼图透明底禁选 JPEG；
// 裸中文文案补 t()（英文界面覆盖）。
import { useState } from "react";
import { t, useT } from "../lib/i18n";
import type { FileEntry } from "../lib/ipc";
import {
  Button,
  ButtonGroup,
  DialogBody,
  DialogFooter,
  InputGroup,
  Slider,
  Switch,
} from "@blueprintjs/core";

import { MONTAGE_MAX, montageGrid, montageOutputName } from "../lib/imgOps";
import { loadDialogPrefs, saveDialogPrefs } from "../lib/dialogPrefs";
import { NpSelect } from "./NpSelect";
import { PosGrid } from "./WmPosGrid";
import { QueueSection, nameOf, pathsByNames } from "./FileQueue";
import { joinPath, parentPath } from "../lib/path";

/** np-seg 分段快选（同 SettingsPanel 用法：激活态 = 描边勾选 chip，2026-10-24
 *  定案方案 A——sel 淡染底 + accent 描边 + ✓ 前缀，替代轨道 + accent 实心填充）。
 *  2026-10-17 起导出共用（工具箱新对话框同款，避免跨文件复制）；
 *  2026-11-03 增 disabled（整组禁用，用于不适用参数行）；
 *  2026-11-09 增逐项 disabled（组内个别选项不适用，如透明底下的 JPEG） */
// 泛型不带 extends 约束：TS6 下联合约束会让推断回退到约束本身，
// setState 直传时整体变宽（实测，见体检记录）；无约束则 value 站稳定全流程
export function Seg<T>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; title?: string; disabled?: boolean }[];
  onChange(v: T): void;
  /** 整组禁用（关联参数不适用时，如 PNG8/无损目标下的质量档） */
  disabled?: boolean;
}) {
  return (
    <ButtonGroup className="np-seg" size="small" variant="minimal">
      {options.map((o) => (
        <Button
          key={String(o.value)}
          active={value === o.value}
          disabled={disabled || o.disabled}
          data-tip={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </ButtonGroup>
  );
}

function FormRow({
  k,
  wide,
  children,
}: {
  k: string;
  /** 宽行：在 2 列参数网格中独占整行（长控件/多选项行使用） */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={"np-bren-field" + (wide ? " np-wide" : "")}>
      <span className="np-bren-k">{k}</span>
      {children}
    </span>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="np-dialog-muted">{children}</div>;
}

/** 对话框页脚：取消 + 主操作（intent 二映射 = primary 实心）；
 *  disabled = 内联校验未过（§4.9：不再点开后弹 alert 补校验） */
function Footer({
  okText,
  disabled,
  onOk,
  onCancel,
}: {
  okText: string;
  disabled?: boolean;
  onOk(): void;
  onCancel(): void;
}) {
  return (
    <DialogFooter
      actions={
        <>
          <Button size="small" onClick={onCancel}>
            {t("取消")}
          </Button>
          <Button size="small" intent="primary" disabled={disabled} onClick={onOk}>
            {okText}
          </Button>
        </>
      }
    />
  );
}

/** JPEG 质量三档（压缩/转换共用口径）+「自定义」档（2026-11-09 P2：滑杆
 *  1–100；三档命中记忆值时直接选中，否则落自定义） */
const QUALITY_SEGS = [
  { value: 85, label: "高质量" },
  { value: 75, label: "均衡" },
  { value: 60, label: "紧凑" },
];
const QUALITY_PRESETS = QUALITY_SEGS.map((q) => q.value);

/** 质量档状态钩子：记忆值命中三档 → 该档；否则 → 自定义档（滑杆初值 = 记忆值） */
function useQualitySeg(saved: number) {
  const [seg, setSeg] = useState<number>(() =>
    QUALITY_PRESETS.includes(saved) ? saved : -1,
  );
  const [custom, setCustom] = useState(() =>
    QUALITY_PRESETS.includes(saved) ? 75 : saved,
  );
  const quality = seg === -1 ? custom : seg;
  return { seg, setSeg, custom, setCustom, quality };
}

/** 质量档行：三档 Seg + 自定义档展开滑杆（qualityOff = 整行禁用降灰） */
function QualityRows({
  t2,
  seg,
  setSeg,
  custom,
  setCustom,
  qualityOff,
}: {
  t2: (s: string, params?: Record<string, string | number>) => string;
  seg: number;
  setSeg(v: number): void;
  custom: number;
  setCustom(v: number): void;
  qualityOff: boolean;
}) {
  return (
    <>
      <FormRow k={t2("质量")}>
        <Seg
          value={seg}
          onChange={setSeg}
          disabled={qualityOff}
          options={[
            ...QUALITY_SEGS.map((q) => ({ value: q.value, label: t2(q.label) })),
            { value: -1, label: t2("自定义") },
          ]}
        />
      </FormRow>
      {seg === -1 && !qualityOff && (
        <FormRow k={t2("质量值（1–100）")}>
          <Slider
            min={1}
            max={100}
            stepSize={1}
            labelValues={[1, 50, 100]}
            value={custom}
            onChange={(v) => setCustom(Array.isArray(v) ? v[0] : v)}
          />
        </FormRow>
      )}
    </>
  );
}

/** 旁写输出预览路径：<stem><后缀>.<扩展名>（ext 缺省 = 保持原扩展名），
 *  取清单首项所在目录（与 Rust 端逐文件旁写同源，首项即示例） */
function outPreview(items: string[], suffix: string, ext?: string): string {
  const first = items[0];
  if (!first) return "";
  const name = nameOf(first);
  const stem = name.replace(/\.[^.]+$/, "");
  const keep = name.slice(stem.length);
  return joinPath(parentPath(first) ?? "", `${stem}${suffix}${ext ? "." + ext : keep}`);
}

// ────────────────────────── 图片压缩 ──────────────────────────

export function CompressDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: { paths: string[]; target: 0 | 1 | 2 | 3; quality: number } | null): void;
}) {
  const t2 = useT();
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const init = loadDialogPrefs("imgCompress", { target: 0, quality: 75 });
  const [target, setTarget] = useState<number>(() =>
    init.target >= 0 && init.target <= 3 ? init.target : 0,
  );
  const q = useQualitySeg(init.quality);
  // 质量只作用于 JPEG 编码路径（Rust 端 PNG8/无损优化不读该值）→ 行禁用降灰；
  // 智能策略下纯 PNG 清单走 PNG8（同样不读质量）→ 一并禁用（2026-11-09 P2）
  const allPng = items.length > 0 && items.every((p) => /\.png$/i.test(p));
  const qualityOff = target === 2 || target === 3 || (target === 0 && allPng);
  // 输出扩展名与 Rust compress 同口径：Auto = PNG→png、其余→jpg
  const ext =
    target === 1 ? "jpg" : target >= 2 ? "png" : /\.png$/i.test(items[0] ?? "") ? "png" : "jpg";
  return (
    <>
      <DialogBody>
        <QueueSection title={t2("处理顺序")} items={items} onChange={setItems} />
        <div className="np-bren-form">
          <FormRow k={t2("策略")}>
            <Seg
              value={target}
              onChange={setTarget}
              options={[
                { value: 0, label: t2("智能"), title: t2("JPEG 转 JPEG、PNG 转 PNG8、其余转 JPEG") },
                { value: 1, label: "JPEG", title: t2("统一转 JPEG（按质量重编码）") },
                { value: 2, label: "PNG8", title: t2("调色板量化 ≤256 色（截图/图标最佳）") },
                { value: 3, label: t2("无损优化"), title: t2("PNG 无损重压缩，画质零损失") },
              ]}
            />
          </FormRow>
          <QualityRows
            t2={t2}
            seg={q.seg}
            setSeg={q.setSeg}
            custom={q.custom}
            setCustom={q.setCustom}
            qualityOff={qualityOff}
          />
        </div>
        <Hint>
          {t2(
            "为 {n} 张图片压缩，旁写 *_压缩.jpg / *_压缩.png，不覆盖原文件；EXIF 方向已烘焙进像素。",
            { n: items.length },
          )}
          {t2("输出预览：{out}", { out: outPreview(items, "_压缩", ext) })}
        </Hint>
      </DialogBody>
      <Footer
        okText={t2("压缩")}
        disabled={!items.length}
        onOk={() => {
          saveDialogPrefs("imgCompress", { target, quality: q.quality });
          onDone({ paths: items, target: target as 0 | 1 | 2 | 3, quality: q.quality });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ────────────────────────── 图片水印 ──────────────────────────

/** 与 PDF 水印同源 8 色板（色码由 Rust parse_color 解析，黑/灰/红/白/绿/黄/蓝/紫） */
const WM_COLORS = [
  { value: "black", label: "黑" },
  { value: "gray", label: "灰" },
  { value: "red", label: "红" },
  { value: "white", label: "白" },
  { value: "green", label: "绿" },
  { value: "yellow", label: "黄" },
  { value: "blue", label: "蓝" },
  { value: "purple", label: "紫" },
];

export function WatermarkDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: {
    paths: string[];
    imagePath: string;
    text: string;
    tile: boolean;
    opacity: number;
    scaleDiv: number;
    color: string;
    pos: string;
  } | null): void;
}) {
  const t2 = useT();
  const init = loadDialogPrefs("imgWatermark", {
    mode: "text",
    text: "",
    tile: true,
    opacity10: 5,
    scaleDiv: 10,
    color: "red",
    pos: "right-bottom",
  });
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const [mode, setMode] = useState<string>(init.mode === "image" ? "image" : "text");
  const [text, setText] = useState(init.text);
  const [imagePath, setImagePath] = useState("");
  const [tile, setTile] = useState(init.tile);
  // 不透明度 0–10 滑杆（2026-11-09 P2 与 PDF 水印统一口径）；payload 仍为
  // 百分比 10–100（Rust clamp 下限 10，滑杆 0 = 10% 近全透）
  const [opacity10, setOpacity10] = useState<number>(() =>
    Math.min(10, Math.max(0, init.opacity10)),
  );
  const [scaleDiv, setScaleDiv] = useState(() => init.scaleDiv);
  const [color, setColor] = useState(() =>
    WM_COLORS.some((c) => c.value === init.color) ? init.color : "red",
  );
  const [pos, setPos] = useState(() =>
    /^((left|mid|right)-(top|mid|bottom))$|^center$/.test(init.pos) ? init.pos : "right-bottom",
  );

  const pickImage = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      title: "选择水印贴图（建议透明底 PNG）",
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    });
    if (typeof path === "string" && path) setImagePath(path);
  };

  // 内联校验（§4.9）：主操作禁用 + 红字指引，不再点开后弹 alert
  const missing =
    mode === "text" && !text.trim()
      ? t2("请输入水印文字")
      : mode === "image" && !imagePath
        ? t2("请选择水印贴图")
        : null;

  return (
    <>
      <DialogBody>
        <QueueSection title={t2("处理顺序")} items={items} onChange={setItems} />
        <div className="np-pdfmform np-two-col">
          <FormRow k={t2("类型")}>
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { value: "text", label: t2("文字") },
                { value: "image", label: t2("贴图") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("布局")}>
            <Seg
              value={tile ? "tile" : "corner"}
              onChange={(v) => setTile(v === "tile")}
              options={[
                { value: "tile", label: t2("平铺"), title: t2("全图 45° 平铺（贴图为阵列平铺）") },
                { value: "corner", label: t2("角标"), title: t2("按下方九宫格位置贴角标") },
              ]}
            />
          </FormRow>
          {mode === "text" ? (
            <FormRow k={t2("文字")} wide>
              <InputGroup
                size="small"
                value={text}
                maxLength={40}
                placeholder={t("最多 40 字")}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
              />
            </FormRow>
          ) : (
            <FormRow k={t2("贴图")} wide>
              <InputGroup
                size="small"
                value={imagePath}
                readOnly
                placeholder={t("未选择")}
                spellCheck={false}
              />
              <Button size="small" onClick={() => void pickImage()}>
                {t("选择…")}
              </Button>
            </FormRow>
          )}
          {mode === "text" && (
            <FormRow k={t2("颜色")}>
              <Seg value={color} onChange={setColor} options={WM_COLORS.map((c) => ({ value: c.value, label: t2(c.label) }))} />
            </FormRow>
          )}
          <FormRow k={tile ? t2("位置（平铺不适用）") : t2("位置")}>
            <PosGrid value={pos} onChange={setPos} disabled={tile} />
          </FormRow>
          <FormRow k={t2("不透明度（0–10）")}>
            <Slider
              min={0}
              max={10}
              stepSize={1}
              labelValues={[0, 5, 10]}
              value={opacity10}
              onChange={(v) => setOpacity10(Array.isArray(v) ? v[0] : v)}
            />
          </FormRow>
          <FormRow k={t2("大小")}>
            <Seg
              value={scaleDiv}
              onChange={setScaleDiv}
              options={[
                { value: 6, label: t2("大"), title: t2("短边的 1/6") },
                { value: 10, label: t2("中"), title: t2("短边的 1/10") },
                { value: 16, label: t2("小"), title: t2("短边的 1/16") },
              ]}
            />
          </FormRow>
        </div>
        {missing && <div className="np-dialog-error">{missing}</div>}
        <Hint>
          {t2("为 {n} 张图片加水印，旁写 *_水印.扩展名（保持原格式），同名自动 (2) 递增，不覆盖原文件。", {
            n: items.length,
          })}
          {t2("输出预览：{out}", { out: outPreview(items, "_水印") })}
        </Hint>
      </DialogBody>
      <Footer
        okText={t2("加水印")}
        disabled={!!missing || !items.length}
        onOk={() => {
          const opacity = Math.max(10, opacity10 * 10);
          saveDialogPrefs("imgWatermark", { mode, text, tile, opacity10, scaleDiv, color, pos });
          onDone({
            paths: items,
            imagePath: mode === "image" ? imagePath : "",
            text: mode === "text" ? text.trim() : "",
            tile,
            opacity,
            scaleDiv,
            color,
            pos,
          });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ────────────────────────── 图片格式转换 ──────────────────────────

export function ConvertDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: {
    paths: string[];
    target: 0 | 1 | 2 | 3 | 4 | 5;
    quality: number;
    bakeExif: boolean;
  } | null): void;
}) {
  const t2 = useT();
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const init = loadDialogPrefs("imgConvert", { target: 0, quality: 85, bakeExif: true });
  const [target, setTarget] = useState<number>(() =>
    init.target >= 0 && init.target <= 5 ? init.target : 0,
  );
  const q = useQualitySeg(init.quality);
  const [bakeExif, setBakeExif] = useState(init.bakeExif);
  // 质量只有 JPEG 编码路径读取（PNG/BMP/TIFF/ICO/WebP 均无损，Rust 端不读该值）
  const qualityOff = target !== 1;
  const ext = ["png", "jpg", "bmp", "tiff", "ico", "webp"][target];
  return (
    <>
      <DialogBody>
        <QueueSection title={t2("处理顺序")} items={items} onChange={setItems} />
        <div className="np-bren-form">
          <FormRow k={t2("目标格式")}>
            <NpSelect
              value={target}
              onChange={(v) => setTarget(v)}
              options={[
                { value: 0, label: "PNG" },
                { value: 1, label: "JPEG" },
                { value: 2, label: "BMP" },
                { value: 3, label: "TIFF" },
                { value: 4, label: t2("ICO（≤256px）") },
                { value: 5, label: t2("WebP（无损）") },
              ]}
            />
          </FormRow>
          <QualityRows
            t2={t2}
            seg={q.seg}
            setSeg={q.setSeg}
            custom={q.custom}
            setCustom={q.setCustom}
            qualityOff={qualityOff}
          />
        </div>
        <div className="np-bren-form">
          {/* Switch v6 无 small 档，默认即紧凑（AGENTS §4.4） */}
          <Switch
            checked={bakeExif}
            label={t("烘焙 EXIF 方向（手机照片转正，顺带抹除位置等元数据）")}
            onChange={(e) => setBakeExif(e.currentTarget.checked)}
          />
        </div>
        <Hint>
          {t2("为 {n} 张图片转换格式，旁写 *_转换.{ext}，不覆盖原文件。", {
            n: items.length,
            ext,
          })}
          {t2("输出预览：{out}", { out: outPreview(items, "_转换", ext) })}
        </Hint>
      </DialogBody>
      <Footer
        okText={t2("转换")}
        disabled={!items.length}
        onOk={() => {
          saveDialogPrefs("imgConvert", { target, quality: q.quality, bakeExif });
          onDone({ paths: items, target: target as 0 | 1 | 2 | 3 | 4 | 5, quality: q.quality, bakeExif });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ────────────────────────── 图片尺寸调整 ──────────────────────────

export function ResizeDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: {
    paths: string[];
    mode: 0 | 1 | 2;
    value: number;
    lanczos: boolean;
    onlyDown: boolean;
  } | null): void;
}) {
  const t2 = useT();
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const init = loadDialogPrefs("imgResize", {
    mode: 0,
    value: "50",
    lanczos: true,
    onlyDown: true,
  });
  const [mode, setMode] = useState<number>(() =>
    init.mode >= 0 && init.mode <= 2 ? init.mode : 0,
  );
  const [value, setValue] = useState(init.value);
  const [lanczos, setLanczos] = useState(init.lanczos);
  const [onlyDown, setOnlyDown] = useState(init.onlyDown);
  const n = Number.parseInt(value, 10);
  // 内联校验（§4.9）：红字随输入即时反馈，主操作禁用，不再弹 alert
  const err =
    !value || !Number.isFinite(n)
      ? t2("请输入数值")
      : mode === 0 && !(n >= 1 && n <= 800)
        ? t2("百分比需在 1–800 之间")
        : mode !== 0 && !(n >= 1 && n <= 20000)
          ? t2("目标尺寸需在 1–20000px 之间")
          : null;
  return (
    <>
      <DialogBody>
        <QueueSection title={t2("处理顺序")} items={items} onChange={setItems} />
        <div className="np-pdfmform np-two-col">
          <FormRow k={t2("模式")}>
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { value: 0, label: t2("按百分比") },
                { value: 1, label: t2("指定宽度") },
                { value: 2, label: t2("指定高度") },
              ]}
            />
          </FormRow>
          <FormRow k={mode === 0 ? t2("百分比 %") : t2("像素")}>
            <InputGroup
              size="small"
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
            />
          </FormRow>
          <FormRow k={t2("插值")}>
            <Seg
              value={lanczos ? "hq" : "fast"}
              onChange={(v) => setLanczos(v === "hq")}
              options={[
                { value: "hq", label: t2("高质量"), title: t2("Lanczos3，照片推荐") },
                { value: "fast", label: t2("快速"), title: t2("Triangle，批量缩略图") },
              ]}
            />
          </FormRow>
          {/* Switch v6 无 small 档，默认即紧凑（AGENTS §4.4） */}
          <span className="np-bren-field">
            <Switch
              checked={onlyDown}
              label={t("仅缩小（不放大会糊）")}
              onChange={(e) => setOnlyDown(e.currentTarget.checked)}
            />
          </span>
        </div>
        {err && <div className="np-dialog-error">{err}</div>}
        <Hint>
          {t2("为 {n} 张图片调整尺寸，宽高比恒定，旁写 *_缩放.扩展名（保持原格式）。", {
            n: items.length,
          })}
          {t2("输出预览：{out}", { out: outPreview(items, "_缩放") })}
        </Hint>
      </DialogBody>
      <Footer
        okText={t2("调整")}
        disabled={!!err || !items.length}
        onOk={() => {
          saveDialogPrefs("imgResize", { mode, value, lanczos, onlyDown });
          onDone({ paths: items, mode: mode as 0 | 1 | 2, value: n, lanczos, onlyDown });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ────────────────────────── 宫格拼图 ──────────────────────────

export function MontageDialog({
  entries,
  onDone,
}: {
  entries: FileEntry[];
  onDone(v: {
    paths: string[];
    cols: number;
    cell: number;
    gap: number;
    cover: boolean;
    bg: 0 | 1 | 2;
    png: boolean;
  } | null): void;
}) {
  const t2 = useT();
  // 拼合顺序 = 清单顺序（拖动调整）；超上限部分不拼入（提示说明）
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const used = items.slice(0, MONTAGE_MAX);
  const init = loadDialogPrefs("imgMontage", {
    cols: 3,
    cell: 512,
    gap: 8,
    cover: true,
    bg: 0,
    png: true,
  });
  const [cols, setCols] = useState(() => (init.cols >= 2 && init.cols <= 4 ? init.cols : 3));
  const [cell, setCell] = useState(() =>
    [512, 768, 1024].includes(init.cell) ? init.cell : 512,
  );
  const [gap, setGap] = useState(() => ([0, 8, 16].includes(init.gap) ? init.gap : 8));
  const [cover, setCover] = useState(init.cover);
  const [bg, setBg] = useState<number>(() => (init.bg >= 0 && init.bg <= 2 ? init.bg : 0));
  const [png, setPng] = useState(init.png);
  const grid = montageGrid(used.length, cols);
  const outW = cols * cell + (cols - 1) * gap;
  const outH = grid.rows * cell + (grid.rows - 1) * gap;
  // 输出名按执行时刻生成，预览以当前时刻示例
  const preview = joinPath(
    parentPath(used[0] ?? items[0] ?? "") ?? "",
    montageOutputName(new Date()),
  );
  return (
    <>
      <DialogBody>
        <QueueSection title={t2("拼合顺序")} items={items} onChange={setItems} />
        <div className="np-pdfmform np-two-col">
          <FormRow k={t2("列数")}>
            <Seg value={cols} onChange={setCols} options={[2, 3, 4].map((c) => ({ value: c, label: t2("{c} 列", { c }) }))} />
          </FormRow>
          <FormRow k={t2("格子")}>
            <Seg
              value={cell}
              onChange={setCell}
              options={[512, 768, 1024].map((c) => ({ value: c, label: `${c}px` }))}
            />
          </FormRow>
          <FormRow k={t2("间距")}>
            <Seg value={gap} onChange={setGap} options={[0, 8, 16].map((g) => ({ value: g, label: `${g}px` }))} />
          </FormRow>
          <FormRow k={t2("填充")}>
            <Seg
              value={cover ? "cover" : "contain"}
              onChange={(v) => setCover(v === "cover")}
              options={[
                { value: "cover", label: t2("裁切填满"), title: t2("居中裁切成正方形格") },
                { value: "contain", label: t2("完整留白"), title: t2("完整放入格子，短边留白") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("底色")}>
            <Seg
              value={bg}
              onChange={(v) => {
                setBg(v);
                if (v === 2) setPng(true);
              }}
              options={[
                { value: 0, label: t2("白") },
                { value: 1, label: t2("黑") },
                { value: 2, label: t2("透明"), title: t2("强制 PNG 输出") },
              ]}
            />
          </FormRow>
          <FormRow k={t2("输出")}>
            <Seg
              value={png ? "png" : "jpeg"}
              onChange={(v) => setPng(v === "png")}
              options={[
                { value: "png", label: "PNG" },
                // 透明底仅 PNG 支持：JPEG 项禁用降灰（2026-11-09 P1，不再静默回退）
                { value: "jpeg", label: t2("JPEG（质量 90）"), title: bg === 2 ? t2("透明底仅 PNG 支持") : undefined, disabled: bg === 2 },
              ]}
            />
          </FormRow>
        </div>
        <Hint>
          {t2("按清单顺序拼合 {n} 张（{rows} 行 × {cols} 列，画布 {w}×{h}px）→", {
            n: used.length,
            rows: grid.rows,
            cols,
            w: outW,
            h: outH,
          })}
          {t2("输出预览：{out}", { out: preview })}
          {items.length > MONTAGE_MAX ? t2("（超出 {max} 张的部分不会拼入）", { max: MONTAGE_MAX }) : ""}
        </Hint>
      </DialogBody>
      <Footer
        okText={t2("拼图")}
        disabled={!used.length}
        onOk={() => {
          saveDialogPrefs("imgMontage", { cols, cell, gap, cover, bg, png });
          onDone({ paths: used, cols, cell, gap, cover, bg: bg as 0 | 1 | 2, png });
        }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}
