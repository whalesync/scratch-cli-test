//! `scratchmd validation` subcommands — read validation results, dump configs,
//! and run dry-run validation without writing to the index.

use crate::shared::folder_index::validation_results_table;
use crate::shared::layout::WorkspaceLayout;
use crate::shared::validators;
use serde::Serialize;

use super::index::resolve_workspace;

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

/// `validation get-folder-problems`: all validation problems for records in a folder.
/// Optional `limit` caps result count and applies a deterministic order
/// (level DESC, filename, field_path) so the cap returns the most useful rows first.
pub fn get_folder_problems_command(
    workspace_start: &std::path::Path,
    folder_path_arg: &str,
    limit: Option<i64>,
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

    let table = validation_results_table();
    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(n) = limit {
        (
            format!(
                "SELECT filename, field_path, validator_kind, level, message, description, fixable \
                 FROM {table} \
                 WHERE folder_path = ?1 \
                 ORDER BY level DESC, filename, field_path \
                 LIMIT ?2"
            ),
            vec![Box::new(folder_path_arg.to_string()), Box::new(n)],
        )
    } else {
        (
            format!(
                "SELECT filename, field_path, validator_kind, level, message, description, fixable \
                 FROM {table} \
                 WHERE folder_path = ?1"
            ),
            vec![Box::new(folder_path_arg.to_string())],
        )
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| anyhow::anyhow!("failed to prepare query: {e}"))?;

    let params_ref: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows: Vec<ValidationResultRow> = stmt
        .query_map(params_ref.as_slice(), |row| {
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

/// `validation get-files-with-problems`: distinct filenames + field paths in a folder
/// that have at least one error-level violation. Used by the desktop app to power the
/// "has errors" grid filter and to focus the relevant columns. Optional `limit` caps
/// the filenames list (field_paths is always returned in full).
pub fn get_files_with_problems_command(
    workspace_start: &std::path::Path,
    folder_path_arg: &str,
    limit: Option<i64>,
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

    let table = validation_results_table();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT DISTINCT filename, field_path FROM {table} \
             WHERE folder_path = ?1"
        ))
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
    if let Some(n) = limit {
        filenames.truncate(n.max(0) as usize);
    }

    let mut field_paths: Vec<String> = rows.iter().map(|(_, p)| p.clone()).collect();
    field_paths.sort();
    field_paths.dedup();

    let out = serde_json::json!({ "filenames": filenames, "field_paths": field_paths });
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

/// `validation get-stats`: error/warning counts grouped by connection and folder
/// across all connections. Reads from the folder-index SQLite databases populated
/// by `paginate-records --validate` and `index refresh-folder --validate`.
///
/// Thin wrapper around [`crate::shared::validation_stats::collect_validation_stats`]
/// so the same aggregation can be called from the `scratchmd-native` napi
/// binding without spawning a CLI process.
pub fn get_stats_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let stats = crate::shared::validation_stats::collect_validation_stats(&workspace_dir)?;
    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}

/// `validation get-file-problems`: all validation problems for a single record.
/// `record_path` is workspace-relative: `<connection>/<folder>/<filename>`.
pub fn get_file_problems_command(
    workspace_start: &std::path::Path,
    record_path: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;

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

    let table = validation_results_table();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT field_path, validator_kind, level, message, description, fixable \
             FROM {table} \
             WHERE folder_path = ?1 AND filename = ?2"
        ))
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

