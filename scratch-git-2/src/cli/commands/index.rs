//! `scratchmd build-index`, `scratchmd dump-index`, `scratchmd dump-validations`,
//! and `scratchmd get-validation-results`.

use std::path::PathBuf;

use crate::config::markers;
use crate::shared::index;
use crate::shared::layout::WorkspaceLayout;
use crate::shared::validators;
use serde::Serialize;

pub fn build_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut total_indexed = 0usize;
    let mut total_connections = 0usize;

    for connection in &workspace_marker.connections {
        let conn_dir_name = &connection.dir_name;
        let master = layout.master_worktree_path(conn_dir_name);
        let db = layout.index_db_path(&connection.repo_path);

        if !master.exists() {
            eprintln!(
                "  {} — master worktree not found at {}, skipping",
                conn_dir_name,
                master.display()
            );
            eprintln!("    Run 'scratchmd workspaces init' to set up the master worktree.");
            continue;
        }

        // Ensure parent dir for db exists
        if let Some(parent) = db.parent() {
            std::fs::create_dir_all(parent)?;
        }

        print!("  Building index for {}... ", conn_dir_name);
        match index::build(&master, &db) {
            Ok(count) => {
                println!("{count} file(s)");
                total_indexed += count;
                total_connections += 1;
            }
            Err(e) => {
                println!("ERROR: {e}");
            }
        }
    }

    println!("\nDone. Indexed {total_indexed} file(s) across {total_connections} connection(s).");
    Ok(())
}

pub fn dump_command(workspace_start: &std::path::Path, filter: Option<&str>) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!("No connections found in {}", workspace_dir.display());
    }

    for connection in &workspace_marker.connections {
        let conn_dir_name = connection.dir_name.clone();

        if let Some(f) = filter {
            if conn_dir_name != f {
                continue;
            }
        }

        let db = layout.index_db_path(&connection.repo_path);

        if !db.exists() {
            println!("[{conn_dir_name}] no index.db — run `scratchmd build-index` first");
            continue;
        }

        println!("\n[{conn_dir_name}]");
        println!("{:<50} {:<40} {}", "folder", "filename", "remote_id");
        println!("{}", "-".repeat(100));

        let rows = index::read_index(&db)?;
        let count = rows.len();
        for row in &rows {
            println!(
                "{:<50} {:<40} {}",
                row.folder,
                row.filename,
                row.remote_id.as_deref().unwrap_or("(none)")
            );
        }
        println!("{count} row(s)");

        let refs = index::read_references(&db)?;
        if !refs.is_empty() {
            println!("\n  [file_references]");
            println!(
                "  {:<50} {:<40} {:<40} {}",
                "source_folder", "source_filename", "target_table_id", "target_remote_id"
            );
            println!("  {}", "-".repeat(140));
            let ref_count = refs.len();
            for r in &refs {
                println!(
                    "  {:<50} {:<40} {:<40} {}",
                    r.source_folder, r.source_filename, r.target_table_id, r.target_remote_id
                );
            }
            println!("  {ref_count} reference(s)");
        }
    }

    Ok(())
}

/// Print all `validation.json` configs found in the workspace.
/// Reads from the filesystem only — no DB required.
pub fn dump_validations_command(
    workspace_start: &std::path::Path,
    connection_filter: Option<&str>,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut found_any = false;
    for connection in &workspace_marker.connections {
        if let Some(filter) = connection_filter {
            if connection.dir_name != filter {
                continue;
            }
        }

        let scratch_dir = layout.connection_scratch_path(&connection.dir_name);

        println!("=== {} ===", connection.dir_name);
        validators::dump_validation_config(&scratch_dir)?;
        found_any = true;
    }

    if !found_any {
        if let Some(filter) = connection_filter {
            anyhow::bail!(
                "Connection '{}' was not found in {}",
                filter,
                workspace_dir.display()
            );
        }
    }

    Ok(())
}

