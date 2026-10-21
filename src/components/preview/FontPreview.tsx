// 字体预览：FontFace API 装载本机字体文件（webview 标准能力，零依赖），渲染字样梯度。

import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";

const FAMILY = "np-pv-font";

export function FontPreview({
  src,
  onError,
}: {
  src: string;
  onError(): void;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let face: FontFace | null = null;
    setReady(false);
    const f = new FontFace(FAMILY, `url("${src}")`);
    face = f;
    f.load()
      .then((loaded) => {
        document.fonts.add(loaded);
        setReady(true);
      })
      .catch(onError);
    return () => {
      if (face) document.fonts.delete(face);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (!ready) return null;
  return (
    <div className="np-pv-doc np-pv-font" style={{ fontFamily: `"${FAMILY}"` }}>
      <div className="np-pv-font-hero">{t("AaBbCc 永珍乾坤")}</div>
      <div className="np-pv-font-row">ABCDEFGHIJKLMNOPQRSTUVWXYZ</div>
      <div className="np-pv-font-row">abcdefghijklmnopqrstuvwxyz 0123456789</div>
      <div className="np-pv-font-row">{t("X-Dir 文件快速预览 · 春眠不觉晓 42")}</div>
    </div>
  );
}
