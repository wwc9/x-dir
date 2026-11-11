// pdf.js 加载器（自 PdfPreview 抽出，2026-11-11 PDF 转图片共用）：显式指定
// worker（主线程兜底极慢）+ 二进制资产自供。未嵌入字体的中文 PDF（书生/方正
// OFD 转换器产出的公文件常见）用 UniGB-UCS2-H 等预定义 CMap 编码，pdf.js
// 必须外供 CMap 数据，否则整页汉字不渲染。顺带补齐标准字体与 jbig2/openjpeg/
// qcms wasm（JBIG2/JPX 扫描件同样依赖外供；quickjs 仅 XFA 表单用，不带）。
// Vite 没有目录资产导入，用 import.meta.glob 逐文件建 URL 映射 + 自定义
// BinaryDataFactory（pdf.js 6 统一二进制工厂协议）：dev 直连 node_modules、
// 打包后为哈希资产，CSP connect-src 'self' 两种形态均放行。
/** pdf.js 主模块类型（type-of import 不进打包） */
type ApiPdfJs = typeof import("pdfjs-dist");

const CMAP_URLS = import.meta.glob("/node_modules/pdfjs-dist/cmaps/*.bcmap", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;
const FONT_URLS = import.meta.glob(
  "/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;
const WASM_URLS = import.meta.glob(
  "/node_modules/pdfjs-dist/wasm/{jbig2,openjpeg,qcms_bg}.wasm",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

const byBasename = (m: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k.slice(k.lastIndexOf("/") + 1), v]),
  );
const ASSET_MAPS: Record<string, Record<string, string>> = {
  cMapUrl: byBasename(CMAP_URLS),
  standardFontDataUrl: byBasename(FONT_URLS),
  wasmUrl: byBasename(WASM_URLS),
};

/** fetch({kind, filename}) → 二进制；pdf.js 传入的基址参数被忽略——
 *  资产 URL 已由 glob 在编译期定死 */
class ViteAssetBinaryFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const map = ASSET_MAPS[kind] ?? {};
    // cMapPacked 下 filename 自带 .bcmap；容错无扩展名请求（非 packed 形态）
    const url = map[filename] ?? map[`${filename}.bcmap`];
    if (!url) throw new Error(`pdf.js 二进制资产缺失：${kind}/${filename}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`pdf.js 二进制资产加载失败（${res.status}）：${filename}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

let workerSrc: string | null = null;

/** 懒加载 pdf.js 主模块（含 worker 指定；重复调用共享同一 workerSrc） */
export async function loadPdfjs(): Promise<ApiPdfJs> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  if (!workerSrc) {
    workerSrc = worker.default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  return pdfjs;
}

/** getDocument 公共参数（CMap/字体/wasm 自供；password 供加密 PDF）；
 *  返回类型由 getDocument 参数位推断（DocumentInitParameters 未从包根导出） */
export function pdfjsDocParams(
  src: { url: string } | { data: Uint8Array },
  password?: string,
) {
  return {
    ...src,
    ...(password ? { password } : {}),
    cMapUrl: "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "standard_fonts/",
    wasmUrl: "wasm/",
    BinaryDataFactory: ViteAssetBinaryFactory,
  };
}
