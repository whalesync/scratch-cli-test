//! Workspace-wide validation-results aggregator.
//!
//! For every connection in `<workspace>/.scratch/.scratchmd`, opens the
//! per-connection `.repos/<dir_name>.db` and reads from the shared
//! `validation_results__vN` table populated by `paginate-records --validate`
//! and `index refresh-folder --validate`. Pure SQL aggregation — no mtime
//! walk, no JSON parse, no git.
//!
//! Extracted from `cli::commands::validation::get_stats_command` so the same
//! aggregation can be called from:
//! - The `validation get-stats` CLI subcommand (which now delegates here).
//! - The `scratchmd-native` napi binding (so the desktop's sidebar dot/badge
//!   counts skip the per-invocation `scratchmd` spawn).
//!
//! Field naming is intentionally snake_case so the JSON output matches the
//! existing `ValidationStat` TypeScript shape and the snake_case keys
//! consumed by `PublishChangesModal.handleViewProblems`,
//! `ValidationStatsDrawer`, and `WorkspaceSidebar`'s
//! `${connection}/${folder_path}` Map key.

// `shared` is compiled for both binaries; only the CLI and the napi crate
// reach into this module today. Allow at module scope to keep the service
// binary's build warning-clean without per-item annotations. Mirrors the
// pattern in `shared::accepted_patches`.
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;

use crate::shared::folder_index::validation_results_table;

/// Per-folder validation-results counts emitted by [`collect_validation_stats`].
///
/// `folder_path` is the workspace-relative folder path *with the connection
/// directory prefix stripped*. Matches the long-standing TS `ValidationStat`
/// shape exactly so the napi-migrated `getValidationStats` call is a drop-in
/// replacement for the prior `runScratchmdJson(['validation', 'get-stats'])`
/// shell-out.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct FolderValidationStat {
    pub connection: String,
    pub folder_path: String,
    pub errors: i64,
    pub warnings: i64,
    /// Number of distinct records (files) that have at least one violation.
    pub records: i64,
}

/// Collect per-folder error/warning/record counts across every connection in
/// the workspace.
///
/// Lenient by design: a connection whose `.repos/<name>.db` is missing or
/// unreadable, or whose `validation_results__vN` table is absent, is silently
/// skipped — the desktop UI prefers a partial answer to a hard error when one
/// connection's index is corrupt. A missing/unreadable workspace marker is
/// surfaced as a normal error.
pub fn collect_validation_stats(workspace_dir: &Path) -> Result<Vec<FolderValidationStat>> {
    let marker = read_local_workspace_marker(workspace_dir)?;
    let table = validation_results_table();

    let mut stats: Vec<FolderValidationStat> = Vec::new();

    for connection in &marker.connections {
        if connection.dir_name.is_empty() {
            continue;
        }
        if !is_safe_connection_dir_name(&connection.dir_name) {
            // Defence in depth: a malformed `dirName` (`..`, path
            // separators, NULs) would let the join below escape the
            // workspace. Mirrors `shared::review_stats`.
            continue;
        }

        let db_path = workspace_dir
            .join(".repos")
            .join(format!("{}.db", &connection.dir_name));
        if !db_path.exists() {
            continue;
        }

        let conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Match the busy_timeout the regular `folder_index::open_conn` sets
        // so a concurrent reindex doesn't bounce us back with SQLITE_BUSY.
        let _ = conn.execute_batch("PRAGMA busy_timeout=5000;");

        let mut folder_stmt = match conn.prepare(&format!(
            "SELECT DISTINCT folder_path FROM {table} ORDER BY folder_path"
        )) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let folder_paths: Vec<String> = match folder_stmt.query_map([], |row| row.get(0)) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => continue,
        };

        for full_folder_path in folder_paths {
            let records: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(DISTINCT filename) FROM {table} WHERE folder_path = ?1"),
                    rusqlite::params![full_folder_path],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            if records == 0 {
                continue;
            }

            let errors: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(DISTINCT filename) FROM {table} \
                         WHERE folder_path = ?1 AND level = 'error'"
                    ),
                    rusqlite::params![full_folder_path],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let warnings: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(DISTINCT filename) FROM {table} \
                         WHERE folder_path = ?1 AND level = 'warning'"
                    ),
                    rusqlite::params![full_folder_path],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            // The `folder_path` column stores `<connection>/<sub_path>`. The
            // public TS shape only carries `<sub_path>`, so strip the prefix
            // — matching the original CLI behaviour at
            // `cli/commands/validation.rs:238`.
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

    Ok(stats)
}

// ─── Workspace marker (local copy of cli::config::markers shape) ────────────
//
// Same rationale as `shared::review_stats`: the canonical marker module lives
// in `cli::config::markers` and is unreachable from `shared::`. A small
// `dir_name`-only deserializer is enough here.

#[derive(serde::Deserialize)]
struct LocalConnectionEntry {
    #[serde(rename = "dirName", default)]
    dir_name: String,
}

#[derive(serde::Deserialize)]
struct LocalWorkspaceMarker {
    #[serde(default)]
    connections: Vec<LocalConnectionEntry>,
}

