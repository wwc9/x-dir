// 文本 / Markdown / office 共用渲染（2026-10-18 结构化升级）：
// 纯文本走 <pre>（textContent，无注入面）；Markdown 经 marked + DOMPurify 双重净化；
// office/odt/odp/rtf/eml/msg 按结构化 blocks 渲染（标题分级/列表缩进/表格网格/键值/备注），
// 无 blocks 时回退纯文本 pre。文本类附加：换行开关、行号（仅不换行模式）、
// 代码语法高亮（highlight.js 懒加载，≤200KB）。搜索高亮经 CSS Custom Highlight API。

import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import type { OfficeBlock, OfficeTextResult, PreviewTextResult } from "../../lib/ipc";
import { extOf } from "../../lib/fileIcons";
import type { PreviewKind } from "../../lib/previewKind";
import { isNumericLike } from "../../lib/sheetGrid";
import {
  clearGroupHighlights,
  highlightInContainer,
  type PreviewSearchCtl,
} from "../../lib/previewSearch";

/** 语法高亮语言映射（扩展名 → highlight.js 语言；按需懒加载单语言包） */
const HL_LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bat: "dos",
  ps1: "powershell",
  css: "css",
  sql: "sql",
  json: "json",
  xml: "xml",
  html: "xml",
  htm: "xml",
};

const HL_MAX_CHARS = 200_000;
/** 行号上限（更长的文件退化为无行号的 nowrap 视图） */
const LINE_NO_MAX = 20_000;

