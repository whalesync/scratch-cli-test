use scratch_core::types::SyncRecord;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Walk up from the current working directory looking for a `.scratch/` directory.
/// Returns the workspace root (parent of `.scratch/`) if found.
pub fn find_workspace_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut dir = cwd.as_path();

    loop {
        if dir.join(".scratch").is_dir() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

/// Resolve a relative path against the workspace root.
pub fn resolve_folder(workspace_root: &Path, path: &str) -> PathBuf {
    let clean = path.trim_start_matches('/');
    workspace_root.join(clean)
}

/// Load all `*.json` schema files from `.scratch/schemas/`.
/// Keys are the filename stem (e.g. `articles` for `articles.json`).
pub fn load_schemas(workspace_root: &Path) -> HashMap<String, Value> {
    let schemas_dir = workspace_root.join(".scratch/schemas");
    let mut schemas = HashMap::new();

    if !schemas_dir.is_dir() {
        return schemas;
    }

    let entries = match std::fs::read_dir(&schemas_dir) {
        Ok(e) => e,
        Err(_) => return schemas,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        schemas.insert(stem, value);
    }

    schemas
}

/// Read all JSON files from a folder and build a list of `SyncRecord` entries.
/// Each record's `id` is derived from the `id` field in the JSON, falling back
/// to the filename stem. The `file_path` is relative to the workspace root.
pub fn load_records(folder: &Path, workspace_root: &Path) -> Vec<SyncRecord> {
    let mut records = Vec::new();

    if !folder.is_dir() {
        return records;
    }

    let entries = match std::fs::read_dir(folder) {
        Ok(e) => e,
        Err(_) => return records,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let fields: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let file_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        let id = fields
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| file_stem.clone());

        let file_path = path
            .strip_prefix(workspace_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        records.push(SyncRecord {
            id,
            file_path,
            fields,
        });
    }

    records
}
