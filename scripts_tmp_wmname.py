# -*- coding: utf-8 -*-
# 水印命名模板收尾 v2（跑完即删）
import io

BS = chr(92)
NL = chr(10)

# ---------- 1) pdf/mod.rs：转义修复 + 输出名模板渲染 ----------
p = "src-tauri/src/pdf/mod.rs"
t = io.open(p, encoding="utf-8").read()
old = ('let out = format!("{}' + BS + BS + '{}_水印.pdf", parent_dir(p), stem_of(p));')
new_lines = [
    "        let dir = parent_dir(p);",
    "        let file_stem = stem_of(p);",
    "        let folder = parent_dir(p);",
    "        // 输出名模板（2026-10-22）：[原文件名]/[原文件夹名]/[日期时间] 可组合，",
    '        // 默认 "[原文件名]-水印"；无扩展名时补 .pdf',
    "        let name = stamp::render_text(",
    "            &opts.out_name,",
    "            &file_stem,",
    "            &folder,",
    '            "",',
    '            "",',
    "            &stamp::today_formatted(opts.dt_fmt),",
    "        );",
    '        let name = if name.to_ascii_lowercase().ends_with(".pdf") {',
    "            name",
    "        } else {",
    '            format!("{name}.pdf")',
    "        };",
    '        let out = format!("{dir}' + BS + '{name}");',
]
new = NL.join(new_lines)
assert old in t, "mod escape"
t = t.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="").write(t)
print("mod ok")

# ---------- 2) commands：out_name 参数（默认模板） ----------
p = "src-tauri/src/commands/pdf_cmds.rs"
t = io.open(p, encoding="utf-8").read()
old = "    paths: Vec<String>," + NL + "    text: String," + NL + "    font_name: Option<String,"
new = ("    paths: Vec<String>," + NL + "    text: String," + NL
       + "    out_name: Option<String>," + NL + "    font_name: Option<String,")
assert old in t, "sig"
t = t.replace(old, new, 1)
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
assert old in t, "opts"
t = t.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="").write(t)
print("pdf_cmds ok")
