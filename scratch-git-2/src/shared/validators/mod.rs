#![allow(dead_code)]
// This module is scaffolded ahead of the validator/runtime slices.
// Keep dead-code warnings quiet until the wiring lands.

pub mod builtin;
pub mod python;

use std::collections::HashMap;
use std::path::Path;

use anyhow::Context;
use rusqlite::{params, Connection};
use serde::Deserialize;

pub const VALIDATION_RESULTS_TABLE: &str = "validation_results_v1";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

pub struct FieldValidationContext {
    pub filename: String,
    pub field_path: String,
    pub value: serde_json::Value,
    pub record: serde_json::Value,
    pub args: serde_json::Value,
}

/// Context passed to record-scoped validators (no `field`/`fields` key in config).
pub struct RecordValidationContext {
    pub filename: String,
    pub record: serde_json::Value,
    /// Master-branch version of the record; `None` for new records (no baseline to compare).
    pub master_record: Option<serde_json::Value>,
    /// Parsed `schema.json` root for this folder; `None` when no schema file exists.
    pub schema: serde_json::Value,
    pub args: serde_json::Value,
}

/// One violation emitted by a record-scoped validator.
/// Only failures are returned; clean fields produce no entry.
pub struct RecordValidationResult {
    pub field_path: String,
    pub level: ValidationLevel,
    pub message: Option<String>,
    pub description: Option<String>,
    pub fixable: bool,
}

/// Severity level for a validation failure.
/// Only failures are stored; passing records produce no rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationLevel {
    /// The value violates a hard constraint (e.g. required field missing).
    Error,
    /// The value violates a soft constraint (e.g. readonly changed, length exceeded).
    Warning,
}

impl ValidationLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            ValidationLevel::Error => "error",
            ValidationLevel::Warning => "warning",
        }
    }
}

/// A validation failure. Only produced when a check fails; passes produce `None`.
#[derive(Debug)]
pub struct ValidationResult {
    pub level: ValidationLevel,
    pub message: Option<String>,
    pub description: Option<String>,
    pub fixable: bool,
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/// One entry in a table's `validation.json` file.
///
/// Example:
/// ```json
/// [
///   { "validator": "length", "params": { "min": 1, "max": 100 }, "field": "title" },
///   { "validator": "required", "field": "id" }
/// ]
/// ```
#[derive(Debug, Deserialize)]
pub struct ValidatorEntry {
    pub validator: String,
    /// Single field path targeted by this validator.
    /// Mutually exclusive with `fields`.
    pub field: Option<String>,
    /// Multiple field paths (for multi-field validators).
    /// Mutually exclusive with `field`.
    pub fields: Option<Vec<String>>,
    /// Arguments passed to the validator function.
    #[serde(default)]
    pub params: serde_json::Value,
    /// Optional execution order (ascending).
    pub order: Option<i64>,
    /// Free-text annotation for humans.
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// ensure_schema helper (called from record_index::open_db)
// ---------------------------------------------------------------------------

pub fn create_validation_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {VALIDATION_RESULTS_TABLE} (
            folder_path     TEXT NOT NULL,
            file_name       TEXT NOT NULL,
            field_path      TEXT NOT NULL,
            validator_kind  TEXT NOT NULL,
            level           TEXT NOT NULL,
            message         TEXT,
            description     TEXT,
            fixable         INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (folder_path, file_name, field_path, validator_kind)
        );"
    ))
    .map_err(|e| anyhow::anyhow!("failed to ensure validation_results schema: {e}"))?;
    Ok(())
}

pub fn drop_validation_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(&format!("DROP TABLE IF EXISTS {VALIDATION_RESULTS_TABLE};"))
        .map_err(|e| anyhow::anyhow!("failed to drop validation_results schema: {e}"))?;
    Ok(())
}

pub fn validation_schema_exists(conn: &Connection) -> anyhow::Result<bool> {
    table_has_columns(
        conn,
        VALIDATION_RESULTS_TABLE,
        &[
            "folder_path",
            "file_name",
            "field_path",
            "validator_kind",
            "level",
            "message",
            "description",
            "fixable",
        ],
    )
}