pub fn index_field_command(
    workspace_start: &std::path::Path,
    folder: &str,
    column: &str,
    debug: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    crate::shared::folder_index::index_field_with_progress(
        &workspace_dir,
        folder,
        column,
        None,
        debug,
    )
}

pub fn clear_column_index_command(
    workspace_start: &std::path::Path,
    folder: &str,
    column: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let result =
        crate::shared::folder_index::clear_column_index(&workspace_dir, folder, column, None)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

pub fn clear_folder_index_command(
    workspace_start: &std::path::Path,
    folder: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let result = crate::shared::folder_index::clear_folder_index(&workspace_dir, folder, None)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

pub fn find_stale_files_command(
    workspace_start: &std::path::Path,
    folder: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let filenames = crate::shared::folder_index::find_stale_files(&workspace_dir, folder, None)?;
    println!("{}", serde_json::to_string(&filenames)?);
    Ok(())
}

pub fn find_column_stale_files_command(
    workspace_start: &std::path::Path,
    folder: &str,
    columns: &[String],
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let filenames = crate::shared::folder_index::find_column_stale_files(
        &workspace_dir,
        folder,
        columns,
        None,
    )?;
    println!("{}", serde_json::to_string(&filenames)?);
    Ok(())
}

pub fn find_stale_command(
    workspace_start: &std::path::Path,
    folder: &str,
    columns: &[String],
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let report = crate::shared::folder_index::find_stale(&workspace_dir, folder, columns, None)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

pub fn reindex_table_command(
    workspace_start: &std::path::Path,
    folder: &str,
    debug: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let rows = crate::shared::folder_index::reindex_table(&workspace_dir, folder, None, debug)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({ "rows": rows }))?
    );
    Ok(())
}

pub fn reindex_workspace_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut total_rows = 0usize;
    let mut total_folders = 0usize;

    for connection in &workspace_marker.connections {
        let conn_dir_name = &connection.dir_name;
        let working_dir = workspace_dir.join(conn_dir_name);
        if !working_dir.exists() {
            eprintln!(
                "  {} — working directory not found, skipping",
                conn_dir_name
            );
            continue;
        }

        // Enumerate immediate subfolders (data folders) in the connection directory.
        let subfolders: Vec<String> = match std::fs::read_dir(&working_dir) {
            Ok(entries) => entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect(),
            Err(_) => {
                eprintln!("  {} — could not read directory, skipping", conn_dir_name);
                continue;
            }
        };

        for subfolder in &subfolders {
            let folder = format!("{conn_dir_name}/{subfolder}");
            eprint!("  reindexing {}... ", folder);
            match crate::shared::folder_index::reindex_table(&workspace_dir, &folder, None, false) {
                Ok(rows) => {
                    eprintln!("{rows} rows");
                    total_rows += rows;
                    total_folders += 1;
                }
                Err(e) => {
                    eprintln!("ERROR: {e}");
                }
            }
        }
    }

    eprintln!("\nDone. {total_rows} rows across {total_folders} folder(s).");
    Ok(())
}

pub fn reindex_files_command(
    workspace_start: &std::path::Path,
    folder: &str,
    files: &[String],
    validate: bool,
    debug: bool,
) -> anyhow::Result<()> {
    if files.is_empty() {
        anyhow::bail!("provide at least one --file argument");
    }
    let workspace_dir = resolve_workspace(workspace_start)?;
    crate::shared::folder_index::reindex_files(&workspace_dir, folder, files, None, debug)?;
    if validate {
        crate::shared::folder_index::validate_files(&workspace_dir, folder, files, None, debug)?;
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({ "reindexed": files.len() }))?
    );
    Ok(())
}

pub fn reindex_files_columns_command(
    workspace_start: &std::path::Path,
    folder: &str,
    files: &[String],
    debug: bool,
) -> anyhow::Result<()> {
    if files.is_empty() {
        anyhow::bail!("provide at least one --file argument");
    }
    let workspace_dir = resolve_workspace(workspace_start)?;
    crate::shared::folder_index::reindex_files_columns(&workspace_dir, folder, files, None, debug)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({ "reindexed": files.len() }))?
    );
    Ok(())
}

