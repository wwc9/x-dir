// 文本 / Markdown / office 文本抽取共用渲染：纯文本走 <pre>（textContent，无注入面），
// Markdown 经 marked + DOMPurify 双重净化后渲染；office 按节（正文/幻灯片 N/工作表）分块。

import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import type { OfficeTextResult, PreviewTextResult } from "../../lib/ipc";
import type { PreviewKind } from "../../lib/previewKind";

export function DocPreview({
  kind,
  text,
  office,
}: {
  kind: PreviewKind;
  text?: PreviewTextResult;
  office?: OfficeTextResult;
}) {
  const mdHtml = useMemo(() => {
    if (kind !== "markdown" || !text) return "";
    return DOMPurify.sanitize(marked.parse(text.content, { async: false }));
  }, [kind, text]);

  if (!text && !office) return null;
  if (text) {
    if (!text.content) return <div className="np-pv-empty">（空文件）</div>;
    if (kind === "markdown") {
      return (
        <div className="np-pv-doc">
          <div className="np-md" dangerouslySetInnerHTML={{ __html: mdHtml }} />
        </div>
      );
    }
    return (
      <div className="np-pv-doc">
        <pre className="np-pv-pre">{text.content}</pre>
      </div>
    );
  }
  return (
    <div className="np-pv-doc">
      {office!.sections.map((sec) => (
        <section key={sec.title} className="np-pv-sec">
          <h3 className="np-pv-sec-title">{sec.title}</h3>
          {sec.text ? (
            <pre className="np-pv-pre">{sec.text}</pre>
          ) : (
            <div className="np-pv-empty">（空）</div>
          )}
        </section>
      ))}
    </div>
  );
}
