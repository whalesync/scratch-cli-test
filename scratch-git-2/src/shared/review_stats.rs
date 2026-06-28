//! Workspace-wide review-state aggregator.
//!
//! For every connection in `<workspace>/.scratch/.scratchmd`, derives the
//! per-folder "needs review" / "approved" counts directly from git +
//! `accepted-patches.json` — no SQLite, no persisted index:
//!
//! - **unreviewed** = records whose working file differs from their approved
//!   state. One `gix status` per connection, disambiguated against `main` +
//!   `accepted-patches.json` (the shared
//!   [`review_ops::list_unreviewed_records_using_gix_status`]).
//! - **approved** = records with an entry in `accepted-patches.json` (the source
//!   of truth for the "approved" state; git does not see it).
//!
//! Both sets are O(changes), so this is cheap on a mostly-clean corpus and needs
//! no cold-start index build (DEV-10327). Powers the desktop sidebar's "Needs
//! review" (blue) and "Approved" (gray) dots per
//! `docs/plans/resolved/2026-05-31-folder-tree-review-approved-dots/2026-05-31-folder-tree-review-approved-dots.md`.
//!
//! Used by:
//! - `cli::commands::files::run_get_review_stats` (the `files get-review-stats`
//!   CLI subcommand).
//! - `scratchmd-native::get_review_stats` (the napi binding consumed by the
//!   Electron main process).

// `shared` is compiled for both binaries; only the CLI and the napi crate reach
// into this module today. Allow at module scope to keep the service binary's
// build warning-clean. Mirrors the pattern in `shared::accepted_patches`.
#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::shared::accepted_patches;
use crate::shared::layout::WorkspaceLayout;
use crate::shared::review_ops::{self, ConnectionPaths};

/// Per-folder review-state counts emitted by [`collect_review_stats`].
///
/// `folder_path` is the connection-relative folder path *with the connection
/// directory prefix stripped* (e.g. for a record at `HubSpot/Posts/rec1.json`
/// inside the `HubSpot` connection this is `"Posts"`; a record at the connection
/// root is `""`). Matches the shape of `cli::commands::validation::
/// FolderValidationStat` so the desktop's `ValidationStat` TS type and the
/// `ReviewStat` TS type stay symmetric.
///
/// Field naming is intentionally snake_case so the JSON output matches the
/// existing `validation get-stats` CLI shape and the desktop's snake_case
/// `ValidationStat` consumers.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct FolderReviewStat {
    pub connection: String,
    pub folder_path: String,
    /// Count of records in the folder whose working file differs from its
    /// approved (post-patch) version — i.e. `gix status` flagged them and a
    /// semantic JSON compare confirmed a real change.
    pub unreviewed: i64,
    /// Count of records in the folder with an entry in `accepted-patches.json`.
    pub approved: i64,
}

