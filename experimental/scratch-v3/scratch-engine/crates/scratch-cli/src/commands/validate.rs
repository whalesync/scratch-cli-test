use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;

use scratch_validate::{ValidateContext, ValidatorRegistry};

/// Validate records against JSON schemas and configured validators.
///
/// JSON Schema validation works offline (`.scratch/schemas/`).
/// Validators that compare against baselines (e.g. `readonly_fields`)
/// require an API connection to download the main-branch state.
pub async fn run(path: Option<&str>, api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;

    // Load JSON schemas
    let schemas_dir = root.join(".scratch/schemas");
    let schemas = load_schemas(&schemas_dir);

    // Load validator config
    let validators_path = root.join(".scratch/validators.json");
    let validator_config = load_validator_config(&validators_path);
    let has_validators = !validator_config.is_empty();

    // Load user-defined Rhai validators
    let validators_dir = root.join(".scratch/validators");
    let mut registry = ValidatorRegistry::new();
    registry
        .load_rhai_dir(&validators_dir)
        .map_err(|e| format!("Failed to load validators: {e}"))?;

    if schemas.is_empty() && !has_validators && registry.names().len() == 3 {
        eprintln!(
            "{}No schemas or validators found. Nothing to validate.{}",
            color::yellow(),
            color::reset()
        );
        return Ok(());
    }

    if !schemas.is_empty() {
        eprintln!(
            "Loaded {} schema(s) from .scratch/schemas/",
            schemas.len()
        );
    }
    if has_validators {
        eprintln!("Loaded validator config for {} folder(s)", validator_config.len());
    }

    // Load baseline files from main branch if any validator needs originals
    let baseline = if has_validators {
        load_baseline(&root, api_url_override).await
    } else {
        HashMap::new()
    };

    // Determine which folders to validate
    let target = match path {
        Some(p) => workspace::resolve_folder(&root, p),
        None => root.clone(),
    };

    if !target.is_dir() {
        return Err(format!("Path is not a directory: {}", target.display()));
    }

    let folders = collect_record_folders(&target, &root);
    if folders.is_empty() {
        eprintln!("No record folders found.");
        return Ok(());
    }

    let mut total_records = 0usize;
    let mut total_errors = 0usize;
    let mut total_warnings = 0usize;
    let mut total_valid = 0usize;

    for (folder_path, schema_id) in &folders {
        let records = workspace::load_records(folder_path, &root);
        if records.is_empty() {
            continue;
        }

        let schema = schemas.get(schema_id.as_str());
        let folder_validators = validator_config.get(schema_id.as_str());
        if schema.is_none() && folder_validators.is_none() {
            continue;
        }

        // Build folder_records map for cross-record validators
        let folder_records: HashMap<String, Value> = records
            .iter()
            .map(|r| (r.file_path.clone(), r.fields.clone()))
            .collect();

        eprintln!("\nValidating {} ({} records):", schema_id, records.len());

        for record in &records {
            total_records += 1;

            let mut options = HashMap::new();
            if let Some(config) = folder_validators {
                if let Some(readonly_fields) = config.get("readonly_fields") {
                    options.insert("fields".to_string(), readonly_fields.clone());
                }
            }

            let original = baseline.get(&record.file_path).cloned();

            let ctx = ValidateContext {
                record: record.fields.clone(),
                original_record: original,
                schema: schema.cloned(),
                folder_records: folder_records.clone(),
                options,
                file_path: record.file_path.clone(),
            };

            let result = scratch_validate::validate(&ctx, &registry);

            if result.issues.is_empty() {
                total_valid += 1;
            } else {
                let errors: Vec<_> = result.issues.iter().filter(|i| !i.warning).collect();
                let warnings: Vec<_> = result.issues.iter().filter(|i| i.warning).collect();

                if !errors.is_empty() {
                    total_errors += errors.len();
                    println!(
                        "  {}FAIL{} {} ({} error(s))",
                        color::red(),
                        color::reset(),
                        record.file_path,
                        errors.len()
                    );
                    for issue in &errors {
                        let p = if issue.path.is_empty() { "(root)" } else { &issue.path };
                        println!("    - {}: {}", p, issue.message);
                    }
                }
                if !warnings.is_empty() {
                    total_warnings += warnings.len();
                    println!(
                        "  {}WARN{} {} ({} warning(s))",
                        color::yellow(),
                        color::reset(),
                        record.file_path,
                        warnings.len()
                    );
                    for issue in &warnings {
                        let p = if issue.path.is_empty() { "(root)" } else { &issue.path };
                        println!("    - {}: {}", p, issue.message);
                    }
                }
                if errors.is_empty() {
                    // Warnings only — still counts as valid
                    total_valid += 1;
                }
            }
        }
    }

    println!("\n--- Validation Summary ---");
    println!("  Records:   {total_records}");
    println!("  Valid:     {total_valid}");
    println!("  Errors:    {total_errors}");
    if total_warnings > 0 {
        println!("  Warnings:  {total_warnings}");
    }

    if total_errors > 0 {
        eprintln!(
            "\n{}Validation failed with {total_errors} error(s).{}",
            color::red(),
            color::reset()
        );
        return Err(format!("{total_errors} validation error(s) found"));
    }

    eprintln!(
        "\n{}All records valid.{}",
        color::green(),
        color::reset()
    );
    Ok(())
}

