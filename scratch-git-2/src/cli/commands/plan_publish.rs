//! `scratchmd plan-publish` — build a local publish plan by diffing dirty vs master.
//!
//! This is a thin CLI wrapper around [`crate::shared::plan_publish::build_publish_plan`].
//! See that module for the core logic, types, and file layout documentation.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use crate::commands::files::{has_unreviewed_record_changes, materialize_treeish_to_worktree};
use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;
use crate::shared::plan_publish::{self, PlanResult};

// ---------------------------------------------------------------------------
// Entry point: build plan for all connectors in a workspace
// ---------------------------------------------------------------------------

pub fn run(workspace_start: &Path) -> anyhow::Result<()> {
    let workspace = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace)?;
    let layout = WorkspaceLayout::for_cli(&workspace);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace.display()
        );
    }

    let timestamp = plan_publish::now_compact();
    let mut any_changes = false;

    for connection in &workspace_marker.connections {
        let conn_name = connection.dir_name.clone();
        let dirty_dir = layout.dirty_checkout_path(&conn_name);
        let master_dir = layout.master_worktree_path(&conn_name);
        let scratch_dir = layout.connection_scratch_path(&conn_name);
        let db_path = layout.index_db_path(&connection.repo_path);
        let bare_repo = layout.bare_repo_path(&connection.repo_path);

        if !dirty_dir.exists() && !bare_repo.exists() {
            eprintln!(
                "  {conn_name}: dirty checkout not found at {}, skipping",
                dirty_dir.display()
            );
            continue;
        }
        if !master_dir.exists() {
            eprintln!(
                "  {conn_name}: master worktree not found at {}, skipping",
                master_dir.display()
            );
            eprintln!("    Run 'scratchmd workspaces init' to set up the master worktree.");
            continue;
        }

        let reviewed_dirty_snapshot = if bare_repo.exists()
            && (!dirty_dir.exists() || has_unreviewed_record_changes(&bare_repo, &dirty_dir)?)
        {
            Some(materialize_branch_from_bare(
                &bare_repo,
                &layout.reviewed_dirty_checkout_path(&conn_name),
            )?)
        } else {
            None
        };
        let dirty_source = reviewed_dirty_snapshot
            .as_ref()
            .map(|temp| temp.path.as_path())
            .unwrap_or(dirty_dir.as_path());

        match plan_publish::build_publish_plan_with_scratch_dir(
            &conn_name,
            &connection.id,
            dirty_source,
            &master_dir,
            &db_path,
            &scratch_dir,
            &timestamp,
        ) {
            Ok(Some(result)) => {
                print_report(&conn_name, &result);
                let _ = io::stdout().flush();
                any_changes = true;
            }
            Ok(None) => {
                println!("  {conn_name}: nothing to publish");
                let _ = io::stdout().flush();
            }
            Err(e) => {
                eprintln!("  {conn_name}: planning error: {e}");
            }
        }
    }

    if !any_changes {
        println!("\nNothing to publish — all connections are in sync.");
        let _ = io::stdout().flush();
    }

    Ok(())
}

