//! Workspace-wide review-state aggregator.
//!
//! For every connection in `<workspace>/.scratch/.scratchmd`, walks the on-disk
//! data folder tree and reads the per-folder index table's `approvedChanges` /
//! `unapprovedChanges` bit columns. Pure SQL aggregation — no mtime walk, no
//! JSON parse, no git. Mirrors the staleness model of
//! `cli::commands::validation::get_stats_command`: the bits reflect whatever
//! `reindex_files` last persisted, so consumers that need fresh bits must call
//! `folder_index::refresh_folder` first.
//!
//! Powers the desktop sidebar's "Needs review" (blue) and "Approved" (gray) dots
//! per `docs/plans/2026-05-31-folder-tree-review-approved-dots.md`.
//!
//! Used by:
//! - `cli::commands::files::run_get_review_stats` (the `files get-review-stats`
//!   CLI subcommand).
//! - `scratchmd-native::get_review_stats` (the napi binding consumed by the
//!   Electron main process).

// `shared` is compiled for both binaries; only the CLI and the napi crate
// reach into this module today. Allow at module scope to keep the service
// binary's build warning-clean without per-item annotations. Mirrors the
// pattern in `shared::accepted_patches`.
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;

use crate::shared::folder_index::{quote_ident, table_name_from_folder, validation_results_table};

/// Per-folder review-state counts emitted by [`collect_review_stats`].
///
/// `folder_path` is the workspace-relative folder path *with the connection
/// directory prefix stripped* (e.g. for a folder at `<workspace>/HubSpot/Posts`
/// inside the `HubSpot` connection this is `"Posts"`). Matches the shape of
/// `cli::commands::validation::FolderValidationStat` so the desktop's
/// `ValidationStat` TS type and the new `ReviewStat` TS type stay symmetric.
///
/// Field naming is intentionally snake_case so the JSON output matches the
/// existing `validation get-stats` CLI shape and the desktop's snake_case
/// `ValidationStat` consumers.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct FolderReviewStat {
    pub connection: String,
    pub folder_path: String,
    /// Count of files in the folder where `unapprovedChanges = 1` — i.e. the
    /// working file differs from the approved (post-patch) version.
    pub unreviewed: i64,
    /// Count of files in the folder where `approvedChanges = 1` — i.e. an
    /// entry exists for the file in `accepted-patches.json`.
    pub approved: i64,
}

/// Collect per-folder unreviewed/approved counts across every connection in the
/// workspace. Skips folders whose counts are both zero so the result list stays
/// proportional to "interesting" folders.
///
/// Lenient by design: a connection whose `.repos/<name>.db` is missing or
/// unreadable is silently skipped (mirrors `validation get-stats` — UI prefers a
/// partial answer to a hard error when one connection's index is corrupt). A
/// missing or unreadable workspace marker, however, *is* surfaced.
///
/// Cost: one SQLite open per connection plus, per indexed folder, three trivial
/// queries (table-existence check + two `COUNT(*)` against partial indexes).
/// Sub-ms for typical workspaces.
pub fn collect_review_stats(workspace_dir: &Path) -> Result<Vec<FolderReviewStat>> {
    let marker = read_local_workspace_marker(workspace_dir)?;
    let validation_table = validation_results_table();

    let mut stats: Vec<FolderReviewStat> = Vec::new();

    for connection in &marker.connections {
        if connection.dir_name.is_empty() {
            continue;
        }
        if !is_safe_connection_dir_name(&connection.dir_name) {
            // Defence in depth: the marker is normally written by the CLI, but
            // a malformed `dirName` (`..`, path separators, NULs) would let the
            // join calls below escape the workspace.
            continue;
        }

        let db_path = workspace_dir
            .join(".repos")
            .join(format!("{}.db", &connection.dir_name));
        if !db_path.exists() {
            continue;
        }
        let db = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Match the busy_timeout the regular `folder_index::open_conn` sets so a
        // concurrent reindex doesn't bounce us back with SQLITE_BUSY.
        let _ = db.execute_batch("PRAGMA busy_timeout=5000;");

        let connection_root = workspace_dir.join(&connection.dir_name);
        if !connection_root.exists() {
            continue;
        }

        // Walk every directory under the connection root (recursively), skipping
        // hidden / dot-prefixed entries. We deliberately include intermediate
        // directories — folder_index has one table per indexed folder, and the
        // mapping from on-disk path to index table is `table_name_from_folder`.
        // Tables that don't exist for a given path are skipped below. Symlinks
        // are dropped silently by the walker because `DirEntry::file_type()`
        // returns the symlink's own type (not the target's) and so reports a
        // non-directory for symlinked subdirectories — no risk of cycles.
        let mut folder_rel_paths: Vec<String> = Vec::new();
        collect_data_folder_rel_paths(&connection_root, "", &mut folder_rel_paths)?;

        // `table_name_from_folder` slugifies `/` → `_`, so two distinct
        // on-disk paths can collide on the same SQL table name (e.g.
        // `foo/bar` and `foo_bar`). Dedup at this layer so we don't read the
        // same per-folder index table twice and emit double-counted rows.
        let mut tables_seen_in_connection = std::collections::HashSet::new();
        for folder_rel_path in folder_rel_paths {
            // `folder_index::table_name_from_folder` expects the
            // `<connection>/<sub_path>` shape (or just `<connection>` for the
            // connection root).
            let folder_key = if folder_rel_path.is_empty() {
                connection.dir_name.clone()
            } else {
                format!("{}/{}", connection.dir_name, folder_rel_path)
            };
            let table = table_name_from_folder(&folder_key);

            // The shared validation_results table lives in every per-connection
            // .db too. Don't confuse it with a per-folder index table.
            if table == validation_table {
                continue;
            }
            if !tables_seen_in_connection.insert(table.clone()) {
                continue;
            }

            // Skip folders that haven't been indexed yet (table absent).
            let table_exists: i64 = match db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![&table],
                |r| r.get(0),
            ) {
                Ok(n) => n,
                Err(_) => continue,
            };
            if table_exists == 0 {
                continue;
            }

            let table_q = quote_ident(&table);

            let unreviewed: i64 = db
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table_q} WHERE unapprovedChanges = 1"),
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let approved: i64 = db
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table_q} WHERE approvedChanges = 1"),
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            if unreviewed == 0 && approved == 0 {
                continue;
            }

            stats.push(FolderReviewStat {
                connection: connection.dir_name.clone(),
                folder_path: folder_rel_path,
                unreviewed,
                approved,
            });
        }
    }

    Ok(stats)
}

