use std::collections::HashMap;
use std::sync::LazyLock;

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use serde::Deserialize;
use serde_json::Value;
use tokio::runtime::Runtime;

use scratch_core::types::*;
use scratch_git_client::client::GitClient;
use scratch_merge::merge::FileMap;
use scratch_sync::context::SyncContext;
use scratch_transform::TransformerRegistry;
use scratch_validate::{ValidateContext, ValidatorRegistry};

static RUNTIME: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("Failed to create Tokio runtime"));

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/// JSON-serializable representation of SyncContext.
/// SyncContext uses tuple keys `(String, String)` which don't serialize well,
/// so we use unit-separator (\x1f) delimited string keys instead.
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncContextJson {
    #[serde(default)]
    remote_id_mappings: HashMap<String, RemoteIdMapping>,
    #[serde(default)]
    fk_record_cache: HashMap<String, Value>,
}

/// Key delimiter for composite keys. Uses unit separator (U+001F) to avoid
/// collisions with IDs that may contain colons.
const KEY_DELIM: char = '\x1f';

/// Split a delimited key string into a `(String, String)` tuple.
/// Falls back to `(full_key, "")` if no delimiter is found.
fn split_key(key: &str) -> (String, String) {
    match key.find(KEY_DELIM) {
        Some(idx) => (key[..idx].to_string(), key[idx + KEY_DELIM.len_utf8()..].to_string()),
        None => (key.to_string(), String::new()),
    }
}

/// Parse a phase string into `SyncPhase`.
fn parse_phase(phase: &str) -> PyResult<SyncPhase> {
    match phase {
        "DATA" => Ok(SyncPhase::Data),
        "FOREIGN_KEY_MAPPING" => Ok(SyncPhase::ForeignKeyMapping),
        _ => Err(PyErr::new::<PyValueError, _>(format!(
            "Invalid phase: '{}'. Expected 'DATA' or 'FOREIGN_KEY_MAPPING'",
            phase
        ))),
    }
}

/// Deserialize a JSON string, returning a Python ValueError on failure.
fn from_json<T: serde::de::DeserializeOwned>(json_str: &str, label: &str) -> PyResult<T> {
    serde_json::from_str(json_str).map_err(|e| {
        PyErr::new::<PyValueError, _>(format!("Failed to parse {}: {}", label, e))
    })
}

