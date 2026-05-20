use super::*;
use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;

fn workspace_marker(connections: &[(&str, &str)]) -> markers::WorkspaceMarker {
    markers::WorkspaceMarker {
        version: "3".to_string(),
        workbook: markers::WorkbookRef {
            id: "wkb_test".to_string(),
            name: "Test".to_string(),
            org_id: "org123".to_string(),
            server_url: "http://localhost".to_string(),
            initialized_at: "2026-01-01T00:00:00Z".to_string(),
        },
        connections: connections
            .iter()
            .map(|(dir_name, repo_path)| markers::ConnectionEntry {
                id: format!("conn_{dir_name}"),
                display_name: (*dir_name).to_string(),
                service: "AIRTABLE".to_string(),
                repo_path: (*repo_path).to_string(),
                dir_name: (*dir_name).to_string(),
            })
            .collect(),
    }
}

struct BareFixture {
    _tmp: TempDir,
    source_dir: PathBuf,
    remote_bare: PathBuf,
    local_bare: PathBuf,
}

fn make_connection_context(root: &Path, bare_repo: &Path) -> ConnectionContext {
    ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        dirty_dir: root.join("Conn"),
        scratch_dir: root.join(".scratch/connections/scratch/Conn"),
        workspace_dir: root.to_path_buf(),
        master_dir: root.join(".scratch/connections/master/Conn"),
        bare_repo: bare_repo.to_path_buf(),
        db_path: root.join(".repos/conn.db"),
    }
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, contents).unwrap();
}

fn commit_all(cwd: &Path, message: &str) {
    run_git(cwd, &["add", "-A"]);
    run_git(
        cwd,
        &[
            "-c",
            "user.name=Scratch",
            "-c",
            "user.email=scratch@example.com",
            "commit",
            "-m",
            message,
        ],
    );
}

fn create_bare_fixture() -> BareFixture {
    let tmp = TempDir::new().unwrap();
    let source_dir = tmp.path().join("source");
    let remote_bare = tmp.path().join("remote.git");
    let local_bare = tmp.path().join("local.git");

    run_git(tmp.path(), &["init", "source"]);
    run_git(&source_dir, &["checkout", "-b", "main"]);
    write_file(&source_dir.join("syncs/a.json"), "{}");
    commit_all(&source_dir, "main content");

    run_git(&source_dir, &["checkout", "-b", "dirty"]);
    write_file(&source_dir.join("posts/rec1.json"), "{\"id\":\"rec1\"}");
    commit_all(&source_dir, "dirty content");

    run_git(tmp.path(), &["init", "--bare", "remote.git"]);
    run_git(
        &source_dir,
        &["remote", "add", "origin", remote_bare.to_str().unwrap()],
    );
    run_git(&source_dir, &["push", "origin", "main:main"]);
    run_git(&source_dir, &["push", "origin", "dirty:dirty"]);

    run_git(
        tmp.path(),
        &[
            "clone",
            "--bare",
            remote_bare.to_str().unwrap(),
            local_bare.to_str().unwrap(),
        ],
    );

    BareFixture {
        _tmp: tmp,
        source_dir,
        remote_bare,
        local_bare,
    }
}

#[test]
fn detect_selected_connection_from_connection_subdir() {
    let workspace = Path::new("/tmp/workspace");
    let cwd = Path::new("/tmp/workspace/AIRTABLE - Main/posts");
    let marker = workspace_marker(&[("AIRTABLE - Main", "org/wkb/conn")]);

    assert_eq!(
        detect_selected_connection(workspace, cwd, &marker),
        Some("AIRTABLE - Main".to_string())
    );
}

#[test]
fn read_and_materialize_repo_maps_split_scratch_content() {
    let tmp = TempDir::new().unwrap();
    let ctx = ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        dirty_dir: tmp.path().join("Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
        workspace_dir: tmp.path().to_path_buf(),
        master_dir: tmp.path().join(".scratch/connections/master/Conn"),
        bare_repo: tmp.path().join(".repos/conn.git"),
        db_path: tmp.path().join(".repos/conn.db"),
    };

    std::fs::create_dir_all(ctx.dirty_dir.join("posts")).unwrap();
    std::fs::create_dir_all(ctx.scratch_dir.join("posts/publish-plan-1/create")).unwrap();
    std::fs::create_dir_all(ctx.scratch_dir.join(".publish-plans/1")).unwrap();
    std::fs::write(ctx.dirty_dir.join("posts/rec1.json"), "{}").unwrap();
    std::fs::write(ctx.scratch_dir.join("posts/schema.json"), "{}").unwrap();
    std::fs::write(
        ctx.scratch_dir
            .join("posts/publish-plan-1/create/rec2.json"),
        "{}",
    )
    .unwrap();
    std::fs::write(ctx.scratch_dir.join(".publish-plans/1/plan.json"), "{}").unwrap();

    let map = read_materialized_repo(&ctx).unwrap();
    assert!(map.contains_key("posts/rec1.json"));
    assert!(map.contains_key(".scratch/posts/schema.json"));
    assert!(map.contains_key(".scratch/posts/publish-plan-1/create/rec2.json"));
    assert!(map.contains_key(".scratch/.publish-plans/1/plan.json"));

    let replacement = HashMap::from([
        ("posts/next.json".to_string(), b"{\"id\":\"next\"}".to_vec()),
        (
            ".scratch/posts/schema.json".to_string(),
            b"{\"schema\":{}}".to_vec(),
        ),
    ]);
    materialize_local_repo(&ctx, &replacement, &map).unwrap();

    assert!(ctx.dirty_dir.join("posts/next.json").exists());
    assert!(!ctx.dirty_dir.join("posts/rec1.json").exists());
    assert!(ctx.scratch_dir.join("posts/schema.json").exists());
    assert!(!ctx.scratch_dir.join(".publish-plans/1/plan.json").exists());
}

#[test]
fn materialize_local_repo_preserves_mtime_when_content_unchanged() {
    let tmp = TempDir::new().unwrap();
    let ctx = ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        dirty_dir: tmp.path().join("Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
        workspace_dir: tmp.path().to_path_buf(),
        master_dir: tmp.path().join(".scratch/connections/master/Conn"),
        bare_repo: tmp.path().join(".repos/conn.git"),
        db_path: tmp.path().join(".repos/conn.db"),
    };

    std::fs::create_dir_all(ctx.dirty_dir.join("posts")).unwrap();
    let unchanged_path = ctx.dirty_dir.join("posts/keep.json");
    let changed_path = ctx.dirty_dir.join("posts/edit.json");
    std::fs::write(&unchanged_path, b"{\"v\":1}").unwrap();
    std::fs::write(&changed_path, b"{\"v\":1}").unwrap();

    let current = read_materialized_repo(&ctx).unwrap();
    let unchanged_mtime_before = std::fs::metadata(&unchanged_path)
        .unwrap()
        .modified()
        .unwrap();
    let changed_mtime_before = std::fs::metadata(&changed_path)
        .unwrap()
        .modified()
        .unwrap();

    // Sleep just enough so a rewrite would observably bump mtime. macOS APFS
    // mtime resolution is ns but the syscall path can coalesce same-instant
    // writes; 10 ms is plenty.
    std::thread::sleep(std::time::Duration::from_millis(10));

    let target = HashMap::from([
        // Same content — should be skipped.
        ("posts/keep.json".to_string(), b"{\"v\":1}".to_vec()),
        // Different content — should be rewritten.
        ("posts/edit.json".to_string(), b"{\"v\":2}".to_vec()),
    ]);
    materialize_local_repo(&ctx, &target, &current).unwrap();

    let unchanged_mtime_after = std::fs::metadata(&unchanged_path)
        .unwrap()
        .modified()
        .unwrap();
    let changed_mtime_after = std::fs::metadata(&changed_path)
        .unwrap()
        .modified()
        .unwrap();

    assert_eq!(
        unchanged_mtime_before, unchanged_mtime_after,
        "file with matching content should not be rewritten"
    );
    assert!(
        changed_mtime_after > changed_mtime_before,
        "file with different content should be rewritten"
    );
    assert_eq!(
        std::fs::read(&changed_path).unwrap(),
        b"{\"v\":2}",
        "rewritten file should have new content"
    );
}

#[test]
fn sync_schema_files_from_master_restores_missing_schema() {
    let tmp = TempDir::new().unwrap();
    let ctx = ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        dirty_dir: tmp.path().join("Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
        workspace_dir: tmp.path().to_path_buf(),
        master_dir: tmp.path().join(".scratch/connections/master/Conn"),
        bare_repo: tmp.path().join(".repos/conn.git"),
        db_path: tmp.path().join(".repos/conn.db"),
    };

    std::fs::create_dir_all(ctx.master_dir.join(".scratch/posts")).unwrap();
    std::fs::write(
        ctx.master_dir.join(".scratch/posts/schema.json"),
        "{\"schema\":{\"fields\":[]}}",
    )
    .unwrap();

    sync_schema_files_from_master(&ctx).unwrap();

    assert_eq!(
        std::fs::read_to_string(ctx.scratch_dir.join("posts/schema.json")).unwrap(),
        "{\"schema\":{\"fields\":[]}}"
    );
}