/// `validation dump-config`: print all `validation.json` configs found in the workspace.
/// Reads from the filesystem only — no DB required.
pub fn dump_config_command(
    workspace_start: &std::path::Path,
    connection_filter: Option<&str>,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = super::index::read_workspace_marker(&workspace_dir)?;
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

/// `validation dry-run`: run validators against one or more records without writing
/// to the index. Designed for agent dry-runs — test a record before saving it, try a
/// new validation rule, or validate inline JSON without touching the index at all.
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
#[allow(clippy::too_many_arguments)]
pub fn dry_run_command(
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
    // For the always-on pseudo-reference format check. Read from the workspace ROOT, not
    // `workspace_dir` (which is the workbook materialization path).
    let workspace_connection_folder_names =
        validators::read_workspace_connection_folder_names(&workspace);

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

    let inline_master: Option<serde_json::Value> = master_json
        .map(|j| serde_json::from_str(j).map_err(|e| anyhow::anyhow!("invalid --master JSON: {e}")))
        .transpose()?;

    let mut all_violations: Vec<validators::DryRunViolation> = Vec::new();

    if let Some(json) = record_json {
        let record: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| anyhow::anyhow!("invalid --record JSON: {e}"))?;
        let violations = validators::run_validators_dry(
            "<inline>",
            &record,
            inline_master.as_ref(),
            schema.as_ref(),
            &entries,
            &workspace_dir,
            &workspace_connection_folder_names,
        )?;
        all_violations.extend(violations);
    } else {
        let (conn, sub) = match (&connection_name, &subfolder) {
            (Some(c), Some(s)) => (c.as_str(), s.as_str()),
            _ => anyhow::bail!("--folder is required when using --file"),
        };
        let worktree_dir = layout.worktree_path(conn);

        // Per-record published-version lookup against the connection's bare
        // repo at `refs/heads/main:<rel>`. Pre-slice-F this read from a
        // sparse `master` worktree on disk; that worktree no longer exists.
        // `--master` still wins when set; this is the on-disk fallback.
        let file_path_to_contents_map_in_main_branch = if master_json.is_some() {
            crate::shared::git_local::FileMap::new()
        } else {
            let marker_path = crate::config::markers::marker_path(&workspace);
            let bare_repo_path = match crate::config::markers::read(&marker_path) {
                Ok(crate::config::markers::Marker::Workspace(marker)) => marker
                    .connections
                    .iter()
                    .find(|c| c.dir_name == conn)
                    .map(|c| layout.bare_repo_path(&c.repo_path)),
                _ => None,
            };
            match bare_repo_path {
                Some(bare) => crate::shared::git_local::read_tree_files(&bare, "refs/heads/main")
                    .unwrap_or_default(),
                None => crate::shared::git_local::FileMap::new(),
            }
        };

        for file_name in files {
            let record_path = if sub.is_empty() {
                worktree_dir.join(file_name)
            } else {
                worktree_dir.join(sub).join(file_name)
            };
            let bytes = std::fs::read(&record_path)
                .map_err(|e| anyhow::anyhow!("failed to read {}: {e}", record_path.display()))?;
            let record: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|e| anyhow::anyhow!("invalid JSON in {}: {e}", record_path.display()))?;

            let disk_master: Option<serde_json::Value> = if master_json.is_none() {
                let key = if sub.is_empty() {
                    file_name.clone()
                } else {
                    format!("{sub}/{file_name}")
                };
                file_path_to_contents_map_in_main_branch
                    .get(&key)
                    .and_then(|b| serde_json::from_slice(b).ok())
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
                &workspace_connection_folder_names,
            )?;
            all_violations.extend(violations);
        }
    }

    println!("{}", serde_json::to_string(&all_violations)?);
    Ok(())
}

/// JSON summary printed by `validation rerun`.
#[derive(Serialize)]
struct RerunSummary {
    scope: &'static str,
    folders_revalidated: usize,
    records_validated: usize,
    errors: i64,
    warnings: i64,
    skipped_folders: usize,
}

