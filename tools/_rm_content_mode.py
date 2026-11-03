# 移除全盘搜索「内容」模式（2026-11-03 用户定案：臃肿）——GlobalSearch.tsx 六段精确删除
import re

p = r"src/components/GlobalSearch.tsx"
s = open(p, encoding="utf-8").read()
orig_len = len(s)

def cut(start_marker, end_marker, note):
    """删 [start_marker 起, end_marker 止) 的区段（含起点行，不含终点行）"""
    global s
    i = s.find(start_marker)
    assert i >= 0, "start not found: " + note
    j = s.find(end_marker, i)
    assert j >= 0, "end not found: " + note
    s = s[:i] + s[j:]
    print("removed", note)

# 1. import 类型
s = s.replace('import type { ContentSearchResult } from "../lib/ipc";\n', "")

# 2. 状态四件
cut(
    "  // 内容搜索模式（2026-10-22）：名称 / 内容；范围目录默认取活动窗格当前目录",
    "  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);",
    "state",
)

# 3. 内容搜索 effect（从注释到下一个空行 + switchMode 结束）
cut(
    "  // 内容搜索（2026-10-22）：范围目录 + 关键词（多词 AND），防抖 350ms，",
    "  /** 命中行关键词高亮（多词交替着色，大小写不敏感） */",
    "effect+switchMode",
)
# 4. HiLine 组件（到 liveEntries 前）
cut(
    "  /** 命中行关键词高亮（多词交替着色，大小写不敏感） */",
    "  const liveEntries = res?.entries ?? stream.entries;",
    "HiLine",
)

# 5. 占位符三元 → 仅名称
s = s.replace(
    """          placeholder={
            mode === "content"
              ? t("搜索文件内容（多词空格分隔，大小写不敏感）")
              : t('搜索所有磁盘 · ext: size: dm: 过滤 · !排除 · "短语" · 拼音首字母')
          }""",
    """          placeholder={t('搜索所有磁盘 · ext: size: dm: 过滤 · !排除 · "短语" · 拼音首字母')}""",
)

# 6. 模式分段 UI
cut(
    '          <div className="np-gsearch-modeseg" role="group" aria-label={t("搜索模式")}>',
    "          <InputGroup",
    "modeseg",
)

# 7. 范围行 + 主区 class + 内容结果块（范围行起，到 panelRef div 前的所有内容模式块）
cut(
    "        {mode === \"content\" && (\n          <div className=\"np-gsearch-crow\">",
    '        <div className="np-gsearch-main">\n          <div\n            ref={panelRef}',
    "scope+content-results",
)
# 上面把 np-gsearch-main 行也吃了开头，补回完整起始
s = s.replace(
    '        <div className="np-gsearch-main">\n          <div\n            ref={panelRef}',
    '        <div className="np-gsearch-main">\n          <div\n            ref={panelRef}',
)
# 恢复被截断的结构：cut 终点写的是两行拼接，实际文件是 main 行后紧跟 panelRef div；
# 校验：main 之后不应再有 is-content / crow / cwrap
assert "is-content" not in s, "is-content remains"
assert "np-gsearch-crow" not in s, "crow remains"
assert "np-gsearch-cwrap" not in s, "cwrap remains"

# 8. 预览面板条件
s = s.replace("{previewOpen && mode === \"name\" && (", "{previewOpen && (")

# 9. 状态条三元 → 仅名称分支
s = s.replace(
    """          <span className="np-gsearch-status-text np-ellipsis">
            {mode === "content"
              ? t("命中 {n} 个文件 · 扫描 {s} 个{tail} · {ms}ms", {
                  n: cRes?.matches.length ?? 0,
                  s: cRes?.scanned ?? 0,
                  tail: cRes?.truncated ? t("（已达上限，缩小范围或加扩展名过滤）") : "",
                  ms: cRes?.elapsedMs ?? 0,
                })
              : (
                <>
                  {statusText}
                  {statusSuffix}
                </>
              )}
          </span>""",
    """          <span className="np-gsearch-status-text np-ellipsis">
            {statusText}
            {statusSuffix}
          </span>""",
)

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("done", orig_len, "->", len(s))
# 残留检查
for w in ["mode", "cRes", "cRoot", "cExts", "HiLine", "switchMode", "ContentSearch", "searchContent"]:
    n = len(re.findall(r"\b" + w + r"\b", s))
    if n:
        print("WARN remaining", w, n)