// ─── Workspace marker (local copy of cli::config::markers shape) ────────────
//
// `cli::config::markers` lives in the CLI crate and is not reachable from
// `shared::`. `shared::review_ops` already establishes the precedent of a
// private local serde struct for the marker — we follow that same pattern so
// this module stays portable across the CLI binary and the napi addon.

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
/// [`collect_review_stats`] escape `workspace_dir`. The CLI normally writes
/// well-formed marker entries, but a hand-edited or imported workspace marker
/// could carry a relative-path-traversal payload — guard against it explicitly.
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

/// Recursively walk `<dir>` and push every encountered subdirectory's path
/// relative to `dir` into `out`. The connection root itself contributes the
/// empty string (so [`collect_review_stats`] can also count the
/// connection-root's index table if one exists).
///
/// Skips entries whose name starts with `.` — the workspace's `.scratch`
/// directory, hidden files, etc.
fn collect_data_folder_rel_paths(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<()> {
    out.push(prefix.to_string());

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let child_prefix = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        collect_data_folder_rel_paths(&entry.path(), &child_prefix, out)?;
    }
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::fs;
    use tempfile::tempdir;

    /// Write a minimal workspace marker for the given connection dir names.
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

    /// Create a per-folder records table with the minimal columns
    /// `collect_review_stats` reads, and populate the bits.
    fn seed_folder_table(
        db: &Connection,
        table: &str,
        rows: &[(&str, i64, i64)],
    ) -> rusqlite::Result<()> {
        let table_q = quote_ident(table);
        db.execute_batch(&format!(
            "CREATE TABLE {table_q} (
                filename TEXT PRIMARY KEY,
                approvedChanges INTEGER NOT NULL DEFAULT 0,
                unapprovedChanges INTEGER NOT NULL DEFAULT 0
            );"
        ))?;
        for (filename, approved, unapproved) in rows {
            db.execute(
                &format!(
                    "INSERT INTO {table_q} (filename, approvedChanges, unapprovedChanges) VALUES (?1, ?2, ?3)"
                ),
                params![filename, approved, unapproved],
            )?;
        }
        Ok(())
    }

    #[test]
    fn empty_workspace_returns_empty() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[]);
        let stats = collect_review_stats(tmp.path()).unwrap();
        assert!(stats.is_empty());
    }

    #[test]
    fn skips_folders_with_no_bits_set() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &["alpha"]);

        // On-disk folder layout: alpha/posts/
        fs::create_dir_all(tmp.path().join("alpha").join("posts")).unwrap();

        // Index DB with a table whose rows have no bits set.
        let db_path = tmp.path().join(".repos").join("alpha.db");
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();
        let table = table_name_from_folder("alpha/posts");
        seed_folder_table(&db, &table, &[("rec1.json", 0, 0), ("rec2.json", 0, 0)]).unwrap();
        drop(db);

        let stats = collect_review_stats(tmp.path()).unwrap();
        assert!(stats.is_empty(), "expected empty stats but got {stats:?}");
    }

    #[test]
    fn aggregates_unreviewed_and_approved_bits_per_folder() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &["alpha", "beta"]);

        // alpha/posts: 3 unreviewed, 1 approved
        // alpha/tags:  0 unreviewed, 2 approved
        // beta/notes:  5 unreviewed, 0 approved
        fs::create_dir_all(tmp.path().join("alpha").join("posts")).unwrap();
        fs::create_dir_all(tmp.path().join("alpha").join("tags")).unwrap();
        fs::create_dir_all(tmp.path().join("beta").join("notes")).unwrap();

        let alpha_db = tmp.path().join(".repos").join("alpha.db");
        fs::create_dir_all(alpha_db.parent().unwrap()).unwrap();
        let db = Connection::open(&alpha_db).unwrap();
        seed_folder_table(
            &db,
            &table_name_from_folder("alpha/posts"),
            &[
                ("a.json", 0, 1),
                ("b.json", 0, 1),
                ("c.json", 0, 1),
                ("d.json", 1, 0),
                ("e.json", 0, 0),
            ],
        )
        .unwrap();
        seed_folder_table(
            &db,
            &table_name_from_folder("alpha/tags"),
            &[("x.json", 1, 0), ("y.json", 1, 0)],
        )
        .unwrap();
        drop(db);

        let beta_db = tmp.path().join(".repos").join("beta.db");
        let db = Connection::open(&beta_db).unwrap();
        seed_folder_table(
            &db,
            &table_name_from_folder("beta/notes"),
            &[
                ("n1.json", 0, 1),
                ("n2.json", 0, 1),
                ("n3.json", 0, 1),
                ("n4.json", 0, 1),
                ("n5.json", 0, 1),
            ],
        )
        .unwrap();
        drop(db);

        let mut stats = collect_review_stats(tmp.path()).unwrap();
        stats.sort_by(|a, b| {
            a.connection
                .cmp(&b.connection)
                .then(a.folder_path.cmp(&b.folder_path))
        });

        assert_eq!(
            stats,
            vec![
                FolderReviewStat {
                    connection: "alpha".to_string(),
                    folder_path: "posts".to_string(),
                    unreviewed: 3,
                    approved: 1,
                },
                FolderReviewStat {
                    connection: "alpha".to_string(),
                    folder_path: "tags".to_string(),
                    unreviewed: 0,
                    approved: 2,
                },
                FolderReviewStat {
                    connection: "beta".to_string(),
                    folder_path: "notes".to_string(),
                    unreviewed: 5,
                    approved: 0,
                },
            ]
        );
    }

    #[test]
    fn ignores_validation_results_table_in_connection_db() {
        // Regression guard: the shared validation_results__vN table lives in the
        // same per-connection .db, and one of the per-folder folder paths could
        // theoretically collide with its slug. Make sure we never accidentally
        // aggregate it.
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &["alpha"]);
        fs::create_dir_all(tmp.path().join("alpha").join("posts")).unwrap();

        let db_path = tmp.path().join(".repos").join("alpha.db");
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();

        // Seed a real per-folder table so the test exercises the normal path.
        seed_folder_table(
            &db,
            &table_name_from_folder("alpha/posts"),
            &[("a.json", 1, 0)],
        )
        .unwrap();

        // Seed a validation_results table with the same column shape so an
        // accidental aggregation would silently succeed instead of erroring.
        let vt = validation_results_table();
        let vt_q = quote_ident(&vt);
        db.execute_batch(&format!(
            "CREATE TABLE {vt_q} (
                filename TEXT PRIMARY KEY,
                approvedChanges INTEGER NOT NULL DEFAULT 0,
                unapprovedChanges INTEGER NOT NULL DEFAULT 0
            );"
        ))
        .unwrap();
        db.execute(
            &format!(
                "INSERT INTO {vt_q} (filename, approvedChanges, unapprovedChanges) VALUES ('x', 1, 1)"
            ),
            [],
        )
        .unwrap();
        drop(db);

        let stats = collect_review_stats(tmp.path()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].connection, "alpha");
        assert_eq!(stats[0].folder_path, "posts");
        assert_eq!(stats[0].unreviewed, 0);
        assert_eq!(stats[0].approved, 1);
    }

    #[test]
    fn skips_connections_with_missing_db() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &["alpha", "beta"]);
        fs::create_dir_all(tmp.path().join("alpha").join("posts")).unwrap();
        fs::create_dir_all(tmp.path().join("beta").join("notes")).unwrap();

        // Only alpha has a .repos/<name>.db. beta should be silently skipped.
        let alpha_db = tmp.path().join(".repos").join("alpha.db");
        fs::create_dir_all(alpha_db.parent().unwrap()).unwrap();
        let db = Connection::open(&alpha_db).unwrap();
        seed_folder_table(
            &db,
            &table_name_from_folder("alpha/posts"),
            &[("a.json", 0, 1)],
        )
        .unwrap();
        drop(db);

        let stats = collect_review_stats(tmp.path()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].connection, "alpha");
    }

    #[test]
    fn rejects_unsafe_connection_dir_names() {
        // `.` / `..` / values containing path separators or NUL get filtered
        // out before any join — defence in depth against a hand-edited
        // marker that points at `../../etc` etc.
        assert!(is_safe_connection_dir_name("alpha"));
        assert!(is_safe_connection_dir_name("HubSpot - Sales"));
        assert!(!is_safe_connection_dir_name("."));
        assert!(!is_safe_connection_dir_name(".."));
        assert!(!is_safe_connection_dir_name("with/slash"));
        assert!(!is_safe_connection_dir_name("with\\back"));
        assert!(!is_safe_connection_dir_name("with\0nul"));
        assert!(!is_safe_connection_dir_name("../../etc"));

        // Integration test: a marker with a hostile dir name produces no
        // stats from the hostile entry while still surfacing the valid
        // entry alongside it.
        let tmp = tempdir().unwrap();
        let scratch_dir = tmp.path().join(".scratch");
        fs::create_dir_all(&scratch_dir).unwrap();
        let yaml = concat!(
            "version: \"1\"\n",
            "workbook:\n",
            "  id: wb1\n",
            "  name: T\n",
            "  orgId: o\n",
            "  serverUrl: http://x\n",
            "  initializedAt: \"2026-05-31T00:00:00Z\"\n",
            "connections:\n",
            "  - id: c0\n",
            "    displayName: D\n",
            "    service: airtable\n",
            "    repoPath: r0\n",
            "    dirName: alpha\n",
            "  - id: c1\n",
            "    displayName: D\n",
            "    service: airtable\n",
            "    repoPath: r1\n",
            "    dirName: \"..\"\n",
        );
        fs::write(scratch_dir.join(".scratchmd"), yaml).unwrap();
        fs::create_dir_all(tmp.path().join("alpha").join("posts")).unwrap();

        let db_path = tmp.path().join(".repos").join("alpha.db");
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();
        seed_folder_table(
            &db,
            &table_name_from_folder("alpha/posts"),
            &[("a.json", 0, 1)],
        )
        .unwrap();
        drop(db);

        let stats = collect_review_stats(tmp.path()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].connection, "alpha");
        assert_eq!(stats[0].folder_path, "posts");
    }

    #[test]
    fn collapses_on_disk_paths_that_map_to_the_same_index_table() {
        // `table_name_from_folder` slugifies `/` -> `_`, so the on-disk
        // paths `alpha/foo/bar` and `alpha/foo_bar` would both resolve to the
        // table `foo_bar__v4`. Without dedup the walker would push both
        // and we'd emit two rows with identical counts. The fix is to skip
        // duplicate table names per connection.
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &["alpha"]);
        fs::create_dir_all(tmp.path().join("alpha").join("foo").join("bar")).unwrap();
        fs::create_dir_all(tmp.path().join("alpha").join("foo_bar")).unwrap();

        let db_path = tmp.path().join(".repos").join("alpha.db");
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Connection::open(&db_path).unwrap();
        // Confirm that the colliding paths produce the same table name.
        let table_a = table_name_from_folder("alpha/foo/bar");
        let table_b = table_name_from_folder("alpha/foo_bar");
        assert_eq!(table_a, table_b);
        seed_folder_table(&db, &table_a, &[("rec.json", 1, 1)]).unwrap();
        drop(db);

        let stats = collect_review_stats(tmp.path()).unwrap();
        assert_eq!(stats.len(), 1, "expected dedup but got {stats:?}");
    }

    #[test]
    fn missing_marker_is_an_error() {
        let tmp = tempdir().unwrap();
        // No .scratch/.scratchmd written.
        let err = collect_review_stats(tmp.path()).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("workspace marker"),
            "unexpected error message: {msg}"
        );
    }
}