/// Collect per-folder unreviewed/approved counts across every connection in the
/// workspace. Skips folders whose counts are both zero so the result list stays
/// proportional to "interesting" folders.
///
/// Lenient by design: a connection whose worktree is missing/unreadable (mid
/// setup, or repo not yet materialized) is silently skipped — the UI prefers a
/// partial answer to a hard error when one connection is in a bad state. A
/// missing or unreadable workspace marker, however, *is* surfaced.
///
/// Cost: one `gix status` plus one `accepted-patches.json` read per connection.
/// Both are O(changes), not O(corpus) — sub-100 ms on a mostly-clean 20k-file
/// connection (DEV-10327).
pub fn collect_review_stats(workspace_dir: &Path) -> Result<Vec<FolderReviewStat>> {
    let marker = read_local_workspace_marker(workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(workspace_dir);

    let mut stats: Vec<FolderReviewStat> = Vec::new();

    for connection in &marker.connections {
        if connection.dir_name.is_empty() || connection.repo_path.is_empty() {
            continue;
        }
        if !is_safe_connection_dir_name(&connection.dir_name) {
            // Defence in depth: the marker is normally written by the CLI, but a
            // malformed `dirName` (`..`, path separators, NULs) would let the
            // path joins below escape the workspace.
            continue;
        }

        let paths = ConnectionPaths {
            conn_dir_name: connection.dir_name.clone(),
            workspace_dir: workspace_dir.to_path_buf(),
            worktree_dir: layout.worktree_path(&connection.dir_name),
            bare_repo: layout.bare_repo_path(&connection.repo_path),
            scratch_dir: layout.connection_scratch_path(&connection.dir_name),
        };

        // Lenient: a connection whose worktree hasn't been materialized yet is
        // skipped rather than failing the whole workspace.
        if !paths.worktree_dir.exists() {
            continue;
        }

        // unreviewed = working differs from approved. One gix status per
        // connection, disambiguated against main + accepted-patches.
        let unreviewed_count_by_folder: HashMap<String, i64> =
            match review_ops::list_unreviewed_records_using_gix_status(&paths, false) {
                Ok(records) => bucket_count_by_folder(records.iter().map(|r| r.path.as_str())),
                // A connection whose repo/worktree is unreadable is skipped, not
                // fatal — same leniency the old per-connection DB-skip had.
                Err(_) => continue,
            };

        // approved = a record has an entry in accepted-patches.json.
        let approved_count_by_folder: HashMap<String, i64> =
            match accepted_patches::load(&review_ops::accepted_patches_dir(&paths)) {
                Ok(file) => bucket_count_by_folder(
                    file.patches
                        .iter()
                        .map(|patch| patch.path.as_str())
                        .filter(|path| review_ops::is_data_path_in_folder(path, "")),
                ),
                Err(_) => continue,
            };

        // Emit one row per folder touched by either set; skip zero-zero (can't
        // happen for a folder present in either map, but the guard keeps the
        // contract explicit).
        let mut folders: BTreeSet<&String> = BTreeSet::new();
        folders.extend(unreviewed_count_by_folder.keys());
        folders.extend(approved_count_by_folder.keys());
        for folder_path in folders {
            let unreviewed = unreviewed_count_by_folder
                .get(folder_path)
                .copied()
                .unwrap_or(0);
            let approved = approved_count_by_folder
                .get(folder_path)
                .copied()
                .unwrap_or(0);
            if unreviewed == 0 && approved == 0 {
                continue;
            }
            stats.push(FolderReviewStat {
                connection: connection.dir_name.clone(),
                folder_path: folder_path.clone(),
                unreviewed,
                approved,
            });
        }
    }

    Ok(stats)
}

/// Count connection-relative record paths by their parent folder.
fn bucket_count_by_folder<'a>(paths: impl Iterator<Item = &'a str>) -> HashMap<String, i64> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for path in paths {
        *counts.entry(parent_folder_of(path)).or_insert(0) += 1;
    }
    counts
}

/// Connection-relative parent folder of a record path: `"Posts/rec1.json"` ->
/// `"Posts"`, `"A/B/rec.json"` -> `"A/B"`, `"rec.json"` -> `""` (connection root).
fn parent_folder_of(record_path: &str) -> String {
    match record_path.rfind('/') {
        Some(idx) => record_path[..idx].to_string(),
        None => String::new(),
    }
}

// ─── Workspace marker (local copy of cli::config::markers shape) ────────────
//
// `cli::config::markers` lives in the CLI crate and is not reachable from
// `shared::`. `shared::review_ops` already establishes the precedent of a
// private local serde struct for the marker — we follow that same pattern so
// this module stays portable across the CLI binary and the napi addon.

#[derive(serde::Deserialize)]
struct LocalConnectionEntry {
    #[serde(rename = "repoPath", default)]
    repo_path: String,
    #[serde(rename = "dirName", default)]
    dir_name: String,
}

#[derive(serde::Deserialize)]
struct LocalWorkspaceMarker {
    #[serde(default)]
    connections: Vec<LocalConnectionEntry>,
}

