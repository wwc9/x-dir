# -*- coding: utf-8 -*-
# 水印收尾 v3（跑完即删）：字体缓存 Arc 化 + 调用点更新 + 遗留清理
import io

BS = chr(92)

# ---------- 1) pdf/mod.rs：清理占位、修转义、测试调用 ----------
p = "src-tauri/src/pdf/mod.rs"
t = io.open(p, encoding="utf-8").read()
# 移除上一步误入的占位块
ph = '''/// 图片水印沿用默认字体链（msyh → simhei → simsun → arial）
pub(crate) fn load_default_font() -> Option<std::sync::Arc<crate::pdf::stamp::FontOwned>> {
    Some(crate::pdf::stamp::load_font(&["msyh.ttc"]))
}

'''
if ph in t:
    t = t.replace(ph, "", 1)
# 转义修复（若未修）
esc_old = 'let out = format!("{}' + BS + '{}_水印.pdf", parent_dir(p), stem_of(p));'
esc_new = 'let out = format!("{}' + BS + BS + '{}_水印.pdf", parent_dir(p), stem_of(p));'
if esc_old in t:
    t = t.replace(esc_old, esc_new, 1)
# 测试字体调用
old = 'let font = stamp::load_cjk_font().expect("Windows 测试机应有系统中文字体");'
if old in t:
    t = t.replace(old, 'let font = stamp::load_font(&["msyh.ttc"]).expect("Windows 测试机应有系统中文字体");')
io.open(p, "w", encoding="utf-8", newline="").write(t)
print("pdf/mod ok")

# ---------- 2) stamp.rs：字体缓存 Arc 化 + 遗留 stamp_document ----------
p = "src-tauri/src/pdf/stamp.rs"
t = io.open(p, encoding="utf-8").read()
start = t.index("/// 按名称加载系统中文字体")
end = t.index("/// 单行文字光栅化")
new_loader = '''/// 按优先级加载系统字体（prefer = Fonts 目录下的字体文件名，如 "simkai.ttf"）；
/// prefer 全部缺失时回退 msyh → simhei → simsun → arial。Arc 共享免克隆。
pub fn load_font(prefer: &[&str]) -> Option<Arc<FontVec>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<FontVec>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\\\Windows".into());
    let mut candidates: Vec<String> = prefer.iter().map(|f| format!("Fonts\\\\{f}")).collect();
    for f in [
        "Fonts\\\\msyh.ttc",
        "Fonts\\\\simhei.ttf",
        "Fonts\\\\simsun.ttc",
        "Fonts\\\\arial.ttf",
    ] {
        candidates.push(f.to_string());
    }
    for f in candidates {
        if let Some(hit) = cache.lock().unwrap().get(&f) {
            return Some(Arc::clone(hit));
        }
        let path = std::path::Path::new(&windir).join(&f);
        if let Ok(data) = std::fs::read(&path) {
            if let Ok(font) = FontVec::try_from_vec_and_index(data, 0)
                .map_err(|_| std::io::Error::other("font"))
            {
                let arc = Arc::new(font);
                cache.lock().unwrap().insert(f, Arc::clone(&arc));
                return Some(arc);
            }
        }
    }
    None
}

/// 遗留兼容（2026-10-22 前的调用形态）：深灰 45° 对角、覆盖率即透明（0.16）
pub fn stamp_document(doc: &mut lopdf::Document, bm: &StampBitmap) -> Result<(), String> {
    let img_id = add_image_xobject(doc, bm)?;
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    for page_id in page_ids {
        let (w, h) = page_size(doc, page_id);
        let alpha = 0.16;
        let ext_gstate = dictionary! {
            "Type" => "ExtGState",
            "ca" => Object::Real(alpha),
            "CA" => Object::Real(alpha),
        };
        mount_resources(doc, page_id, img_id, ext_gstate)?;
        let diag = (w * w + h * h).sqrt();
        let disp_w = diag * 0.8;
        let disp_h = disp_w * bm.height as f32 / bm.width.max(1) as f32;
        let (sin, cos) = (45f32.to_radians().sin(), 45f32.to_radians().cos());
        let content = Content {
            operations: vec![
                lopdf::content::Operation::new("q", vec![]),
                lopdf::content::Operation::new("gs", vec![Object::Name("WmGs".into())]),
                lopdf::content::Operation::new(
                    "cm",
                    vec![
                        Object::Real(cos),
                        Object::Real(sin),
                        Object::Real(-sin),
                        Object::Real(cos),
                        Object::Real(w / 2.0),
                        Object::Real(h / 2.0),
                    ],
                ),
                lopdf::content::Operation::new(
                    "cm",
                    vec![
                        Object::Real(disp_w),
                        Object::Real(0.0),
                        Object::Real(0.0),
                        Object::Real(disp_h),
                        Object::Real(-disp_w / 2.0),
                        Object::Real(-disp_h / 2.0),
                    ],
                ),
                lopdf::content::Operation::new("Do", vec![Object::Name("WmIm".into())]),
                lopdf::content::Operation::new("Q", vec![]),
            ],
        };
        append_content_stream(doc, page_id, &content)?;
    }
    Ok(())
}

'''
t = t[:start] + new_loader + t[end:]
io.open(p, "w", encoding="utf-8", newline="").write(t)
print("stamp ok")
