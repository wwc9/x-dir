//! 配置与工作区命令（§6.9）：settings.json + workspaces/*.json。

use serde_json::Value;

use crate::config::{config_root, sanitize_name, workspaces_dir};

/// 启动参数（--bench <dir> 内存基准模式等）
#[tauri::command]
pub fn get_launch_args() -> Vec<String> {
    crate::LAUNCH_ARGS.get().cloned().unwrap_or_default()
}

#[tauri::command]
pub fn get_settings() -> Value {
    let p = config_root().join("settings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// 截图标注偏好：白名单键补丁式 read-modify-write——轻量截图页拿不到主窗
/// 完整设置对象，整对象回写会覆盖掉其他键；只写传入且在白名单内的键。
/// 键 = 阴影/边框装饰三键 + 滚轮调节持久化的逐类型宽度五键
/// （shotStrokeW 线形/shotTextFont 字号/shotStepW 序号圈/shotMosaicW
/// 马赛克格/shotBlurAlpha 模糊不透明度，2026-10-30「滚轮记忆」定案）。
/// async + blocking：settings.json 可达上百 KB（含菜单布局），读改写整段
/// 在主线程会卡标注滚轮调节的收尾（2026-11-01 响应速度优化）
#[tauri::command]
pub async fn shot_save_prefs(prefs: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shot_save_prefs_blocking(prefs))
        .await
        .map_err(|e| format!("保存线程失败：{e}"))?
}

fn shot_save_prefs_blocking(prefs: Value) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "shotShadowW",
        "shotBorderW",
        "shotBorderColor",
        "shotStrokeW",
        "shotTextFont",
        "shotStepW",
        "shotMosaicW",
        "shotBlurAlpha",
    ];
    let Some(map) = prefs.as_object() else {
        return Err("prefs 必须是键值对象".into());
    };
    let p = config_root().join("settings.json");
    let mut v: Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let obj = v.as_object_mut().ok_or("settings.json 结构异常")?;
    for (k, val) in map {
        if ALLOWED.contains(&k.as_str()) {
            obj.insert(k.clone(), val.clone());
        }
    }
    serde_json::to_string_pretty(&v)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(p, s).map_err(|e| e.to_string()))
}

/// 剪贴板浮窗尺寸持久化（§3.7，2026-10-31 边缘拖拽调宽高）：白名单补丁
/// cliphistWinW/H（逻辑 px），与 shot_save_prefs 同法 RMW——浮窗页拿不到
/// 主窗完整设置对象，防覆盖；同因走 blocking 线程
#[tauri::command]
pub async fn cliphist_save_size(width: f64, height: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cliphist_save_size_blocking(width, height))
        .await
        .map_err(|e| format!("保存线程失败：{e}"))?
}

fn cliphist_save_size_blocking(width: f64, height: f64) -> Result<(), String> {
    let p = config_root().join("settings.json");
    let mut v: Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let obj = v.as_object_mut().ok_or("settings.json 结构异常")?;
    obj.insert(
        "cliphistWinW".into(),
        Value::from(width.round().clamp(360.0, 1200.0)),
    );
    obj.insert(
        "cliphistWinH".into(),
        Value::from(height.round().clamp(300.0, 1500.0)),
    );
    serde_json::to_string_pretty(&v)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(p, s).map_err(|e| e.to_string()))
}

/// 由轻量窗口补丁命令直写 settings.json 的键（shot_save_prefs 八键 +
/// cliphist_save_size 两键）。save_settings 落盘时**保留磁盘值**——主窗
/// store 启动时加载、此后不再重读，整对象覆盖会把这些键回滚到启动时的旧值
/// （2026-11-01 审查修复：截图滚轮调节 → 主窗任意设置变更，调节即被回滚）
const PATCH_OWNED_KEYS: &[&str] = &[
    "shotShadowW",
    "shotBorderW",
    "shotBorderColor",
    "shotStrokeW",
    "shotTextFont",
    "shotStepW",
    "shotMosaicW",
    "shotBlurAlpha",
    "cliphistWinW",
    "cliphistWinH",
];