pub fn ensure_validation_schema(conn: &Connection) -> anyhow::Result<()> {
    if !validation_schema_exists(conn)? {
        drop_validation_schema(conn)?;
        create_validation_schema(conn)?;
    }
    Ok(())
}

fn table_has_columns(
    conn: &Connection,
    table_name: &str,
    required: &[&str],
) -> anyhow::Result<bool> {
    let table_exists = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table_name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if !table_exists {
        return Ok(false);
    }

    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|e| anyhow::anyhow!("failed to inspect {table_name} schema: {e}"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| anyhow::anyhow!("failed to query {table_name} schema: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    Ok(required
        .iter()
        .all(|required_column| columns.iter().any(|column| column == required_column)))
}

// ---------------------------------------------------------------------------
// run_validations — main entry point called from refresh_record_index_command
// ---------------------------------------------------------------------------

/// Run all configured validators for `dirty_dir` and write results to the
/// `validation_results` table in `db_path`.
///
/// - `scratch_dir`: where `validation.json` files live (`.scratch/connections/scratch/<connection>`)
/// - `dirty_dir`: where record JSON files live (the dirty checkout, `<connection>`)
/// - `workspace_dir`: base directory for resolving `python:` script paths (`.scratch/workspace`)
///
/// `is_full_rebuild` controls whether stale results cleanup runs:
/// - full rebuild → clean up rows whose records no longer exist in record_index
/// - partial refresh → skip cleanup (would delete results for unprocessed records)
pub fn run_validations(
    scratch_dir: &Path,
    dirty_dir: &Path,
    workspace_dir: &Path,
    master_dir: &Path,
    db_path: &Path,
    is_full_rebuild: bool,
    selected_paths: Option<&std::collections::HashSet<String>>,
) -> anyhow::Result<()> {
    // Discover all validation.json files once (keyed by folder_path relative to scratch_dir).
    let configs = load_all_configs(scratch_dir)?;

    let conn = open_validation_db(db_path)?;

    reset_validation_results(&conn, selected_paths)?;

    if configs.is_empty() {
        return Ok(());
    }

    // Walk every record file and apply configured validators.
    validate_records(
        dirty_dir,
        workspace_dir,
        scratch_dir,
        master_dir,
        &configs,
        &conn,
        selected_paths,
    )?;

    // Stale cleanup — only on full refresh to avoid deleting results for
    // records not included in this partial run.
    if is_full_rebuild && selected_paths.is_none() {
        cleanup_stale_results(&conn)?;
    }

    Ok(())
}

fn reset_validation_results(
    conn: &Connection,
    selected_paths: Option<&std::collections::HashSet<String>>,
) -> anyhow::Result<()> {
    match selected_paths {
        Some(paths) => {
            for rel_path in paths {
                let (folder_path, file_name) = split_record_path(rel_path)?;
                conn.execute(
                    &format!("DELETE FROM {VALIDATION_RESULTS_TABLE} WHERE folder_path = ?1 AND file_name = ?2"),
                    params![folder_path, file_name],
                )
                .map_err(|e| {
                    anyhow::anyhow!("failed to clear validation results for {rel_path}: {e}")
                })?;
            }
        }
        None => {
            conn.execute(&format!("DELETE FROM {VALIDATION_RESULTS_TABLE}"), [])
                .map_err(|e| anyhow::anyhow!("failed to clear validation results: {e}"))?;
        }
    }
    Ok(())
}

fn split_record_path(rel_path: &str) -> anyhow::Result<(String, String)> {
    let normalized = crate::shared::git_path::normalize_logical_git_path(rel_path)
        .map_err(|e| anyhow::anyhow!(e))?;
    let path = Path::new(&normalized);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("invalid record filename in path {rel_path}"))?
        .to_string();
    let folder_path = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    Ok((folder_path, file_name))
}