export function DocPreview({
  kind,
  text,
  office,
  fileName,
  search,
  textWrap = true,
}: {
  kind: PreviewKind;
  text?: PreviewTextResult;
  office?: OfficeTextResult;
  /** 文件名（语法高亮语言判定用） */
  fileName?: string;
  search?: PreviewSearchCtl;
  /** 自动换行开关（仅纯文本；关闭且行数 ≤2 万时带行号） */
  textWrap?: boolean;
}) {
  const mdHtml = useMemo(() => {
    if (kind !== "markdown" || !text) return "";
    return DOMPurify.sanitize(marked.parse(text.content, { async: false }));
  }, [kind, text]);

  // 代码高亮：懒加载 highlight.js core + 单语言包，超长或非代码扩展名跳过
  const [hl, setHl] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== "text" || !text?.content) {
      setHl(null);
      return;
    }
    const lang = HL_LANGS[extOf(fileName ?? "")];
    if (!lang || text.content.length > HL_MAX_CHARS) {
      setHl(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const [{ default: hljs }, langMod] = await Promise.all([
          import("highlight.js/lib/core"),
          import(`highlight.js/lib/languages/${lang}.js`),
        ]);
        if (!alive) return;
        hljs.registerLanguage(lang, langMod.default);
        setHl(hljs.highlight(text!.content, { language: lang }).value);
      } catch {
        if (alive) setHl(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [kind, text, fileName]);

  const lineCount = useMemo(
    () => (text ? (text.content ? text.content.split("\n").length : 0) : 0),
    [text],
  );
  const showLines = !textWrap && lineCount <= LINE_NO_MAX;

  // 预览内查找：容器扫描 + CSS Highlight API 高亮（覆盖 pre/markdown/blocks）
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !search) return;
    const total = highlightInContainer(el, "doc", search.term, search.active);
    search.onTotal(total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.term, search?.active, hl, text, office, textWrap]);
  useEffect(() => () => clearGroupHighlights("doc"), []);

  const code = text ? (hl !== null ? hl : text.content) : "";
  const codeHtml = hl !== null ? DOMPurify.sanitize(hl) : "";

  if (!text && !office) return null;
  return (
    <div className="np-pv-doc" ref={bodyRef}>
      {text && (
        <>
          {!text.content && <div className="np-pv-empty">（空文件）</div>}
          {kind === "markdown" && text.content && (
            <div className="np-md" dangerouslySetInnerHTML={{ __html: mdHtml }} />
          )}
          {kind !== "markdown" && text.content && (
            <div className="np-pv-codewrap">
              {showLines && (
                <div className="np-pv-gutter" aria-hidden>
                  {Array.from({ length: lineCount }, (_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
              )}
              {hl !== null ? (
                <pre
                  className={`np-pv-pre${textWrap ? "" : " is-nowrap"}`}
                  dangerouslySetInnerHTML={{ __html: codeHtml }}
                />
              ) : (
                <pre className={`np-pv-pre${textWrap ? "" : " is-nowrap"}`}>{code}</pre>
              )}
            </div>
          )}
        </>
      )}
      {office && <OfficeSections office={office} />}
    </div>
  );
}

function OfficeSections({ office }: { office: OfficeTextResult }) {
  const cover = office.kind === "epub" ? office.cover : null;
  const sections = (
    <>
      {office.sections.map((sec) => (
        <section key={sec.title} className="np-pv-sec">
          <h3 className="np-pv-sec-title">{sec.title}</h3>
          {sec.blocks?.length ? (
            <Blocks blocks={sec.blocks} />
          ) : sec.text ? (
            <pre className="np-pv-pre">{sec.text}</pre>
          ) : (
            <div className="np-pv-empty">（空）</div>
          )}
        </section>
      ))}
    </>
  );
  if (cover) {
    return (
      <div className="np-pv-epub">
        <img className="np-pv-epub-cover" src={cover} alt="封面" />
        <div className="np-pv-epub-sections">{sections}</div>
      </div>
    );
  }
  return sections;
}

function Blocks({ blocks }: { blocks: OfficeBlock[] }) {
  return (
    <div className="np-pv-blocks">
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const lvl = Math.min(Math.max(b.level, 1), 4);
          const Tag = (`h${lvl}` === "h1" ? "h1" : `h${lvl}`) as "h1" | "h2" | "h3" | "h4";
          return (
            <Tag key={i} className={`np-pv-h np-pv-h${lvl}`}>
              {b.text}
            </Tag>
          );
        }
        if (b.kind === "list") {
          return (
            <div
              key={i}
              className="np-pv-li"
              style={{ marginInlineStart: `${Math.min(b.level, 6) * 18}px` }}
            >
              <span className="np-pv-li-dot">•</span>
              <span>{b.text}</span>
            </div>
          );
        }
        if (b.kind === "table") return <DocTable key={i} rows={b.rows} />;
        if (b.kind === "kv") {
          return (
            <div key={i} className="np-pv-kv">
              <span className="np-pv-kv-label">{b.label}</span>
              <span className="np-pv-kv-val np-ellipsis" title={b.text}>
                {b.text}
              </span>
            </div>
          );
        }
        if (b.kind === "note") {
          return (
            <div key={i} className="np-pv-note">
              {b.text}
            </div>
          );
        }
        return b.text ? (
          <p key={i} className="np-pv-p">
            {b.text}
          </p>
        ) : null;
      })}
    </div>
  );
}

/** 文档内嵌表格（docx/odt 的 w:tbl/table:table）：静态小网格，护栏 100 行×30 列 */
function DocTable({ rows }: { rows: string[][] }) {
  const capped = rows.slice(0, 100).map((r) => r.slice(0, 30));
  const cols = Math.max(1, ...capped.map((r) => r.length));
  return (
    <div
      className="np-pv-dtable"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(72px, 1fr))` }}
    >
      {capped.flatMap((row, r) =>
        Array.from({ length: cols }, (_, c) => {
          const cell = row[c] ?? "";
          return (
            <div
              key={`${r}:${c}`}
              className={`np-pv-dtable-cell${r === 0 ? " is-head" : ""}${
                isNumericLike(cell) ? " is-num" : ""
              }`}
              title={cell}
            >
              {cell}
            </div>
          );
        }),
      )}
    </div>
  );
}
