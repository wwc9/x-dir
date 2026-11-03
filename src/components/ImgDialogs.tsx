// 图片处理五件套对话框（2026-10-15；2026-11-03 §4.9 完善批对齐水印对话框）：
// 压缩 / 水印 / 格式转换 / 尺寸调整 / 宫格拼图。三段式统一：
// ① 待处理清单置顶（FileQueue 拖动定序，处理顺序随清单）；
// ② 参数区（np-bren-form / np-pdfmform.np-two-col，不适用参数行禁用降灰）；
// ③ 说明收尾（旁写规则 + 输出预览）+ Footer（校验不过即禁用主操作，内联提示）。
// 表单行复用 np-bren-form/field/k 基类，分段选择走 np-seg（§4.7）；
// 编排（api + 任务登记）在 lib/operations.ts，处理后端在 src/img/mod.rs。
import { useState } from "react";
import { t, useT } from "../lib/i18n";
import type { FileEntry } from "../lib/ipc";
import { Button, ButtonGroup, DialogBody, DialogFooter, InputGroup, Switch } from "@blueprintjs/core";

import { MONTAGE_MAX, montageGrid, montageOutputName } from "../lib/imgOps";
import { NpSelect } from "./NpSelect";
import { QueueSection, nameOf, pathsByNames } from "./FileQueue";
import { joinPath, parentPath } from "../lib/path";

/** np-seg 分段快选（同 SettingsPanel 用法：激活态 = 描边勾选 chip，2026-10-24
 *  定案方案 A——sel 淡染底 + accent 描边 + ✓ 前缀，替代轨道 + accent 实心填充）。
 *  2026-10-17 起导出共用（工具箱新对话框同款，避免跨文件复制）；
 *  2026-11-03 增 disabled（整组禁用，用于不适用参数行） */
// 泛型不带 extends 约束：TS6 下联合约束会让推断回退到约束本身，
// setState 直传时整体变宽（实测，见体检记录）；无约束则 value 站稳定全流程
export function Seg<T>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
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
          disabled={disabled}
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