/// Print validation config for a connection's scratch directory.
/// Reads from filesystem only — no DB required.
pub fn dump_validation_config(dirty_dir: &Path) -> anyhow::Result<()> {
    let configs = load_all_configs(dirty_dir)?;
    if configs.is_empty() {
        println!("No validation.json files found in {}", dirty_dir.display());
        return Ok(());
    }
    for (folder, entries) in &configs {
        println!("--- {folder}/validation.json ---");
        for (i, entry) in entries.iter().enumerate() {
            let target = match (&entry.field, &entry.fields) {
                (Some(f), _) => format!("field: {f}"),
                (_, Some(fs)) => format!("fields: [{}]", fs.join(", ")),
                _ => "record-scoped".to_string(),
            };
            let params_str = if entry.params.is_null()
                || entry.params == serde_json::Value::Object(Default::default())
            {
                String::new()
            } else {
                format!(" params={}", entry.params)
            };
            let note_str = entry
                .note
                .as_deref()
                .map(|n| format!("  # {n}"))
                .unwrap_or_default();
            println!(
                "  [{i}] validator={}{params_str}  {target}{note_str}",
                entry.validator
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dry-run API (no DB writes — designed for agent use via validate-record)
// ---------------------------------------------------------------------------

/// One violation produced by a dry-run validation pass.
#[derive(serde::Serialize)]
pub struct DryRunViolation {
    pub file: String,
    pub field_path: String,
    pub validator_kind: String,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub fixable: bool,
}

/// Run all validators from `entries` against a single record and return
/// violations without writing to any database.
///
/// Designed for agent dry-runs via the `validate-record` CLI command:
/// test a record before saving it, try a custom validation rule, or validate
/// inline JSON without touching the index at all.
pub fn run_validators_dry(
    file_name: &str,
    record: &serde_json::Value,
    master_record: Option<&serde_json::Value>,
    schema: Option<&serde_json::Value>,
    entries: &[ValidatorEntry],
    workspace_dir: &Path,
) -> anyhow::Result<Vec<DryRunViolation>> {
    let mut out = Vec::new();

    let mut sorted: Vec<&ValidatorEntry> = entries.iter().collect();
    sorted.sort_by_key(|e| e.order.unwrap_or(0));

    for entry in &sorted {
        if entry.field.is_some() && entry.fields.is_some() {
            anyhow::bail!(
                "validator '{}' specifies both 'field' and 'fields'; use one or the other",
                entry.validator
            );
        }

        match (&entry.field, &entry.fields) {
            (Some(field_path), _) => {
                let field_value = get_by_dot_path(record, field_path);
                if field_value.is_none() && entry.validator != "required" {
                    continue;
                }
                let value = field_value.cloned().unwrap_or(serde_json::Value::Null);
                let ctx = FieldValidationContext {
                    filename: file_name.to_string(),
                    field_path: field_path.clone(),
                    value,
                    record: record.clone(),
                    args: entry.params.clone(),
                };
                if let Some(result) = dispatch_validator(&entry.validator, &ctx, workspace_dir)? {
                    out.push(DryRunViolation {
                        file: file_name.to_string(),
                        field_path: field_path.clone(),
                        validator_kind: entry.validator.clone(),
                        level: result.level.as_str().to_string(),
                        message: result.message,
                        description: result.description,
                        fixable: result.fixable,
                    });
                }
            }
            (_, Some(_)) => {
                // multi-field validators not yet implemented — skip silently
            }
            (None, None) => {
                let record_ctx = RecordValidationContext {
                    filename: file_name.to_string(),
                    record: record.clone(),
                    master_record: master_record.cloned(),
                    schema: schema.cloned().unwrap_or(serde_json::Value::Null),
                    args: entry.params.clone(),
                };
                let violations = dispatch_record_validator(&entry.validator, &record_ctx)?;
                for v in violations {
                    out.push(DryRunViolation {
                        file: file_name.to_string(),
                        field_path: v.field_path,
                        validator_kind: entry.validator.clone(),
                        level: v.level.as_str().to_string(),
                        message: v.message,
                        description: v.description,
                        fixable: v.fixable,
                    });
                }
            }
        }
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Load all `validation.json` files found under `dirty_dir`.
/// Returns a map from folder_path (relative) → Vec<ValidatorEntry>.
/// Absent files are silently skipped. Malformed files produce an error.
fn load_all_configs(dirty_dir: &Path) -> anyhow::Result<HashMap<String, Vec<ValidatorEntry>>> {
    let mut configs = HashMap::new();
    collect_configs_recursive(dirty_dir, dirty_dir, &mut configs)?;
    Ok(configs)
}

fn collect_configs_recursive(
    root: &Path,
    dir: &Path,
    out: &mut HashMap<String, Vec<ValidatorEntry>>,
) -> anyhow::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(anyhow::anyhow!(
                "failed to read directory {}: {err}",
                dir.display()
            ))
        }
    };

    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            collect_configs_recursive(root, &path, out)?;
        } else if file_type.is_file() && name_str == "validation.json" {
            let rel = path
                .parent()
                .and_then(|p| p.strip_prefix(root).ok())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();

            let bytes = std::fs::read(&path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            let parsed: Vec<ValidatorEntry> = serde_json::from_slice(&bytes).with_context(|| {
                format!(
                    "{} is invalid JSON\n  Syntax: [{{ \"validator\": \"length\", \"field\": \"title\", \"params\": {{ \"min\": 1, \"max\": 100 }} }}, ...]\n  Valid validators: length",
                    path.display()
                )
            })?;
            out.insert(rel, parsed);
        }
    }

    Ok(())
}

/// Apply all validators to all records under `dirty_dir`.
/// `workspace_dir` is used to resolve `python:` script paths.
/// `scratch_dir` is used to load `schema.json` for record-scoped validators.
/// `master_dir` is used to load the master-branch version of each record.
fn validate_records(
    dirty_dir: &Path,
    workspace_dir: &Path,
    scratch_dir: &Path,
    master_dir: &Path,
    configs: &HashMap<String, Vec<ValidatorEntry>>,
    conn: &Connection,
    selected_paths: Option<&std::collections::HashSet<String>>,
) -> anyhow::Result<()> {
    for (folder_path, entries) in configs {
        let folder_dir = if folder_path.is_empty() {
            dirty_dir.to_path_buf()
        } else {
            dirty_dir.join(folder_path)
        };

        // Load schema.json once per folder (absence is silently tolerated).
        let schema = load_schema_for_folder(scratch_dir, folder_path);

        // Collect record files in this folder.
        let record_files = collect_record_files_in_folder(&folder_dir)?;

        for file_name in &record_files {
            let rel_path = if folder_path.is_empty() {
                file_name.clone()
            } else {
                format!("{folder_path}/{file_name}")
            };

            // If a path filter is active, skip unselected records.
            if let Some(selected) = selected_paths {
                if !selected.contains(&rel_path) {
                    continue;
                }
            }

            let record_path = folder_dir.join(file_name);
            let bytes = match std::fs::read(&record_path) {
                Ok(b) => b,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => {
                    return Err(anyhow::anyhow!(
                        "failed to read {}: {err}",
                        record_path.display()
                    ))
                }
            };
            let record: serde_json::Value = serde_json::from_slice(&bytes)
                .with_context(|| format!("failed to parse JSON in {}", record_path.display()))?;

            // Load master record for readonly checks (absent file = new record = None).
            let master_record = load_master_record(master_dir, folder_path, file_name);

            apply_validators_to_record(
                conn,
                folder_path,
                file_name,
                &record,
                master_record.as_ref(),
                schema.as_ref(),
                entries,
                workspace_dir,
            )?;
        }
    }
    Ok(())
}

/// Load `schema.json` from `scratch_dir/<folder_path>/schema.json`.
/// Returns `None` if absent or unparseable (with a warning to stderr).
fn load_schema_for_folder(scratch_dir: &Path, folder_path: &str) -> Option<serde_json::Value> {
    let schema_path = if folder_path.is_empty() {
        scratch_dir.join("schema.json")
    } else {
        scratch_dir.join(folder_path).join("schema.json")
    };
    match std::fs::read(&schema_path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!(
                    "[validation] failed to parse {}: {e} — record-scoped validators will be skipped",
                    schema_path.display()
                );
                None
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            eprintln!(
                "[validation] failed to read {}: {e} — record-scoped validators will be skipped",
                schema_path.display()
            );
            None
        }
    }
}

/// Load the master-branch version of a record file.
/// Returns `None` if the file doesn't exist (new record) or can't be parsed (warns to stderr).
fn load_master_record(
    master_dir: &Path,
    folder_path: &str,
    file_name: &str,
) -> Option<serde_json::Value> {
    let path = if folder_path.is_empty() {
        master_dir.join(file_name)
    } else {
        master_dir.join(folder_path).join(file_name)
    };
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!(
                    "[validation] failed to parse master record {}: {e} — readonly checks skipped",
                    path.display()
                );
                None
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            eprintln!(
                "[validation] failed to read master record {}: {e} — readonly checks skipped",
                path.display()
            );
            None
        }
    }
}

