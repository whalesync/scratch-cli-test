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

/// Run all configured validators for `worktree_dir` and write results to the
/// `validation_results` table in `db_path`.
///
/// - `scratch_dir`: where `validation.json` files live (`.scratch/connections/scratch/<connection>`)
/// - `worktree_dir`: where record JSON files live (the user worktree, `<connection>`)
/// - `workspace_dir`: base directory for resolving `python:` script paths (`.scratch/workspace`)
/// - `bare_repo`: per-connection bare git repo. Read-only validators look up
///   the published version of each record at `refs/heads/main:<rel>`. Pass an
///   empty path if read-only checks aren't needed (the lookup degrades to
///   "no master record", and readonly violations silently skip — matches the
///   "new record" branch).
///
/// `is_full_rebuild` controls whether stale results cleanup runs:
/// - full rebuild → clean up rows whose records no longer exist in record_index
/// - partial refresh → skip cleanup (would delete results for unprocessed records)
pub fn run_validations(
    scratch_dir: &Path,
    worktree_dir: &Path,
    workspace_dir: &Path,
    bare_repo: &Path,
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
        worktree_dir,
        workspace_dir,
        scratch_dir,
        bare_repo,
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
pub fn dump_validation_config(worktree_dir: &Path) -> anyhow::Result<()> {
    let configs = load_all_configs(worktree_dir)?;
    if configs.is_empty() {
        println!(
            "No validation.json files found in {}",
            worktree_dir.display()
        );
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

/// Load all `validation.json` files found under `worktree_dir`.
/// Returns a map from folder_path (relative) → Vec<ValidatorEntry>.
/// Absent files are silently skipped. Malformed files produce an error.
fn load_all_configs(worktree_dir: &Path) -> anyhow::Result<HashMap<String, Vec<ValidatorEntry>>> {
    let mut configs = HashMap::new();
    collect_configs_recursive(worktree_dir, worktree_dir, &mut configs)?;
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

/// One pending DB write produced by the parallel validation phase.
struct PendingResult {
    folder_path: String,
    file_name: String,
    field_path: String,
    validator_kind: String,
    level: String,
    message: Option<String>,
    description: Option<String>,
    fixable: bool,
}

/// Work item built during the serial collection phase.
struct WorkItem {
    folder_path: String,
    file_name: String,
    /// Schema loaded once per folder in the serial phase.
    schema: Option<serde_json::Value>,
}

/// Apply all validators to all records under `worktree_dir`.
/// `workspace_dir` is used to resolve `python:` script paths.
/// `scratch_dir` is used to load `schema.json` for record-scoped validators.
/// `bare_repo` is used to pre-load the `refs/heads/main` tree so read-only
/// validators can compare current vs. published values.
///
/// Records are validated in parallel using rayon; DB writes are serialised
/// on the calling thread afterwards (rusqlite `Connection` is not `Send`).
fn validate_records(
    worktree_dir: &Path,
    workspace_dir: &Path,
    scratch_dir: &Path,
    bare_repo: &Path,
    configs: &HashMap<String, Vec<ValidatorEntry>>,
    conn: &Connection,
    selected_paths: Option<&std::collections::HashSet<String>>,
) -> anyhow::Result<()> {
    use rayon::prelude::*;

    // Pre-load `refs/heads/main` into a FileMap once. Per-record lookups in
    // the parallel phase below hit the in-memory map; no fs I/O against a
    // master worktree (the worktree no longer exists post-slice-F). On a
    // path that isn't a valid bare repo, the helper errs and we fall through
    // to an empty map — readonly checks then skip silently.
    let main_files =
        crate::shared::git_local::read_tree_files(bare_repo, "refs/heads/main").unwrap_or_default();

    // Phase 1 (serial): enumerate work items, loading schema once per folder.
    let mut work_items: Vec<WorkItem> = Vec::new();
    for (folder_path, _entries) in configs {
        let folder_dir = if folder_path.is_empty() {
            worktree_dir.to_path_buf()
        } else {
            worktree_dir.join(folder_path)
        };

        let schema = load_schema_for_folder(scratch_dir, folder_path);
        let record_files = collect_record_files_in_folder(&folder_dir)?;

        for file_name in record_files {
            let rel_path = if folder_path.is_empty() {
                file_name.clone()
            } else {
                format!("{folder_path}/{file_name}")
            };
            if let Some(selected) = selected_paths {
                if !selected.contains(&rel_path) {
                    continue;
                }
            }
            work_items.push(WorkItem {
                folder_path: folder_path.clone(),
                file_name,
                schema: schema.clone(),
            });
        }
    }

    // Phase 2 (parallel): load each record file and run its validators.
    let results: Vec<anyhow::Result<Vec<PendingResult>>> = work_items
        .par_iter()
        .map(|item| {
            let folder_dir = if item.folder_path.is_empty() {
                worktree_dir.to_path_buf()
            } else {
                worktree_dir.join(&item.folder_path)
            };

            let record_path = folder_dir.join(&item.file_name);
            let bytes = match std::fs::read(&record_path) {
                Ok(b) => b,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Vec::new());
                }
                Err(err) => {
                    return Err(anyhow::anyhow!(
                        "failed to read {}: {err}",
                        record_path.display()
                    ));
                }
            };
            let record: serde_json::Value = serde_json::from_slice(&bytes)
                .with_context(|| format!("failed to parse JSON in {}", record_path.display()))?;

            let master_record =
                lookup_master_record(&main_files, &item.folder_path, &item.file_name);

            let entries = configs
                .get(&item.folder_path)
                .map(Vec::as_slice)
                .unwrap_or(&[]);

            apply_validators_to_record(
                &item.folder_path,
                &item.file_name,
                &record,
                master_record.as_ref(),
                item.schema.as_ref(),
                entries,
                workspace_dir,
            )
        })
        .collect();

    // Phase 3 (serial): flush violations to SQLite.
    for result in results {
        for v in result? {
            upsert_result(
                conn,
                &v.folder_path,
                &v.file_name,
                &v.field_path,
                &v.validator_kind,
                &v.level,
                v.message.as_deref(),
                v.description.as_deref(),
                v.fixable,
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

/// Look up the master-branch version of a record file in a pre-loaded
/// `refs/heads/main` tree map. Returns `None` if the path isn't in main (new
/// record) or the blob can't be parsed (warns to stderr).
///
/// Pre-slice-F read from a separate sparse `master` worktree on disk; that
/// worktree no longer exists. The bare repo's `refs/heads/main` blob is now
/// the canonical published state.
fn lookup_master_record(
    main_files: &crate::shared::git_local::FileMap,
    folder_path: &str,
    file_name: &str,
) -> Option<serde_json::Value> {
    let key = if folder_path.is_empty() {
        file_name.to_string()
    } else {
        format!("{folder_path}/{file_name}")
    };
    let bytes = main_files.get(&key)?;
    match serde_json::from_slice(bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!(
                "[validation] failed to parse master record refs/heads/main:{key}: {e} — readonly checks skipped"
            );
            None
        }
    }
}

/// Apply the validator entries for one record file and return all violations.
/// Does not touch the database — the caller serialises writes.
fn apply_validators_to_record(
    folder_path: &str,
    file_name: &str,
    record: &serde_json::Value,
    master_record: Option<&serde_json::Value>,
    schema: Option<&serde_json::Value>,
    entries: &[ValidatorEntry],
    workspace_dir: &Path,
) -> anyhow::Result<Vec<PendingResult>> {
    let mut pending = Vec::new();

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
                    pending.push(PendingResult {
                        folder_path: folder_path.to_string(),
                        file_name: file_name.to_string(),
                        field_path: field_path.clone(),
                        validator_kind: entry.validator.clone(),
                        level: result.level.as_str().to_string(),
                        message: result.message,
                        description: result.description,
                        fixable: result.fixable,
                    });
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
                    pending.push(PendingResult {
                        folder_path: folder_path.to_string(),
                        file_name: file_name.to_string(),
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

    Ok(pending)
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

/// Remove rows in `validation_results` whose record no longer exists. Source of
/// truth is the per-folder `<sanitized_folder>__v1` tables managed by
/// `folder_index`: a record is "alive" iff its row in that table has a
/// non-null `dirty_mtime`.
///
/// One DELETE per distinct folder_path. If a folder's per-folder table doesn't
/// exist at all (e.g. the data folder was removed), every result row for that
/// folder_path is dropped.
fn cleanup_stale_results(conn: &Connection) -> anyhow::Result<()> {
    let folder_paths: Vec<String> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT DISTINCT folder_path FROM {VALIDATION_RESULTS_TABLE}"
        ))?;
        let rows: Vec<rusqlite::Result<String>> = stmt.query_map([], |row| row.get(0))?.collect();
        rows.into_iter().collect::<Result<_, _>>()?
    };

    for folder_path in folder_paths {
        let table_name = crate::shared::folder_index::table_name_from_folder(&folder_path);
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![&table_name],
                |row| row.get::<_, i64>(0).map(|n| n > 0),
            )
            .map_err(|e| anyhow::anyhow!("failed to probe {table_name}: {e}"))?;

        if !table_exists {
            conn.execute(
                &format!("DELETE FROM {VALIDATION_RESULTS_TABLE} WHERE folder_path = ?1"),
                params![&folder_path],
            )
            .map_err(|e| {
                anyhow::anyhow!("failed to drop orphaned validation_results for {folder_path}: {e}")
            })?;
            continue;
        }

        let table_q = crate::shared::folder_index::quote_ident(&table_name);
        conn.execute(
            &format!(
                "DELETE FROM {VALIDATION_RESULTS_TABLE} \
                 WHERE folder_path = ?1 \
                   AND file_name NOT IN (SELECT filename FROM {table_q} WHERE dirty_mtime IS NOT NULL)"
            ),
            params![&folder_path],
        )
        .map_err(|e| anyhow::anyhow!("failed to clean stale validation_results for {folder_path}: {e}"))?;
    }
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
        let worktree_dir = tmp.path().join("dirty");
        let db_path = tmp.path().join("index.db");

        write_file(
            &scratch_dir,
            "posts/validation.json",
            r#"[{"field":"title","validator":"length","params":{"max":5}}]"#,
        );
        write_file(&worktree_dir, "posts/one.json", r#"{"title":"too long"}"#);

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());
        run_validations(
            &scratch_dir,
            &worktree_dir,
            &worktree_dir,
            &worktree_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        write_file(&worktree_dir, "posts/one.json", r#"{"title":"ok"}"#);
        run_validations(
            &scratch_dir,
            &worktree_dir,
            &worktree_dir,
            &worktree_dir,
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
        let worktree_dir = tmp.path().join("dirty");
        let db_path = tmp.path().join("index.db");

        write_file(
            &scratch_dir,
            "posts/validation.json",
            r#"[{"field":"title","validator":"length","params":{"max":5}}]"#,
        );
        write_file(&worktree_dir, "posts/one.json", r#"{"title":"too long"}"#);

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());
        run_validations(
            &scratch_dir,
            &worktree_dir,
            &worktree_dir,
            &worktree_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        fs::remove_file(worktree_dir.join("posts/one.json")).unwrap();
        run_validations(
            &scratch_dir,
            &worktree_dir,
            &worktree_dir,
            &worktree_dir,
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
        let worktree_dir = tmp.path().join("dirty");
        let db_path = tmp.path().join("index.db");

        write_file(
            &scratch_dir,
            "posts/validation.json",
            r#"[{"field":"title","validator":"length","params":{"max":5}}]"#,
        );
        write_file(&worktree_dir, "posts/one.json", r#"{"title":"too long"}"#);

        let mut selected = HashSet::new();
        selected.insert("posts/one.json".to_string());
        run_validations(
            &scratch_dir,
            &worktree_dir,
            &worktree_dir,
            &worktree_dir,
            &db_path,
            false,
            Some(&selected),
        )
        .unwrap();

        fs::remove_file(scratch_dir.join("posts/validation.json")).unwrap();
        run_validations(
            &scratch_dir,
            &worktree_dir,
            &worktree_dir,
            &worktree_dir,
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

    /// Slice F.3 regression test: the readonly-field validator reads the
    /// published version of each record from `refs/heads/main:<rel>` in the
    /// per-connection bare repo. Pre-F.3 this read from a sparse `master`
    /// worktree on disk; F.2.b retired that worktree, leaving the path empty.
    /// F.3 repoints `run_validations` to the bare repo via gix.
    ///
    /// The test sets up a real bare repo with one commit on `main`, then
    /// writes a *changed* version of that record to the worktree along with
    /// a `validation.json` + a `schema.json` marking the field as readonly.
    /// `run_validations` must detect the violation.
    #[test]
    fn readonly_validator_reads_master_from_bare_repo_refs_heads_main() {
        // Skip the test if git isn't on PATH (mirrors other git-dependent
        // tests in the crate).
        if crate::shared::git_exec::git_command()
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping git-dependent test: git executable not available");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let scratch_dir = tmp.path().join("scratch");
        let worktree_dir = tmp.path().join("worktree");
        let workspace_dir = tmp.path().join("workspace");
        let bare_repo = tmp.path().join("repo.git");
        let db_path = tmp.path().join("index.db");

        // Build a source repo with a single record on main.
        let source = tmp.path().join("source");
        let run_git = |cwd: &Path, args: &[&str]| {
            let output = crate::shared::git_exec::git_command()
                .current_dir(cwd)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(tmp.path(), &["init", "source"]);
        run_git(&source, &["checkout", "-b", "main"]);
        write_file(
            &source,
            "posts/rec1.json",
            r#"{"id":"original","title":"Hello"}"#,
        );
        run_git(&source, &["add", "-A"]);
        run_git(
            &source,
            &[
                "-c",
                "user.name=Scratch",
                "-c",
                "user.email=s@x.com",
                "commit",
                "-m",
                "init",
            ],
        );
        run_git(tmp.path(), &["init", "--bare", "repo.git"]);
        run_git(
            &source,
            &["remote", "add", "origin", bare_repo.to_str().unwrap()],
        );
        run_git(&source, &["push", "origin", "main:main"]);

        // User edited `id` (which is readonly) in the worktree.
        write_file(
            &worktree_dir,
            "posts/rec1.json",
            r#"{"id":"CHANGED","title":"Hello"}"#,
        );

        // schema.json: `enforce_schema` reads `.schema.properties.<field>.x-scratch-readonly`.
        // validation.json: record-scoped entry (no `field` → `enforce_schema` fires).
        write_file(
            &scratch_dir,
            "posts/schema.json",
            r#"{"schema":{"type":"object","properties":{"id":{"type":"string","x-scratch-readonly":true},"title":{"type":"string"}}}}"#,
        );
        write_file(
            &scratch_dir,
            "posts/validation.json",
            r#"[{"validator":"enforce_schema","params":{}}]"#,
        );

        // `is_full_rebuild = false` to skip `cleanup_stale_results` — that
        // helper deletes rows whose paths aren't in the folder_index table
        // (which we don't populate here). Production full-rebuild paths
        // always have the folder_index up to date first.
        run_validations(
            &scratch_dir,
            &worktree_dir,
            &workspace_dir,
            &bare_repo,
            &db_path,
            false,
            None,
        )
        .unwrap();

        let conn = Connection::open(&db_path).unwrap();
        let rows: Vec<(String, String, String)> = conn
            .prepare(&format!(
                "SELECT field_path, level, COALESCE(message, '') FROM {VALIDATION_RESULTS_TABLE} \
                 WHERE folder_path = 'posts' AND file_name = 'rec1.json' AND validator_kind = 'enforce_schema'"
            ))
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        let id_violation = rows.iter().find(|(field, _, _)| field == "id");
        assert!(
            id_violation.is_some(),
            "expected a readonly violation on `id` after changing it in the worktree; got rows: {rows:?}",
        );
        let (_, level, message) = id_violation.unwrap();
        assert_eq!(level, "warning", "readonly violations are warnings");
        assert!(
            message.to_lowercase().contains("readonly")
                || message.to_lowercase().contains("read-only"),
            "expected readonly mention in message, got: {message}"
        );
    }
}
