// 图片处理五件套对话框（2026-10-15）：压缩 / 水印 / 格式转换 / 尺寸调整 /
// 宫格拼图。表单行复用 np-bren-form/field/k 基类，分段选择走 np-seg（§4.7）；
// 编排（api + 任务登记）在 lib/operations.ts，处理后端在 src/img/mod.rs。
import { useState } from "react";
import { t } from "../lib/i18n";
import { Button, ButtonGroup, DialogBody, DialogFooter, InputGroup, Switch } from "@blueprintjs/core";

import { MONTAGE_MAX, montageGrid } from "../lib/imgOps";
import { NpSelect } from "./NpSelect";

/** np-seg 分段快选（同 SettingsPanel 用法：active = accent 填充）。
 *  2026-10-17 起导出共用（工具箱新对话框同款，避免跨文件复制） */
// 泛型不带 extends 约束：TS6 下联合约束会让推断回退到约束本身，
// setState 直传时整体变宽（实测，见体检记录）；无约束则 value 站稳定全流程
export function Seg<T>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange(v: T): void;
}) {
  return (
    <ButtonGroup className="np-seg" size="small" variant="minimal">
      {options.map((o) => (
        <Button key={String(o.value)} active={value === o.value} data-tip={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </Button>
      ))}
    </ButtonGroup>
  );
}

function FormRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="np-bren-field">
      <span className="np-bren-k">{k}</span>
      {children}
    </span>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="np-dialog-muted">{children}</div>;
}

/** 对话框页脚：取消 + 主操作（intent 二映射 = primary 实心） */
function Footer({
  okText,
  onOk,
  onCancel,
}: {
  okText: string;
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
          <Button size="small" intent="primary" onClick={onOk}>
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

// ────────────────────────── 图片压缩 ──────────────────────────

export function CompressDialog({
  count,
  onDone,
}: {
  count: number;
  onDone(v: { target: 0 | 1 | 2 | 3; quality: number } | null): void;
}) {
  const [target, setTarget] = useState<number>(0);
  const [quality, setQuality] = useState(75);
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <FormRow k="策略">
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
          <FormRow k="质量">
            <Seg value={quality} onChange={setQuality} options={QUALITY_SEGS} />
          </FormRow>
        </div>
        <Hint>
          为 {count} 张图片压缩，旁写 *_压缩.jpg / *_压缩.png，不覆盖原文件；EXIF
          方向已烘焙进像素。
        </Hint>
      </DialogBody>
      <Footer okText="压缩" onOk={() => onDone({ target: target as 0 | 1 | 2 | 3, quality })} onCancel={() => onDone(null)} />
    </>
  );
}

// ────────────────────────── 图片水印 ──────────────────────────

export function WatermarkDialog({
  count,
  onDone,
}: {
  count: number;
  onDone(v: {
    imagePath: string;
    text: string;
    tile: boolean;
    opacity: number;
    scaleDiv: number;
  } | null): void;
}) {
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

  const err =
    mode === "text" && !text.trim()
      ? "请输入水印文字"
      : mode === "image" && !imagePath
        ? "请选择水印贴图"
        : null;

  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <FormRow k="类型">
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { value: "text", label: "文字" },
                { value: "image", label: "贴图" },
              ]}
            />
          </FormRow>
          {mode === "text" ? (
            <FormRow k="文字">
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
            <FormRow k="贴图">
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
        </div>
        <div className="np-bren-form">
          <FormRow k="布局">
            <Seg
              value={tile ? "tile" : "corner"}
              onChange={(v) => setTile(v === "tile")}
              options={[
                { value: "tile", label: "平铺", title: "全图 45° 平铺（贴图为阵列平铺）" },
                { value: "corner", label: "右下角标" },
              ]}
            />
          </FormRow>
          <FormRow k="不透明度">
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
          <FormRow k="大小">
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
        <Hint>
          为 {count} 张图片加水印，旁写 *_水印.扩展名（保持原格式），不覆盖原文件。
        </Hint>
      </DialogBody>
      <Footer
        okText="加水印"
        onCancel={() => onDone(null)}
        onOk={() => {
          if (err) {
            void import("../stores/ui").then(({ alertDialog }) =>
              alertDialog({ title: "图片水印", message: err, kind: "warn" }),
            );
            return;
          }
          onDone({
            imagePath: mode === "image" ? imagePath : "",
            text: mode === "text" ? text.trim() : "",
            tile,
            opacity,
            scaleDiv,
          });
        }}
      />
    </>
  );
}

// ────────────────────────── 图片格式转换 ──────────────────────────