/// Serialize a value to a JSON string, returning a Python RuntimeError on failure.
fn to_json<T: serde::Serialize>(value: &T) -> PyResult<String> {
    serde_json::to_string(value).map_err(|e| {
        PyErr::new::<PyRuntimeError, _>(format!("Failed to serialize result: {}", e))
    })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Validate a record against a JSON schema.
///
/// Returns a JSON array of validation error objects, each with `path`, `message`,
/// and `warning` fields. An empty array means the record is valid.
#[pyfunction]
fn validate_record(record_json: &str, schema_json: &str) -> PyResult<String> {
    let record: Value = from_json(record_json, "record")?;
    let schema: Value = from_json(schema_json, "schema")?;

    let registry = ValidatorRegistry::new();
    let ctx = ValidateContext {
        record,
        original_record: None,
        schema: Some(schema),
        folder_records: HashMap::new(),
        options: HashMap::new(),
        file_path: String::new(),
    };

    let result = scratch_validate::validate_with(&ctx, &registry, &["json_schema"]);

    let issue_values: Vec<Value> = result
        .issues
        .into_iter()
        .map(|i| {
            serde_json::json!({
                "path": i.path,
                "message": i.message,
                "warning": i.warning,
            })
        })
        .collect();

    to_json(&issue_values)
}

/// Validate all records in a folder using the full validator pipeline.
///
/// Arguments:
///   records_json: JSON object mapping file paths to record values
///   schema_json:  JSON Schema for this folder (optional, pass "null" to skip)
///   originals_json: JSON object mapping file paths to original record values (optional, pass "null")
///   validators_dir: Path to a directory of `.rhai` validator scripts (optional, pass "" to skip)
///
/// Returns a JSON object mapping file paths to arrays of issue objects.
/// Each issue has `path`, `message`, and `warning` (boolean) fields.
/// File paths with no issues are omitted from the result.
#[pyfunction]
#[pyo3(signature = (records_json, schema_json="null", originals_json="null", validators_dir=""))]
fn validate_folder(
    records_json: &str,
    schema_json: &str,
    originals_json: &str,
    validators_dir: &str,
) -> PyResult<String> {
    let records: HashMap<String, Value> = from_json(records_json, "records")?;
    let schema: Option<Value> = match schema_json {
        "null" | "" => None,
        s => Some(from_json(s, "schema")?),
    };
    let originals: Option<HashMap<String, Value>> = match originals_json {
        "null" | "" => None,
        s => Some(from_json(s, "originals")?),
    };

    let mut registry = ValidatorRegistry::new();
    if !validators_dir.is_empty() {
        let dir = std::path::Path::new(validators_dir);
        registry
            .load_rhai_dir(dir)
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    }

    let mut results: serde_json::Map<String, Value> = serde_json::Map::new();

    for (file_path, record) in &records {
        let original = originals
            .as_ref()
            .and_then(|o| o.get(file_path))
            .cloned();

        let ctx = ValidateContext {
            record: record.clone(),
            original_record: original,
            schema: schema.clone(),
            folder_records: records.clone(),
            options: HashMap::new(),
            file_path: file_path.clone(),
        };

        let result = scratch_validate::validate(&ctx, &registry);

        if !result.issues.is_empty() {
            let issues: Vec<Value> = result
                .issues
                .into_iter()
                .map(|i| {
                    serde_json::json!({
                        "path": i.path,
                        "message": i.message,
                        "warning": i.warning,
                    })
                })
                .collect();
            results.insert(file_path.clone(), Value::Array(issues));
        }
    }

    to_json(&Value::Object(results))
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

/// Run the sync engine for a single table mapping.
///
/// All parameters are JSON strings. Returns a JSON string containing the `SyncOutput`.
#[pyfunction]
fn sync_table_mapping(
    config_json: &str,
    source_records_json: &str,
    dest_records_json: &str,
    source_schema_json: &str,
    dest_schema_json: &str,
    phase: &str,
    context_json: &str,
) -> PyResult<String> {
    let table_mapping: TableMapping = from_json(config_json, "config (TableMapping)")?;
    let source_records: Vec<SyncRecord> = from_json(source_records_json, "source_records")?;
    let dest_records: Vec<SyncRecord> = from_json(dest_records_json, "dest_records")?;
    let sync_phase = parse_phase(phase)?;

    // Parse schemas — allow empty string or "null" to mean None.
    let source_schema: Option<Value> = if source_schema_json.is_empty()
        || source_schema_json == "null"
    {
        None
    } else {
        Some(from_json(source_schema_json, "source_schema")?)
    };
    let dest_schema: Option<Value> = if dest_schema_json.is_empty()
        || dest_schema_json == "null"
    {
        None
    } else {
        Some(from_json(dest_schema_json, "dest_schema")?)
    };

    // Parse context — convert colon-delimited keys to tuple keys.
    let ctx_json: SyncContextJson = from_json(context_json, "context")?;
    let mut ctx = SyncContext {
        remote_id_mappings: ctx_json
            .remote_id_mappings
            .into_iter()
            .map(|(k, v)| (split_key(&k), v))
            .collect(),
        fk_record_cache: ctx_json
            .fk_record_cache
            .into_iter()
            .map(|(k, v)| (split_key(&k), v))
            .collect(),
    };

    let registry = TransformerRegistry::new();

    let output = scratch_sync::engine::sync_table_mapping(
        &table_mapping,
        &source_records,
        &dest_records,
        source_schema.as_ref(),
        dest_schema.as_ref(),
        sync_phase,
        &mut ctx,
        &registry,
    );

    // Serialize updated context back to delimited keys for Python.
    let updated_ctx = SyncContextJson {
        remote_id_mappings: ctx
            .remote_id_mappings
            .into_iter()
            .map(|((k1, k2), v)| (format!("{}{}{}", k1, KEY_DELIM, k2), v))
            .collect(),
        fk_record_cache: ctx
            .fk_record_cache
            .into_iter()
            .map(|((k1, k2), v)| (format!("{}{}{}", k1, KEY_DELIM, k2), v))
            .collect(),
    };

    let result = serde_json::json!({
        "output": output,
        "context": updated_ctx,
    });

    to_json(&result)
}

// ---------------------------------------------------------------------------
// Publish plan
// ---------------------------------------------------------------------------

/// Build a publish plan from pre-loaded data.
///
/// All parameters are JSON strings. Returns a JSON string containing the `PublishPlan`.
#[pyfunction]
fn build_publish_plan(
    changes_json: &str,
    file_contents_json: &str,
    main_contents_json: &str,
    schemas_json: &str,
    file_index_json: &str,
    folder_lookup_json: &str,
) -> PyResult<String> {
    let changes: Vec<FileChange> = from_json(changes_json, "changes")?;
    let file_contents: HashMap<String, Value> = from_json(file_contents_json, "file_contents")?;
    let main_contents: HashMap<String, Value> = from_json(main_contents_json, "main_contents")?;
    let schemas: HashMap<String, Value> = from_json(schemas_json, "schemas")?;
    let file_index: HashMap<String, String> = from_json(file_index_json, "file_index")?;
    let folder_lookup: HashMap<String, String> = from_json(folder_lookup_json, "folder_lookup")?;

    let plan = scratch_publish::plan_builder::build_publish_plan(
        &changes,
        &file_contents,
        &main_contents,
        &schemas,
        &file_index,
        &folder_lookup,
    );

    to_json(&plan)
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/// Compute merge actions for three-way file comparison.
///
/// Each parameter is a JSON string representing a `HashMap<String, Vec<u8>>` (file map),
/// where the values are base64-encoded byte arrays or UTF-8 strings.
/// Returns a JSON array of merge action objects.
#[pyfunction]
fn compute_merge_actions(base_json: &str, local_json: &str, remote_json: &str) -> PyResult<String> {
    let base: HashMap<String, Vec<u8>> = from_json(base_json, "base file map")?;
    let local: HashMap<String, Vec<u8>> = from_json(local_json, "local file map")?;
    let remote: HashMap<String, Vec<u8>> = from_json(remote_json, "remote file map")?;

    let base_map: FileMap = base;
    let local_map: FileMap = local;
    let remote_map: FileMap = remote;

    let actions = scratch_merge::merge::compute_merge_actions(&base_map, &local_map, &remote_map);

    // MergeAction doesn't derive Serialize, so we manually build JSON.
    let action_values: Vec<Value> = actions
        .into_iter()
        .map(|a| {
            let action_str = match a.action {
                scratch_merge::merge::ActionType::KeepLocal => "keep_local",
                scratch_merge::merge::ActionType::WriteRemote => "write_remote",
                scratch_merge::merge::ActionType::Delete => "delete",
                scratch_merge::merge::ActionType::Merge => "merge",
            };
            serde_json::json!({
                "path": a.path,
                "action": action_str,
                "base": a.base,
                "local": a.local,
                "remote": a.remote,
                "warningMsg": a.warning_msg,
            })
        })
        .collect();

    to_json(&action_values)
}

/// Three-way text merge.
///
/// Takes base, local, and remote content as bytes. Returns the merged content as bytes.
/// If base is empty, local wins entirely.
#[pyfunction]
fn merge_text<'py>(
    py: Python<'py>,
    base: &[u8],
    local: &[u8],
    remote: &[u8],
) -> PyResult<Bound<'py, PyBytes>> {
    let base_opt = if base.is_empty() { None } else { Some(base) };
    let result = scratch_merge::text_merge::merge_text(base_opt, local, remote);
    Ok(PyBytes::new(py, &result))
}

// ---------------------------------------------------------------------------
// Transform (preview / testing)
// ---------------------------------------------------------------------------

/// Transform a single record using column mappings.
///
/// Returns a JSON object with `fields` (the transformed record) and `warnings` (array of strings).
#[pyfunction]
fn transform_record(record_json: &str, mappings_json: &str, phase: &str) -> PyResult<String> {
    let record: SyncRecord = from_json(record_json, "record")?;
    let mappings: Vec<ColumnMapping> = from_json(mappings_json, "mappings")?;
    let sync_phase = parse_phase(phase)?;
    let registry = TransformerRegistry::new();

    let result = scratch_sync::transform_record::transform_record(
        &record,
        &mappings,
        None, // no lookup tools
        sync_phase,
        None, // no base fields
        &registry,
    );

    match result {
        Ok((fields, warnings)) => {
            let output = serde_json::json!({
                "fields": fields,
                "warnings": warnings,
            });
            to_json(&output)
        }
        Err(e) => Err(PyErr::new::<PyRuntimeError, _>(format!(
            "Transform failed: {}",
            e
        ))),
    }
}

// ---------------------------------------------------------------------------
// Diff utility
// ---------------------------------------------------------------------------

/// Compute a sparse diff of changed fields between two JSON objects.
///
/// Returns a JSON object containing only the fields that differ between main and dirty.
#[pyfunction]
fn compute_changed_fields(main_json: &str, dirty_json: &str) -> PyResult<String> {
    let main: Value = from_json(main_json, "main")?;
    let dirty: Value = from_json(dirty_json, "dirty")?;
    let changed = scratch_publish::diff_utils::compute_changed_fields(&main, &dirty);
    to_json(&changed)
}

// ---------------------------------------------------------------------------
// Git-integrated sync (bulk data stays in Rust)
// ---------------------------------------------------------------------------

/// Repo folder info for resolving referenced folders.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferencedFolder {
    folder_id: String,
    repo_id: String,
    folder_path: String,
}