struct TempDirGuard {
    path: PathBuf,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn materialize_branch_from_bare(
    bare_repo: &Path,
    snapshot_path: &Path,
) -> anyhow::Result<TempDirGuard> {
    let path = snapshot_path.to_path_buf();
    materialize_treeish_to_worktree(bare_repo, "dirty", &path)?;
    Ok(TempDirGuard { path })
}

// ---------------------------------------------------------------------------
// publish-from-git: trigger server-side publish for all connectors with a plan
// ---------------------------------------------------------------------------

pub async fn run_publish_from_git(
    workspace_start: &Path,
    client: &crate::api::ApiClient,
) -> anyhow::Result<()> {
    let workspace = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace)?;
    let layout = WorkspaceLayout::for_cli(&workspace);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!("No connections found. Run 'scratchmd workspaces init' first.");
    }

    let mut any_triggered = false;

    for connection in &workspace_marker.connections {
        let conn_name = connection.dir_name.clone();
        let manifest_dir = layout
            .connection_scratch_path(&conn_name)
            .join(".publish-plans");
        let plan_dir = match std::fs::read_dir(&manifest_dir)
            .ok()
            .and_then(|mut d| d.next())
        {
            Some(Ok(e)) if e.path().is_dir() => e.path(),
            _ => {
                eprintln!(
                    "  {conn_name}: no publish plan found — run 'scratchmd plan-publish' first"
                );
                continue;
            }
        };

        let plan_timestamp = plan_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let plan_path = format!(".scratch/.publish-plans/{}", plan_timestamp);

        match client
            .publish_from_git(&workspace_marker.workbook.id, &connection.id, &plan_path)
            .await
        {
            Ok(resp) => {
                let job_id = resp
                    .get("jobId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unknown)");
                println!("  {conn_name}: publish job queued (jobId: {job_id})");
                let _ = io::stdout().flush();
                any_triggered = true;
            }
            Err(e) => {
                eprintln!("  {conn_name}: failed to trigger publish: {e}");
            }
        }
    }

    if !any_triggered {
        println!("No publish jobs triggered.");
        let _ = io::stdout().flush();
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// CLI output
// ---------------------------------------------------------------------------

fn print_report(conn_name: &str, result: &PlanResult) {
    println!("  {conn_name}");
    for fr in &result.folder_reports {
        let label = if fr.folder.is_empty() {
            "(root)".to_string()
        } else {
            fr.folder.clone()
        };

        let mut raw_parts = vec![];
        if fr.raw_modified > 0 {
            raw_parts.push(format!("{} modified", fr.raw_modified));
        }
        if fr.raw_added > 0 {
            raw_parts.push(format!("{} added", fr.raw_added));
        }
        if fr.raw_deleted > 0 {
            raw_parts.push(format!("{} deleted", fr.raw_deleted));
        }
        if fr.raw_ref_clear > 0 {
            raw_parts.push(format!("{} ref-clear", fr.raw_ref_clear));
        }

        let mut plan_parts = vec![];
        if fr.plan_edit > 0 {
            plan_parts.push(format!("{} edit", fr.plan_edit));
        }
        if fr.plan_create > 0 {
            plan_parts.push(format!("{} create", fr.plan_create));
        }
        if fr.plan_delete > 0 {
            plan_parts.push(format!("{} delete", fr.plan_delete));
        }
        if fr.plan_backfill > 0 {
            plan_parts.push(format!("{} backfill", fr.plan_backfill));
        }
        if fr.plan_rename > 0 {
            plan_parts.push(format!("{} rename", fr.plan_rename));
        }

        let raw_str = if raw_parts.is_empty() {
            "no changes".to_string()
        } else {
            raw_parts.join(", ")
        };
        let plan_str = if plan_parts.is_empty() {
            "no ops".to_string()
        } else {
            plan_parts.join(", ")
        };

        println!("    {label}  ({raw_str})  →  ({plan_str})");
    }
}

// ---------------------------------------------------------------------------
// Workspace / connector discovery (CLI-specific, uses .scratchmd markers)
// ---------------------------------------------------------------------------

fn resolve_workspace(start: &Path) -> anyhow::Result<PathBuf> {
    let abs = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    Ok(markers::find_nearest_workspace(&abs).unwrap_or(abs))
}

fn read_workspace_marker(workspace: &Path) -> anyhow::Result<markers::WorkspaceMarker> {
    let marker_path = markers::marker_path(workspace);
    match markers::read(&marker_path) {
        Ok(markers::Marker::Workspace(marker)) => Ok(marker),
        _ => anyhow::bail!(
            "Could not read workspace marker at {}",
            marker_path.display()
        ),
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::process::Command;
    use tempfile::TempDir;

    fn make_workspace(conn: &str) -> (TempDir, PathBuf, PathBuf, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();

        std::fs::create_dir_all(root.join(".scratch")).unwrap();
        let wb_marker = root.join(".scratch/.scratchmd");
        std::fs::write(
            &wb_marker,
            format!(
                "version: \"3\"\nworkbook:\n  id: wkb_test\n  name: Test\n  serverUrl: http://localhost\n  initializedAt: \"2024-01-01T00:00:00Z\"\nconnections:\n  - id: conn_test_id\n    displayName: Test\n    service: airtable\n    repoPath: org123/wkb_test/conn_test_id\n    dirName: {conn}\n"
            ),
        ).unwrap();

        let conn_dir = root.join(conn);
        std::fs::create_dir_all(&conn_dir).unwrap();

        let master_dir = root
            .join(".scratch")
            .join("connections")
            .join("master")
            .join(conn);
        std::fs::create_dir_all(&master_dir).unwrap();

        let scratch_dir = root
            .join(".scratch")
            .join("connections")
            .join("scratch")
            .join(conn);
        let db_path = root.join(".repos").join("conn_test_id.db");

        (tmp, conn_dir, master_dir, scratch_dir, db_path)
    }

    fn write_json(dir: &Path, rel: &str, v: &Value) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(v).unwrap()).unwrap();
    }

    fn read_plan_json(plan_root: &Path) -> Value {
        let content = std::fs::read_to_string(plan_root.join("plan.json")).unwrap();
        serde_json::from_str(&content).unwrap()
    }

    fn find_plan_root(scratch_dir: &Path) -> Option<PathBuf> {
        let plans_dir = scratch_dir.join(".publish-plans");
        if !plans_dir.exists() {
            return None;
        }
        std::fs::read_dir(&plans_dir)
            .ok()?
            .flatten()
            .find(|e| e.path().is_dir())
            .map(|e| e.path())
    }

    fn phase_file(
        scratch_dir: &Path,
        plan_root: &Path,
        folder: &str,
        phase: &str,
        filename: &str,
    ) -> PathBuf {
        let ts = plan_root.file_name().unwrap().to_string_lossy();
        let plan_subdir = format!("publish-plan-{ts}");
        if folder.is_empty() {
            scratch_dir.join(plan_subdir).join(phase).join(filename)
        } else {
            scratch_dir
                .join(folder)
                .join(plan_subdir)
                .join(phase)
                .join(filename)
        }
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn test_simple_edit() {
        let (tmp, conn_dir, master_dir, scratch_dir, _db_path) = make_workspace("my-conn");

        write_json(
            &master_dir,
            "public/posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "Old"}}),
        );
        write_json(
            &conn_dir,
            "public/posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "New"}}),
        );

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&scratch_dir).expect("plan dir not created");
        let plan = read_plan_json(&plan_root);

        assert_eq!(plan["summary"]["edit"], 1);
        assert_eq!(plan["summary"]["create"], 0);
        assert_eq!(plan["summary"]["delete"], 0);

        let edit_file = phase_file(
            &scratch_dir,
            &plan_root,
            "public/posts",
            "edit",
            "rec1.json",
        );
        assert!(edit_file.exists(), "edit file not created");
        let edit_content: Value =
            serde_json::from_str(&std::fs::read_to_string(edit_file).unwrap()).unwrap();
        assert_eq!(edit_content["content"]["fields"]["title"], "New");
    }

    #[test]
    fn test_create_and_delete() {
        let (tmp, conn_dir, master_dir, scratch_dir, _db_path) = make_workspace("my-conn");

        write_json(&master_dir, "posts/old.json", &json!({"id": "rec_old"}));
        write_json(
            &conn_dir,
            "posts/new.json",
            &json!({"fields": {"title": "New Post"}}),
        );
        write_json(&master_dir, "posts/same.json", &json!({"id": "rec_same"}));
        write_json(&conn_dir, "posts/same.json", &json!({"id": "rec_same"}));

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&scratch_dir).expect("plan dir not created");
        let plan = read_plan_json(&plan_root);

        assert_eq!(plan["summary"]["create"], 1);
        assert_eq!(plan["summary"]["delete"], 1);
        assert_eq!(plan["summary"]["edit"], 0);

        let delete_file = phase_file(&scratch_dir, &plan_root, "posts", "delete", "old.json");
        assert!(delete_file.exists(), "delete file not created");
        let delete_content: Value =
            serde_json::from_str(&std::fs::read_to_string(delete_file).unwrap()).unwrap();
        assert_eq!(delete_content["remoteId"], "rec_old");
    }

    #[test]
    fn test_nothing_to_publish_when_identical() {
        let (tmp, conn_dir, master_dir, scratch_dir, _db_path) = make_workspace("my-conn");

        write_json(
            &master_dir,
            "posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "Same"}}),
        );
        write_json(
            &conn_dir,
            "posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "Same"}}),
        );

        run(tmp.path()).unwrap();

        assert!(
            find_plan_root(&scratch_dir).is_none(),
            "should not create plan when nothing changed"
        );
    }

    #[test]
    fn test_pending_file_gets_rename_entry() {
        let (tmp, conn_dir, master_dir, scratch_dir, _) = make_workspace("my-conn");

        write_json(&master_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(&conn_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(
            &conn_dir,
            "posts/scratch_pending_abc.json",
            &json!({"fields": {"title": "New"}}),
        );

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&scratch_dir).expect("plan dir not created");
        let plan = read_plan_json(&plan_root);

        assert_eq!(plan["summary"]["create"], 1);
        assert_eq!(plan["summary"]["rename"], 1);
    }

    #[test]
    fn test_asset_pseudo_refs_stripped_in_create() {
        let (tmp, conn_dir, master_dir, scratch_dir, _) = make_workspace("my-conn");

        write_json(&master_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(&conn_dir, "posts/existing.json", &json!({"id": "rec1"}));
        write_json(
            &conn_dir,
            "posts/new.json",
            &json!({
                "fields": {
                    "title": "Hello",
                    "image": "@asset/uploads/img.png"
                }
            }),
        );

        run(tmp.path()).unwrap();

        let plan_root = find_plan_root(&scratch_dir).expect("plan dir not created");
        let create_file = phase_file(&scratch_dir, &plan_root, "posts", "create", "new.json");
        assert!(create_file.exists());
        let content: Value =
            serde_json::from_str(&std::fs::read_to_string(create_file).unwrap()).unwrap();
        assert!(
            content["fields"]["image"].is_null(),
            "asset pseudo-ref should be stripped to null"
        );
    }

    #[test]
    fn uses_local_dirty_branch_not_working_tree_when_bare_repo_exists() {
        if !git_available() {
            eprintln!("skipping git-dependent test: git executable not available");
            return;
        }

        let (_tmp, conn_dir, master_dir, scratch_dir, _db_path) = make_workspace("my-conn");
        let root = conn_dir.parent().unwrap();
        let repo_path = root.join(".repos/conn_test_id.git");
        let source_repo = root.join("source-repo");

        std::fs::create_dir_all(&source_repo).unwrap();
        run_git(root, &["init", "source-repo"]);
        run_git(&source_repo, &["checkout", "-b", "dirty"]);
        std::fs::create_dir_all(source_repo.join("posts")).unwrap();
        std::fs::write(
            source_repo.join("posts/rec1.json"),
            serde_json::to_string_pretty(&json!({"id":"rec1","fields":{"title":"Committed"}}))
                .unwrap(),
        )
        .unwrap();
        run_git(&source_repo, &["add", "."]);
        run_git(
            &source_repo,
            &[
                "-c",
                "user.name=Scratch",
                "-c",
                "user.email=scratch@example.com",
                "commit",
                "-m",
                "committed",
            ],
        );
        run_git(root, &["init", "--bare", repo_path.to_str().unwrap()]);
        run_git(
            &source_repo,
            &["remote", "add", "origin", repo_path.to_str().unwrap()],
        );
        run_git(&source_repo, &["push", "origin", "dirty:dirty"]);

        write_json(
            &master_dir,
            "posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "Committed"}}),
        );
        write_json(
            &conn_dir,
            "posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "Unreviewed"}}),
        );

        run(root).unwrap();

        assert!(
            find_plan_root(&scratch_dir).is_none(),
            "plan should ignore unreviewed working-tree changes when the local dirty branch exists"
        );
    }

    #[test]
    fn reviewed_dirty_snapshot_is_cleaned_up_after_planning() {
        if !git_available() {
            eprintln!("skipping git-dependent test: git executable not available");
            return;
        }

        let (_tmp, conn_dir, master_dir, _scratch_dir, _db_path) = make_workspace("my-conn");
        let root = conn_dir.parent().unwrap();
        let repo_path = root.join(".repos/conn_test_id.git");
        let source_repo = root.join("source-repo");
        let reviewed_dirty_dir = root.join(".scratch/connections/dirty/my-conn");

        std::fs::create_dir_all(&source_repo).unwrap();
        run_git(root, &["init", "source-repo"]);
        run_git(&source_repo, &["checkout", "-b", "dirty"]);
        std::fs::create_dir_all(source_repo.join("posts")).unwrap();
        std::fs::write(
            source_repo.join("posts/rec1.json"),
            serde_json::to_string_pretty(&json!({"id":"rec1","fields":{"title":"Committed"}}))
                .unwrap(),
        )
        .unwrap();
        run_git(&source_repo, &["add", "."]);
        run_git(
            &source_repo,
            &[
                "-c",
                "user.name=Scratch",
                "-c",
                "user.email=scratch@example.com",
                "commit",
                "-m",
                "committed",
            ],
        );
        run_git(root, &["init", "--bare", repo_path.to_str().unwrap()]);
        run_git(
            &source_repo,
            &["remote", "add", "origin", repo_path.to_str().unwrap()],
        );
        run_git(&source_repo, &["push", "origin", "dirty:dirty"]);

        write_json(
            &master_dir,
            "posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "Committed"}}),
        );
        write_json(
            &conn_dir,
            "posts/rec1.json",
            &json!({"id": "rec1", "fields": {"title": "Unreviewed"}}),
        );

        run(root).unwrap();

        assert!(
            !reviewed_dirty_dir.exists(),
            "reviewed dirty snapshot should be removed after planning"
        );
    }

    #[test]
    fn test_compute_changed_fields() {
        let master = json!({"id": "1", "fields": {"title": "Old", "count": 5}});
        let dirty = json!({"id": "1", "fields": {"title": "New", "count": 5}});
        // Use the shared module's build_publish_plan indirectly via a workspace test
        // For unit testing compute_changed_fields, we test via the plan output
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".scratch")).unwrap();
        std::fs::write(root.join(".scratch/.scratchmd"),
            "version: \"3\"\nworkbook:\n  id: wkb_test\n  name: Test\n  serverUrl: http://localhost\n  initializedAt: \"2024-01-01T00:00:00Z\"\nconnections:\n  - id: cid\n    displayName: C\n    service: airtable\n    repoPath: org123/wkb_test/cid\n    dirName: c\n",
        ).unwrap();
        let conn_dir = root.join("c");
        std::fs::create_dir_all(&conn_dir).unwrap();
        let master_dir = root.join(".scratch/connections/master/c");
        let scratch_dir = root.join(".scratch/connections/scratch/c");
        std::fs::create_dir_all(&master_dir).unwrap();
        write_json(&master_dir, "t/r.json", &master);
        write_json(&conn_dir, "t/r.json", &dirty);

        run(root).unwrap();

        let plan_root = find_plan_root(&scratch_dir).expect("plan dir");
        let edit_file = phase_file(&scratch_dir, &plan_root, "t", "edit", "r.json");
        let content: Value =
            serde_json::from_str(&std::fs::read_to_string(edit_file).unwrap()).unwrap();
        assert_eq!(content["changedFields"]["fields"]["title"], "New");
        assert!(
            content["changedFields"]["fields"].get("count").is_none(),
            "unchanged field should not appear"
        );
    }
}