#[test]
fn commit_file_map_to_dirty_ref_does_not_commit_temp_index_files() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);

    let files = HashMap::from([("posts/rec.json".to_string(), b"{}".to_vec())]);
    commit_file_map_to_dirty_ref(&bare_repo, None, &files, "test commit").unwrap();

    let output = Command::new("git")
        .arg(format!("--git-dir={}", bare_repo.display()))
        .args(["ls-tree", "-r", "--name-only", "dirty"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let paths = String::from_utf8_lossy(&output.stdout);
    assert!(paths.lines().any(|line| line == "posts/rec.json"));
    assert!(!paths.lines().any(|line| line == ".git-index"));
    assert!(!paths.lines().any(|line| line == ".git-index.lock"));
}

#[test]
fn restore_deleted_records_locally_drops_delete_entry_and_writes_main_blob() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);

    let main_files = HashMap::from([(
        "posts/restore.json".to_string(),
        b"{\"id\":\"restore\",\"name\":\"from-main\"}".to_vec(),
    )]);
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/main",
        None,
        &main_files,
        "main seed",
    )
    .unwrap();

    let ctx = make_connection_context(tmp.path(), &bare_repo);
    // Set up dirty_dir as a sparse worktree (no dirty ref yet; start from empty).
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/dirty",
        None,
        &HashMap::new(),
        "init dirty",
    )
    .unwrap();
    crate::git_ops::setup_sparse_worktree(&bare_repo, &ctx.dirty_dir, "refs/heads/dirty").unwrap();

    // Seed an accepted Delete for the record to restore.
    {
        use crate::commands::re_anchor::{AnchoredPatch, PatchKind};
        use crate::config::accepted_patches::{save_atomic, AcceptedPatchesFile};
        let layout = WorkspaceLayout::for_cli(&ctx.workspace_dir);
        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        save_atomic(
            &connection_dir,
            &AcceptedPatchesFile {
                patches: vec![AnchoredPatch {
                    path: "posts/restore.json".into(),
                    kind: PatchKind::Delete,
                    patch: serde_json::Value::Null,
                }],
            },
        )
        .unwrap();
    }

    restore_deleted_records_locally(&ctx, &["posts/restore.json".to_string()]).unwrap();

    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("posts/restore.json")).unwrap(),
        "{\"id\":\"restore\",\"name\":\"from-main\"}"
    );
    let file = load_accepted(&ctx);
    assert!(
        !file.patches.iter().any(|e| e.path == "posts/restore.json"),
        "Delete entry should have been removed"
    );
}

#[test]
fn restore_deleted_records_locally_errors_when_entry_is_not_a_delete() {
    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);
    let main_files = HashMap::from([(
        "posts/restore.json".to_string(),
        b"{\"id\":\"restore\"}".to_vec(),
    )]);
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/main",
        None,
        &main_files,
        "main",
    )
    .unwrap();

    let ctx = make_connection_context(tmp.path(), &bare_repo);
    {
        use crate::commands::re_anchor::{AnchoredPatch, PatchKind};
        use crate::config::accepted_patches::{save_atomic, AcceptedPatchesFile};
        let layout = WorkspaceLayout::for_cli(&ctx.workspace_dir);
        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        save_atomic(
            &connection_dir,
            &AcceptedPatchesFile {
                patches: vec![AnchoredPatch {
                    path: "posts/restore.json".into(),
                    kind: PatchKind::Update,
                    patch: serde_json::json!({"name": "edit"}),
                }],
            },
        )
        .unwrap();
    }

    let err =
        restore_deleted_records_locally(&ctx, &["posts/restore.json".to_string()]).unwrap_err();
    assert!(err.to_string().contains("not an approved deleted record"));
}

#[test]
fn discard_created_records_locally_drops_create_entry_and_removes_worktree_file() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);
    // Empty main — the path doesn't exist on main, which is the precondition
    // for a "Create" entry to be valid.
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/main",
        None,
        &HashMap::new(),
        "main seed",
    )
    .unwrap();
    // Set up a dirty branch + sparse worktree so the path layout matches what
    // production looks like, but the dirty ref is irrelevant to the new logic.
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/dirty",
        None,
        &HashMap::new(),
        "init dirty",
    )
    .unwrap();
    let ctx = make_connection_context(tmp.path(), &bare_repo);
    crate::git_ops::setup_sparse_worktree(&bare_repo, &ctx.dirty_dir, "refs/heads/dirty").unwrap();

    // Working file exists; accepted-patches has the corresponding Create.
    write_file(
        &ctx.dirty_dir.join("posts/created.json"),
        "{\"id\":\"created\"}",
    );
    {
        use crate::commands::re_anchor::{AnchoredPatch, PatchKind};
        use crate::config::accepted_patches::{save_atomic, AcceptedPatchesFile};
        let layout = WorkspaceLayout::for_cli(&ctx.workspace_dir);
        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        save_atomic(
            &connection_dir,
            &AcceptedPatchesFile {
                patches: vec![AnchoredPatch {
                    path: "posts/created.json".into(),
                    kind: PatchKind::Create,
                    patch: serde_json::json!({"id": "created"}),
                }],
            },
        )
        .unwrap();
    }

    discard_created_records_locally(&ctx, &["posts/created.json".to_string()]).unwrap();

    assert!(!ctx.dirty_dir.join("posts/created.json").exists());
    let file = load_accepted(&ctx);
    assert!(
        !file.patches.iter().any(|e| e.path == "posts/created.json"),
        "Create entry should have been removed"
    );
}

#[test]
fn discard_created_records_locally_errors_when_main_has_the_path() {
    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);
    // Main HAS the path — this is the "not a created record" failure case.
    let main_files = HashMap::from([(
        "posts/created.json".to_string(),
        b"{\"id\":\"created\"}".to_vec(),
    )]);
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/main",
        None,
        &main_files,
        "main",
    )
    .unwrap();

    let ctx = make_connection_context(tmp.path(), &bare_repo);
    {
        use crate::commands::re_anchor::{AnchoredPatch, PatchKind};
        use crate::config::accepted_patches::{save_atomic, AcceptedPatchesFile};
        let layout = WorkspaceLayout::for_cli(&ctx.workspace_dir);
        let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
        save_atomic(
            &connection_dir,
            &AcceptedPatchesFile {
                patches: vec![AnchoredPatch {
                    path: "posts/created.json".into(),
                    kind: PatchKind::Create,
                    patch: serde_json::json!({"id": "created"}),
                }],
            },
        )
        .unwrap();
    }

    let err =
        discard_created_records_locally(&ctx, &["posts/created.json".to_string()]).unwrap_err();
    assert!(err.to_string().contains("exists on main"));
}

#[test]
fn git_fetch_updates_remote_tracking_dirty_ref() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();

    write_file(
        &fixture.source_dir.join("posts/rec2.json"),
        "{\"id\":\"rec2\"}",
    );
    commit_all(&fixture.source_dir, "remote dirty update");
    run_git(&fixture.source_dir, &["push", "origin", "dirty:dirty"]);

    crate::git_ops::fetch_origin(&fixture.local_bare, "test-token").unwrap();

    let local_tracking = git_rev_parse(&fixture.local_bare, "refs/remotes/origin/dirty").unwrap();
    let remote_dirty = git_rev_parse(&fixture.remote_bare, "dirty").unwrap();
    assert_eq!(local_tracking, remote_dirty);
}

#[test]
fn git_push_force_overwrites_diverged_remote_dirty_branch() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();

    write_file(
        &fixture.source_dir.join("posts/server-only.json"),
        "{\"id\":\"server-only\"}",
    );
    commit_all(&fixture.source_dir, "remote only update");
    run_git(&fixture.source_dir, &["push", "origin", "dirty:dirty"]);

    let stale_parent = git_rev_parse(&fixture.local_bare, "dirty").unwrap();
    let files = HashMap::from([(
        "posts/local-only.json".to_string(),
        b"{\"id\":\"local-only\"}".to_vec(),
    )]);
    let local_commit = commit_file_map_to_dirty_ref(
        &fixture.local_bare,
        Some(stale_parent.as_str()),
        &files,
        "diverged local update",
    )
    .unwrap();

    crate::git_ops::force_push_origin_dirty(&fixture.local_bare, "test-token").unwrap();

    let remote_dirty = git_rev_parse(&fixture.remote_bare, "dirty").unwrap();
    assert_eq!(remote_dirty, local_commit);
}

#[test]
fn file_map_changed_data_paths_handles_add_modify_delete_and_filters_scratch() {
    let old = HashMap::from([
        ("posts/keep.json".to_string(), b"{\"v\":1}".to_vec()),
        ("posts/edit.json".to_string(), b"{\"v\":1}".to_vec()),
        ("posts/gone.json".to_string(), b"{\"v\":1}".to_vec()),
        (
            ".scratch/posts/schema.json".to_string(),
            b"{\"old\":1}".to_vec(),
        ),
    ]);
    let new = HashMap::from([
        // Same content — must not appear.
        ("posts/keep.json".to_string(), b"{\"v\":1}".to_vec()),
        // Different content — modification.
        ("posts/edit.json".to_string(), b"{\"v\":2}".to_vec()),
        // New file — addition.
        ("posts/new.json".to_string(), b"{\"v\":3}".to_vec()),
        // Modified `.scratch` entry — must be filtered out (folder_index
        // only tracks data paths under data folders).
        (
            ".scratch/posts/schema.json".to_string(),
            b"{\"new\":1}".to_vec(),
        ),
    ]);

    let mut got = file_map_changed_data_paths(&old, &new);
    got.sort();
    assert_eq!(
        got,
        vec![
            "posts/edit.json".to_string(),
            "posts/gone.json".to_string(),
            "posts/new.json".to_string(),
        ],
        "should cover add/modify/delete on data paths, filter `.scratch/`"
    );
}