/// Run a sync with git I/O handled entirely in Rust.
///
/// Only small config and summaries cross the FFI boundary.
/// Bulk record data is read/written inside Rust via the git service.
#[pyfunction]
fn run_sync(
    py: Python<'_>,
    git_url: &str,
    table_mapping_json: &str,
    src_repo_id: &str,
    src_folder_path: &str,
    dst_repo_id: &str,
    dst_folder_path: &str,
    phase: &str,
    context_json: &str,
    referenced_folders_json: &str,
    commit_message: &str,
) -> PyResult<String> {
    let mut table_mapping: TableMapping = from_json(table_mapping_json, "table_mapping")?;
    let sync_phase = parse_phase(phase)?;
    let ctx_json: SyncContextJson = from_json(context_json, "context")?;
    let referenced_folders: Vec<ReferencedFolder> =
        from_json(referenced_folders_json, "referenced_folders")?;

    // Rewrite destinationDataFolderId to the folder *path* (for Rust file path construction)
    let dst_path_stripped = dst_folder_path.trim_start_matches('/');
    table_mapping.destination_data_folder_id = dst_path_stripped.to_string();

    // Convert delimited keys to tuple keys
    let mut ctx = SyncContext {
        remote_id_mappings: ctx_json
            .remote_id_mappings
            .into_iter()
            .map(|(k, v)| (split_key(&k), v))
            .collect(),
        fk_record_cache: ctx_json
            .fk_record_cache
            .into_iter()
            .map(|(k, v)| (split_key(&k), v))
            .collect(),
    };

    let git_url = git_url.to_string();
    let src_repo_id = src_repo_id.to_string();
    let src_folder_path = src_folder_path.to_string();
    let dst_repo_id = dst_repo_id.to_string();
    let commit_message = commit_message.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);

            // Read schemas
            let src_schema = git
                .read_schema(&src_repo_id, &src_folder_path, "main")
                .await
                .unwrap_or(None);
            let dst_schema = git
                .read_schema(&dst_repo_id, &dst_folder_path, "dirty")
                .await
                .unwrap_or(None);

            // Read ID columns from schemas
            let src_id_col = scratch_core::schema::id_column(src_schema.as_ref()).to_string();
            let dst_id_col = scratch_core::schema::id_column(dst_schema.as_ref()).to_string();

            // Read records — bulk data stays in Rust
            let src_records = git
                .read_folder_records(&src_repo_id, &src_folder_path, "main", &src_id_col)
                .await
                .unwrap_or_default();
            let dst_records = git
                .read_folder_records(&dst_repo_id, &dst_folder_path, "dirty", &dst_id_col)
                .await
                .unwrap_or_default();

            // Populate FK cache from referenced folders (DATA phase only)
            if sync_phase == SyncPhase::Data {
                for rf in &referenced_folders {
                    // Skip if already cached
                    let prefix = &rf.folder_id;
                    if ctx
                        .fk_record_cache
                        .keys()
                        .any(|(k1, _)| k1 == prefix)
                    {
                        continue;
                    }

                    let id_col = git
                        .read_id_column(&rf.repo_id, &rf.folder_path, "main")
                        .await
                        .unwrap_or_else(|_| "id".to_string());

                    let records = git
                        .read_folder_records(&rf.repo_id, &rf.folder_path, "main", &id_col)
                        .await
                        .unwrap_or_default();

                    for record in &records {
                        ctx.fk_record_cache.insert(
                            (rf.folder_id.clone(), record.id.clone()),
                            record.fields.clone(),
                        );
                    }
                }
            }

            // Run the pure sync engine
            let registry = TransformerRegistry::new();
            let output = scratch_sync::engine::sync_table_mapping(
                &table_mapping,
                &src_records,
                &dst_records,
                src_schema.as_ref(),
                dst_schema.as_ref(),
                sync_phase,
                &mut ctx,
                &registry,
            );

            // Write output files to git
            if !output.files_to_write.is_empty() {
                let git_files: Vec<Value> = output
                    .files_to_write
                    .iter()
                    .map(|f| {
                        serde_json::json!({
                            "path": f.path,
                            "content": f.content,
                        })
                    })
                    .collect();

                if let Err(e) = git
                    .write_files(&dst_repo_id, &git_files, &commit_message, "dirty")
                    .await
                {
                    return Err(format!("Batch write failed: {e}"));
                }
            }

            Ok((output, ctx))
        })
    });

    let (output, ctx) = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;

    // Serialize updated context back to delimited keys for Python
    let updated_ctx = SyncContextJson {
        remote_id_mappings: ctx
            .remote_id_mappings
            .into_iter()
            .map(|((k1, k2), v)| (format!("{}{}{}", k1, KEY_DELIM, k2), v))
            .collect(),
        fk_record_cache: ctx
            .fk_record_cache
            .into_iter()
            .map(|((k1, k2), v)| (format!("{}{}{}", k1, KEY_DELIM, k2), v))
            .collect(),
    };

    let result_json = serde_json::json!({
        "output": output,
        "context": updated_ctx,
    });

    to_json(&result_json)
}

