// 搜索流式与展示纯函数：reqId 槽位分配、批次累积、结果排序、名称高亮、历史维护。
// 全部为纯函数（铁律：交互逻辑进 lib/ 并配单测），组件层只做状态持有。

import type { FileEntry, SearchBatchEvent } from "./ipc";

// ── reqId 分配（每次搜索唯一；发起新搜索前显式 cancel 旧 reqId）────

let reqCounter = 100; // 0 留给"无取消"调用
const paneSeq = new Map<string, number>();

/** 全盘搜索面板取号 */
export function nextGlobalSearchReq(): number {
  return ++reqCounter;
}

/** 窗格搜索取号（同窗格序号单调，配合显式取消实现"连打作废旧扫描"） */
export function nextPaneSearchReq(paneId: string): number {
  paneSeq.set(paneId, (paneSeq.get(paneId) ?? 0) + 1);
  return ++reqCounter;
}

// ── 流式累积 ───────────────────────────────────────────────────────

export interface StreamState {
  entries: FileEntry[];
  scanned: number;
  truncated: boolean;
}

export const EMPTY_STREAM: StreamState = { entries: [], scanned: 0, truncated: false };

/** 累积一批流式命中（reqId 不是当前活跃请求则丢弃）；终态响应到达后整体替换 */
export function applyBatch(state: StreamState, batch: SearchBatchEvent, activeReq: number | null): StreamState {
  if (activeReq === null || batch.reqId !== activeReq) return state;
  return {
    entries: state.entries.concat(batch.entries),
    scanned: batch.scanned,
    truncated: state.truncated,
  };
}

// ── 结果排序（客户端再排序；与 Rust 端一致的自然序语义）──────────

export type ResultSortKey = "name" | "path" | "mtime" | "size";

export type SortDir = "asc" | "desc";

/** 数字段按值比较的自然排序（对齐 StrCmpLogicalW 习惯） */
export function naturalCompare(a: string, b: string): number {
  const ra = /(\d+)|(\D+)/g;
  const rb = /(\d+)|(\D+)/g;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  let ma: RegExpExecArray | null;
  let mb: RegExpExecArray | null;
  let ia = 0;
  let ib = 0;
  while (ia < la.length && ib < lb.length && (ma = ra.exec(la)) && (mb = rb.exec(lb))) {
    ia = ma.index + ma[0].length;
    ib = mb.index + mb[0].length;
    if (ma[1] !== undefined && mb[1] !== undefined) {
      const diff = Number(ma[1]) - Number(mb[1]);
      if (diff !== 0) return diff;
    } else if (ma[0] !== mb[0]) {
      return ma[0] < mb[0] ? -1 : 1;
    }
  }
  return la.length - lb.length || (la < lb ? -1 : la > lb ? 1 : 0);
}

/** 结果排序：文件夹恒在前（与列表语义一致），再按所选键与方向 */
export function sortResults(
  entries: FileEntry[],
  key: ResultSortKey,
  dir: SortDir = "asc",
): FileEntry[] {
  const sign = dir === "desc" ? -1 : 1;
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const ord =
      key === "mtime"
        ? a.mtimeMs - b.mtimeMs
        : key === "size"
          ? a.size - b.size
          : key === "path"
            ? naturalCompare(a.path, b.path)
            : naturalCompare(a.name, b.name);
    return ord * sign;
  });
  return sorted;
}

// ── 名称高亮（子串词字面命中；拼音首字母词标记对应汉字区间）────────

export interface NamePart {
  text: string;
  hit: boolean;
}

/** 属性过滤词前缀（Rust matcher 同款：ext/size/dm 及长别名）——不参与名称高亮 */
const ATTR_TERM_RE = /^(?:ext|extension|size|filesize|dm|datemodified):/;

function isHanziChar(c: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(c);
}

/**
 * 拼音首字母命中 → 名称字符区间：term 在 py 串（`FileEntry.py`，Rust
 * `pinyin_initials` 产物）中的码位区间映射回名称字符下标。对齐规则与 Rust
 * 构建侧一致（每字符贡献：汉字 1 个首字母 / 非汉字取小写展开），命中即说明
 * 首字母通道匹配成立，可安全高亮。无对应返回 null。
 */
export function pinyinHighlightRange(
  name: string,
  py: string,
  term: string,
): [number, number] | null {
  if (!term || !py) return null;
  const at = py.indexOf(term);
  if (at < 0) return null;
  const termEnd = at + term.length;
  let pyIdx = 0;
  let start = -1;
  let end = -1;
  let i = 0;
  for (const ch of name) {
    const contrib = isHanziChar(ch) ? 1 : ch.toLowerCase().length;
    const segEnd = pyIdx + contrib;
    if (segEnd > at && pyIdx < termEnd) {
      if (start < 0) start = i;
      end = i + 1;
    }
    pyIdx = segEnd;
    i += 1;
  }
  return start >= 0 ? [start, end] : null;
}

