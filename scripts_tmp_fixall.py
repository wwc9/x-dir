# -*- coding: utf-8 -*-
# 水印命名模板综合修复 v2（跑完即删）——幂等：各步骤检测现状后执行
import io

BS = chr(92)
NL = chr(10)

# ═══ A. pdf/mod.rs：转义（若未修）+ 测试补 out_name（若缺） ═══
p = "src-tauri/src/pdf/mod.rs"
t = io.open(p, encoding="utf-8").read()
old = 'let out = format!("{dir}' + BS + '{name}");'
if old in t:
    t = t.replace(old, 'let out = format!("{dir}' + BS + BS + '{name}");', 1)
    print("A1 转义修复")
if 'out_name: "[原文件名]-水印".into(),' not in t:
    old = '            text: "绝密".into(),'
    assert t.count(old) == 1, "A2"
    t = t.replace(old, old + "\n            out_name: \"[原文件名]-水印\".into(),", 1)
    print("A2 测试补 out_name")
io.open(p, "w", encoding="utf-8", newline="").write(t)

# ═══ B. stamp.rs：补 today_formatted（若缺） ═══
p = "src-tauri/src/pdf/stamp.rs"
t = io.open(p, encoding="utf-8").read()
if "pub fn today_formatted" not in t:
    anchor = "/// 当前本机日期（UTC 近似，水印用途足够）"
    assert anchor in t, "B anchor"
    idx = t.index(anchor)
    end = t.index("\n}\n", idx) + 3
    add = (anchor + NL
           + "pub fn today() -> (i64, u32, u32) {" + NL
           + "    let (y, m, d) = civil_from_days((std::time::SystemTime::now()" + NL
           + "        .duration_since(std::time::UNIX_EPOCH)" + NL
           + "        .map(|dd| dd.as_secs())" + NL
           + "        .unwrap_or(0)" + NL
           + "        / 86_400) as i64);" + NL
           + "    (y, m, d)" + NL
           + "}" + NL + NL
           + "/// 当前日期按格式渲染" + NL
           + "pub fn today_formatted(fmt: WmDtFmt) -> String {" + NL
           + "    let (y, m, d) = today();" + NL
           + "    fmt.render(y, m, d)" + NL
           + "}")
    t = t[:end] + add + t[end:]
    print("B today_formatted 补")
io.open(p, "w", encoding="utf-8", newline="").write(t)

# ═══ C. commands/pdf_cmds.rs：out_name 参数 + opts（若缺） ═══
p = "src-tauri/src/commands/pdf_cmds.rs"
t = io.open(p, encoding="utf-8").read()
changed = False
if "out_name: Option<String>" not in t:
    old = "    paths: Vec<String>," + NL + "    text: String," + NL + "    font_name: Option<String,"
    new = ("    paths: Vec<String>," + NL + "    text: String," + NL
           + "    out_name: Option<String>," + NL + "    font_name: Option<String,")
    assert old in t, "C1"
    t = t.replace(old, new, 1)
    changed = True
if "        out_name: {" not in t:
    old = "    let opts = crate::pdf::stamp::WatermarkOpts {" + NL + "        text,"
    new = ("    let opts = crate::pdf::stamp::WatermarkOpts {" + NL
           + "        text," + NL
           + "        out_name: {" + NL
           + "            let v = out_name.unwrap_or_default();" + NL
           + "            let v = v.trim();" + NL
           + "            if v.is_empty() {" + NL
           + '                "[原文件名]-水印".to_string()' + NL
           + "            } else {" + NL
           + "                v.to_string()" + NL
           + "            }" + NL
           + "        },")
    assert old in t, "C2"
    t = t.replace(old, new, 1)
    changed = True
io.open(p, "w", encoding="utf-8", newline="").write(t)
print("C ok, changed =", changed)

# ═══ D. ToolsDialogs：合并对话框去污染（若被误插水印行） ═══
p = "src/components/ToolsDialogs.tsx"
t = io.open(p, encoding="utf-8").read()
merge_at = t.index("export function PdfMergeDialog")
wm_at = t.index("export function PdfWatermarkDialog")
row_key = '          <FormRow k={t2("输出文件名")}>'
if row_key in t[merge_at:wm_at]:
    row_start = t.index(row_key, merge_at)
    row_end = t.index("</FormRow>" + NL, row_start) + len("</FormRow>" + NL)
    t = t[:row_start] + t[row_end:]
    print("D 合并对话框去污染")
old = ('          {t2("输出预览：{dir}' + BS + BS + '{name}.pdf", {' + NL
       + "            dir: dirOf(dirOf(firstPath))," + NL
       + "            name: renderedName," + NL
       + "          })}")
if old in t[:wm_at]:
    t = t.replace(old, '          {t2("输出预览：{out}", { out: output })}', 1)
    print("D 合并预览还原")
io.open(p, "w", encoding="utf-8", newline="").write(t)

# ═══ E. 水印对话框：补 输出文件名 行（若缺） ═══
t = io.open(p, encoding="utf-8").read()
wm_at = t.index("export function PdfWatermarkDialog")
row_key = '          <FormRow k={t2("输出文件名")}>'
if row_key not in t[wm_at:]:
    anchor = t.index("value={datetimeFormat}", wm_at)
    fr_end = t.index("</FormRow>", anchor) + len("</FormRow>")
    row = (
        NL + '          <FormRow k={t2("输出文件名")}>' + NL
        + "            <InputGroup" + NL
        + '              size="small"' + NL
        + "              value={outName}" + NL
        + "              spellCheck={false}" + NL
        + "              onChange={(e) => setOutName(e.target.value)}" + NL
        + "            />" + NL
        + '            <div className="np-wm-chips">' + NL
        + '              {["[原文件名]", "[原文件夹名]", "[日期时间]"].map((ph) => (' + NL
        + "                <button" + NL
        + "                  key={ph}" + NL
        + '                  className="np-wm-chip"' + NL
        + '                  title={t2("点击插入占位符")}' + NL
        + "                  onClick={() => setOutName((v) => v + ph)}" + NL
        + "                >" + NL
        + "                  {ph}" + NL
        + "                </button>" + NL
        + "              ))}" + NL
        + "            </div>" + NL
        + "          </FormRow>"
    )
    t = t[:fr_end] + row + t[fr_end:]
    print("E 输出文件名行补")
io.open(p, "w", encoding="utf-8", newline="").write(t)
print("E ok")