#[test]
fn update_master_worktree_returns_no_move_when_main_unchanged() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    // `create_bare_fixture` clones a bare repo, which copies both
    // refs/heads/main and refs/heads/dirty. So `refs/heads/main` already
    // matches `refs/remotes/origin/main` from the moment we open the ctx.
    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let ctx = make_connection_context(tmp.path(), &fixture.local_bare);

    let result = update_master_worktree(&ctx, "test-token").unwrap();
    // origin/main didn't advance ⇒ no move ⇒ no per-folder work needed.
    // This is the "unchanged connection in a publish flow" case where
    // run_download wants to skip rebuild_index_for_conn entirely.
    assert!(!result.moved, "unchanged master should report moved=false");
    assert!(
        result.changed_paths.is_empty(),
        "no master move ⇒ no changed paths"
    );
}

#[test]
fn update_master_worktree_returns_diff_when_main_advances() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let ctx = make_connection_context(tmp.path(), &fixture.local_bare);

    // Initial call is a no-op (main is already at origin/main from clone)
    // — still needed to materialize the worktree before the next reset.
    let initial = update_master_worktree(&ctx, "test-token").unwrap();
    assert!(!initial.moved);

    // Advance origin/main: add one data file, modify an existing data file,
    // and write a `.scratch` file that should NOT surface in changed_paths.
    run_git(&fixture.source_dir, &["checkout", "main"]);
    write_file(
        &fixture.source_dir.join("posts/added.json"),
        "{\"id\":\"added\"}",
    );
    write_file(
        &fixture.source_dir.join("syncs/a.json"),
        "{\"changed\":true}",
    );
    write_file(
        &fixture.source_dir.join(".scratch/notes.json"),
        "{\"hidden\":true}",
    );
    commit_all(&fixture.source_dir, "advance main");
    run_git(&fixture.source_dir, &["push", "origin", "main"]);

    let result = update_master_worktree(&ctx, "test-token").unwrap();
    assert!(result.moved, "master moved ⇒ moved=true");
    let mut paths = result.changed_paths.clone();
    paths.sort();
    assert_eq!(
        paths,
        vec!["posts/added.json".to_string(), "syncs/a.json".to_string()],
        ".scratch/* must be filtered out; everything else surfaces"
    );
}

/// Verify that batched `read_tree_files` returns correct paths and blob contents
/// for a repo with nested directories, multiple files, and a non-blob entry.
#[test]
fn read_tree_files_batched_returns_all_blobs() {
    let fixture = create_bare_fixture();
    let map = read_git_tree(&fixture.local_bare, "refs/heads/dirty").unwrap();

    // The dirty branch has "posts/rec1.json" (from dirty commit) and "syncs/a.json" (from main).
    assert_eq!(
        String::from_utf8_lossy(map.get("posts/rec1.json").expect("missing posts/rec1.json")),
        "{\"id\":\"rec1\"}"
    );
    assert_eq!(
        String::from_utf8_lossy(map.get("syncs/a.json").expect("missing syncs/a.json")),
        "{}"
    );
    assert_eq!(map.len(), 2);
}

/// Verify that `read_tree_files` returns an empty map for a commit with an empty tree.
#[test]
fn read_tree_files_batched_handles_empty_tree() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("source");
    run_git(tmp.path(), &["init", "source"]);
    run_git(&source, &["checkout", "-b", "main"]);
    // Create an initial commit then remove all files to get an empty tree.
    write_file(&source.join("placeholder"), "x");
    commit_all(&source, "initial");
    std::fs::remove_file(source.join("placeholder")).unwrap();
    commit_all(&source, "empty tree");

    let bare = tmp.path().join("bare.git");
    run_git(
        tmp.path(),
        &[
            "clone",
            "--bare",
            source.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );

    let map = read_git_tree(&bare, "refs/heads/main").unwrap();
    assert!(map.is_empty());
}

fn git_available() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn json_bytes(value: &str) -> Vec<u8> {
    value.as_bytes().to_vec()
}

fn empty_conn_ctx() -> ConnectionContext {
    ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        dirty_dir: PathBuf::new(),
        scratch_dir: PathBuf::new(),
        workspace_dir: PathBuf::new(),
        master_dir: PathBuf::new(),
        bare_repo: PathBuf::new(),
        db_path: PathBuf::new(),
    }
}

mod field_helpers {
    use super::*;
    use crate::commands::re_anchor::{AnchoredPatch, PatchKind};
    use crate::config::accepted_patches::AcceptedPatchesFile;
    use serde_json::{json, Value as JsonValue};