/// Apply the validator entries for one record file and persist results.
fn apply_validators_to_record(
    conn: &Connection,
    folder_path: &str,
    file_name: &str,
    record: &serde_json::Value,
    master_record: Option<&serde_json::Value>,
    schema: Option<&serde_json::Value>,
    entries: &[ValidatorEntry],
    workspace_dir: &Path,
) -> anyhow::Result<()> {
    // Sort by order if present (stable sort keeps original order for ties).
    let mut sorted: Vec<&ValidatorEntry> = entries.iter().collect();
    sorted.sort_by_key(|e| e.order.unwrap_or(0));

    for entry in sorted {
        // Validate `field` and `fields` are mutually exclusive.
        if entry.field.is_some() && entry.fields.is_some() {
            anyhow::bail!(
                "{folder_path}/validation.json: validator '{}' specifies both 'field' and 'fields'; use one or the other",
                entry.validator
            );
        }

        match (&entry.field, &entry.fields) {
            (Some(field_path), _) => {
                // Field-scoped validator.
                let field_value = get_by_dot_path(record, field_path);
                // `required` must fire even when the field is absent (receives Null).
                // All other validators skip absent fields to avoid spurious failures.
                if field_value.is_none() && entry.validator != "required" {
                    eprintln!(
                        "[validation] field '{}' not found in {folder_path}/{file_name}\n  Fix: check field names in the record or remove '{0}' from {folder_path}/validation.json",
                        field_path
                    );
                    continue;
                }
                let value = field_value.cloned().unwrap_or(serde_json::Value::Null);

                let ctx = FieldValidationContext {
                    filename: file_name.to_string(),
                    field_path: field_path.clone(),
                    value,
                    record: record.clone(),
                    args: entry.params.clone(),
                };
                if let Some(result) = dispatch_validator(&entry.validator, &ctx, workspace_dir)? {
                    upsert_result(
                        conn,
                        folder_path,
                        file_name,
                        field_path,
                        &entry.validator,
                        result.level.as_str(),
                        result.message.as_deref(),
                        result.description.as_deref(),
                        result.fixable,
                    )?;
                }
            }
            (_, Some(_fields)) => {
                // Multi-field validators deferred to a future slice.
                // Warn so the config isn't silently ignored.
                eprintln!(
                    "[validation] multi-field validators (fields: [...]) are not yet implemented; skipping '{}' in {folder_path}/validation.json",
                    entry.validator
                );
            }
            (None, None) => {
                // Record-scoped validator. `enforce_schema` reads schema + master.
                // Absence of rows for a record means no violations (violations-only model).
                let record_ctx = RecordValidationContext {
                    filename: file_name.to_string(),
                    record: record.clone(),
                    master_record: master_record.cloned(),
                    schema: schema.cloned().unwrap_or(serde_json::Value::Null),
                    args: entry.params.clone(),
                };
                let violations = dispatch_record_validator(&entry.validator, &record_ctx)?;
                for v in violations {
                    upsert_result(
                        conn,
                        folder_path,
                        file_name,
                        &v.field_path,
                        &entry.validator,
                        v.level.as_str(),
                        v.message.as_deref(),
                        v.description.as_deref(),
                        v.fixable,
                    )?;
                }
            }
        }
    }

    Ok(())
}