fn resolve_workspace(start: &std::path::Path) -> anyhow::Result<PathBuf> {
    let abs = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    Ok(markers::find_nearest_workspace(&abs).unwrap_or(abs))
}

fn read_workspace_marker(
    workspace_dir: &std::path::Path,
) -> anyhow::Result<markers::WorkspaceMarker> {
    let marker_path = markers::marker_path(workspace_dir);
    match markers::read(&marker_path) {
        Ok(markers::Marker::Workspace(marker)) => Ok(marker),
        _ => anyhow::bail!(
            "Could not read workspace marker at {}",
            marker_path.display()
        ),
    }
}

// ---------------------------------------------------------------------------
// get-validation-results command
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ValidationResultRow {
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    field_path: String,
    validator_kind: String,
    level: String,
    message: Option<String>,
    description: Option<String>,
    fixable: bool,
}

pub fn get_folder_validation_results_command(
    workspace_start: &std::path::Path,
    folder_path_arg: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;

    let slash = folder_path_arg.find('/').ok_or_else(|| {
        anyhow::anyhow!("folder path must be '<connection>/<folder>', got: {folder_path_arg}")
    })?;
    let connection_name = &folder_path_arg[..slash];

    let db_path = workspace_dir
        .join(".repos")
        .join(format!("{connection_name}.db"));
    if !db_path.exists() {
        println!("[]");
        return Ok(());
    }

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

    let mut stmt = conn
        .prepare(
            "SELECT filename, field_path, validator_kind, level, message, description, fixable \
             FROM validation_results \
             WHERE folder_path = ?1",
        )
        .map_err(|e| anyhow::anyhow!("failed to prepare query: {e}"))?;

    let rows: Vec<ValidationResultRow> = stmt
        .query_map(rusqlite::params![folder_path_arg], |row| {
            Ok(ValidationResultRow {
                file_name: Some(row.get(0)?),
                field_path: row.get(1)?,
                validator_kind: row.get(2)?,
                level: row.get(3)?,
                message: row.get(4)?,
                description: row.get(5)?,
                fixable: row.get(6)?,
            })
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("row read failed: {e}"))?;

    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}

// ── get-filenames-with-errors ─────────────────────────────────────────────────

/// Return the distinct filenames and field paths in a folder that have at least one
/// error-level validation violation. Used by the desktop app to power the "has errors"
/// grid filter and to focus the relevant columns.
///
/// Output: `{ "filenames": [...], "field_paths": [...] }`
/// `folder_path_arg` is workspace-relative: `<connection>/<folder>`.
pub fn get_filenames_with_errors_command(
    workspace_start: &std::path::Path,
    folder_path_arg: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;

    let slash = folder_path_arg.find('/').ok_or_else(|| {
        anyhow::anyhow!("folder path must be '<connection>/<folder>', got: {folder_path_arg}")
    })?;
    let connection_name = &folder_path_arg[..slash];

    let db_path = workspace_dir
        .join(".repos")
        .join(format!("{connection_name}.db"));
    if !db_path.exists() {
        println!("{{\"filenames\":[],\"field_paths\":[]}}");
        return Ok(());
    }

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT filename, field_path FROM validation_results \
             WHERE folder_path = ?1",
        )
        .map_err(|e| anyhow::anyhow!("failed to prepare query: {e}"))?;

    let rows = stmt
        .query_map(rusqlite::params![folder_path_arg], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("row read failed: {e}"))?;

    let mut filenames: Vec<String> = rows.iter().map(|(f, _)| f.clone()).collect();
    filenames.sort();
    filenames.dedup();

    let mut field_paths: Vec<String> = rows.iter().map(|(_, p)| p.clone()).collect();
    field_paths.sort();
    field_paths.dedup();

    let out = serde_json::json!({ "filenames": filenames, "field_paths": field_paths });
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

// ── Validation stats ──────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct FolderValidationStat {
    connection: String,
    folder_path: String,
    errors: i64,
    warnings: i64,
    /// Number of distinct records (files) that have at least one violation.
    records: i64,
}