    fn entry(path: &str, kind: PatchKind, patch: JsonValue) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind,
            patch,
        }
    }

    fn json_pretty(value: &str) -> Vec<u8> {
        // Match what `apply_patch_entry_to_blob` / json_object_to_bytes
        // would emit — pretty-printed JSON, no trailing newline. Tests
        // operate on JSON-equivalent bytes; we don't rely on byte equality.
        let v: JsonValue = serde_json::from_str(value).unwrap();
        serde_json::to_vec_pretty(&v).unwrap()
    }

    fn parsed(bytes: &[u8]) -> JsonValue {
        serde_json::from_slice(bytes).unwrap()
    }

    #[test]
    fn accept_field_inserts_update_patch_for_modified_row() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "public/smoke_records/record-1.json".to_string(),
            json_pretty(r#"{"id":1,"name":"Before","ts":"a"}"#),
        )]);
        let local = HashMap::from([(
            "public/smoke_records/record-1.json".to_string(),
            json_pretty(r#"{"id":1,"name":"After","ts":"a"}"#),
        )]);
        let mut file = AcceptedPatchesFile::default();

        let result = accept_field_in_folder(
            &ctx,
            "public/smoke_records",
            "name",
            &main,
            &mut file,
            &local,
        )
        .unwrap();

        assert_eq!(file.patches.len(), 1);
        assert_eq!(file.patches[0].path, "public/smoke_records/record-1.json");
        assert_eq!(file.patches[0].kind, PatchKind::Update);
        assert_eq!(file.patches[0].patch, json!({"name": "After"}));
        assert_eq!(
            result.changed_paths,
            vec!["Conn/public/smoke_records/record-1.json".to_string()]
        );
        assert!(result.patches_changed);
    }

    #[test]
    fn accept_field_inserts_create_patch_for_locally_created_row() {
        let ctx = empty_conn_ctx();
        let main = HashMap::new();
        let local = HashMap::from([(
            "public/smoke_records/record-2.json".to_string(),
            json_pretty(r#"{"id":2,"name":"Created","ts":"b"}"#),
        )]);
        let mut file = AcceptedPatchesFile::default();

        let result = accept_field_in_folder(
            &ctx,
            "public/smoke_records",
            "name",
            &main,
            &mut file,
            &local,
        )
        .unwrap();

        assert_eq!(file.patches.len(), 1);
        assert_eq!(file.patches[0].kind, PatchKind::Create);
        // Only the accepted field appears in the Create payload — accept-field
        // ships exactly the field the user accepted, not the rest of the row.
        assert_eq!(file.patches[0].patch, json!({"name": "Created"}));
        assert_eq!(
            result.changed_paths,
            vec!["Conn/public/smoke_records/record-2.json".to_string()]
        );
        assert!(result.patches_changed);
    }

    #[test]
    fn accept_field_skips_locally_deleted_files() {
        // Whole-file delete is not a field-level target.
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "public/smoke_records/record-3.json".to_string(),
            json_pretty(r#"{"id":3,"name":"On main","ts":"c"}"#),
        )]);
        let local = HashMap::new();
        let mut file = AcceptedPatchesFile::default();

        let result = accept_field_in_folder(
            &ctx,
            "public/smoke_records",
            "name",
            &main,
            &mut file,
            &local,
        )
        .unwrap();

        assert!(file.patches.is_empty());
        assert!(result.changed_paths.is_empty());
        assert!(!result.patches_changed);
    }

    #[test]
    fn accept_field_merges_field_into_existing_update_entry() {
        // Existing patch already touches a different field; accept-field on
        // a new field should fold it into the same Update entry.
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "Companies/rec_1.json".to_string(),
            json_pretty(r#"{"name":"Acme","industry":"Other","employees":5}"#),
        )]);
        let local = HashMap::from([(
            "Companies/rec_1.json".to_string(),
            json_pretty(r#"{"name":"Acme","industry":"SaaS","employees":10}"#),
        )]);
        let mut file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_1.json",
                PatchKind::Update,
                json!({"employees": 10}),
            )],
        };

        let result =
            accept_field_in_folder(&ctx, "Companies", "industry", &main, &mut file, &local)
                .unwrap();

        assert_eq!(file.patches.len(), 1);
        assert_eq!(file.patches[0].kind, PatchKind::Update);
        assert_eq!(
            file.patches[0].patch,
            json!({"employees": 10, "industry": "SaaS"})
        );
        assert_eq!(
            result.changed_paths,
            vec!["Conn/Companies/rec_1.json".to_string()]
        );
        assert!(result.patches_changed);
    }

    #[test]
    fn accept_field_is_noop_when_field_already_matches_approved() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "public/smoke_records/record-1.json".to_string(),
            json_pretty(r#"{"id":1,"name":"Stable"}"#),
        )]);
        let local = main.clone();
        let mut file = AcceptedPatchesFile::default();

        let result = accept_field_in_folder(
            &ctx,
            "public/smoke_records",
            "name",
            &main,
            &mut file,
            &local,
        )
        .unwrap();

        assert!(file.patches.is_empty());
        assert!(result.changed_paths.is_empty());
        assert!(!result.patches_changed);
    }

    #[test]
    fn accept_field_handles_nested_paths() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"author":{"name":"Before","role":"editor"}}"#),
        )]);
        let local = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"author":{"name":"After","role":"editor"}}"#),
        )]);
        let mut file = AcceptedPatchesFile::default();

        let result =
            accept_field_in_folder(&ctx, "Posts", "author.name", &main, &mut file, &local).unwrap();

        assert_eq!(file.patches.len(), 1);
        assert_eq!(file.patches[0].kind, PatchKind::Update);
        assert_eq!(file.patches[0].patch, json!({"author": {"name": "After"}}));
        assert_eq!(
            result.changed_paths,
            vec!["Conn/Posts/rec_1.json".to_string()]
        );
    }

    #[test]
    fn accept_field_only_touches_requested_folder() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([
            (
                "Posts/rec_1.json".to_string(),
                json_pretty(r#"{"id":1,"name":"Before"}"#),
            ),
            (
                "Articles/rec_1.json".to_string(),
                json_pretty(r#"{"id":10,"name":"Other before"}"#),
            ),
        ]);
        let local = HashMap::from([
            (
                "Posts/rec_1.json".to_string(),
                json_pretty(r#"{"id":1,"name":"After"}"#),
            ),
            (
                "Articles/rec_1.json".to_string(),
                json_pretty(r#"{"id":10,"name":"Other after"}"#),
            ),
        ]);
        let mut file = AcceptedPatchesFile::default();

        let result =
            accept_field_in_folder(&ctx, "Posts", "name", &main, &mut file, &local).unwrap();

        assert_eq!(file.patches.len(), 1);
        assert_eq!(file.patches[0].path, "Posts/rec_1.json");
        assert_eq!(
            result.changed_paths,
            vec!["Conn/Posts/rec_1.json".to_string()]
        );
    }

    #[test]
    fn reject_field_restores_working_to_approved_for_unreviewed_field() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"name":"Dirty","ts":"a"}"#),
        )]);
        let local = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"name":"Local edit","ts":"a"}"#),
        )]);
        // No patch entry — approved = main.
        let file = AcceptedPatchesFile::default();

        let (next_local, result) =
            reject_field_in_folder(&ctx, "Posts", "name", &main, &file, &local).unwrap();

        assert_eq!(
            parsed(&next_local["Posts/rec_1.json"]),
            json!({"id":1,"name":"Dirty","ts":"a"})
        );
        assert_eq!(
            result.changed_paths,
            vec!["Conn/Posts/rec_1.json".to_string()]
        );
        // Reject NEVER mutates the patch file (decision 35).
        assert!(!result.patches_changed);
    }

    #[test]
    fn reject_field_uses_apply_patch_entry_to_compute_approved_value() {
        // Approved value is the result of applying the patch entry to main —
        // not main directly. Field-level reject restores `local[field]` to
        // that synthesized approved value.
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"name":"Main name"}"#),
        )]);
        let local = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"name":"Local typo"}"#),
        )]);
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Posts/rec_1.json",
                PatchKind::Update,
                json!({"name": "Approved edit"}),
            )],
        };

        let (next_local, _result) =
            reject_field_in_folder(&ctx, "Posts", "name", &main, &file, &local).unwrap();

        assert_eq!(
            parsed(&next_local["Posts/rec_1.json"]),
            json!({"id":1,"name":"Approved edit"})
        );
    }

    #[test]
    fn reject_field_is_noop_when_field_already_matches_approved() {
        // Decision 35: already-approved fields are not reject-field's
        // concern. Discard-field is the operation that rolls approved back
        // to published.
        let ctx = empty_conn_ctx();
        let main = HashMap::from([("Posts/rec_3.json".to_string(), json_pretty(r#"{"id":3}"#))]);
        let local = HashMap::from([(
            "Posts/rec_3.json".to_string(),
            json_pretty(r#"{"id":3,"name":"Created approved"}"#),
        )]);
        // Patch entry already approves the {name: "Created approved"} edit.
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Posts/rec_3.json",
                PatchKind::Update,
                json!({"name": "Created approved"}),
            )],
        };

        let (next_local, result) =
            reject_field_in_folder(&ctx, "Posts", "name", &main, &file, &local).unwrap();

        // Working unchanged.
        assert_eq!(
            parsed(&next_local["Posts/rec_3.json"]),
            json!({"id":3,"name":"Created approved"})
        );
        assert!(result.changed_paths.is_empty());
        assert!(!result.patches_changed);
    }

    #[test]
    fn reject_field_deletes_created_file_when_last_field_is_removed() {
        // A locally-created file whose only field is unreviewed: rejecting
        // restores approved (= "missing"), so the working file is removed.
        let ctx = empty_conn_ctx();
        let main = HashMap::new();
        let local = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"name":"Only field"}"#),
        )]);
        let file = AcceptedPatchesFile::default();

        let (next_local, result) =
            reject_field_in_folder(&ctx, "Posts", "name", &main, &file, &local).unwrap();

        assert!(!next_local.contains_key("Posts/rec_1.json"));
        assert_eq!(
            result.changed_paths,
            vec!["Conn/Posts/rec_1.json".to_string()]
        );
        assert!(!result.patches_changed);
    }

    #[test]
    fn reject_field_skips_locally_deleted_files() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "Posts/rec_4.json".to_string(),
            json_pretty(r#"{"id":4,"name":"On main"}"#),
        )]);
        let local = HashMap::new();
        // User accepted a Delete; working file is also missing. No field-
        // level action applies — discard-field would re-instate the file.
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Posts/rec_4.json",
                PatchKind::Delete,
                JsonValue::Null,
            )],
        };

        let (next_local, result) =
            reject_field_in_folder(&ctx, "Posts", "name", &main, &file, &local).unwrap();

        assert!(next_local.is_empty());
        assert!(result.changed_paths.is_empty());
        assert!(!result.patches_changed);
    }

    #[test]
    fn reject_field_handles_nested_paths() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"author":{"name":"Before","role":"editor"}}"#),
        )]);
        let local = HashMap::from([(
            "Posts/rec_1.json".to_string(),
            json_pretty(r#"{"id":1,"author":{"name":"After","role":"editor"}}"#),
        )]);
        let file = AcceptedPatchesFile::default();

        let (next_local, result) =
            reject_field_in_folder(&ctx, "Posts", "author.name", &main, &file, &local).unwrap();

        assert_eq!(
            parsed(&next_local["Posts/rec_1.json"]),
            json!({"id":1,"author":{"name":"Before","role":"editor"}})
        );
        assert_eq!(result.changed_paths.len(), 1);
    }

    #[test]
    fn reject_field_only_touches_requested_folder() {
        let ctx = empty_conn_ctx();
        let main = HashMap::from([
            (
                "Posts/rec_1.json".to_string(),
                json_pretty(r#"{"id":1,"name":"Before"}"#),
            ),
            (
                "Articles/rec_1.json".to_string(),
                json_pretty(r#"{"id":10,"name":"Other before"}"#),
            ),
        ]);
        let local = HashMap::from([
            (
                "Posts/rec_1.json".to_string(),
                json_pretty(r#"{"id":1,"name":"After"}"#),
            ),
            (
                "Articles/rec_1.json".to_string(),
                json_pretty(r#"{"id":10,"name":"Other after"}"#),
            ),
        ]);
        let file = AcceptedPatchesFile::default();

        let (next_local, result) =
            reject_field_in_folder(&ctx, "Posts", "name", &main, &file, &local).unwrap();

        assert_eq!(
            parsed(&next_local["Posts/rec_1.json"]),
            json!({"id":1,"name":"Before"})
        );
        // Articles untouched.
        assert_eq!(
            parsed(&next_local["Articles/rec_1.json"]),
            json!({"id":10,"name":"Other after"})
        );
        assert_eq!(
            result.changed_paths,
            vec!["Conn/Posts/rec_1.json".to_string()]
        );
    }
}

/// Build a bare repo with two data folders (posts/, articles/) on both main and dirty,
/// where dirty differs from main in BOTH folders. Returns the bare repo path and a
/// connection context whose dirty_dir has been materialized from the dirty branch.
/// Seed `accepted-patches.json` so it carries the same approved-vs-published
/// delta the legacy fixture encoded as `dirty != main`. Tests written against
/// the pre-B model used `refs/heads/dirty` directly; the post-B model reads
/// from `accepted-patches.json`. Tests that previously relied on the
/// fixture's dirty/main divergence call this helper to translate that
/// state to an `accepted-patches.json` file before invoking the
/// function under test.
fn seed_accepted_patches_from_fixture(ctx: &ConnectionContext) {
    use crate::commands::re_anchor::{AnchoredPatch, PatchKind};
    use crate::config::accepted_patches::{save_atomic, AcceptedPatchesFile};
    use serde_json::Value as JsonValue;

    let main_map = read_main_tree(&ctx.bare_repo).unwrap();
    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")
        .unwrap()
        .expect("fixture must have refs/heads/dirty");
    let dirty_map = read_git_tree(&ctx.bare_repo, &dirty_hash).unwrap();

    let mut patches = Vec::new();
    let mut keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for k in main_map.keys() {
        keys.insert(k.clone());
    }
    for k in dirty_map.keys() {
        keys.insert(k.clone());
    }
    for path in keys {
        if !is_data_path_in_folder(&path, "") {
            continue;
        }
        let m = main_map.get(&path);
        let d = dirty_map.get(&path);
        let entry = match (m, d) {
            (Some(_), None) => AnchoredPatch {
                path: path.clone(),
                kind: PatchKind::Delete,
                patch: JsonValue::Null,
            },
            (None, Some(d)) => {
                let v: JsonValue = serde_json::from_slice(d).unwrap();
                AnchoredPatch {
                    path: path.clone(),
                    kind: PatchKind::Create,
                    patch: v,
                }
            }
            (Some(m), Some(d)) if m != d => {
                let mv: JsonValue = serde_json::from_slice(m).unwrap();
                let dv: JsonValue = serde_json::from_slice(d).unwrap();
                let p = crate::commands::merge_patch::diff(&mv, &dv).unwrap();
                AnchoredPatch {
                    path: path.clone(),
                    kind: PatchKind::Update,
                    patch: p,
                }
            }
            _ => continue,
        };
        patches.push(entry);
    }

    let layout = WorkspaceLayout::for_cli(&ctx.workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
    save_atomic(&connection_dir, &AcceptedPatchesFile { patches }).unwrap();
}

fn create_multi_folder_fixture() -> (TempDir, ConnectionContext) {
    let tmp = TempDir::new().unwrap();
    let source_dir = tmp.path().join("source");
    let bare_repo = tmp.path().join("repo.git");

    run_git(tmp.path(), &["init", "source"]);
    run_git(&source_dir, &["checkout", "-b", "main"]);
    write_file(&source_dir.join("posts/rec1.json"), "{\"v\":\"main-p1\"}");
    write_file(
        &source_dir.join("articles/rec1.json"),
        "{\"v\":\"main-a1\"}",
    );
    commit_all(&source_dir, "main content");

    run_git(&source_dir, &["checkout", "-b", "dirty"]);
    // Approved-but-unpublished edits in BOTH folders.
    write_file(&source_dir.join("posts/rec1.json"), "{\"v\":\"dirty-p1\"}");
    write_file(
        &source_dir.join("articles/rec1.json"),
        "{\"v\":\"dirty-a1\"}",
    );
    commit_all(&source_dir, "dirty content");

    run_git(
        tmp.path(),
        &[
            "clone",
            "--bare",
            source_dir.to_str().unwrap(),
            bare_repo.to_str().unwrap(),
        ],
    );

    let root = tmp.path().to_path_buf();
    let ctx = make_connection_context(&root, &bare_repo);
    // Production creates dirty_dir as a sparse worktree (see
    // `materialize_dirty_checkout` in workspaces.rs); the reset-hard in
    // discard_all_single_repo requires that. Mirror it here.
    crate::git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.dirty_dir, "refs/heads/dirty")
        .unwrap();

    (tmp, ctx)
}

/// Load `accepted-patches.json` for a test ctx.
fn load_accepted(ctx: &ConnectionContext) -> crate::config::accepted_patches::AcceptedPatchesFile {
    let layout = WorkspaceLayout::for_cli(&ctx.workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
    crate::config::accepted_patches::load(&connection_dir).unwrap()
}

#[test]
fn accept_all_single_repo_folder_accepts_only_target_folder() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Pending edits in both folders on top of the seeded "approved" state.
    write_file(
        &ctx.dirty_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );
    write_file(
        &ctx.dirty_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let result = accept_all_single_repo(&ctx, &ctx.workspace_dir.clone(), Some("posts")).unwrap();

    assert_eq!(result.files_accepted, 1);
    assert_eq!(result.accepted_paths, vec!["posts/rec1.json".to_string()]);

    let file = load_accepted(&ctx);
    let posts = file
        .patches
        .iter()
        .find(|e| e.path == "posts/rec1.json")
        .expect("posts entry should exist post-accept");
    assert_eq!(
        posts.kind,
        crate::commands::re_anchor::PatchKind::Update,
        "posts is an edit over main"
    );
    assert_eq!(posts.patch, serde_json::json!({"v": "pending-p1"}));

    let articles = file
        .patches
        .iter()
        .find(|e| e.path == "articles/rec1.json")
        .expect("articles entry should remain — it was already approved");
    assert_eq!(articles.patch, serde_json::json!({"v": "dirty-a1"}));

    // Worktree untouched by accept.
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"pending-p1\"}"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn accept_all_single_repo_folder_noop_when_folder_has_no_changes() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Pending edit only in articles/; posts/ is unchanged from the seeded
    // approved state (= the original dirty branch content materialized into
    // the worktree).
    write_file(
        &ctx.dirty_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let pre = load_accepted(&ctx);
    let result = accept_all_single_repo(&ctx, &ctx.workspace_dir.clone(), Some("posts")).unwrap();

    assert_eq!(result.files_accepted, 0);
    assert!(result.accepted_paths.is_empty());
    // Patch file untouched in scope. (No save_atomic call is asserted directly
    // — the test below would fail if a stale patch had been re-written.)
    assert_eq!(
        load_accepted(&ctx),
        pre,
        "accepted-patches should be unchanged when target folder is clean"
    );
}

#[test]
fn accept_all_single_repo_folder_handles_deletion_inside_folder() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Delete the scoped folder's file from the working tree.
    std::fs::remove_file(ctx.dirty_dir.join("posts/rec1.json")).unwrap();

    let result = accept_all_single_repo(&ctx, &ctx.workspace_dir.clone(), Some("posts")).unwrap();

    assert_eq!(result.files_accepted, 1);
    assert_eq!(result.accepted_paths, vec!["posts/rec1.json".to_string()]);

    let file = load_accepted(&ctx);
    let posts = file
        .patches
        .iter()
        .find(|e| e.path == "posts/rec1.json")
        .expect("posts entry should be replaced with a Delete");
    assert_eq!(posts.kind, crate::commands::re_anchor::PatchKind::Delete);
    assert!(
        file.patches.iter().any(|e| e.path == "articles/rec1.json"),
        "articles entry must remain untouched"
    );
}

#[test]
fn discard_all_single_repo_folder_reverts_only_target_folder() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Pending edits in both folders on top of the seeded approved state.
    write_file(
        &ctx.dirty_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );
    write_file(
        &ctx.dirty_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let result = discard_all_single_repo(&ctx, &ctx.workspace_dir.clone(), Some("posts")).unwrap();

    assert!(!result.skipped_missing_main);
    assert_eq!(result.files_discarded, 1);
    assert_eq!(result.discarded_paths, vec!["posts/rec1.json".to_string()]);

    let file = load_accepted(&ctx);
    assert!(
        !file.patches.iter().any(|e| e.path == "posts/rec1.json"),
        "posts entry should be dropped"
    );
    assert!(
        file.patches.iter().any(|e| e.path == "articles/rec1.json"),
        "articles entry remains — out of scope for the posts discard"
    );

    // Worktree for the scoped folder should be reset to main content (read
    // back as the raw bytes the fixture committed to main).
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
    // Worktree for the other folder must retain its pending edit — a scoped
    // discard must not wipe unrelated working-tree changes.
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn discard_all_single_repo_folder_noop_when_folder_clean() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();

    // Realign main so it matches dirty for posts/ — i.e. the fixture's posts
    // is approved AND published. Only articles ends up with an approved-but-
    // unpublished delta to seed into accepted-patches.json.
    let dirty_hash = git_rev_parse(&ctx.bare_repo, "refs/heads/dirty").unwrap();
    let dirty_tree = read_git_tree(&ctx.bare_repo, &dirty_hash).unwrap();
    let mut new_main = dirty_tree.clone();
    new_main.insert(
        "articles/rec1.json".to_string(),
        b"{\"v\":\"main-a1\"}".to_vec(),
    );
    let commit_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        Some(dirty_hash.as_str()),
        &new_main,
        "align posts on main",
    )
    .unwrap();
    git_update_ref(&ctx.bare_repo, "refs/heads/main", &commit_hash).unwrap();
    git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &dirty_hash).unwrap();

    seed_accepted_patches_from_fixture(&ctx);

    // Confirm seeding only produced an articles entry.
    let pre = load_accepted(&ctx);
    assert!(
        !pre.patches.iter().any(|e| e.path == "posts/rec1.json"),
        "posts has no approved-vs-published diff after the realign"
    );
    assert!(
        pre.patches.iter().any(|e| e.path == "articles/rec1.json"),
        "articles diff should seed"
    );

    // Pending edit only in articles/; posts/ is unchanged from its (now-
    // identical) approved state.
    write_file(
        &ctx.dirty_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let result = discard_all_single_repo(&ctx, &ctx.workspace_dir.clone(), Some("posts")).unwrap();

    assert!(!result.skipped_missing_main);
    assert_eq!(result.files_discarded, 0);
    assert!(result.discarded_paths.is_empty());
    assert_eq!(
        load_accepted(&ctx),
        pre,
        "accepted-patches should be unchanged when target folder is clean"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn discard_paths_single_repo_reverts_only_listed_paths() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Pending working-tree edits in both folders on top of the approved
    // patches already seeded into accepted-patches.json.
    write_file(
        &ctx.dirty_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );
    write_file(
        &ctx.dirty_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let rel = vec!["posts/rec1.json".to_string()];
    let input_map: HashMap<&str, &str> =
        HashMap::from([("posts/rec1.json", "Conn/posts/rec1.json")]);

    let result = discard_paths_single_repo(&ctx, &rel, &input_map).unwrap();

    assert!(!result.skipped_missing_main);
    assert_eq!(result.files_discarded, 1);
    assert_eq!(result.discarded_paths, vec!["posts/rec1.json".to_string()]);

    // accepted-patches.json: posts entry dropped, articles entry kept.
    let connection_dir =
        WorkspaceLayout::for_cli(&ctx.workspace_dir).connection_root_path(&ctx.conn_dir_name);
    let file = crate::config::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(file.patches.len(), 1, "only articles entry should remain");
    assert_eq!(file.patches[0].path, "articles/rec1.json");

    // Worktree: listed path matches main; unlisted path keeps its pending edit.
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn discard_paths_single_repo_reverts_path_with_only_unapproved_change() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();

    // Align dirty's posts back to main (no approved change for posts), leaving
    // articles diverged. The pending edit on posts is the only remaining diff
    // for that path.
    let dirty_hash = git_rev_parse(&ctx.bare_repo, "refs/heads/dirty").unwrap();
    let mut realigned = read_git_tree(&ctx.bare_repo, &dirty_hash).unwrap();
    realigned.insert(
        "posts/rec1.json".to_string(),
        b"{\"v\":\"main-p1\"}".to_vec(),
    );
    let new_dirty = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        Some(dirty_hash.as_str()),
        &realigned,
        "realign posts to main",
    )
    .unwrap();
    // Refresh the worktree so the pending edit below is the only diff on posts.
    crate::git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.dirty_dir, &new_dirty).unwrap();

    write_file(
        &ctx.dirty_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );

    let rel = vec!["posts/rec1.json".to_string()];
    let input_map: HashMap<&str, &str> =
        HashMap::from([("posts/rec1.json", "Conn/posts/rec1.json")]);

    let result = discard_paths_single_repo(&ctx, &rel, &input_map).unwrap();

    assert_eq!(result.files_discarded, 1);
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
}

#[test]
fn discard_paths_single_repo_reverts_path_with_only_approved_change() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    // Fixture's posts/rec1.json has an approved-but-unpublished edit
    // (main=main-p1, approved=dirty-p1). No pending working-tree edit on posts.
    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    let rel = vec!["posts/rec1.json".to_string()];
    let input_map: HashMap<&str, &str> =
        HashMap::from([("posts/rec1.json", "Conn/posts/rec1.json")]);

    let result = discard_paths_single_repo(&ctx, &rel, &input_map).unwrap();

    assert_eq!(result.files_discarded, 1);
    let connection_dir =
        WorkspaceLayout::for_cli(&ctx.workspace_dir).connection_root_path(&ctx.conn_dir_name);
    let file = crate::config::accepted_patches::load(&connection_dir).unwrap();
    assert!(
        !file.patches.iter().any(|e| e.path == "posts/rec1.json"),
        "posts entry should be removed"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.dirty_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
}

#[test]
fn discard_paths_single_repo_errors_when_path_has_no_changes() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    // Align posts on both main and dirty so the path has no approved or pending change.
    let (_tmp, ctx) = create_multi_folder_fixture();
    let dirty_hash = git_rev_parse(&ctx.bare_repo, "refs/heads/dirty").unwrap();
    let mut new_main = read_git_tree(&ctx.bare_repo, &dirty_hash).unwrap();
    // Keep articles as main-a1 so only articles has an approved diff.
    new_main.insert(
        "articles/rec1.json".to_string(),
        b"{\"v\":\"main-a1\"}".to_vec(),
    );
    let commit_hash = commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        Some(dirty_hash.as_str()),
        &new_main,
        "align posts on main",
    )
    .unwrap();
    git_update_ref(&ctx.bare_repo, "refs/heads/main", &commit_hash).unwrap();
    git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &dirty_hash).unwrap();

    let rel = vec!["posts/rec1.json".to_string()];
    let input_map: HashMap<&str, &str> =
        HashMap::from([("posts/rec1.json", "Conn/posts/rec1.json")]);

    let err = discard_paths_single_repo(&ctx, &rel, &input_map).unwrap_err();
    assert!(
        err.to_string().contains("No local changes to discard"),
        "unexpected error message: {err}"
    );
}