/// Load JSON Schema files from a directory, keyed by filename stem.
fn load_schemas(dir: &Path) -> HashMap<String, Value> {
    let mut schemas = HashMap::new();
    if !dir.is_dir() {
        return schemas;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return schemas,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(schema) = serde_json::from_str::<Value>(&content) {
                        schemas.insert(stem.to_string(), schema);
                    }
                }
            }
        }
    }
    schemas
}

/// Load `.scratch/validators.json` — maps folder schema IDs to validator options.
///
/// Format:
/// ```json
/// {
///   "wordpress/posts": {
///     "readonly_fields": ["status", "date"]
///   }
/// }
/// ```
fn load_validator_config(path: &Path) -> HashMap<String, HashMap<String, Value>> {
    if !path.is_file() {
        return HashMap::new();
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<HashMap<String, HashMap<String, Value>>>(&content) {
        Ok(config) => config,
        Err(e) => {
            eprintln!(
                "{}Warning: failed to parse validators.json: {e}{}",
                color::yellow(),
                color::reset()
            );
            HashMap::new()
        }
    }
}

/// Download files from the main (published) branch and index by relative path.
async fn load_baseline(
    root: &Path,
    api_url_override: Option<&str>,
) -> HashMap<String, Value> {
    let config = match WorkspaceConfig::load(root) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "{}Warning: cannot load baseline — {e}. Readonly checks will be skipped.{}",
                color::yellow(),
                color::reset()
            );
            return HashMap::new();
        }
    };

    let client = config.api_client(api_url_override);
    let download = match client.download_baseline(&config.workbook_id).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!(
                "{}Warning: failed to download baseline from main branch — {e}. Readonly checks will be skipped.{}",
                color::yellow(),
                color::reset()
            );
            return HashMap::new();
        }
    };

    let files = download
        .get("files")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut map = HashMap::new();
    for file in files {
        let path = file.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let content = file.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() || content.is_empty() {
            continue;
        }
        // path starts with / — strip to get relative path matching record.file_path
        let rel = path.trim_start_matches('/');
        if let Ok(value) = serde_json::from_str::<Value>(content) {
            map.insert(rel.to_string(), value);
        }
    }

    if !map.is_empty() {
        eprintln!("Loaded {} baseline file(s) from main branch", map.len());
    }

    map
}

/// Collect directories that contain JSON files, paired with their schema ID
/// (derived from the directory name relative to the workspace root).
fn collect_record_folders(
    target: &Path,
    workspace_root: &Path,
) -> Vec<(std::path::PathBuf, String)> {
    let mut folders = Vec::new();

    if target.is_dir() {
        if has_json_files(target) {
            let schema_id = target
                .strip_prefix(workspace_root)
                .unwrap_or(target)
                .to_string_lossy()
                .to_string();
            if !schema_id.is_empty() && !schema_id.starts_with(".scratch") {
                folders.push((target.to_path_buf(), schema_id));
            }
        }

        if let Ok(entries) = std::fs::read_dir(target) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    if name.starts_with('.') {
                        continue;
                    }
                    let mut sub = collect_record_folders(&path, workspace_root);
                    folders.append(&mut sub);
                }
            }
        }
    }

    folders
}

/// Check if a directory contains at least one `.json` file.
fn has_json_files(dir: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
                return true;
            }
        }
    }
    false
}