// ---------------------------------------------------------------------------
// Git-integrated publish plan builder
// ---------------------------------------------------------------------------

/// Repo+folders descriptor for build_plan_from_git.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoFolders {
    repo_id: String,
    folders: Vec<FolderInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderInfo {
    id: String,
    path: String,
}

// ---------------------------------------------------------------------------
// Helper types for git operations
// ---------------------------------------------------------------------------

/// Folder-to-repo mapping for download operations.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitFolderSpec {
    repo_id: String,
    folder_path: String,
}

/// File-to-repo mapping for publish operations.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitFileSpec {
    repo_id: String,
    path: String,
}

/// Repo write batch for push operations.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitWriteBatch {
    repo_id: String,
    files: Vec<Value>,
}

/// Build a publish plan with git I/O handled in Rust.
///
/// Reads git status, file contents, and schemas from the git service.
/// Only small config crosses the FFI boundary.
#[pyfunction]
fn build_plan_from_git(
    py: Python<'_>,
    git_url: &str,
    repo_folders_json: &str,
    file_index_json: &str,
) -> PyResult<String> {
    let repo_folders: Vec<RepoFolders> = from_json(repo_folders_json, "repo_folders")?;
    let file_index: HashMap<String, String> = from_json(file_index_json, "file_index")?;

    let git_url = git_url.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);

            // 1. Get git status for all repos in parallel
            let status_futures: Vec<_> = repo_folders
                .iter()
                .map(|rf| {
                    let git = &git;
                    let repo_id = &rf.repo_id;
                    async move { (repo_id.as_str(), git.git_status(repo_id).await) }
                })
                .collect();

            let status_results = futures::future::join_all(status_futures).await;

            // Build folder lookup: folder_path → list of folders in that repo
            let mut folder_by_path: HashMap<String, (&str, &FolderInfo)> = HashMap::new();
            for rf in &repo_folders {
                for folder in &rf.folders {
                    let stripped = folder.path.trim_start_matches('/');
                    folder_by_path.insert(stripped.to_string(), (&rf.repo_id, folder));
                }
            }

            // 2. Collect changes and build folder_lookup
            let mut changes: Vec<FileChange> = Vec::new();
            let mut folder_lookup: HashMap<String, String> = HashMap::new();
            let mut dirty_read_tasks: Vec<(String, String)> = Vec::new(); // (repo_id, path)
            let mut main_read_tasks: Vec<(String, String)> = Vec::new();

            for (repo_id, status_result) in &status_results {
                let entries = match status_result {
                    Ok(Value::Array(arr)) => arr.clone(),
                    Ok(other) => vec![other.clone()],
                    Err(_) => continue,
                };

                for entry in &entries {
                    let raw_path = entry
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if raw_path.is_empty() {
                        continue;
                    }

                    // Normalize path: ensure leading /
                    let path = if raw_path.starts_with('/') {
                        raw_path.to_string()
                    } else {
                        format!("/{raw_path}")
                    };
                    let stripped = path.trim_start_matches('/').to_string();

                    let status_str = entry
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("modified");
                    let status = match status_str {
                        "added" => FileChangeStatus::Added,
                        "deleted" => FileChangeStatus::Deleted,
                        _ => FileChangeStatus::Modified,
                    };

                    // Find containing folder
                    let mut found_folder: Option<&str> = None;
                    for (folder_path, (_, _folder_info)) in &folder_by_path {
                        if stripped.starts_with(folder_path)
                            && (stripped.len() == folder_path.len()
                                || stripped[folder_path.len()..].starts_with('/'))
                        {
                            // Pick the longest (most specific) match
                            if found_folder.map_or(true, |prev| folder_path.len() > prev.len()) {
                                found_folder = Some(folder_path.as_str());
                            }
                        }
                    }

                    if let Some(fp) = found_folder {
                        let (_, folder_info) = folder_by_path[fp];
                        folder_lookup.insert(stripped.clone(), folder_info.id.clone());
                    }

                    changes.push(FileChange {
                        path: stripped.clone(),
                        status,
                    });

                    if status != FileChangeStatus::Deleted {
                        dirty_read_tasks.push((repo_id.to_string(), stripped.clone()));
                    }
                    if status != FileChangeStatus::Added {
                        main_read_tasks.push((repo_id.to_string(), stripped.clone()));
                    }
                }
            }

            if changes.is_empty() {
                return Ok(PublishPlan { operations: vec![] });
            }

            // 3. Read dirty and main file contents in parallel
            let mut file_contents: HashMap<String, Value> = HashMap::new();
            let mut main_contents: HashMap<String, Value> = HashMap::new();

            let dirty_futures: Vec<_> = dirty_read_tasks
                .iter()
                .map(|(repo_id, path)| {
                    let git = &git;
                    async move {
                        let result = git.read_file(repo_id, path, "dirty").await;
                        (path.clone(), result)
                    }
                })
                .collect();

            let main_futures: Vec<_> = main_read_tasks
                .iter()
                .map(|(repo_id, path)| {
                    let git = &git;
                    async move {
                        let result = git.read_file(repo_id, path, "main").await;
                        (path.clone(), result)
                    }
                })
                .collect();

            let (dirty_results, main_results) = tokio::join!(
                futures::future::join_all(dirty_futures),
                futures::future::join_all(main_futures),
            );

            for (path, result) in dirty_results {
                if let Ok(data) = result {
                    if let Some(content) = parse_git_file_content(&data) {
                        file_contents.insert(path, content);
                    }
                }
            }

            for (path, result) in main_results {
                if let Ok(data) = result {
                    if let Some(content) = parse_git_file_content(&data) {
                        main_contents.insert(path, content);
                    }
                }
            }

            // 4. Read schemas per folder
            let mut schemas: HashMap<String, Value> = HashMap::new();
            let mut seen_folders: std::collections::HashSet<String> = std::collections::HashSet::new();

            for change in &changes {
                // Find which folder this change belongs to
                if let Some(folder_id) = folder_lookup.get(&change.path) {
                    if seen_folders.contains(folder_id) {
                        continue;
                    }
                    seen_folders.insert(folder_id.clone());

                    // Find the repo_id and folder_path for this folder
                    for rf in &repo_folders {
                        for folder in &rf.folders {
                            if &folder.id == folder_id {
                                let stripped_path =
                                    folder.path.trim_start_matches('/').to_string();
                                if let Ok(Some(schema_file)) = git
                                    .read_schema(&rf.repo_id, &folder.path, "main")
                                    .await
                                {
                                    // .scratch/schema.json wraps the JSON Schema
                                    // under a "schema" key — unwrap for the plan builder
                                    let json_schema = schema_file
                                        .get("schema")
                                        .cloned()
                                        .unwrap_or(schema_file);
                                    schemas.insert(stripped_path, json_schema);
                                }
                            }
                        }
                    }
                }
            }

            // 5. Strip leading / from file_index keys
            let rust_file_index: HashMap<String, String> = file_index
                .into_iter()
                .map(|(k, v)| (k.trim_start_matches('/').to_string(), v))
                .collect();

            // 6. Build plan
            let plan = scratch_publish::plan_builder::build_publish_plan(
                &changes,
                &file_contents,
                &main_contents,
                &schemas,
                &rust_file_index,
                &folder_lookup,
            );

            Ok(plan)
        })
    });

    let plan = result.map_err(|e: String| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&plan)
}