#[test]
fn discard_paths_single_repo_skips_when_main_missing() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    // Build a fixture that has only a dirty branch (no main ref).
    let tmp = TempDir::new().unwrap();
    let source_dir = tmp.path().join("source");
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "source"]);
    run_git(&source_dir, &["checkout", "-b", "dirty"]);
    write_file(&source_dir.join("posts/rec1.json"), "{\"v\":\"dirty\"}");
    commit_all(&source_dir, "dirty only");
    run_git(
        tmp.path(),
        &[
            "clone",
            "--bare",
            source_dir.to_str().unwrap(),
            bare_repo.to_str().unwrap(),
        ],
    );
    // The clone's HEAD will point at dirty. Ensure no refs/heads/main exists.
    assert!(git_rev_parse_optional(&bare_repo, "refs/heads/main")
        .unwrap()
        .is_none());

    let ctx = make_connection_context(tmp.path(), &bare_repo);

    let rel = vec!["posts/rec1.json".to_string()];
    let input_map: HashMap<&str, &str> =
        HashMap::from([("posts/rec1.json", "Conn/posts/rec1.json")]);

    let result = discard_paths_single_repo(&ctx, &rel, &input_map).unwrap();
    assert!(result.skipped_missing_main);
    assert_eq!(result.files_discarded, 0);
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