/// Dispatch to a validator by kind string.
///
/// Built-in validators use plain names (e.g. `"length"`).
/// Python validators use the `python:` prefix followed by a path relative to
/// `workspace_dir` (e.g. `"python:validators/check_name.py"`).
fn dispatch_validator(
    kind: &str,
    ctx: &FieldValidationContext,
    workspace_dir: &Path,
) -> anyhow::Result<Option<ValidationResult>> {
    if let Some(rel_path) = kind.strip_prefix("python:") {
        return python::run_python_validator(rel_path, workspace_dir, ctx);
    }
    match kind {
        "required" => Ok(builtin::required(ctx)),
        "length" => Ok(builtin::length(ctx)),
        "max_length" => Ok(builtin::length(ctx)),
        other => anyhow::bail!(
            "unknown validator '{}' — valid validators: required, length, python:<path>",
            other
        ),
    }
}

/// Dispatch to a record-scoped validator by kind string.
fn dispatch_record_validator(
    kind: &str,
    ctx: &RecordValidationContext,
) -> anyhow::Result<Vec<RecordValidationResult>> {
    match kind {
        "enforce_schema" => Ok(builtin::enforce_schema(ctx)),
        other => anyhow::bail!(
            "unknown record-scoped validator '{}' — valid: enforce_schema",
            other
        ),
    }
}