/// Parse git file content from a response Value (string JSON or object).
fn parse_git_file_content(data: &Value) -> Option<Value> {
    match data.get("content") {
        Some(Value::String(s)) => serde_json::from_str(s).ok(),
        Some(v @ Value::Object(_)) => Some(v.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Git operations (PyO3 orchestrators)
// ---------------------------------------------------------------------------

/// Get dirty files across multiple repos in parallel.
///
/// Returns a JSON array of `{path, status}` objects with normalized paths.
#[pyfunction]
fn git_get_dirty_files(py: Python<'_>, git_url: &str, repo_ids_json: &str) -> PyResult<String> {
    let repo_ids: Vec<String> = from_json(repo_ids_json, "repo_ids")?;
    let git_url = git_url.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let futs: Vec<_> = repo_ids
                .iter()
                .map(|rid| {
                    let git = &git;
                    async move { git.git_status(rid).await }
                })
                .collect();

            let results = futures::future::join_all(futs).await;
            let mut all_dirty: Vec<Value> = Vec::new();
            for status_result in results {
                let entries = match status_result {
                    Ok(Value::Array(arr)) => arr,
                    _ => continue,
                };
                for mut entry in entries {
                    if let Some(path) =
                        entry.get("path").and_then(|v| v.as_str()).map(String::from)
                    {
                        let normalized = if path.starts_with('/') {
                            path
                        } else {
                            format!("/{path}")
                        };
                        entry["path"] = Value::String(normalized);
                    }
                    all_dirty.push(entry);
                }
            }
            all_dirty
        })
    });

    to_json(&result)
}