#[tauri::command]
pub async fn save_settings(json: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_settings_blocking(json))
        .await
        .map_err(|e| format!("保存线程失败：{e}"))?
}

fn save_settings_blocking(json: Value) -> Result<(), String> {
    let p = config_root().join("settings.json");
    // 合并落盘：以磁盘现档为底、incoming 覆盖，补丁键回填磁盘值
    let disk: Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut merged = disk.clone();
    if let (Some(m), Some(n)) = (merged.as_object_mut(), json.as_object()) {
        for (k, v) in n {
            m.insert(k.clone(), v.clone());
        }
    } else {
        merged = json;
    }
    if let Some(m) = merged.as_object_mut() {
        for k in PATCH_OWNED_KEYS {
            if let Some(v) = disk.get(k) {
                m.insert((*k).to_string(), v.clone());
            }
        }
    }
    serde_json::to_string_pretty(&merged)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(p, s).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn list_workspaces() -> Vec<String> {
    let dir = workspaces_dir();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let p = e.path();
                    if p.extension().is_some_and(|x| x == "json") {
                        p.file_stem().map(|s| s.to_string_lossy().into_owned())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tauri::command]
pub fn load_workspace(name: String) -> Result<Value, String> {
    let p = workspaces_dir().join(format!("{}.json", sanitize_name(&name)));
    let s = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_workspace(name: String, tree: Value) -> Result<(), String> {
    let p = workspaces_dir().join(format!("{}.json", sanitize_name(&name)));
    let doc = serde_json::json!({ "name": sanitize_name(&name), "tree": tree });
    // 原子写：临时文件 + rename（§6.9）
    let tmp = p.with_extension("json.tmp");
    serde_json::to_string_pretty(&doc)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(&tmp, s).map_err(|e| e.to_string()))?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace(name: String) -> Result<(), String> {
    let p = workspaces_dir().join(format!("{}.json", sanitize_name(&name)));
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// 重命名前置校验（纯函数，cargo test 锁定冲突口径）：旧档必须存在、
/// 新名不得与现有档同名（重命名绝不静默覆盖，与 save_workspace 的
/// 「保存即覆盖」语义区分）
fn rename_check(src_exists: bool, dst_exists: bool, old: &str, new: &str) -> Result<(), String> {
    if !src_exists {
        return Err(format!("方案“{old}”不存在"));
    }
    if dst_exists {
        return Err(format!("方案“{new}”已存在，请换一个名字"));
    }
    Ok(())
}

/// 重命名布局方案（2026-11-11）：文档内 name 字段同步改写后落新档、删旧档。
/// 先写新档（临时文件 + rename 原子落盘）再删旧档——中途崩溃最多残留双档，
/// 不会丢方案
#[tauri::command]
pub fn rename_workspace(old: String, new: String) -> Result<(), String> {
    let new = sanitize_name(&new);
    if new == "未命名" {
        return Err("方案名不能为空".into());
    }
    let dir = workspaces_dir();
    let src = dir.join(format!("{}.json", sanitize_name(&old)));
    let dst = dir.join(format!("{new}.json"));
    rename_check(
        src.exists(),
        dst.exists(),
        sanitize_name(&old).as_str(),
        new.as_str(),
    )?;
    let mut v: Value =
        serde_json::from_str(&std::fs::read_to_string(&src).map_err(|e| e.to_string())?)
            .map_err(|e| format!("方案档损坏：{e}"))?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("name".into(), Value::from(new.clone()));
    }
    let tmp = dst.with_extension("json.tmp");
    serde_json::to_string_pretty(&v)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(&tmp, s).map_err(|e| e.to_string()))?;
    std::fs::rename(&tmp, &dst).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::remove_file(&src).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::rename_check;

    #[test]
    fn rename_rejects_missing_src_and_collision() {
        assert!(rename_check(true, false, "a", "b").is_ok());
        assert_eq!(
            rename_check(false, false, "a", "b").unwrap_err(),
            "方案“a”不存在"
        );
        assert_eq!(
            rename_check(true, true, "a", "b").unwrap_err(),
            "方案“b”已存在，请换一个名字"
        );
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub workspaces: usize,
    pub source_settings_path: String,
}

/// 导出配置：settings.json + 全部工作区打包为单个 JSON（version 字段供后续导入对齐）。
#[tauri::command]
pub fn export_config(path: String) -> Result<ExportSummary, String> {
    let root = config_root();
    let settings = serde_json::from_str::<Value>(
        &std::fs::read_to_string(root.join("settings.json")).unwrap_or_else(|_| "{}".into()),
    )
    .unwrap_or_else(|_| serde_json::json!({}));

    let dir = workspaces_dir();
    let mut workspaces = serde_json::Map::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().is_some_and(|x| x == "json") {
                let name = p.file_stem().map(|s| s.to_string_lossy().into_owned());
                if let Some(name) = name
                    && let Ok(content) = std::fs::read_to_string(&p)
                    && let Ok(v) = serde_json::from_str::<Value>(&content)
                {
                    workspaces.insert(name, v);
                }
            }
        }
    }

    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 工作日历日志（2026-11-13 新功能）随配置包导出：无文件/损坏 → null 不阻断
    let worklog = std::fs::read_to_string(config_root().join("worklog.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let bundle = serde_json::json!({
        "app": "x-dir",
        "version": 1,
        "exportedAt": exported_at,
        "settings": settings,
        "workspaces": workspaces,
        "worklog": worklog,
    });
    // 原子写：临时文件 + rename
    let tmp = std::path::Path::new(&path).with_extension("json.tmp");
    serde_json::to_string_pretty(&bundle)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(&tmp, s).map_err(|e| e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写入失败：{e}"))?;

    Ok(ExportSummary {
        workspaces: workspaces.len(),
        source_settings_path: root.join("settings.json").to_string_lossy().into_owned(),
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub workspaces: usize,
    pub imported_settings: bool,
}

/// 原子写 JSON 文件：临时文件 + rename（与 export_config 同款）
fn atomic_write_json(p: &std::path::Path, v: &Value) -> Result<(), String> {
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("写入失败：{e}"))
}

/// 导入配置包（export_config 的逆向）：整体覆盖 settings.json 与 workspaces/*.json。
/// 仅接受 app == "x-dir" 的导出；version 高于当前实现时拒绝（防未知结构静默破坏）。
/// 成功后广播 config-imported（2026-11-11 审计补）：常驻剪贴板浮窗是独立
/// WebView、不随主窗设置热重载——导入含主题/直接粘贴偏好变更时由本事件
/// 触发浮窗重读 settings 立即跟随
#[tauri::command]
pub fn import_config(app: tauri::AppHandle, path: String) -> Result<ImportSummary, String> {
    use tauri::Emitter;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("不是有效的 JSON：{e}"))?;
    if v.get("app").and_then(|x| x.as_str()) != Some("x-dir") {
        return Err("不是 x-dir 导出的配置文件".into());
    }
    let ver = v.get("version").and_then(|x| x.as_u64()).unwrap_or(1);
    if ver > 1 {
        return Err(format!("配置版本过新（v{ver}），请升级程序后再导入"));
    }
    if let Some(settings) = v.get("settings") {
        if !settings.is_object() {
            return Err("配置包缺少有效的 settings 字段".into());
        }
        atomic_write_json(&config_root().join("settings.json"), settings)?;
    }
    let mut ws_count = 0usize;
    if let Some(wss) = v.get("workspaces").and_then(|x| x.as_object()) {
        let dir = workspaces_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
        for (name, tree) in wss {
            let safe = sanitize_name(name);
            if safe == "未命名" {
                continue;
            }
            atomic_write_json(&dir.join(format!("{safe}.json")), tree)?;
            ws_count += 1;
        }
    }
    // 工作日历日志可选恢复：包内无 worklog 键（旧版导出）时不动现有日志
    if let Some(wl) = v.get("worklog").filter(|wl| wl.is_object()) {
        atomic_write_json(&config_root().join("worklog.json"), wl)?;
    }
    let _ = app.emit("config-imported", ());
    Ok(ImportSummary {
        workspaces: ws_count,
        imported_settings: v.get("settings").is_some(),
    })
}