fn upsert_result(
    conn: &Connection,
    folder_path: &str,
    file_name: &str,
    field_path: &str,
    validator_kind: &str,
    level: &str,
    message: Option<&str>,
    description: Option<&str>,
    fixable: bool,
) -> anyhow::Result<()> {
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO {VALIDATION_RESULTS_TABLE} \
         (folder_path, file_name, field_path, validator_kind, level, message, description, fixable) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ),
        params![
            folder_path,
            file_name,
            field_path,
            validator_kind,
            level,
            message,
            description,
            fixable
        ],
    )
    .map_err(|e| anyhow::anyhow!("failed to write validation result: {e}"))?;
    Ok(())
}

/// Remove rows in validation_results whose (folder_path, file_name) is no
/// longer present in record_index (i.e. the record file was deleted).
fn cleanup_stale_results(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        &format!(
            "DELETE FROM {VALIDATION_RESULTS_TABLE} \
         WHERE (folder_path, file_name) NOT IN \
               (SELECT folder_path, file_name FROM {})",
            crate::shared::record_index::RECORD_INDEX_TABLE
        ),
        [],
    )
    .map_err(|e| anyhow::anyhow!("failed to clean stale validation results: {e}"))?;
    Ok(())
}

/// Collect non-schema JSON record filenames directly inside a directory (non-recursive).
fn collect_record_files_in_folder(folder_dir: &Path) -> anyhow::Result<Vec<String>> {
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(folder_dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(err) => {
            return Err(anyhow::anyhow!(
                "failed to read {}: {err}",
                folder_dir.display()
            ))
        }
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".json") {
            continue;
        }
        if name_str == "schema.json" || name_str == "validation.json" {
            continue;
        }
        if name_str.starts_with('.') {
            continue;
        }
        if entry.file_type()?.is_file() {
            files.push(name_str.into_owned());
        }
    }
    files.sort();
    Ok(files)
}

/// Traverse a dot-separated path into a JSON value.
/// `"fieldData.name"` → `value["fieldData"]["name"]`.
/// Returns `None` if any segment is missing or the value is not an object.
fn get_by_dot_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