/// Reject `dirName` values that would let the join calls in
/// [`collect_validation_stats`] escape `workspace_dir`. Mirrors the same guard
/// in `shared::review_stats`.
fn is_safe_connection_dir_name(dir_name: &str) -> bool {
    if dir_name == "." || dir_name == ".." {
        return false;
    }
    !dir_name.contains('/') && !dir_name.contains('\\') && !dir_name.contains('\0')
}

fn read_local_workspace_marker(workspace_dir: &Path) -> Result<LocalWorkspaceMarker> {
    let marker_path = workspace_dir.join(".scratch").join(".scratchmd");
    let content = std::fs::read_to_string(&marker_path).with_context(|| {
        format!(
            "failed to read workspace marker at {}",
            marker_path.display()
        )
    })?;
    let marker: LocalWorkspaceMarker = serde_yaml::from_str(&content).with_context(|| {
        format!(
            "failed to parse workspace marker at {}",
            marker_path.display()
        )
    })?;
    Ok(marker)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::fs;
    use tempfile::tempdir;

    fn write_workspace_marker(workspace_dir: &Path, connection_dir_names: &[&str]) {
        let scratch_dir = workspace_dir.join(".scratch");
        fs::create_dir_all(&scratch_dir).unwrap();
        let mut yaml = String::from(
            "version: \"1\"\nworkbook:\n  id: wb1\n  name: Test\n  orgId: org1\n  serverUrl: http://localhost\n  initializedAt: \"2026-05-31T00:00:00Z\"\nconnections:\n",
        );
        for name in connection_dir_names {
            yaml.push_str(&format!(
                "  - id: c-{name}\n    displayName: {name}\n    service: airtable\n    repoPath: repo/{name}\n    dirName: {name}\n",
                name = name
            ));
        }
        fs::write(scratch_dir.join(".scratchmd"), yaml).unwrap();
    }

    /// Seed the shared `validation_results` table with rows. Each row is
    /// `(folder_path, filename, field_path, validator_kind, level)`.
    fn seed_validation_results(db: &Connection, rows: &[(&str, &str, &str, &str, &str)]) {
        let table = validation_results_table();
        db.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {table} (
                folder_path TEXT NOT NULL,
                filename TEXT NOT NULL,
                field_path TEXT NOT NULL,
                validator_kind TEXT NOT NULL,
                level TEXT NOT NULL CHECK (level IN ('error','warning')),
                message TEXT,
                description TEXT,
                fixable INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (folder_path, filename, field_path, validator_kind)
            );"
        ))
        .unwrap();
        for (folder_path, filename, field_path, validator_kind, level) in rows {
            db.execute(
                &format!(
                    "INSERT INTO {table} (folder_path, filename, field_path, validator_kind, level) VALUES (?1, ?2, ?3, ?4, ?5)"
                ),
                params![folder_path, filename, field_path, validator_kind, level],
            )
            .unwrap();
        }
    }

    #[test]
    fn empty_workspace_returns_empty() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[]);
        let stats = collect_validation_stats(tmp.path()).unwrap();
        assert!(stats.is_empty());
    }

    #[test]
    fn aggregates_distinct_filename_counts_per_level() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &["alpha"]);
        let db_path = tmp.path().join(".repos").join("alpha.db");
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();

        // alpha/posts:
        //   rec1 has 2 errors on 2 fields (counts as 1 distinct file)
        //   rec2 has 1 warning
        //   rec3 has 1 error
        seed_validation_results(
            &db,
            &[
                ("alpha/posts", "rec1.json", "title", "required", "error"),
                ("alpha/posts", "rec1.json", "body", "length", "error"),
                ("alpha/posts", "rec2.json", "title", "max_length", "warning"),
                ("alpha/posts", "rec3.json", "body", "required", "error"),
            ],
        );
        // alpha/tags: 2 records, both warnings only
        seed_validation_results(
            &db,
            &[
                ("alpha/tags", "tag1.json", "name", "max_length", "warning"),
                ("alpha/tags", "tag2.json", "name", "max_length", "warning"),
            ],
        );
        drop(db);

        let mut stats = collect_validation_stats(tmp.path()).unwrap();
        stats.sort_by(|a, b| a.folder_path.cmp(&b.folder_path));

        assert_eq!(
            stats,
            vec![
                FolderValidationStat {
                    connection: "alpha".to_string(),
                    folder_path: "posts".to_string(),
                    errors: 2,
                    warnings: 1,
                    records: 3,
                },
                FolderValidationStat {
                    connection: "alpha".to_string(),
                    folder_path: "tags".to_string(),
                    errors: 0,
                    warnings: 2,
                    records: 2,
                },
            ]
        );
    }

    #[test]
    fn missing_db_is_skipped() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &["alpha", "beta"]);
        // Only beta has a DB.
        let db_path = tmp.path().join(".repos").join("beta.db");
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();
        seed_validation_results(
            &db,
            &[("beta/notes", "n1.json", "title", "required", "error")],
        );
        drop(db);

        let stats = collect_validation_stats(tmp.path()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].connection, "beta");
        assert_eq!(stats[0].folder_path, "notes");
    }

    #[test]
    fn missing_marker_is_an_error() {
        let tmp = tempdir().unwrap();
        let err = collect_validation_stats(tmp.path()).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("workspace marker"),
            "unexpected error message: {msg}"
        );
    }
}