fn df(id: &str, name: &str, path: Option<&str>) -> crate::api::DataFolder {
    crate::api::DataFolder {
        id: id.to_string(),
        name: name.to_string(),
        path: path.map(String::from),
    }
}

#[test]
fn reconcile_creates_missing_folders() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    let folders = vec![
        df("a", "Foo", Some("/Foo")),
        df("b", "Baz", Some("/Bar/Baz")),
    ];
    reconcile_data_folder_dirs(root, &folders).unwrap();

    assert!(root.join("Foo").is_dir());
    assert!(root.join("Bar").is_dir());
    assert!(root.join("Bar/Baz").is_dir());
}

#[test]
fn reconcile_creates_deep_chain_up_to_leaf_only() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    let folders = vec![df("leaf", "D", Some("/A/B/C/D"))];
    reconcile_data_folder_dirs(root, &folders).unwrap();

    assert!(root.join("A").is_dir());
    assert!(root.join("A/B").is_dir());
    assert!(root.join("A/B/C").is_dir());
    assert!(root.join("A/B/C/D").is_dir());
}

#[test]
fn reconcile_skips_null_and_slash_only_paths() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    let folders = vec![df("a", "NoPath", None), df("b", "Root", Some("/"))];
    reconcile_data_folder_dirs(root, &folders).unwrap();

    let entries: Vec<_> = std::fs::read_dir(root).unwrap().collect();
    assert!(entries.is_empty(), "no directories should be created");
}

#[test]
fn reconcile_prunes_unknown_empty_dirs() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    std::fs::create_dir(root.join("Stale")).unwrap();
    std::fs::create_dir(root.join("Kept")).unwrap();

    let folders = vec![df("k", "Kept", Some("/Kept"))];
    reconcile_data_folder_dirs(root, &folders).unwrap();

    assert!(root.join("Kept").is_dir());
    assert!(
        !root.join("Stale").exists(),
        "empty unknown dir should be pruned"
    );
}

#[test]
fn reconcile_preserves_non_empty_unknown_dirs() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let stale = root.join("HasFile");
    std::fs::create_dir(&stale).unwrap();
    std::fs::write(stale.join("record.json"), b"{}").unwrap();

    reconcile_data_folder_dirs(root, &[]).unwrap();

    assert!(stale.is_dir(), "non-empty unknown dir must be kept");
    assert!(stale.join("record.json").exists());
}

#[test]
fn reconcile_leaves_dotfiles_alone() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    std::fs::create_dir(root.join(".scratch")).unwrap();
    std::fs::write(root.join(".scratchmd"), b"").unwrap();

    reconcile_data_folder_dirs(root, &[]).unwrap();

    assert!(
        root.join(".scratch").is_dir(),
        ".scratch must survive prune"
    );
    assert!(
        root.join(".scratchmd").exists(),
        ".scratchmd must survive prune"
    );
}

#[test]
fn reconcile_prunes_nested_empty_chains() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("Outer/Inner")).unwrap();

    reconcile_data_folder_dirs(root, &[]).unwrap();

    assert!(!root.join("Outer").exists());
}

#[test]
fn reconcile_preserves_ancestors_of_wanted_folder() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("A/B/C")).unwrap();

    let folders = vec![df("c", "C", Some("/A/B/C"))];
    reconcile_data_folder_dirs(root, &folders).unwrap();

    assert!(root.join("A").is_dir());
    assert!(root.join("A/B").is_dir());
    assert!(root.join("A/B/C").is_dir());
}

// ---------------------------------------------------------------------------
// Slice D — `download_single_repo` rewrite (refuse-or-replay model).
// Pre-Slice-F the working tree happens to live in `ctx.dirty_dir`, but D
// no longer uses the dirty branch for any of its semantics: re-anchor and
// replay run against `refs/heads/main` ↔ `refs/remotes/origin/main` and the
// per-connection `accepted-patches.json` file.
// ---------------------------------------------------------------------------

fn seed_main_with_record(
    fixture: &BareFixture,
    ctx: &ConnectionContext,
    rel_path: &str,
    content: &str,
) -> String {
    run_git(&fixture.source_dir, &["checkout", "main"]);
    write_file(&fixture.source_dir.join(rel_path), content);
    commit_all(&fixture.source_dir, &format!("seed {rel_path}"));
    run_git(&fixture.source_dir, &["push", "origin", "main:main"]);
    crate::git_ops::fetch_origin(&ctx.bare_repo, "test-token").unwrap();
    let new_main = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/main").unwrap();
    git_update_ref(&ctx.bare_repo, "refs/heads/main", &new_main).unwrap();
    new_main
}

fn advance_remote_main(fixture: &BareFixture, rel_path: &str, content: &str, msg: &str) {
    run_git(&fixture.source_dir, &["checkout", "main"]);
    write_file(&fixture.source_dir.join(rel_path), content);
    commit_all(&fixture.source_dir, msg);
    run_git(&fixture.source_dir, &["push", "origin", "main:main"]);
}