export function ConvertDialog({
  count,
  onDone,
}: {
  count: number;
  onDone(v: { target: 0 | 1 | 2 | 3 | 4 | 5; quality: number; bakeExif: boolean } | null): void;
}) {
  const [target, setTarget] = useState<number>(0);
  const [quality, setQuality] = useState(85);
  const [bakeExif, setBakeExif] = useState(true);
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <FormRow k="目标格式">
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
          <FormRow k="质量">
            <Seg value={quality} onChange={setQuality} options={QUALITY_SEGS} />
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
          为 {count} 张图片转换格式，旁写 *_转换.扩展名，不覆盖原文件。
        </Hint>
      </DialogBody>
      <Footer okText="转换" onOk={() => onDone({ target: target as 0 | 1 | 2 | 3 | 4 | 5, quality, bakeExif })} onCancel={() => onDone(null)} />
    </>
  );
}

// ────────────────────────── 图片尺寸调整 ──────────────────────────

export function ResizeDialog({
  count,
  onDone,
}: {
  count: number;
  onDone(v: {
    mode: 0 | 1 | 2;
    value: number;
    lanczos: boolean;
    onlyDown: boolean;
  } | null): void;
}) {
  const [mode, setMode] = useState<number>(0);
  const [value, setValue] = useState("50");
  const [lanczos, setLanczos] = useState(true);
  const [onlyDown, setOnlyDown] = useState(true);
  const n = Number.parseInt(value, 10);
  const err = !Number.isFinite(n)
    ? "请输入数值"
    : mode === 0 && !(n >= 1 && n <= 800)
      ? "百分比需在 1–800 之间"
      : mode !== 0 && !(n >= 1 && n <= 20000)
        ? "目标尺寸需在 1–20000px 之间"
        : null;
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <FormRow k="模式">
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
          <FormRow k={mode === 0 ? "百分比 %" : "像素"}>
            <InputGroup
              size="small"
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
            />
          </FormRow>
        </div>
        <div className="np-bren-form">
          <FormRow k="插值">
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
          <Switch checked={onlyDown} label={t("仅缩小（不放大会糊）")} onChange={(e) => setOnlyDown(e.currentTarget.checked)} />
        </div>
        <Hint>
          为 {count} 张图片调整尺寸，宽高比恒定，旁写 *_缩放.扩展名（保持原格式）。
        </Hint>
      </DialogBody>
      <Footer
        okText="调整"
        onCancel={() => onDone(null)}
        onOk={() => {
          if (err || !Number.isFinite(n)) {
            void import("../stores/ui").then(({ alertDialog }) =>
              alertDialog({ title: "尺寸调整", message: err ?? "请输入数值", kind: "warn" }),
            );
            return;
          }
          onDone({ mode: mode as 0 | 1 | 2, value: n, lanczos, onlyDown });
        }}
      />
    </>
  );
}

// ────────────────────────── 宫格拼图 ──────────────────────────

export function MontageDialog({
  count,
  onDone,
}: {
  count: number;
  onDone(v: {
    cols: number;
    cell: number;
    gap: number;
    cover: boolean;
    bg: 0 | 1 | 2;
    png: boolean;
  } | null): void;
}) {
  const [cols, setCols] = useState(3);
  const [cell, setCell] = useState(512);
  const [gap, setGap] = useState(8);
  const [cover, setCover] = useState(true);
  const [bg, setBg] = useState<number>(0);
  const [png, setPng] = useState(true);
  const grid = montageGrid(Math.min(count, MONTAGE_MAX), cols);
  const outW = cols * cell + (cols - 1) * gap;
  const outH = grid.rows * cell + (grid.rows - 1) * gap;
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <FormRow k="列数">
            <Seg value={cols} onChange={setCols} options={[2, 3, 4].map((c) => ({ value: c, label: `${c} 列` }))} />
          </FormRow>
          <FormRow k="格子">
            <Seg
              value={cell}
              onChange={setCell}
              options={[512, 768, 1024].map((c) => ({ value: c, label: `${c}px` }))}
            />
          </FormRow>
          <FormRow k="间距">
            <Seg value={gap} onChange={setGap} options={[0, 8, 16].map((g) => ({ value: g, label: `${g}px` }))} />
          </FormRow>
        </div>
        <div className="np-bren-form">
          <FormRow k="填充">
            <Seg
              value={cover ? "cover" : "contain"}
              onChange={(v) => setCover(v === "cover")}
              options={[
                { value: "cover", label: "裁切填满", title: "居中裁切成正方形格" },
                { value: "contain", label: "完整留白", title: "完整放入格子，短边留白" },
              ]}
            />
          </FormRow>
          <FormRow k="底色">
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
          <FormRow k="输出">
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
          按当前顺序拼合 {Math.min(count, MONTAGE_MAX)} 张（{grid.rows} 行 × {cols} 列，
          画布 {outW}×{outH}px）→ 输出到首图所在目录，重名自动 (2)。
          {count > MONTAGE_MAX ? `（超出 ${MONTAGE_MAX} 张的部分不会拼入）` : ""}
        </Hint>
      </DialogBody>
      <Footer okText="拼图" onOk={() => onDone({ cols, cell, gap, cover, bg: bg as 0 | 1 | 2, png })} onCancel={() => onDone(null)} />
    </>
  );
}
