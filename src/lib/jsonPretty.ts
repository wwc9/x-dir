// 压缩 JSON 自动排版（快速预览 2026-11-03）：纯函数。
// 仅当内容为「整串一行」且可完整 parse 的对象/数组时，按 2 空格缩进重排展示；
// 已含换行（本就排版过或手写）、纯量、非法 JSON、超长内容一律不动（返回 null），
// 保持"展示可以美化、内容绝不改写"的口径（磁盘文件永不写回）。

export interface PrettyJsonResult {
  text: string;
}

export function prettyJson(
  content: string,
  maxChars = 200_000,
): PrettyJsonResult | null {
  const s = content.trim();
  if (!s || s.length > maxChars) return null;
  // JSON 根只可能是 { 或 [（纯量数字/字符串无排版意义）
  if (s[0] !== "{" && s[0] !== "[") return null;
  // 已含换行 = 可能已排版，尊重原样
  if (s.includes("\n")) return null;
  try {
    const obj: unknown = JSON.parse(s);
    if (typeof obj !== "object" || obj === null) return null;
    const text = JSON.stringify(obj, null, 2);
    // 重排结果比原文还长很多（畸形嵌套）或仍超限：不值得，保持原文
    if (text.length > maxChars * 1.5) return null;
    return { text };
  } catch {
    return null;
  }
}