/// Reject `dirName` values that would let the path joins in
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

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::accepted_patches::AcceptedPatchesFile;
    use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
    use std::fs;
    use std::process::{Command, Stdio};
    use tempfile::tempdir;

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed in {}", dir.display());
    }

    /// Write a workspace marker for the given `(dir_name, repo_path)` connections.
    fn write_workspace_marker(workspace_dir: &Path, connections: &[(&str, &str)]) {
        let scratch_dir = workspace_dir.join(".scratch");
        fs::create_dir_all(&scratch_dir).unwrap();
        let mut yaml = String::from(
            "version: \"1\"\nworkbook:\n  id: wb1\n  name: Test\n  orgId: org1\n  serverUrl: http://localhost\n  initializedAt: \"2026-05-31T00:00:00Z\"\nconnections:\n",
        );
        for (dir_name, repo_path) in connections {
            yaml.push_str(&format!(
                "  - id: c-{dir_name}\n    displayName: {dir_name}\n    service: airtable\n    repoPath: {repo_path}\n    dirName: {dir_name}\n",
            ));
        }
        fs::write(scratch_dir.join(".scratchmd"), yaml).unwrap();
    }

    /// Build a connection: a worktree at `<workspace>/<dir_name>` with `records`
    /// committed on `main` (index fresh == clean), and a bare repo cloned from it
    /// at `<workspace>/.repos/<repo>.git` (where `collect_review_stats` looks).
    fn setup_connection(workspace: &Path, dir_name: &str, repo: &str, records: &[(&str, &str)]) {
        let worktree = workspace.join(dir_name);
        fs::create_dir_all(&worktree).unwrap();
        git(&worktree, &["init", "-q", "-b", "main", "."]);
        git(&worktree, &["config", "user.email", "t@t.com"]);
        git(&worktree, &["config", "user.name", "t"]);
        git(&worktree, &["config", "commit.gpgsign", "false"]);
        for (path, content) in records {
            write_record(&worktree, path, content);
        }
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-q", "-m", "seed"]);
        let bare = workspace.join(".repos").join(format!("{repo}.git"));
        fs::create_dir_all(bare.parent().unwrap()).unwrap();
        git(
            &worktree,
            &["clone", "-q", "--bare", ".", bare.to_str().unwrap()],
        );
    }

    fn write_record(worktree: &Path, rel_path: &str, content: &str) {
        let p = worktree.join(rel_path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn write_accepted_patches(workspace: &Path, dir_name: &str, patches: Vec<AnchoredPatch>) {
        let connection_dir = workspace
            .join(".scratch")
            .join("connections")
            .join(dir_name);
        accepted_patches::save_atomic(&connection_dir, &AcceptedPatchesFile { patches }).unwrap();
    }

    fn sorted(mut stats: Vec<FolderReviewStat>) -> Vec<FolderReviewStat> {
        stats.sort_by(|a, b| {
            a.connection
                .cmp(&b.connection)
                .then(a.folder_path.cmp(&b.folder_path))
        });
        stats
    }

    #[test]
    fn empty_workspace_returns_empty() {
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[]);
        assert!(collect_review_stats(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn clean_connection_yields_no_stats() {
        if !git_available() {
            return;
        }
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[("HubSpot", "hub")]);
        setup_connection(
            tmp.path(),
            "HubSpot",
            "hub",
            &[("Posts/a.json", "{\"name\":\"A\"}\n")],
        );
        assert!(collect_review_stats(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn unreviewed_changes_bucketed_by_folder() {
        if !git_available() {
            return;
        }
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[("HubSpot", "hub")]);
        setup_connection(
            tmp.path(),
            "HubSpot",
            "hub",
            &[
                ("Posts/a.json", "{\"name\":\"A\"}\n"),
                ("Posts/b.json", "{\"name\":\"B\"}\n"),
                ("Posts/c.json", "{\"name\":\"C\"}\n"),
                ("Tags/d.json", "{\"name\":\"D\"}\n"),
            ],
        );

        // Dirty 2 records in Posts and 1 in Tags with real semantic edits.
        let worktree = tmp.path().join("HubSpot");
        write_record(&worktree, "Posts/a.json", "{\"name\":\"A-edited\"}\n");
        write_record(&worktree, "Posts/b.json", "{\"name\":\"B-edited\"}\n");
        write_record(&worktree, "Tags/d.json", "{\"name\":\"D-edited\"}\n");

        let stats = sorted(collect_review_stats(tmp.path()).unwrap());
        assert_eq!(
            stats,
            vec![
                FolderReviewStat {
                    connection: "HubSpot".into(),
                    folder_path: "Posts".into(),
                    unreviewed: 2,
                    approved: 0,
                },
                FolderReviewStat {
                    connection: "HubSpot".into(),
                    folder_path: "Tags".into(),
                    unreviewed: 1,
                    approved: 0,
                },
            ]
        );
    }

    #[test]
    fn whitespace_only_edit_is_not_unreviewed() {
        if !git_available() {
            return;
        }
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[("HubSpot", "hub")]);
        setup_connection(
            tmp.path(),
            "HubSpot",
            "hub",
            &[("Posts/a.json", "{\n  \"name\": \"A\"\n}\n")],
        );
        // Re-write with different bytes (no trailing newline) but identical JSON.
        write_record(
            &tmp.path().join("HubSpot"),
            "Posts/a.json",
            "{\"name\":\"A\"}",
        );

        assert!(
            collect_review_stats(tmp.path()).unwrap().is_empty(),
            "a whitespace/formatting-only edit must not count as unreviewed",
        );
    }

    #[test]
    fn approved_changes_counted_and_not_double_counted_as_unreviewed() {
        if !git_available() {
            return;
        }
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[("HubSpot", "hub")]);
        // main: Posts/a.json = {"name":"Acme"}, plus a clean sibling.
        setup_connection(
            tmp.path(),
            "HubSpot",
            "hub",
            &[
                ("Posts/a.json", "{\"name\":\"Acme\"}\n"),
                ("Posts/b.json", "{\"name\":\"Bee\"}\n"),
            ],
        );

        // Accept an Update on Posts/a.json (merge patch adds "status").
        write_accepted_patches(
            tmp.path(),
            "HubSpot",
            vec![AnchoredPatch {
                path: "Posts/a.json".into(),
                kind: PatchKind::Update,
                patch: serde_json::json!({ "status": "new" }),
                revert: false,
            }],
        );
        // Write the working file to the *approved* state (= apply(main, patch))
        // so it is approved but NOT unreviewed.
        write_record(
            &tmp.path().join("HubSpot"),
            "Posts/a.json",
            "{\"name\":\"Acme\",\"status\":\"new\"}\n",
        );

        let stats = sorted(collect_review_stats(tmp.path()).unwrap());
        assert_eq!(
            stats,
            vec![FolderReviewStat {
                connection: "HubSpot".into(),
                folder_path: "Posts".into(),
                unreviewed: 0,
                approved: 1,
            }]
        );
    }

    #[test]
    fn aggregates_across_multiple_connections() {
        if !git_available() {
            return;
        }
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[("Alpha", "alpha"), ("Beta", "beta")]);
        setup_connection(
            tmp.path(),
            "Alpha",
            "alpha",
            &[("Posts/a.json", "{\"v\":1}\n")],
        );
        setup_connection(
            tmp.path(),
            "Beta",
            "beta",
            &[("Notes/n.json", "{\"v\":1}\n")],
        );

        write_record(&tmp.path().join("Alpha"), "Posts/a.json", "{\"v\":2}\n");
        write_record(&tmp.path().join("Beta"), "Notes/n.json", "{\"v\":2}\n");

        let stats = sorted(collect_review_stats(tmp.path()).unwrap());
        assert_eq!(
            stats,
            vec![
                FolderReviewStat {
                    connection: "Alpha".into(),
                    folder_path: "Posts".into(),
                    unreviewed: 1,
                    approved: 0,
                },
                FolderReviewStat {
                    connection: "Beta".into(),
                    folder_path: "Notes".into(),
                    unreviewed: 1,
                    approved: 0,
                },
            ]
        );
    }

    #[test]
    fn root_level_record_buckets_to_empty_folder_path() {
        if !git_available() {
            return;
        }
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[("HubSpot", "hub")]);
        setup_connection(
            tmp.path(),
            "HubSpot",
            "hub",
            &[("root.json", "{\"v\":1}\n")],
        );
        write_record(&tmp.path().join("HubSpot"), "root.json", "{\"v\":2}\n");

        let stats = collect_review_stats(tmp.path()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].folder_path, "");
        assert_eq!(stats[0].unreviewed, 1);
    }

    #[test]
    fn rejects_unsafe_connection_dir_names() {
        assert!(is_safe_connection_dir_name("alpha"));
        assert!(is_safe_connection_dir_name("HubSpot - Sales"));
        assert!(!is_safe_connection_dir_name("."));
        assert!(!is_safe_connection_dir_name(".."));
        assert!(!is_safe_connection_dir_name("with/slash"));
        assert!(!is_safe_connection_dir_name("with\\back"));
        assert!(!is_safe_connection_dir_name("with\0nul"));
        assert!(!is_safe_connection_dir_name("../../etc"));

        if !git_available() {
            return;
        }
        // A hostile dir name in the marker produces no stats while the valid
        // connection alongside it still does.
        let tmp = tempdir().unwrap();
        write_workspace_marker(tmp.path(), &[("alpha", "alpha"), ("..", "evil")]);
        setup_connection(
            tmp.path(),
            "alpha",
            "alpha",
            &[("Posts/a.json", "{\"v\":1}\n")],
        );
        write_record(&tmp.path().join("alpha"), "Posts/a.json", "{\"v\":2}\n");

        let stats = collect_review_stats(tmp.path()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].connection, "alpha");
        assert_eq!(stats[0].folder_path, "Posts");
    }

    #[test]
    fn missing_marker_is_an_error() {
        let tmp = tempdir().unwrap();
        let err = collect_review_stats(tmp.path()).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("workspace marker"),
            "unexpected error message: {msg}"
        );
    }
}