/// Return error/warning counts grouped by connection and folder across all connections.
///
/// Reads from the folder-index SQLite databases (`.repos/<dir_name>.db`) which are
/// populated by `paginate-records --validate`. Each folder table has `has_errors` for
/// the total record count and a shared `validation_results` table for per-level counts.
///
/// Output: JSON array of `{ connection, folder_path, errors, warnings, records }`.
/// Folders with zero violations are omitted.
pub fn get_validation_stats_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;

    let mut stats: Vec<FolderValidationStat> = Vec::new();

    for connection in &workspace_marker.connections {
        if connection.dir_name.is_empty() {
            continue;
        }
        // Folder-index DB is keyed by the connection's display name, not repo_path.
        let db_path = workspace_dir
            .join(".repos")
            .join(format!("{}.db", &connection.dir_name));
        if !db_path.exists() {
            continue;
        }
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Enumerate all folders that have any validation violation recorded.
        let mut folder_stmt = match conn
            .prepare("SELECT DISTINCT folder_path FROM validation_results ORDER BY folder_path")
        {
            Ok(s) => s,
            Err(_) => continue,
        };
        let folder_paths: Vec<String> = folder_stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| anyhow::anyhow!("failed to query validation_results: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        for full_folder_path in folder_paths {
            let records: i64 = conn
                .query_row(
                    "SELECT COUNT(DISTINCT filename) FROM validation_results WHERE folder_path = ?1",
                    rusqlite::params![full_folder_path],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            if records == 0 {
                continue;
            }

            let errors: i64 = conn
                .query_row(
                    "SELECT COUNT(DISTINCT filename) FROM validation_results \
                     WHERE folder_path = ?1 AND level = 'error'",
                    rusqlite::params![full_folder_path],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let warnings: i64 = conn
                .query_row(
                    "SELECT COUNT(DISTINCT filename) FROM validation_results \
                     WHERE folder_path = ?1 AND level = 'warning'",
                    rusqlite::params![full_folder_path],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            // Strip the leading connection prefix for the UI (e.g. "conn/public/posts" → "public/posts").
            let sub_path = match full_folder_path.find('/') {
                Some(idx) => full_folder_path[idx + 1..].to_string(),
                None => String::new(),
            };

            stats.push(FolderValidationStat {
                connection: connection.dir_name.clone(),
                folder_path: sub_path,
                errors,
                warnings,
                records,
            });
        }
    }

    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}

/// Return up to 20 validation results for a folder — same shape as
/// `get-folder-validation-results` but capped for UI preview use.
/// Errors are returned before warnings; within each level results are ordered
/// by file name then field path.
pub fn get_folder_validation_sample_command(
    workspace_start: &std::path::Path,
    folder_path_arg: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;

    let slash = folder_path_arg.find('/').ok_or_else(|| {
        anyhow::anyhow!("folder path must be '<connection>/<folder>', got: {folder_path_arg}")
    })?;
    let connection_name = &folder_path_arg[..slash];
    let folder_path = &folder_path_arg[slash + 1..];

    // Folder-index DB is keyed by the connection's display name.
    let db_path = workspace_dir
        .join(".repos")
        .join(format!("{connection_name}.db"));
    if !db_path.exists() {
        println!("[]");
        return Ok(());
    }

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

    let full_folder = format!("{connection_name}/{folder_path}");

    let mut stmt = conn
        .prepare(
            "SELECT filename, field_path, validator_kind, level, message, description, fixable \
             FROM validation_results \
             WHERE folder_path = ?1 \
             ORDER BY level DESC, filename, field_path \
             LIMIT 20",
        )
        .map_err(|e| anyhow::anyhow!("failed to prepare query: {e}"))?;

    let sample_rows: Vec<ValidationResultRow> = stmt
        .query_map(rusqlite::params![full_folder], |row| {
            Ok(ValidationResultRow {
                file_name: Some(row.get(0)?),
                field_path: row.get(1)?,
                validator_kind: row.get(2)?,
                level: row.get(3)?,
                message: row.get(4)?,
                description: row.get(5)?,
                fixable: row.get(6)?,
            })
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("row read failed: {e}"))?;

    println!("{}", serde_json::to_string(&sample_rows)?);
    Ok(())
}

/// Return all validation results for a single record as a JSON array.
///
/// `record_path` is workspace-relative: `<connection>/<folder>/<filename>`.
/// Returns an empty array when no DB exists or no results are stored.
pub fn get_validation_results_command(
    workspace_start: &std::path::Path,
    record_path: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;

    // Split "<connection>/<folder...>/<filename>" into (connection, folder_path, filename).
    let slash = record_path.find('/').ok_or_else(|| {
        anyhow::anyhow!("record path must be '<connection>/<folder>/<file>', got: {record_path}")
    })?;
    let connection_name = &record_path[..slash];
    let rest = &record_path[slash + 1..];

    let (folder_subpath, file_name) = match rest.rfind('/') {
        Some(pos) => (&rest[..pos], &rest[pos + 1..]),
        None => ("", rest),
    };
    let full_folder = format!("{connection_name}/{folder_subpath}");

    let db_path = workspace_dir
        .join(".repos")
        .join(format!("{connection_name}.db"));
    if !db_path.exists() {
        println!("[]");
        return Ok(());
    }

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| anyhow::anyhow!("failed to open {}: {e}", db_path.display()))?;

    let mut stmt = conn
        .prepare(
            "SELECT field_path, validator_kind, level, message, description, fixable \
             FROM validation_results \
             WHERE folder_path = ?1 AND filename = ?2",
        )
        .map_err(|e| anyhow::anyhow!("failed to prepare query: {e}"))?;

    let rows: Vec<ValidationResultRow> = stmt
        .query_map(rusqlite::params![full_folder, file_name], |row| {
            Ok(ValidationResultRow {
                file_name: None,
                field_path: row.get(0)?,
                validator_kind: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                description: row.get(4)?,
                fixable: row.get(5)?,
            })
        })
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("row read failed: {e}"))?;

    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}

// ---------------------------------------------------------------------------
// validate-record command
// ---------------------------------------------------------------------------

/// Run validation against one or more records without writing to the index.
///
/// Designed for agent dry-runs: test a record before saving it, try a new
/// validation rule, or validate inline JSON without touching the index at all.
///
/// Sources can come from disk (`--folder` / `--file`) or inline JSON strings.
/// Any combination is supported:
///   - `--file` reads record files from the working copy; requires `--folder`.
///   - `--record` accepts inline record JSON; mutually exclusive with `--file`.
///   - `--master` overrides the master-record lookup (for readonly checks).
///   - `--validation` overrides the `validation.json` content.
///   - `--schema` overrides the `schema.json` content.
///
/// When all four JSON overrides are provided, `--folder` is not required.
pub fn validate_record_command(
    workspace_start: &std::path::Path,
    folder: Option<&str>,
    files: &[String],
    record_json: Option<&str>,
    master_json: Option<&str>,
    validation_json: Option<&str>,
    schema_json: Option<&str>,
) -> anyhow::Result<()> {
    if !files.is_empty() && record_json.is_some() {
        anyhow::bail!("--file and --record are mutually exclusive");
    }
    if files.is_empty() && record_json.is_none() {
        anyhow::bail!("provide either --file <filename> (repeatable) or --record <json>");
    }

    let workspace = resolve_workspace(workspace_start)?;
    let layout = WorkspaceLayout::for_cli(&workspace);
    let workspace_dir = layout.workbook_materialization_path();

    // Split folder into connection name + subfolder path.
    let (connection_name, subfolder): (Option<String>, Option<String>) = if let Some(f) = folder {
        let slash = f.find('/');
        let conn = match slash {
            Some(i) => f[..i].to_string(),
            None => f.to_string(),
        };
        let sub = match slash {
            Some(i) => f[i + 1..].to_string(),
            None => String::new(),
        };
        (Some(conn), Some(sub))
    } else {
        (None, None)
    };

    // Load validation config: inline > disk > empty.
    let entries: Vec<validators::ValidatorEntry> = if let Some(json) = validation_json {
        serde_json::from_str(json).map_err(|e| anyhow::anyhow!("invalid --validation JSON: {e}"))?
    } else if let (Some(conn), Some(sub)) = (&connection_name, &subfolder) {
        let scratch_dir = layout.connection_scratch_path(conn);
        let val_path = if sub.is_empty() {
            scratch_dir.join("validation.json")
        } else {
            scratch_dir.join(sub).join("validation.json")
        };
        match std::fs::read(&val_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| anyhow::anyhow!("failed to parse {}: {e}", val_path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => anyhow::bail!("failed to read {}: {e}", val_path.display()),
        }
    } else {
        Vec::new()
    };

    // Load schema: inline > disk > None.
    let schema: Option<serde_json::Value> = if let Some(json) = schema_json {
        Some(
            serde_json::from_str(json)
                .map_err(|e| anyhow::anyhow!("invalid --schema JSON: {e}"))?,
        )
    } else if let (Some(conn), Some(sub)) = (&connection_name, &subfolder) {
        let scratch_dir = layout.connection_scratch_path(conn);
        let schema_path = if sub.is_empty() {
            scratch_dir.join("schema.json")
        } else {
            scratch_dir.join(sub).join("schema.json")
        };
        match std::fs::read(&schema_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(_) => None,
        }
    } else {
        None
    };

    // Parse inline master once (reused for all files when --master is given).
    let inline_master: Option<serde_json::Value> = master_json
        .map(|j| serde_json::from_str(j).map_err(|e| anyhow::anyhow!("invalid --master JSON: {e}")))
        .transpose()?;

    let mut all_violations: Vec<validators::DryRunViolation> = Vec::new();

    if let Some(json) = record_json {
        // Inline record mode.
        let record: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| anyhow::anyhow!("invalid --record JSON: {e}"))?;
        let violations = validators::run_validators_dry(
            "<inline>",
            &record,
            inline_master.as_ref(),
            schema.as_ref(),
            &entries,
            &workspace_dir,
        )?;
        all_violations.extend(violations);
    } else {
        // Disk file mode.
        let (conn, sub) = match (&connection_name, &subfolder) {
            (Some(c), Some(s)) => (c.as_str(), s.as_str()),
            _ => anyhow::bail!("--folder is required when using --file"),
        };
        let dirty_dir = layout.dirty_checkout_path(conn);
        let master_dir = layout.master_worktree_path(conn);

        for file_name in files {
            let record_path = if sub.is_empty() {
                dirty_dir.join(file_name)
            } else {
                dirty_dir.join(sub).join(file_name)
            };
            let bytes = std::fs::read(&record_path)
                .map_err(|e| anyhow::anyhow!("failed to read {}: {e}", record_path.display()))?;
            let record: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|e| anyhow::anyhow!("invalid JSON in {}: {e}", record_path.display()))?;

            // Master: inline override takes priority; otherwise try disk.
            let disk_master: Option<serde_json::Value> = if master_json.is_none() {
                let master_path = if sub.is_empty() {
                    master_dir.join(file_name)
                } else {
                    master_dir.join(sub).join(file_name)
                };
                match std::fs::read(&master_path) {
                    Ok(bytes) => serde_json::from_slice(&bytes).ok(),
                    Err(_) => None,
                }
            } else {
                None
            };
            let file_master = if master_json.is_some() {
                inline_master.as_ref()
            } else {
                disk_master.as_ref()
            };

            let violations = validators::run_validators_dry(
                file_name,
                &record,
                file_master,
                schema.as_ref(),
                &entries,
                &workspace_dir,
            )?;
            all_violations.extend(violations);
        }
    }

    println!("{}", serde_json::to_string(&all_violations)?);
    Ok(())
}