#[test]
fn download_re_anchors_accepted_patch_when_server_touches_disjoint_field() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    // Seed: main has Acme with industry=Tech.
    seed_main_with_record(
        &fixture,
        &ctx,
        "posts/rec_acme.json",
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"Tech\"\n}\n",
    );

    // User accepted industry → SaaS. Working file holds the approved value
    // (`apply(main, patch)`); the accept-time path always leaves
    // local == approved.
    let connection_dir = accepted_patches_dir(&ctx);
    let accepted = crate::config::accepted_patches::AcceptedPatchesFile {
        patches: vec![crate::commands::re_anchor::AnchoredPatch {
            path: "posts/rec_acme.json".to_string(),
            kind: crate::commands::re_anchor::PatchKind::Update,
            patch: serde_json::json!({"industry": "SaaS"}),
        }],
    };
    crate::config::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();
    write_file(
        &ctx.dirty_dir.join("posts/rec_acme.json"),
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}\n",
    );

    // Server independently renames the record (touches `name`, not `industry`).
    advance_remote_main(
        &fixture,
        "posts/rec_acme.json",
        "{\n  \"name\": \"Acme Inc\",\n  \"industry\": \"Tech\"\n}\n",
        "server renames Acme",
    );

    let result = download_single_repo(&ctx, &workspace_dir, "test-token", &[]).unwrap();

    assert_eq!(result.status, "downloaded");
    assert_eq!(result.conflicts_auto_resolved, 0);
    let local_main = git_rev_parse(&ctx.bare_repo, "refs/heads/main").unwrap();
    let origin_main = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/main").unwrap();
    assert_eq!(local_main, origin_main, "local main must advance to origin");

    // Patch preserved verbatim — server didn't touch industry.
    let reloaded = crate::config::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(reloaded.patches.len(), 1);
    assert_eq!(
        reloaded.patches[0].patch,
        serde_json::json!({"industry": "SaaS"})
    );

    // Working file = apply(new_main_blob, patch): server's name rename
    // surfaces; the user's industry edit replays on top.
    let working: serde_json::Value =
        serde_json::from_slice(&std::fs::read(ctx.dirty_dir.join("posts/rec_acme.json")).unwrap())
            .unwrap();
    assert_eq!(working["name"], "Acme Inc");
    assert_eq!(working["industry"], "SaaS");

    // No conflict log written — disjoint fields.
    assert!(!workspace_dir.join(".scratch/conflicts.log").exists());
}

#[test]
fn download_logs_conflict_and_user_wins_when_server_overwrites_same_field() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    seed_main_with_record(
        &fixture,
        &ctx,
        "posts/rec_acme.json",
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"Tech\"\n}\n",
    );

    let connection_dir = accepted_patches_dir(&ctx);
    let accepted = crate::config::accepted_patches::AcceptedPatchesFile {
        patches: vec![crate::commands::re_anchor::AnchoredPatch {
            path: "posts/rec_acme.json".to_string(),
            kind: crate::commands::re_anchor::PatchKind::Update,
            patch: serde_json::json!({"industry": "SaaS"}),
        }],
    };
    crate::config::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();
    write_file(
        &ctx.dirty_dir.join("posts/rec_acme.json"),
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}\n",
    );

    // Server changes the SAME field to a different value.
    advance_remote_main(
        &fixture,
        "posts/rec_acme.json",
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"Marketing\"\n}\n",
        "server changes industry",
    );

    let result = download_single_repo(&ctx, &workspace_dir, "test-token", &[]).unwrap();

    assert_eq!(result.status, "downloaded");
    assert_eq!(result.conflicts_auto_resolved, 1);

    // User wins: patch unchanged.
    let reloaded = crate::config::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(
        reloaded.patches[0].patch,
        serde_json::json!({"industry": "SaaS"})
    );
    let working: serde_json::Value =
        serde_json::from_slice(&std::fs::read(ctx.dirty_dir.join("posts/rec_acme.json")).unwrap())
            .unwrap();
    assert_eq!(working["industry"], "SaaS");

    // Conflict log written with the specific field name.
    let log_path = workspace_dir.join(".scratch/conflicts.log");
    assert!(log_path.exists());
    let log_content = std::fs::read_to_string(&log_path).unwrap();
    let entry: crate::config::conflicts_log::ConflictEntry =
        serde_json::from_str(log_content.trim_end()).unwrap();
    assert_eq!(entry.path, "posts/rec_acme.json");
    assert_eq!(entry.connector_account_id, ctx.connection_id);
    assert_eq!(entry.conflicting_keys, vec!["industry"]);
}

#[test]
fn download_returns_up_to_date_when_server_main_unchanged() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    seed_main_with_record(
        &fixture,
        &ctx,
        "posts/rec.json",
        "{\n  \"name\": \"X\"\n}\n",
    );

    // No server-side advance — should short-circuit to up_to_date with no
    // ref bump, no conflict log, no patch-file mutation.
    let result = download_single_repo(&ctx, &workspace_dir, "test-token", &[]).unwrap();
    assert_eq!(result.status, "up_to_date");
    assert_eq!(result.files_created, 0);
    assert_eq!(result.files_updated, 0);
    assert!(!workspace_dir.join(".scratch/conflicts.log").exists());
}

mod accepted_state_helpers {
    use super::super::super::re_anchor::{AnchoredPatch, PatchKind};
    use super::super::*;
    use crate::config::accepted_patches::AcceptedPatchesFile;
    use serde_json::{json, Value as JsonValue};

    fn map_of(pairs: &[(&str, &str)]) -> FileMap {
        let mut m = FileMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.as_bytes().to_vec());
        }
        m
    }

    fn entry(path: &str, kind: PatchKind, patch: JsonValue) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind,
            patch,
        }
    }

    fn json_bytes(v: &JsonValue) -> Vec<u8> {
        serde_json::to_vec_pretty(v).unwrap()
    }

    #[test]
    fn compute_accepted_state_with_empty_file_returns_main_map() {
        let main = map_of(&[("Companies/rec_1.json", "{\"name\":\"Acme\"}")]);
        let file = AcceptedPatchesFile::default();
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert_eq!(approved, main);
    }

    #[test]
    fn compute_accepted_state_applies_update_via_merge_patch() {
        let base = json!({"name": "Acme", "industry": "Other"});
        let main = {
            let mut m = FileMap::new();
            m.insert("Companies/rec_1.json".into(), json_bytes(&base));
            m
        };
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_1.json",
                PatchKind::Update,
                json!({"industry": "SaaS"}),
            )],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        let expected = json_bytes(&json!({"name": "Acme", "industry": "SaaS"}));
        assert_eq!(
            approved.get("Companies/rec_1.json").map(|v| v.as_slice()),
            Some(expected.as_slice())
        );
    }

    #[test]
    fn compute_accepted_state_inserts_create_entries() {
        let main = FileMap::new();
        let new_record = json!({"name": "New Co"});
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_new.json",
                PatchKind::Create,
                new_record.clone(),
            )],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert_eq!(
            approved.get("Companies/rec_new.json").map(|v| v.as_slice()),
            Some(json_bytes(&new_record).as_slice())
        );
    }

    #[test]
    fn compute_accepted_state_removes_delete_entries() {
        let main = map_of(&[("Companies/rec_1.json", "{\"name\":\"Acme\"}")]);
        let file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_1.json",
                PatchKind::Delete,
                JsonValue::Null,
            )],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert!(approved.is_empty());
    }

    #[test]
    fn compute_accepted_state_handles_multiple_entries_in_order() {
        let main = {
            let mut m = FileMap::new();
            m.insert(
                "Companies/rec_1.json".into(),
                json_bytes(&json!({"name": "Acme"})),
            );
            m.insert(
                "Companies/rec_keep.json".into(),
                json_bytes(&json!({"name": "Keep"})),
            );
            m
        };
        let file = AcceptedPatchesFile {
            patches: vec![
                entry(
                    "Companies/rec_1.json",
                    PatchKind::Update,
                    json!({"industry": "SaaS"}),
                ),
                entry(
                    "Companies/rec_2.json",
                    PatchKind::Create,
                    json!({"name": "Beta"}),
                ),
                entry(
                    "Companies/rec_keep.json",
                    PatchKind::Delete,
                    JsonValue::Null,
                ),
            ],
        };
        let approved = compute_accepted_state(&main, &file).unwrap();
        assert_eq!(approved.len(), 2);
        assert!(approved.contains_key("Companies/rec_1.json"));
        assert!(approved.contains_key("Companies/rec_2.json"));
        assert!(!approved.contains_key("Companies/rec_keep.json"));
    }

    #[test]
    fn apply_patch_entry_to_blob_create_serializes_full_content() {
        let e = entry("p.json", PatchKind::Create, json!({"name": "Acme"}));
        let out = apply_patch_entry_to_blob(None, &e).unwrap();
        assert_eq!(out, Some(json_bytes(&json!({"name": "Acme"}))));
    }

    #[test]
    fn apply_patch_entry_to_blob_update_merges_keys() {
        let main_blob = json_bytes(&json!({"name": "Acme", "industry": "Other"}));
        let e = entry("p.json", PatchKind::Update, json!({"industry": "SaaS"}));
        let out = apply_patch_entry_to_blob(Some(&main_blob), &e).unwrap();
        assert_eq!(
            out,
            Some(json_bytes(&json!({"name": "Acme", "industry": "SaaS"})))
        );
    }

    #[test]
    fn apply_patch_entry_to_blob_update_with_null_key_deletes_field() {
        let main_blob = json_bytes(&json!({"name": "Acme", "draft": true}));
        let e = entry("p.json", PatchKind::Update, json!({"draft": null}));
        let out = apply_patch_entry_to_blob(Some(&main_blob), &e).unwrap();
        assert_eq!(out, Some(json_bytes(&json!({"name": "Acme"}))));
    }

    #[test]
    fn apply_patch_entry_to_blob_delete_returns_none() {
        let main_blob = json_bytes(&json!({"name": "Acme"}));
        let e = entry("p.json", PatchKind::Delete, JsonValue::Null);
        let out = apply_patch_entry_to_blob(Some(&main_blob), &e).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn apply_patch_entry_to_blob_update_against_missing_main_treats_as_null() {
        // Pathological state but we don't want to panic. RFC 7396 apply on
        // null + an object patch produces a fresh object from the patch's
        // non-null keys.
        let e = entry("p.json", PatchKind::Update, json!({"name": "Acme"}));
        let out = apply_patch_entry_to_blob(None, &e).unwrap();
        assert_eq!(out, Some(json_bytes(&json!({"name": "Acme"}))));
    }
}