fn open_validation_db(db_path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create db dir {}", parent.display()))?;
    }
    let conn = Connection::open(db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;
    ensure_validation_schema(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::{ensure_validation_schema, run_validations, VALIDATION_RESULTS_TABLE};
    use rusqlite::Connection;
    use std::collections::HashSet;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn write_file(root: &Path, rel_path: &str, contents: &str) {
        let path = root.join(rel_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn ensure_validation_schema_recreates_table_when_columns_are_missing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE validation_results (
                folder_path     TEXT NOT NULL,
                file_name       TEXT NOT NULL,
                field_path      TEXT NOT NULL,
                validator_kind  TEXT NOT NULL,
                level           TEXT NOT NULL,
                message         TEXT,
                PRIMARY KEY (folder_path, file_name, field_path, validator_kind)
            );",
        )
        .unwrap();

        ensure_validation_schema(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM pragma_table_info('{VALIDATION_RESULTS_TABLE}') WHERE name IN ('description', 'fixable')"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn selected_validation_refresh_replaces_existing_record_results() {
        let tmp = TempDir::new().unwrap();
        let scratch_dir = tmp.path().join("scratch");
        let dirty_dir = tmp.path().join("dirty");
        let db_path = tmp.path().join("index.db");

        write_file(
            &scratch_dir,
            "posts/validation.json",
            r#"[{"field":"title","validator":"length","params":{"max":5}}]"#,
        );
        write_file(&dirty_dir, "posts/one.json", r#"{"title":"too long"}"#);

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());
        run_validations(
            &scratch_dir,
            &dirty_dir,
            &dirty_dir,
            &dirty_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        write_file(&dirty_dir, "posts/one.json", r#"{"title":"ok"}"#);
        run_validations(
            &scratch_dir,
            &dirty_dir,
            &dirty_dir,
            &dirty_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        let conn = Connection::open(&db_path).unwrap();
        let rows: Vec<(String, Option<String>)> = conn
            .prepare(&format!(
                "SELECT level, message FROM {VALIDATION_RESULTS_TABLE} \
                 WHERE folder_path = 'posts' AND file_name = 'one.json'",
            ))
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            rows.is_empty(),
            "no violations after fix — expected no rows, got: {rows:?}"
        );
    }

    #[test]
    fn selected_validation_refresh_clears_results_when_record_is_gone() {
        let tmp = TempDir::new().unwrap();
        let scratch_dir = tmp.path().join("scratch");
        let dirty_dir = tmp.path().join("dirty");
        let db_path = tmp.path().join("index.db");

        write_file(
            &scratch_dir,
            "posts/validation.json",
            r#"[{"field":"title","validator":"length","params":{"max":5}}]"#,
        );
        write_file(&dirty_dir, "posts/one.json", r#"{"title":"too long"}"#);

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());
        run_validations(
            &scratch_dir,
            &dirty_dir,
            &dirty_dir,
            &dirty_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        fs::remove_file(dirty_dir.join("posts/one.json")).unwrap();
        run_validations(
            &scratch_dir,
            &dirty_dir,
            &dirty_dir,
            &dirty_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        let conn = Connection::open(&db_path).unwrap();
        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {VALIDATION_RESULTS_TABLE}"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn selected_validation_refresh_clears_results_when_config_is_gone() {
        let tmp = TempDir::new().unwrap();
        let scratch_dir = tmp.path().join("scratch");
        let dirty_dir = tmp.path().join("dirty");
        let db_path = tmp.path().join("index.db");

        write_file(
            &scratch_dir,
            "posts/validation.json",
            r#"[{"field":"title","validator":"length","params":{"max":5}}]"#,
        );
        write_file(&dirty_dir, "posts/one.json", r#"{"title":"too long"}"#);

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());
        run_validations(
            &scratch_dir,
            &dirty_dir,
            &dirty_dir,
            &dirty_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        fs::remove_file(scratch_dir.join("posts/validation.json")).unwrap();
        run_validations(
            &scratch_dir,
            &dirty_dir,
            &dirty_dir,
            &dirty_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        let conn = Connection::open(&db_path).unwrap();
        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {VALIDATION_RESULTS_TABLE}"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