/// Download all files across multiple folders.
///
/// Returns a JSON array of `{path, content}` objects.
/// `branch` defaults to `"dirty"` if not provided.
#[pyfunction]
#[pyo3(signature = (git_url, folder_specs_json, branch = "dirty"))]
fn git_download_all_files(
    py: Python<'_>,
    git_url: &str,
    folder_specs_json: &str,
    branch: &str,
) -> PyResult<String> {
    let folder_specs: Vec<GitFolderSpec> = from_json(folder_specs_json, "folder_specs")?;
    let git_url = git_url.to_string();
    let branch = branch.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let mut all_files: Vec<Value> = Vec::new();

            for spec in &folder_specs {
                let folder_path = spec.folder_path.trim_start_matches('/');
                let items = match git.list_files(&spec.repo_id, folder_path, &branch).await {
                    Ok(items) => items,
                    Err(_) => continue,
                };

                let paths: Vec<String> = items
                    .iter()
                    .filter(|item| {
                        let is_file =
                            item.get("type").and_then(|v| v.as_str()) == Some("file");
                        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        is_file && !name.starts_with('.')
                    })
                    .filter_map(|item| {
                        item.get("path")
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim_start_matches('/').to_string())
                    })
                    .collect();

                if paths.is_empty() {
                    continue;
                }

                let batch =
                    match git.read_files_batch(&spec.repo_id, &paths, &branch).await {
                        Ok(batch) => batch,
                        Err(_) => continue,
                    };

                for item in &batch {
                    let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let normalized = if path.starts_with('/') {
                        path.to_string()
                    } else {
                        format!("/{path}")
                    };
                    let content =
                        item.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    all_files.push(serde_json::json!({
                        "path": normalized,
                        "content": content,
                    }));
                }
            }

            all_files
        })
    });

    to_json(&result)
}