mod discard_field_helper {
    use super::super::super::re_anchor::{AnchoredPatch, PatchKind};
    use super::super::*;
    use crate::config::accepted_patches::AcceptedPatchesFile;
    use serde_json::{json, Value as JsonValue};
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn entry(path: &str, kind: PatchKind, patch: JsonValue) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind,
            patch,
        }
    }

    fn ctx_in(tmp: &TempDir) -> ConnectionContext {
        // discard_field_in_folder uses only conn_dir_name to build the
        // workspace-prefixed paths in its result; the worktree mutations
        // happen via the returned next_local_map, not on disk.
        ConnectionContext {
            connection_id: "ca_test".into(),
            conn_dir_name: "HubSpot".into(),
            dirty_dir: tmp.path().to_path_buf(),
            scratch_dir: tmp.path().to_path_buf(),
            workspace_dir: tmp.path().to_path_buf(),
            master_dir: tmp.path().to_path_buf(),
            bare_repo: tmp.path().to_path_buf(),
            db_path: PathBuf::new(),
        }
    }

    fn map_with_json(pairs: &[(&str, &JsonValue)]) -> FileMap {
        let mut m = FileMap::new();
        for (k, v) in pairs {
            m.insert((*k).into(), serde_json::to_vec_pretty(v).unwrap());
        }
        m
    }

    fn parsed(map: &FileMap, path: &str) -> JsonValue {
        let bytes = map.get(path).expect("missing path");
        serde_json::from_slice(bytes).expect("invalid JSON")
    }

    #[test]
    fn discard_field_strips_update_patch_key_and_restores_working_to_main_value() {
        let tmp = TempDir::new().unwrap();
        let ctx = ctx_in(&tmp);
        let main = map_with_json(&[(
            "Companies/rec_1.json",
            &json!({"industry": "Other", "name": "Acme"}),
        )]);
        let local = map_with_json(&[(
            "Companies/rec_1.json",
            &json!({"industry": "SaaS", "name": "Acme"}),
        )]);
        let mut file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_1.json",
                PatchKind::Update,
                json!({"industry": "SaaS"}),
            )],
        };

        let (next_local, result) =
            discard_field_in_folder(&ctx, "Companies", "industry", &main, &mut file, &local)
                .unwrap();

        assert!(
            file.patches.is_empty(),
            "Update patch should drop when last key removed"
        );
        assert_eq!(
            parsed(&next_local, "Companies/rec_1.json"),
            json!({"industry": "Other", "name": "Acme"}),
        );
        assert_eq!(
            result.changed_paths,
            vec!["HubSpot/Companies/rec_1.json".to_string()]
        );
        assert!(result.patches_changed);
    }

    #[test]
    fn discard_field_on_create_strips_key_and_removes_working_when_empty() {
        let tmp = TempDir::new().unwrap();
        let ctx = ctx_in(&tmp);
        let main = FileMap::new();
        let local = map_with_json(&[("Companies/rec_new.json", &json!({"name": "New"}))]);
        let mut file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_new.json",
                PatchKind::Create,
                json!({"name": "New"}),
            )],
        };

        let (next_local, result) =
            discard_field_in_folder(&ctx, "Companies", "name", &main, &mut file, &local).unwrap();

        assert!(
            file.patches.is_empty(),
            "Create patch should drop when last key removed"
        );
        assert!(
            !next_local.contains_key("Companies/rec_new.json"),
            "working file should be removed when Create empties"
        );
        assert_eq!(
            result.changed_paths,
            vec!["HubSpot/Companies/rec_new.json".to_string()]
        );
        assert!(result.patches_changed);
    }

    #[test]
    fn discard_field_on_create_with_remaining_keys_updates_working_to_match() {
        let tmp = TempDir::new().unwrap();
        let ctx = ctx_in(&tmp);
        let main = FileMap::new();
        let local = map_with_json(&[(
            "Companies/rec_new.json",
            &json!({"name": "New", "industry": "SaaS"}),
        )]);
        let mut file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_new.json",
                PatchKind::Create,
                json!({"name": "New", "industry": "SaaS"}),
            )],
        };

        let (next_local, _result) =
            discard_field_in_folder(&ctx, "Companies", "industry", &main, &mut file, &local)
                .unwrap();

        // Patch loses 'industry' but stays as Create with 'name'.
        assert_eq!(file.patches.len(), 1);
        assert_eq!(file.patches[0].kind, PatchKind::Create);
        assert_eq!(file.patches[0].patch, json!({"name": "New"}));
        // Working file matches: 'industry' is gone because published has no such record.
        assert_eq!(
            parsed(&next_local, "Companies/rec_new.json"),
            json!({"name": "New"})
        );
    }

    #[test]
    fn discard_field_on_delete_entry_is_noop() {
        let tmp = TempDir::new().unwrap();
        let ctx = ctx_in(&tmp);
        let main = map_with_json(&[("Companies/rec_1.json", &json!({"name": "Acme"}))]);
        let local = FileMap::new(); // working file is already gone
        let mut file = AcceptedPatchesFile {
            patches: vec![entry(
                "Companies/rec_1.json",
                PatchKind::Delete,
                JsonValue::Null,
            )],
        };

        let (next_local, result) =
            discard_field_in_folder(&ctx, "Companies", "name", &main, &mut file, &local).unwrap();

        assert_eq!(file.patches.len(), 1, "Delete entry must stay");
        assert_eq!(file.patches[0].kind, PatchKind::Delete);
        assert!(next_local.is_empty(), "working untouched (still absent)");
        assert!(result.changed_paths.is_empty());
        assert!(!result.patches_changed);
    }

    #[test]
    fn discard_field_without_patch_just_resets_working_to_main_value() {
        // User has only an unreviewed working-tree edit (no patch entry).
        // discard-field should reset that field's value to published.
        let tmp = TempDir::new().unwrap();
        let ctx = ctx_in(&tmp);
        let main = map_with_json(&[(
            "Companies/rec_1.json",
            &json!({"industry": "Other", "name": "Acme"}),
        )]);
        let local = map_with_json(&[(
            "Companies/rec_1.json",
            &json!({"industry": "Tweaked", "name": "Acme"}),
        )]);
        let mut file = AcceptedPatchesFile::default();

        let (next_local, result) =
            discard_field_in_folder(&ctx, "Companies", "industry", &main, &mut file, &local)
                .unwrap();

        assert!(file.patches.is_empty());
        assert_eq!(
            parsed(&next_local, "Companies/rec_1.json"),
            json!({"industry": "Other", "name": "Acme"}),
        );
        assert_eq!(
            result.changed_paths,
            vec!["HubSpot/Companies/rec_1.json".to_string()]
        );
        // Working changed but no patch movement.
        assert!(!result.patches_changed);
    }

    #[test]
    fn discard_field_outside_folder_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let ctx = ctx_in(&tmp);
        let main = map_with_json(&[
            ("Companies/rec_1.json", &json!({"x": 1})),
            ("Contacts/rec_2.json", &json!({"x": 1})),
        ]);
        let local = map_with_json(&[
            ("Companies/rec_1.json", &json!({"x": 2})),
            ("Contacts/rec_2.json", &json!({"x": 99})),
        ]);
        let mut file = AcceptedPatchesFile::default();

        let (next_local, result) =
            discard_field_in_folder(&ctx, "Companies", "x", &main, &mut file, &local).unwrap();

        assert_eq!(parsed(&next_local, "Companies/rec_1.json"), json!({"x": 1}));
        // Contacts/rec_2.json untouched.
        assert_eq!(parsed(&next_local, "Contacts/rec_2.json"), json!({"x": 99}));
        assert_eq!(result.changed_paths.len(), 1);
        assert!(result.changed_paths[0].ends_with("Companies/rec_1.json"));
    }

    #[test]
    fn discard_field_field_already_at_published_is_full_noop() {
        let tmp = TempDir::new().unwrap();
        let ctx = ctx_in(&tmp);
        let main = map_with_json(&[("Companies/rec_1.json", &json!({"x": "v"}))]);
        let local = map_with_json(&[("Companies/rec_1.json", &json!({"x": "v"}))]);
        let mut file = AcceptedPatchesFile::default();

        let (next_local, result) =
            discard_field_in_folder(&ctx, "Companies", "x", &main, &mut file, &local).unwrap();

        assert_eq!(
            parsed(&next_local, "Companies/rec_1.json"),
            json!({"x": "v"})
        );
        assert!(result.changed_paths.is_empty());
        assert!(!result.patches_changed);
    }
}
