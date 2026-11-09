// WizTree 式矩形树图（squarified treemap，Bruls et al. 2000）：面积 ∝ 体积，
// 行沿剩余空隙的短边排布、以「最差长宽比不劣化」为行扩充判据，保证色块接近
// 正方形可读。纯函数零依赖，配 vitest（面积守恒/比例界/边角输入锁定）。
// 类型着色映射复用 index.css 的 --np-icon-* 语义色板（CSS 端按 data-cat 取色）。

export interface TmItem {
  key: string;
  size: number;
}

export interface TmRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把一行（面积数组）按短边 side 竖排/横排时的最差长宽比（Bruls 式 worst 函数） */
function worstRatio(rowAreas: number[], side: number): number {
  const sum = rowAreas.reduce((s, a) => s + a, 0);
  if (sum <= 0) return Infinity;
  const max = Math.max(...rowAreas);
  const min = Math.min(...rowAreas);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max(s2 * (max / sum2), sum2 / (s2 * min));
}

/** 面积 ∝ size 的矩形树图；非正尺寸项（0 字节/非法值）不入图（调用方在列表
 *  侧承载），输入须非空容器否则返回空数组 */
export function treemap(items: TmItem[], width: number, height: number): TmRect[] {
  if (!(width > 0) || !(height > 0) || !items.length) return [];
  const sorted = items.filter((it) => it.size > 0).sort((a, b) => b.size - a.size);
  if (!sorted.length) return [];
  const scale = (width * height) / sorted.reduce((s, it) => s + it.size, 0);
  const areas = sorted.map((it) => it.size * scale);

  const out: TmRect[] = [];
  let rx = 0;
  let ry = 0;
  let rw = width;
  let rh = height;
  let row: number[] = [];
  let rowKeys: string[] = [];
  let i = 0;

  const layRow = () => {
    if (!row.length) return;
    const sum = row.reduce((s, a) => s + a, 0);
    if (rw >= rh) {
      // 剩余空隙横向更宽：行 = 左缘竖条（条宽 = 行面积和 / 空隙高），项在条内纵向堆叠
      const t = sum / rh;
      let cy = ry;
      for (let k = 0; k < row.length; k++) {
        const h = row[k] / t;
        out.push({ key: rowKeys[k], x: rx, y: cy, w: t, h });
        cy += h;
      }
      rx += t;
      rw -= t;
    } else {
      // 纵向更高：行 = 顶缘横条（条高 = 行面积和 / 空隙宽），项在条内横向堆叠
      const t = sum / rw;
      let cx = rx;
      for (let k = 0; k < row.length; k++) {
        const w = row[k] / t;
        out.push({ key: rowKeys[k], x: cx, y: ry, w, h: t });
        cx += w;
      }
      ry += t;
      rh -= t;
    }
    row = [];
    rowKeys = [];
  };

  while (i < sorted.length) {
    const side = Math.min(rw, rh);
    if (side <= 0) break; // 浮点耗尽：余项面积可忽略
    const candidate = [...row, areas[i]];
    if (!row.length || worstRatio(candidate, side) <= worstRatio(row, side)) {
      row = candidate;
      rowKeys.push(sorted[i].key);
      i += 1;
      continue;
    }
    layRow();
  }
  layRow();

  // 钳制浮点漂移：不越容器边界、宽高非负
  return out.map((r) => {
    const x = Math.max(0, Math.min(r.x, width));
    const y = Math.max(0, Math.min(r.y, height));
    return {
      key: r.key,
      x,
      y,
      w: Math.max(0, Math.min(r.w, width - x)),
      h: Math.max(0, Math.min(r.h, height - y)),
    };
  });
}

/** 类型着色分类（data-cat → CSS 取 --np-icon-* 语义色板）：文件夹金、视频红、
 *  图片蓝、音频紫、压缩包橙、PDF 红、表格绿、文档蓝、幻灯橙、代码青、字体粉、
 *  可执行紫、其余灰。取磁盘空间的大头类型优先列出 */
export function extColorCat(name: string, isDir: boolean): string {
  if (isDir) return "folder";
  const i = name.lastIndexOf(".");
  const ext = i >= 0 && i + 1 < name.length ? name.slice(i + 1).toLowerCase() : "";
  if (!ext) return "generic";
  const table: Record<string, string> = {
    video: "mp4 mkv avi mov wmv flv webm m4v rmvb rm mpg mpeg 3gp vob m2ts",
    image: "png jpg jpeg gif webp bmp tif tiff ico heic heif svg psd ai",
    audio: "mp3 wav flac aac ogg m4a wma opus ape",
    archive: "zip 7z rar tar gz bz2 xz tgz iso cab",
    pdf: "pdf",
    table: "xls xlsx xlsm xlsb ods csv tsv",
    doc: "doc docx docm rtf odt pages",
    slide: "ppt pptx pptm odp key",
    code: "js mjs cjs ts tsx jsx py rs c h cpp hpp cs java go rb php swift kt html htm css json xml yml yaml toml ini sh bat ps1 vbs lua sql",
    font: "ttf otf woff woff2 eot fon",
    exe: "exe msi dll sys appx msix bin",
    text: "txt md log eml",
  };
  for (const [cat, exts] of Object.entries(table)) {
    if (exts.split(" ").includes(ext)) return cat;
  }
  return "generic";
}