/** JPEG 质量三档（压缩/转换共用口径） */
const QUALITY_SEGS = [
  { value: 85, label: "高质量" },
  { value: 75, label: "均衡" },
  { value: 60, label: "紧凑" },
];

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
  const [target, setTarget] = useState<number>(0);
  const [quality, setQuality] = useState(75);
  // 质量只作用于 JPEG 编码路径（Rust 端 PNG8/无损优化不读该值）→ 行禁用降灰
  const qualityOff = target === 2 || target === 3;
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
                { value: 0, label: "智能", title: "JPEG 转 JPEG、PNG 转 PNG8、其余转 JPEG" },
                { value: 1, label: "JPEG", title: "统一转 JPEG（按质量重编码）" },
                { value: 2, label: "PNG8", title: "调色板量化 ≤256 色（截图/图标最佳）" },
                { value: 3, label: "无损优化", title: "PNG 无损重压缩，画质零损失" },
              ]}
            />
          </FormRow>
          <FormRow k={t2("质量")}>
            <Seg
              value={quality}
              onChange={setQuality}
              disabled={qualityOff}
              options={QUALITY_SEGS}
            />
          </FormRow>
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
        onOk={() => onDone({ paths: items, target: target as 0 | 1 | 2 | 3, quality })}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ────────────────────────── 图片水印 ──────────────────────────

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
  } | null): void;
}) {
  const t2 = useT();
  const [items, setItems] = useState<string[]>(() => pathsByNames(entries));
  const [mode, setMode] = useState<string>("text");
  const [text, setText] = useState("");
  const [imagePath, setImagePath] = useState("");
  const [tile, setTile] = useState(true);
  const [opacity, setOpacity] = useState(50);
  const [scaleDiv, setScaleDiv] = useState(10);

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

  // 内联校验（§4.9）：主操作禁用 + 灰字指引，不再点开后弹 alert
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
                { value: "text", label: "文字" },
                { value: "image", label: "贴图" },
              ]}
            />
          </FormRow>
          <FormRow k={t2("布局")}>
            <Seg
              value={tile ? "tile" : "corner"}
              onChange={(v) => setTile(v === "tile")}
              options={[
                { value: "tile", label: "平铺", title: "全图 45° 平铺（贴图为阵列平铺）" },
                { value: "corner", label: "右下角标" },
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
          <FormRow k={t2("不透明度")}>
            <Seg
              value={opacity}
              onChange={setOpacity}
              options={[
                { value: 25, label: "淡" },
                { value: 50, label: "中" },
                { value: 75, label: "浓" },
              ]}
            />
          </FormRow>
          <FormRow k={t2("大小")}>
            <Seg
              value={scaleDiv}
              onChange={setScaleDiv}
              options={[
                { value: 6, label: "大", title: "短边的 1/6" },
                { value: 10, label: "中", title: "短边的 1/10" },
                { value: 16, label: "小", title: "短边的 1/16" },
              ]}
            />
          </FormRow>
        </div>
        {missing && <div className="np-dialog-muted">{missing}</div>}
        <Hint>
          {t2("为 {n} 张图片加水印，旁写 *_水印.扩展名（保持原格式），不覆盖原文件。", {
            n: items.length,
          })}
          {t2("输出预览：{out}", { out: outPreview(items, "_水印") })}
        </Hint>
      </DialogBody>
      <Footer
        okText={t2("加水印")}
        disabled={!!missing || !items.length}
        onOk={() =>
          onDone({
            paths: items,
            imagePath: mode === "image" ? imagePath : "",
            text: mode === "text" ? text.trim() : "",
            tile,
            opacity,
            scaleDiv,
          })
        }
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
  const [target, setTarget] = useState<number>(0);
  const [quality, setQuality] = useState(85);
  const [bakeExif, setBakeExif] = useState(true);
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
                { value: 4, label: "ICO（≤256px）" },
                { value: 5, label: "WebP（无损）" },
              ]}
            />
          </FormRow>
          <FormRow k={t2("质量")}>
            <Seg
              value={quality}
              onChange={setQuality}
              disabled={qualityOff}
              options={QUALITY_SEGS}
            />
          </FormRow>
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
        onOk={() =>
          onDone({ paths: items, target: target as 0 | 1 | 2 | 3 | 4 | 5, quality, bakeExif })
        }
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
  const [mode, setMode] = useState<number>(0);
  const [value, setValue] = useState("50");
  const [lanczos, setLanczos] = useState(true);
  const [onlyDown, setOnlyDown] = useState(true);
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
                { value: 0, label: "按百分比" },
                { value: 1, label: "指定宽度" },
                { value: 2, label: "指定高度" },
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
                { value: "hq", label: "高质量", title: "Lanczos3，照片推荐" },
                { value: "fast", label: "快速", title: "Triangle，批量缩略图" },
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
        onOk={() => onDone({ paths: items, mode: mode as 0 | 1 | 2, value: n, lanczos, onlyDown })}
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
  const [cols, setCols] = useState(3);
  const [cell, setCell] = useState(512);
  const [gap, setGap] = useState(8);
  const [cover, setCover] = useState(true);
  const [bg, setBg] = useState<number>(0);
  const [png, setPng] = useState(true);
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
            <Seg value={cols} onChange={setCols} options={[2, 3, 4].map((c) => ({ value: c, label: `${c} 列` }))} />
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
                { value: "cover", label: "裁切填满", title: "居中裁切成正方形格" },
                { value: "contain", label: "完整留白", title: "完整放入格子，短边留白" },
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
                { value: 0, label: "白" },
                { value: 1, label: "黑" },
                { value: 2, label: "透明", title: "强制 PNG 输出" },
              ]}
            />
          </FormRow>
          <FormRow k={t2("输出")}>
            <Seg
              value={png ? "png" : "jpeg"}
              onChange={(v) => setPng(v === "png")}
              options={[
                { value: "png", label: "PNG" },
                { value: "jpeg", label: "JPEG（质量 90）", title: bg === 2 ? "透明底仅 PNG 支持" : undefined },
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
        onOk={() => onDone({ paths: used, cols, cell, gap, cover, bg: bg as 0 | 1 | 2, png })}
        onCancel={() => onDone(null)}
      />
    </>
  );
}