/// `validation rerun`: force re-run all validators against the CURRENT index and refresh the
/// stored results, non-destructively, for a single folder, a whole connection, or the whole
/// workbook. Exactly one scope is set (clap's `ArgGroup` enforces it). Per-folder progress goes
/// to stderr; the aggregate JSON summary goes to stdout.
pub fn rerun_command(
    workspace_start: &std::path::Path,
    folder: Option<&str>,
    connection: Option<&str>,
    all: bool,
    debug: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;

    // Resolve the scope label and the concrete list of `<connection>/<subfolder>` folders to
    // revalidate. Connection/workspace scopes enumerate working-dir subfolders the same way
    // `index rebuild-all` does (one level under each connection dir, skipping dotfiles).
    let (scope, folders): (&'static str, Vec<String>) = if let Some(f) = folder {
        let normalized = f.trim_end_matches('/').to_string();
        if normalized.is_empty() || !normalized.contains('/') {
            anyhow::bail!("--folder must be '<connection>/<subfolder>', got: {f}");
        }
        ("folder", vec![normalized])
    } else if let Some(conn) = connection {
        let marker = super::index::read_workspace_marker(&workspace_dir)?;
        if !marker.connections.iter().any(|c| c.dir_name == conn) {
            anyhow::bail!(
                "Connection '{conn}' was not found in {}",
                workspace_dir.display()
            );
        }
        (
            "connection",
            subfolders_for_connection(&workspace_dir, conn),
        )
    } else if all {
        let marker = super::index::read_workspace_marker(&workspace_dir)?;
        let mut folders = Vec::new();
        for c in &marker.connections {
            folders.extend(subfolders_for_connection(&workspace_dir, &c.dir_name));
        }
        ("workspace", folders)
    } else {
        // Unreachable: clap's required ArgGroup guarantees exactly one scope flag.
        anyhow::bail!("exactly one of --folder, --connection, or --all is required");
    };

    let mut folders_revalidated = 0usize;
    let mut records_validated = 0usize;
    let mut skipped_folders = 0usize;

    for folder_path in &folders {
        eprintln!("[rerun] revalidating {folder_path}...");
        match crate::shared::folder_index::revalidate_folder(&workspace_dir, folder_path, debug) {
            Ok(result) => {
                folders_revalidated += 1;
                records_validated += result.validated;
            }
            Err(e) => {
                eprintln!("  ERROR revalidating {folder_path}: {e}");
                skipped_folders += 1;
            }
        }
    }

    // Sum error/warning totals for the scope from the freshly-updated results table.
    // `collect_validation_stats` returns `folder_path` with the connection prefix stripped, so
    // we compare its `folder_path` against the subfolder portion, not the full `<conn>/<sub>`.
    let stats = crate::shared::validation_stats::collect_validation_stats(&workspace_dir)?;
    let mut errors = 0i64;
    let mut warnings = 0i64;
    for stat in &stats {
        let in_scope = match scope {
            "folder" => {
                let folder_arg = folder.unwrap_or_default().trim_end_matches('/');
                let (conn, sub) = folder_arg.split_once('/').unwrap_or((folder_arg, ""));
                stat.connection == conn && stat.folder_path == sub
            }
            "connection" => stat.connection == connection.unwrap_or_default(),
            _ => true, // workspace scope
        };
        if in_scope {
            errors += stat.errors;
            warnings += stat.warnings;
        }
    }

    let summary = RerunSummary {
        scope,
        folders_revalidated,
        records_validated,
        errors,
        warnings,
        skipped_folders,
    };
    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
}

/// List `<dir_name>/<subfolder>` folders for one connection's working directory, mirroring
/// `index rebuild-all` (immediate subdirectories, skipping dotfiles). A missing or unreadable
/// working dir yields an empty list — the connection simply contributes no folders.
fn subfolders_for_connection(
    workspace_dir: &std::path::Path,
    connection_dir_name: &str,
) -> Vec<String> {
    let working_dir = workspace_dir.join(connection_dir_name);
    let entries = match std::fs::read_dir(&working_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| format!("{connection_dir_name}/{}", e.file_name().to_string_lossy()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn subfolders_for_connection_lists_dirs_and_skips_dotfiles_and_files() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        fs::create_dir_all(ws.join("conn").join("posts")).unwrap();
        fs::create_dir_all(ws.join("conn").join("tags")).unwrap();
        fs::create_dir_all(ws.join("conn").join(".scratch")).unwrap(); // dot-dir → skipped
        fs::write(ws.join("conn").join("notafolder.txt"), "x").unwrap(); // file → skipped

        let mut folders = subfolders_for_connection(ws, "conn");
        folders.sort();
        assert_eq!(
            folders,
            vec!["conn/posts".to_string(), "conn/tags".to_string()]
        );
    }

    #[test]
    fn subfolders_for_connection_missing_dir_is_empty() {
        let tmp = TempDir::new().unwrap();
        assert!(subfolders_for_connection(tmp.path(), "nope").is_empty());
    }
}