/// Push files to git repos (dirty branch).
///
/// Returns a JSON object `{written, errors}`.
#[pyfunction]
fn git_push_files(
    py: Python<'_>,
    git_url: &str,
    repo_writes_json: &str,
) -> PyResult<String> {
    let repo_writes: Vec<GitWriteBatch> = from_json(repo_writes_json, "repo_writes")?;
    let git_url = git_url.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let mut written = 0usize;
            let mut errors: Vec<String> = Vec::new();

            for rw in &repo_writes {
                match git.write_files(&rw.repo_id, &rw.files, "", "dirty").await {
                    Ok(_) => written += rw.files.len(),
                    Err(e) => errors.push(format!("Repo {}: {}", rw.repo_id, e)),
                }
            }

            serde_json::json!({"written": written, "errors": errors})
        })
    });

    to_json(&result)
}

/// Publish a single file from dirty to main branch.
#[pyfunction]
fn git_publish_file(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    path: &str,
) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let path = path.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let file_data = git
                .read_file(&repo_id, &path, "dirty")
                .await
                .map_err(|e| format!("Read failed: {e}"))?;
            let content = file_data
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            git.publish(&repo_id, &path, content)
                .await
                .map_err(|e| format!("Publish failed: {e}"))?;
            Ok::<_, String>(serde_json::json!({"ok": true}))
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Publish multiple files from dirty to main.
///
/// Returns a JSON object `{published, errors}`.
#[pyfunction]
fn git_publish_all(
    py: Python<'_>,
    git_url: &str,
    file_specs_json: &str,
) -> PyResult<String> {
    let file_specs: Vec<GitFileSpec> = from_json(file_specs_json, "file_specs")?;
    let git_url = git_url.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let mut published = 0usize;
            let mut errors: Vec<String> = Vec::new();

            for spec in &file_specs {
                let file_data =
                    match git.read_file(&spec.repo_id, &spec.path, "dirty").await {
                        Ok(d) => d,
                        Err(e) => {
                            errors.push(format!("{}: {e}", spec.path));
                            continue;
                        }
                    };
                let content = file_data
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match git.publish(&spec.repo_id, &spec.path, content).await {
                    Ok(_) => published += 1,
                    Err(e) => errors.push(format!("{}: {e}", spec.path)),
                }
            }

            serde_json::json!({"published": published, "errors": errors})
        })
    });

    to_json(&result)
}

/// Discard changes for a single file.
#[pyfunction]
fn git_discard_changes(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    path: &str,
) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let path = path.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            git.discard_changes(&repo_id, &path)
                .await
                .map_err(|e| format!("Discard failed: {e}"))?;
            Ok::<_, String>(serde_json::json!({"ok": true}))
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Read a file from git with dirty content and original (base) content.
///
/// Returns `{path, content, originalContent}`.
#[pyfunction]
fn git_read_file(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    path: &str,
) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let path = path.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let stripped = path.trim_start_matches('/');

            let (dirty_result, diff_result) = tokio::join!(
                git.read_file(&repo_id, stripped, "dirty"),
                git.read_diff(&repo_id, stripped),
            );

            let content = dirty_result
                .ok()
                .and_then(|d| d.get("content").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_default();

            let original_content = diff_result.ok().and_then(|d| d.get("base").cloned());

            let mut result = serde_json::json!({
                "path": path,
                "content": content,
            });
            if let Some(orig) = original_content {
                result["originalContent"] = orig;
            }

            result
        })
    });

    to_json(&result)
}