/** 空白切词 + 双引号内不切（与 Rust split_ws_respect_quotes 同款；引号字符保留） */
function splitQueryTokens(query: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const c of query) {
    if (c === '"') {
      inQuote = !inQuote;
      cur += c;
    } else if (/\s/.test(c) && !inQuote) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 按查询词切分名称用于高亮。与 Rust 端解析对齐：`!` 排除词与 ext:/size:/dm:
 * 属性词跳过；双引号短语剥壳后按字面子串高亮；通配符/路径词跳过。
 * `py` = `FileEntry.py`（拼音首字母串，可选）：子串未命中的词在其上做首字母
 * 匹配，命中则标记对应的汉字区间（与 Rust 首字母通道同语义）。
 * 返回交替的 hit 段；无命中返回整段原文。
 */
export function highlightParts(
  name: string,
  query: string,
  py?: string | null,
): NamePart[] {
  const terms = splitQueryTokens(query.toLowerCase()).flatMap((raw): string[] => {
    if (!raw || raw.startsWith("!") || ATTR_TERM_RE.test(raw)) return [];
    // 双引号短语 = 字面子串（引号内通配符也按字面）
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      const inner = raw.slice(1, -1);
      return inner ? [inner] : [];
    }
    return /[*?\\/]/.test(raw) ? [] : [raw];
  });
  if (!terms.length) return [{ text: name, hit: false }];
  const lower = name.toLowerCase();
  // 每个字符标记是否被任一词覆盖
  const marks = new Array<boolean>(name.length).fill(false);
  for (const t of terms) {
    let literal = false;
    let from = 0;
    while (from <= lower.length - t.length) {
      const i = lower.indexOf(t, from);
      if (i < 0) break;
      literal = true;
      for (let k = i; k < i + t.length; k++) marks[k] = true;
      from = i + Math.max(1, t.length);
    }
    // 拼音首字母通道：字面未覆盖且 py 串含该词 → 标记对应汉字区间
    if (!literal && py) {
      const r = pinyinHighlightRange(name, py, t);
      if (r) {
        for (let k = r[0]; k < r[1]; k++) marks[k] = true;
      }
    }
  }
  const parts: NamePart[] = [];
  let cur = "";
  let curHit = marks[0] ?? false;
  for (let i = 0; i < name.length; i++) {
    if (marks[i] === curHit) {
      cur += name[i];
    } else {
      if (cur) parts.push({ text: cur, hit: curHit });
      cur = name[i];
      curHit = marks[i];
    }
  }
  if (cur) parts.push({ text: cur, hit: curHit });
  return parts.length ? parts : [{ text: name, hit: false }];
}

// ── 搜索历史 ───────────────────────────────────────────────────────

export const SEARCH_HISTORY_CAP = 20;

/** 去重置顶 + 截断 */
export function pushSearchHistory(history: string[], query: string): string[] {
  const q = query.trim();
  if (!q) return history;
  return [q, ...history.filter((h) => h !== q)].slice(0, SEARCH_HISTORY_CAP);
}

// ── 常用类型预设（Everything Filters 同款场景）────────────────────

export interface GsTypePreset {
  key: string;
  label: string;
  /** `;` 分隔的扩展名表（空 = 不过滤） */
  exts: string;
}

/** 预设不走 IPC 新参数：组合成 ext: 属性词追加到查询（Rust matcher 两引擎同语义），
 *  历史记录/名称高亮仍用用户原始输入 */
export const GSEARCH_TYPE_PRESETS: GsTypePreset[] = [
  { key: "any", label: "常用类型", exts: "" },
  { key: "docs", label: "文档", exts: "pdf;doc;docx;dot;dotx;odt;ott;rtf;wps;txt;md;csv;tsv;xps" },
  { key: "sheets", label: "表格", exts: "xls;xlsx;xlsm;xlsb;xlt;xltx;ods;ots;csv;tsv;et" },
  { key: "slides", label: "演示", exts: "ppt;pptx;pptm;pot;potx;pps;ppsx;odp;otp" },
  { key: "images", label: "图片", exts: "png;jpg;jpeg;gif;webp;bmp;svg;ico;tif;tiff;heic;avif;psd;ai" },
  { key: "audio", label: "音频", exts: "mp3;wav;flac;m4a;aac;ogg;opus;wma;aiff;ape;mid" },
  { key: "video", label: "视频", exts: "mp4;mkv;avi;mov;wmv;flv;webm;mpg;mpeg;rm;rmvb;m2ts;3gp" },
  { key: "archives", label: "压缩包", exts: "zip;rar;7z;tar;gz;bz2;xz;zst;tgz;cab;iso" },
  { key: "apps", label: "程序", exts: "exe;msi;lnk;bat;cmd;ps1;dll;jar;apk" },
];

/** 用户查询 + 类型预设 → 发往后端的实际查询（预设不过滤时原样返回） */
export function composeTypeFilterQuery(query: string, presetKey: string): string {
  const q = query.trim();
  const preset = GSEARCH_TYPE_PRESETS.find((p) => p.key === presetKey);
  return preset && preset.exts ? `${q} ext:${preset.exts}` : q;
}
