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
/// 马赛克格/shotBlurAlpha 模糊不透明度，2026-10-30「滚轮记忆」定案）
#[tauri::command]
pub fn shot_save_prefs(prefs: Value) -> Result<(), String> {
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

#[tauri::command]
pub fn save_settings(json: Value) -> Result<(), String> {
    let p = config_root().join("settings.json");
    serde_json::to_string_pretty(&json)
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
    let bundle = serde_json::json!({
        "app": "x-dir",
        "version": 1,
        "exportedAt": exported_at,
        "settings": settings,
        "workspaces": workspaces,
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
#[tauri::command]
pub fn import_config(path: String) -> Result<ImportSummary, String> {
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
    Ok(ImportSummary {
        workspaces: ws_count,
        imported_settings: v.get("settings").is_some(),
    })
}