/// Write files to a git repository.
#[pyfunction]
fn git_write_files(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    files_json: &str,
    branch: &str,
) -> PyResult<String> {
    let files: Vec<Value> = from_json(files_json, "files")?;
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let branch = branch.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            git.write_files(&repo_id, &files, "", &branch)
                .await
                .map_err(|e| format!("Write failed: {e}"))?;
            Ok::<_, String>(serde_json::json!({"ok": true}))
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Publish a file to main with explicit content (no dirty read).
#[pyfunction]
fn git_publish_content(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    path: &str,
    content: &str,
) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let path = path.to_string();
    let content = content.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            git.publish(&repo_id, &path, &content)
                .await
                .map_err(|e| format!("Publish failed: {e}"))?;
            Ok::<_, String>(serde_json::json!({"ok": true}))
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Rename files in a repository folder.
#[pyfunction]
fn git_rename_files(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    folder_path: &str,
    renames_json: &str,
) -> PyResult<String> {
    let renames: Vec<Value> = from_json(renames_json, "renames")?;
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let folder_path = folder_path.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            git.rename_files(&repo_id, &folder_path, &renames)
                .await
                .map_err(|e| format!("Rename failed: {e}"))?;
            Ok::<_, String>(serde_json::json!({"ok": true}))
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// List files in a folder on a specific branch.
#[pyfunction]
fn git_list_files(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    folder: &str,
    branch: &str,
) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let folder = folder.to_string();
    let branch = branch.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let items = git
                .list_files(&repo_id, &folder, &branch)
                .await
                .map_err(|e| format!("List failed: {e}"))?;
            Ok::<_, String>(items)
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Rebase the dirty branch onto the latest main.
#[pyfunction]
fn git_rebase_dirty(py: Python<'_>, git_url: &str, repo_id: &str) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            git.rebase_dirty(&repo_id)
                .await
                .map_err(|e| format!("Rebase failed: {e}"))?;
            Ok::<_, String>(serde_json::json!({"ok": true}))
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Read a single file from any branch (without diff).
#[pyfunction]
fn git_read_file_content(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    path: &str,
    branch: &str,
) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let path = path.to_string();
    let branch = branch.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let data = git
                .read_file(&repo_id, &path, &branch)
                .await
                .map_err(|e| format!("Read failed: {e}"))?;
            Ok::<_, String>(data)
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Read multiple files from a single repo in one batch.
///
/// Returns a JSON array of file objects with `{path, content}`.
#[pyfunction]
fn git_read_files_batch(
    py: Python<'_>,
    git_url: &str,
    repo_id: &str,
    paths_json: &str,
    branch: &str,
) -> PyResult<String> {
    let paths: Vec<String> = from_json(paths_json, "paths")?;
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();
    let branch = branch.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let batch = git
                .read_files_batch(&repo_id, &paths, &branch)
                .await
                .map_err(|e| format!("Batch read failed: {e}"))?;
            Ok::<_, String>(batch)
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Initialize a git repository.
#[pyfunction]
fn git_init_repo(py: Python<'_>, git_url: &str, repo_id: &str) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            git.init_repo(&repo_id)
                .await
                .map_err(|e| format!("Init failed: {e}"))?;
            Ok::<_, String>(serde_json::json!({"ok": true}))
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

/// Get git status for a single repo.
#[pyfunction]
fn git_status(py: Python<'_>, git_url: &str, repo_id: &str) -> PyResult<String> {
    let git_url = git_url.to_string();
    let repo_id = repo_id.to_string();

    let result = py.allow_threads(|| {
        RUNTIME.block_on(async {
            let git = GitClient::new(&git_url);
            let val = git
                .git_status(&repo_id)
                .await
                .map_err(|e| format!("Status failed: {e}"))?;
            Ok::<_, String>(val)
        })
    });

    let val = result.map_err(|e| PyErr::new::<PyRuntimeError, _>(e))?;
    to_json(&val)
}

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

/// scratch_engine — PyO3 bindings for the Scratch Engine Rust workspace.
#[pymodule]
fn scratch_engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(validate_record, m)?)?;
    m.add_function(wrap_pyfunction!(validate_folder, m)?)?;
    m.add_function(wrap_pyfunction!(sync_table_mapping, m)?)?;
    m.add_function(wrap_pyfunction!(build_publish_plan, m)?)?;
    m.add_function(wrap_pyfunction!(compute_merge_actions, m)?)?;
    m.add_function(wrap_pyfunction!(merge_text, m)?)?;
    m.add_function(wrap_pyfunction!(transform_record, m)?)?;
    m.add_function(wrap_pyfunction!(compute_changed_fields, m)?)?;
    m.add_function(wrap_pyfunction!(run_sync, m)?)?;
    m.add_function(wrap_pyfunction!(build_plan_from_git, m)?)?;
    m.add_function(wrap_pyfunction!(git_get_dirty_files, m)?)?;
    m.add_function(wrap_pyfunction!(git_download_all_files, m)?)?;
    m.add_function(wrap_pyfunction!(git_push_files, m)?)?;
    m.add_function(wrap_pyfunction!(git_publish_file, m)?)?;
    m.add_function(wrap_pyfunction!(git_publish_all, m)?)?;
    m.add_function(wrap_pyfunction!(git_discard_changes, m)?)?;
    m.add_function(wrap_pyfunction!(git_read_file, m)?)?;
    m.add_function(wrap_pyfunction!(git_write_files, m)?)?;
    m.add_function(wrap_pyfunction!(git_publish_content, m)?)?;
    m.add_function(wrap_pyfunction!(git_rename_files, m)?)?;
    m.add_function(wrap_pyfunction!(git_list_files, m)?)?;
    m.add_function(wrap_pyfunction!(git_rebase_dirty, m)?)?;
    m.add_function(wrap_pyfunction!(git_read_file_content, m)?)?;
    m.add_function(wrap_pyfunction!(git_read_files_batch, m)?)?;
    m.add_function(wrap_pyfunction!(git_init_repo, m)?)?;
    m.add_function(wrap_pyfunction!(git_status, m)?)?;
    Ok(())
}
