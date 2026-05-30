use super::*;
use crate::shared::git_exec::git_command;
use std::path::PathBuf;
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
        worktree_dir: root.join("Conn"),
        scratch_dir: root.join(".scratch/connections/scratch/Conn"),
        workspace_dir: root.to_path_buf(),
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
        worktree_dir: tmp.path().join("Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
        workspace_dir: tmp.path().to_path_buf(),
        bare_repo: tmp.path().join(".repos/conn.git"),
        db_path: tmp.path().join(".repos/conn.db"),
    };

    std::fs::create_dir_all(ctx.worktree_dir.join("posts")).unwrap();
    std::fs::create_dir_all(ctx.scratch_dir.join("posts/publish-plan-1/create")).unwrap();
    std::fs::write(ctx.worktree_dir.join("posts/rec1.json"), "{}").unwrap();
    std::fs::write(ctx.scratch_dir.join("posts/schema.json"), "{}").unwrap();
    std::fs::write(
        ctx.scratch_dir
            .join("posts/publish-plan-1/create/rec2.json"),
        "{}",
    )
    .unwrap();

    let map = read_worktree_files_and_scratch_state(&ctx).unwrap();
    assert!(map.contains_key("posts/rec1.json"));
    assert!(map.contains_key(".scratch/posts/schema.json"));
    assert!(map.contains_key(".scratch/posts/publish-plan-1/create/rec2.json"));

    let replacement = HashMap::from([
        ("posts/next.json".to_string(), b"{\"id\":\"next\"}".to_vec()),
        (
            ".scratch/posts/schema.json".to_string(),
            b"{\"schema\":{}}".to_vec(),
        ),
    ]);
    materialize_local_repo(&ctx, &replacement, &map).unwrap();

    assert!(ctx.worktree_dir.join("posts/next.json").exists());
    assert!(!ctx.worktree_dir.join("posts/rec1.json").exists());
    assert!(ctx.scratch_dir.join("posts/schema.json").exists());
}

#[test]
fn materialize_local_repo_preserves_mtime_when_content_unchanged() {
    let tmp = TempDir::new().unwrap();
    let ctx = ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        worktree_dir: tmp.path().join("Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
        workspace_dir: tmp.path().to_path_buf(),
        bare_repo: tmp.path().join(".repos/conn.git"),
        db_path: tmp.path().join(".repos/conn.db"),
    };

    std::fs::create_dir_all(ctx.worktree_dir.join("posts")).unwrap();
    let unchanged_path = ctx.worktree_dir.join("posts/keep.json");
    let changed_path = ctx.worktree_dir.join("posts/edit.json");
    std::fs::write(&unchanged_path, b"{\"v\":1}").unwrap();
    std::fs::write(&changed_path, b"{\"v\":1}").unwrap();

    let current = read_worktree_files_and_scratch_state(&ctx).unwrap();
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
fn sync_schema_files_from_worktree_restores_missing_schema() {
    let tmp = TempDir::new().unwrap();
    let ctx = ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        worktree_dir: tmp.path().join("Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
        workspace_dir: tmp.path().to_path_buf(),
        bare_repo: tmp.path().join(".repos/conn.git"),
        db_path: tmp.path().join(".repos/conn.db"),
    };

    // Post-slice-F source: the worktree's tracked .scratch/, not the
    // deleted master worktree.
    std::fs::create_dir_all(ctx.worktree_dir.join(".scratch/posts")).unwrap();
    std::fs::write(
        ctx.worktree_dir.join(".scratch/posts/schema.json"),
        "{\"schema\":{\"fields\":[]}}",
    )
    .unwrap();

    sync_schema_files_from_worktree(&ctx).unwrap();

    assert_eq!(
        std::fs::read_to_string(ctx.scratch_dir.join("posts/schema.json")).unwrap(),
        "{\"schema\":{\"fields\":[]}}"
    );
}

// Slice F.5 removed `commit_file_map_to_dirty_ref` + `force_push_origin_dirty`
// + `run_force_upload`. The tests that exercised them (a
// `commit_file_map_to_dirty_ref` smoke + `git_push_force_overwrites_…`) went
// with the code. The local dirty branch is no longer something the CLI ever
// commits to or pushes.

#[test]
fn restore_deleted_record_paths_from_main_branch_drops_delete_entry_and_writes_main_blob() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);

    let file_path_to_contents_map_in_main_branch = HashMap::from([(
        "posts/restore.json".to_string(),
        b"{\"id\":\"restore\",\"name\":\"from-main\"}".to_vec(),
    )]);
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/main",
        None,
        &file_path_to_contents_map_in_main_branch,
        "main seed",
    )
    .unwrap();

    let ctx = make_connection_context(tmp.path(), &bare_repo);
    // Set up worktree_dir as a sparse worktree (no dirty ref yet; start from empty).
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/dirty",
        None,
        &HashMap::new(),
        "init dirty",
    )
    .unwrap();
    crate::git_ops::setup_sparse_worktree(&bare_repo, &ctx.worktree_dir, "refs/heads/dirty")
        .unwrap();

    // Seed an accepted Delete for the record to restore.
    {
        use crate::shared::accepted_patches::{save_atomic, AcceptedPatchesFile};
        use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
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

    restore_deleted_record_paths_from_main_branch(&ctx, &["posts/restore.json".to_string()])
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("posts/restore.json")).unwrap(),
        "{\"id\":\"restore\",\"name\":\"from-main\"}"
    );
    let file = load_accepted(&ctx);
    assert!(
        !file.patches.iter().any(|e| e.path == "posts/restore.json"),
        "Delete entry should have been removed"
    );
}

#[test]
fn restore_deleted_record_paths_from_main_branch_errors_when_entry_is_not_a_delete() {
    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);
    let file_path_to_contents_map_in_main_branch = HashMap::from([(
        "posts/restore.json".to_string(),
        b"{\"id\":\"restore\"}".to_vec(),
    )]);
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/main",
        None,
        &file_path_to_contents_map_in_main_branch,
        "main",
    )
    .unwrap();

    let ctx = make_connection_context(tmp.path(), &bare_repo);
    {
        use crate::shared::accepted_patches::{save_atomic, AcceptedPatchesFile};
        use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
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
        restore_deleted_record_paths_from_main_branch(&ctx, &["posts/restore.json".to_string()])
            .unwrap_err();
    assert!(err.to_string().contains("not an approved deleted record"));
}

#[test]
fn drop_create_patches_and_delete_working_files_for_record_paths_drops_create_entry_and_removes_worktree_file(
) {
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
    crate::git_ops::setup_sparse_worktree(&bare_repo, &ctx.worktree_dir, "refs/heads/dirty")
        .unwrap();

    // Working file exists; accepted-patches has the corresponding Create.
    write_file(
        &ctx.worktree_dir.join("posts/created.json"),
        "{\"id\":\"created\"}",
    );
    {
        use crate::shared::accepted_patches::{save_atomic, AcceptedPatchesFile};
        use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
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

    drop_create_patches_and_delete_working_files_for_record_paths(
        &ctx,
        &["posts/created.json".to_string()],
    )
    .unwrap();

    assert!(!ctx.worktree_dir.join("posts/created.json").exists());
    let file = load_accepted(&ctx);
    assert!(
        !file.patches.iter().any(|e| e.path == "posts/created.json"),
        "Create entry should have been removed"
    );
}

#[test]
fn drop_create_patches_and_delete_working_files_for_record_paths_errors_when_main_has_the_path() {
    let tmp = TempDir::new().unwrap();
    let bare_repo = tmp.path().join("repo.git");
    run_git(tmp.path(), &["init", "--bare", bare_repo.to_str().unwrap()]);
    // Main HAS the path — this is the "not a created record" failure case.
    let file_path_to_contents_map_in_main_branch = HashMap::from([(
        "posts/created.json".to_string(),
        b"{\"id\":\"created\"}".to_vec(),
    )]);
    crate::git_ops::commit_file_map_to_ref(
        &bare_repo,
        "refs/heads/main",
        None,
        &file_path_to_contents_map_in_main_branch,
        "main",
    )
    .unwrap();

    let ctx = make_connection_context(tmp.path(), &bare_repo);
    {
        use crate::shared::accepted_patches::{save_atomic, AcceptedPatchesFile};
        use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
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

    let err = drop_create_patches_and_delete_working_files_for_record_paths(
        &ctx,
        &["posts/created.json".to_string()],
    )
    .unwrap_err();
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
fn update_main_worktree_after_pull_returns_no_move_when_main_unchanged() {
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

    let result = update_main_worktree_after_pull(&ctx, "test-token").unwrap();
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
fn update_main_worktree_after_pull_returns_diff_when_main_advances() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let ctx = make_connection_context(tmp.path(), &fixture.local_bare);

    // Initial call is a no-op (main is already at origin/main from clone)
    // — still needed to materialize the worktree before the next reset.
    let initial = update_main_worktree_after_pull(&ctx, "test-token").unwrap();
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

    // `update_main_worktree_after_pull` no longer fetches (mr35 perf fix —
    // the production caller, `download_single_repo`, already fetched right
    // before). The unit test now does the fetch explicitly to reproduce
    // that contract. Uses the same `+refs/heads/*:refs/remotes/origin/*`
    // refspec `git_ops::fetch_origin` does — a bare clone's default refspec
    // is `refs/heads/*:refs/heads/*`, which would overwrite local main
    // directly and short-circuit the moved check.
    run_git(
        &ctx.bare_repo,
        &["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
    );

    let result = update_main_worktree_after_pull(&ctx, "test-token").unwrap();
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
    git_command().arg("--version").output().is_ok()
}

#[allow(dead_code)]
fn json_bytes(value: &str) -> Vec<u8> {
    value.as_bytes().to_vec()
}

fn empty_conn_ctx() -> ConnectionContext {
    ConnectionContext {
        connection_id: "conn_test".to_string(),
        conn_dir_name: "Conn".to_string(),
        worktree_dir: PathBuf::new(),
        scratch_dir: PathBuf::new(),
        workspace_dir: PathBuf::new(),
        bare_repo: PathBuf::new(),
        db_path: PathBuf::new(),
    }
}

mod field_helpers {
    use super::*;
    use crate::shared::accepted_patches::AcceptedPatchesFile;
    use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
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
/// connection context whose worktree_dir has been materialized from the dirty branch.
/// Seed `accepted-patches.json` so it carries the same approved-vs-published
/// delta the legacy fixture encoded as `dirty != main`. Tests written against
/// the pre-B model used `refs/heads/dirty` directly; the post-B model reads
/// from `accepted-patches.json`. Tests that previously relied on the
/// fixture's dirty/main divergence call this helper to translate that
/// state to an `accepted-patches.json` file before invoking the
/// function under test.
fn seed_accepted_patches_from_fixture(ctx: &ConnectionContext) {
    use crate::shared::accepted_patches::{save_atomic, AcceptedPatchesFile};
    use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
    use serde_json::Value as JsonValue;

    let file_path_to_contents_map_in_main_branch =
        read_main_branch_contents(&ctx.bare_repo).unwrap();
    let dirty_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")
        .unwrap()
        .expect("fixture must have refs/heads/dirty");
    let dirty_map = read_git_tree(&ctx.bare_repo, &dirty_hash).unwrap();

    let mut patches = Vec::new();
    let mut keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for k in file_path_to_contents_map_in_main_branch.keys() {
        keys.insert(k.clone());
    }
    for k in dirty_map.keys() {
        keys.insert(k.clone());
    }
    for path in keys {
        if !is_data_path_in_folder(&path, "") {
            continue;
        }
        let m = file_path_to_contents_map_in_main_branch.get(&path);
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
                let p = crate::shared::merge_patch::diff(&mv, &dv).unwrap();
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
    // Production creates worktree_dir as a sparse worktree (see
    // `materialize_dirty_checkout` in workspaces.rs); the reset-hard in
    // discard_all_unreviewed_changes_in_connection_repo requires that. Mirror it here.
    crate::git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.worktree_dir, "refs/heads/dirty")
        .unwrap();

    (tmp, ctx)
}

/// Load `accepted-patches.json` for a test ctx.
fn load_accepted(ctx: &ConnectionContext) -> crate::shared::accepted_patches::AcceptedPatchesFile {
    let layout = WorkspaceLayout::for_cli(&ctx.workspace_dir);
    let connection_dir = layout.connection_root_path(&ctx.conn_dir_name);
    crate::shared::accepted_patches::load(&connection_dir).unwrap()
}

#[test]
fn accept_all_unreviewed_changes_in_connection_repo_folder_accepts_only_target_folder() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Pending edits in both folders on top of the seeded "approved" state.
    write_file(
        &ctx.worktree_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );
    write_file(
        &ctx.worktree_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let result = accept_all_unreviewed_changes_in_connection_repo(
        &ctx,
        &ctx.workspace_dir.clone(),
        Some("posts"),
    )
    .unwrap();

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
        crate::shared::re_anchor::PatchKind::Update,
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
        std::fs::read_to_string(ctx.worktree_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"pending-p1\"}"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn accept_all_unreviewed_changes_in_connection_repo_folder_noop_when_folder_has_no_changes() {
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
        &ctx.worktree_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let pre = load_accepted(&ctx);
    let result = accept_all_unreviewed_changes_in_connection_repo(
        &ctx,
        &ctx.workspace_dir.clone(),
        Some("posts"),
    )
    .unwrap();

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
fn accept_all_unreviewed_changes_in_connection_repo_folder_handles_deletion_inside_folder() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Delete the scoped folder's file from the working tree.
    std::fs::remove_file(ctx.worktree_dir.join("posts/rec1.json")).unwrap();

    let result = accept_all_unreviewed_changes_in_connection_repo(
        &ctx,
        &ctx.workspace_dir.clone(),
        Some("posts"),
    )
    .unwrap();

    assert_eq!(result.files_accepted, 1);
    assert_eq!(result.accepted_paths, vec!["posts/rec1.json".to_string()]);

    let file = load_accepted(&ctx);
    let posts = file
        .patches
        .iter()
        .find(|e| e.path == "posts/rec1.json")
        .expect("posts entry should be replaced with a Delete");
    assert_eq!(posts.kind, crate::shared::re_anchor::PatchKind::Delete);
    assert!(
        file.patches.iter().any(|e| e.path == "articles/rec1.json"),
        "articles entry must remain untouched"
    );
}

#[test]
fn discard_all_unreviewed_changes_in_connection_repo_folder_reverts_only_target_folder() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Pending edits in both folders on top of the seeded approved state.
    write_file(
        &ctx.worktree_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );
    write_file(
        &ctx.worktree_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let result = discard_all_unreviewed_changes_in_connection_repo(
        &ctx,
        &ctx.workspace_dir.clone(),
        Some("posts"),
    )
    .unwrap();

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
        std::fs::read_to_string(ctx.worktree_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
    // Worktree for the other folder must retain its pending edit — a scoped
    // discard must not wipe unrelated working-tree changes.
    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn discard_all_unreviewed_changes_in_connection_repo_folder_noop_when_folder_clean() {
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
    let commit_hash = crate::git_ops::commit_file_map_to_ref(
        &ctx.bare_repo,
        "refs/heads/dirty",
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
        &ctx.worktree_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let result = discard_all_unreviewed_changes_in_connection_repo(
        &ctx,
        &ctx.workspace_dir.clone(),
        Some("posts"),
    )
    .unwrap();

    assert!(!result.skipped_missing_main);
    assert_eq!(result.files_discarded, 0);
    assert!(result.discarded_paths.is_empty());
    assert_eq!(
        load_accepted(&ctx),
        pre,
        "accepted-patches should be unchanged when target folder is clean"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn discard_record_paths_in_connection_repo_reverts_only_listed_paths() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, ctx) = create_multi_folder_fixture();
    seed_accepted_patches_from_fixture(&ctx);

    // Pending working-tree edits in both folders on top of the approved
    // patches already seeded into accepted-patches.json.
    write_file(
        &ctx.worktree_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );
    write_file(
        &ctx.worktree_dir.join("articles/rec1.json"),
        "{\"v\":\"pending-a1\"}",
    );

    let rel = vec!["posts/rec1.json".to_string()];
    let input_map: HashMap<&str, &str> =
        HashMap::from([("posts/rec1.json", "Conn/posts/rec1.json")]);

    let result = discard_record_paths_in_connection_repo(&ctx, &rel, &input_map).unwrap();

    assert!(!result.skipped_missing_main);
    assert_eq!(result.files_discarded, 1);
    assert_eq!(result.discarded_paths, vec!["posts/rec1.json".to_string()]);

    // accepted-patches.json: posts entry dropped, articles entry kept.
    let connection_dir =
        WorkspaceLayout::for_cli(&ctx.workspace_dir).connection_root_path(&ctx.conn_dir_name);
    let file = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(file.patches.len(), 1, "only articles entry should remain");
    assert_eq!(file.patches[0].path, "articles/rec1.json");

    // Worktree: listed path matches main; unlisted path keeps its pending edit.
    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("articles/rec1.json")).unwrap(),
        "{\"v\":\"pending-a1\"}"
    );
}

#[test]
fn discard_record_paths_in_connection_repo_reverts_path_with_only_unapproved_change() {
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
    let new_dirty = crate::git_ops::commit_file_map_to_ref(
        &ctx.bare_repo,
        "refs/heads/dirty",
        Some(dirty_hash.as_str()),
        &realigned,
        "realign posts to main",
    )
    .unwrap();
    // Refresh the worktree so the pending edit below is the only diff on posts.
    crate::git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.worktree_dir, &new_dirty).unwrap();

    write_file(
        &ctx.worktree_dir.join("posts/rec1.json"),
        "{\"v\":\"pending-p1\"}",
    );

    let rel = vec!["posts/rec1.json".to_string()];
    let input_map: HashMap<&str, &str> =
        HashMap::from([("posts/rec1.json", "Conn/posts/rec1.json")]);

    let result = discard_record_paths_in_connection_repo(&ctx, &rel, &input_map).unwrap();

    assert_eq!(result.files_discarded, 1);
    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
}

#[test]
fn discard_record_paths_in_connection_repo_reverts_path_with_only_approved_change() {
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

    let result = discard_record_paths_in_connection_repo(&ctx, &rel, &input_map).unwrap();

    assert_eq!(result.files_discarded, 1);
    let connection_dir =
        WorkspaceLayout::for_cli(&ctx.workspace_dir).connection_root_path(&ctx.conn_dir_name);
    let file = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert!(
        !file.patches.iter().any(|e| e.path == "posts/rec1.json"),
        "posts entry should be removed"
    );
    assert_eq!(
        std::fs::read_to_string(ctx.worktree_dir.join("posts/rec1.json")).unwrap(),
        "{\"v\":\"main-p1\"}"
    );
}

#[test]
fn discard_record_paths_in_connection_repo_errors_when_path_has_no_changes() {
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
    let commit_hash = crate::git_ops::commit_file_map_to_ref(
        &ctx.bare_repo,
        "refs/heads/dirty",
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

    let err = discard_record_paths_in_connection_repo(&ctx, &rel, &input_map).unwrap_err();
    assert!(
        err.to_string().contains("No local changes to discard"),
        "unexpected error message: {err}"
    );
}

#[test]
fn discard_record_paths_in_connection_repo_skips_when_main_missing() {
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

    let result = discard_record_paths_in_connection_repo(&ctx, &rel, &input_map).unwrap();
    assert!(result.skipped_missing_main);
    assert_eq!(result.files_discarded, 0);
}

fn run_git(dir: &Path, args: &[&str]) {
    let output = git_command().current_dir(dir).args(args).output().unwrap();
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
// Pre-Slice-F the working tree happens to live in `ctx.worktree_dir`, but D
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
    let accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: vec![crate::shared::re_anchor::AnchoredPatch {
            path: "posts/rec_acme.json".to_string(),
            kind: crate::shared::re_anchor::PatchKind::Update,
            patch: serde_json::json!({"industry": "SaaS"}),
        }],
    };
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();
    write_file(
        &ctx.worktree_dir.join("posts/rec_acme.json"),
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
    let reloaded = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(reloaded.patches.len(), 1);
    assert_eq!(
        reloaded.patches[0].patch,
        serde_json::json!({"industry": "SaaS"})
    );

    // Working file = apply(new_main_blob, patch): server's name rename
    // surfaces; the user's industry edit replays on top.
    let working: serde_json::Value = serde_json::from_slice(
        &std::fs::read(ctx.worktree_dir.join("posts/rec_acme.json")).unwrap(),
    )
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
    let accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: vec![crate::shared::re_anchor::AnchoredPatch {
            path: "posts/rec_acme.json".to_string(),
            kind: crate::shared::re_anchor::PatchKind::Update,
            patch: serde_json::json!({"industry": "SaaS"}),
        }],
    };
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();
    write_file(
        &ctx.worktree_dir.join("posts/rec_acme.json"),
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
    let reloaded = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(
        reloaded.patches[0].patch,
        serde_json::json!({"industry": "SaaS"})
    );
    let working: serde_json::Value = serde_json::from_slice(
        &std::fs::read(ctx.worktree_dir.join("posts/rec_acme.json")).unwrap(),
    )
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

// ---------------------------------------------------------------------------
// DEV-10175 — `reconcile_accepted_after_publish` keeps patches whose connector
// batch failed silently and drops ones that genuinely landed in `main`.
// Replaces the prior unconditional `clear` that erased the patch file
// regardless of connector-level outcome.
// ---------------------------------------------------------------------------

#[test]
fn reconcile_keeps_patch_when_server_main_did_not_advance() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    // Seed: main has Acme with industry=Tech. User accepted industry → SaaS.
    seed_main_with_record(
        &fixture,
        &ctx,
        "posts/rec_acme.json",
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"Tech\"\n}\n",
    );
    let connection_dir = accepted_patches_dir(&ctx);
    let accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: vec![crate::shared::re_anchor::AnchoredPatch {
            path: "posts/rec_acme.json".to_string(),
            kind: crate::shared::re_anchor::PatchKind::Update,
            patch: serde_json::json!({"industry": "SaaS"}),
        }],
    };
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();

    // Connector batch failed → server's main did NOT advance.
    reconcile_accepted_after_publish(&ctx, &workspace_dir, "test-token").unwrap();

    // Patch must still be there for the next publish attempt.
    let reloaded = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(
        reloaded.patches.len(),
        1,
        "patch must survive failed publish"
    );
    assert_eq!(
        reloaded.patches[0].patch,
        serde_json::json!({"industry": "SaaS"})
    );
    assert!(!workspace_dir.join(".scratch/conflicts.log").exists());
}

#[test]
fn reconcile_drops_patch_when_server_published_the_change() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    // Seed: main has Acme with industry=Tech. User accepted industry → SaaS.
    seed_main_with_record(
        &fixture,
        &ctx,
        "posts/rec_acme.json",
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"Tech\"\n}\n",
    );
    let connection_dir = accepted_patches_dir(&ctx);
    let accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: vec![crate::shared::re_anchor::AnchoredPatch {
            path: "posts/rec_acme.json".to_string(),
            kind: crate::shared::re_anchor::PatchKind::Update,
            patch: serde_json::json!({"industry": "SaaS"}),
        }],
    };
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();

    // Server committed the user's edit verbatim — new main blob has
    // industry=SaaS. Re-anchor's no-op detection should drop the patch.
    advance_remote_main(
        &fixture,
        "posts/rec_acme.json",
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}\n",
        "publish lands user's edit",
    );

    reconcile_accepted_after_publish(&ctx, &workspace_dir, "test-token").unwrap();

    let reloaded = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert!(
        reloaded.patches.is_empty(),
        "patch must drop after publish lands"
    );
    // Local main advanced to match origin.
    let local_main = git_rev_parse(&ctx.bare_repo, "refs/heads/main").unwrap();
    let origin_main = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/main").unwrap();
    assert_eq!(local_main, origin_main);
    assert!(!workspace_dir.join(".scratch/conflicts.log").exists());
}

#[test]
fn reconcile_keeps_failed_record_when_partial_publish_succeeded() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    // Seed: two records on main.
    seed_main_with_record(&fixture, &ctx, "posts/rec_a.json", "{\n  \"v\": 1\n}\n");
    seed_main_with_record(&fixture, &ctx, "posts/rec_b.json", "{\n  \"v\": 1\n}\n");

    // User accepted both → v: 2.
    let connection_dir = accepted_patches_dir(&ctx);
    let accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: vec![
            crate::shared::re_anchor::AnchoredPatch {
                path: "posts/rec_a.json".to_string(),
                kind: crate::shared::re_anchor::PatchKind::Update,
                patch: serde_json::json!({"v": 2}),
            },
            crate::shared::re_anchor::AnchoredPatch {
                path: "posts/rec_b.json".to_string(),
                kind: crate::shared::re_anchor::PatchKind::Update,
                patch: serde_json::json!({"v": 2}),
            },
        ],
    };
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();

    // Connector succeeded for A, failed for B → only A lands on main.
    advance_remote_main(
        &fixture,
        "posts/rec_a.json",
        "{\n  \"v\": 2\n}\n",
        "publish lands A",
    );

    reconcile_accepted_after_publish(&ctx, &workspace_dir, "test-token").unwrap();

    let reloaded = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(
        reloaded.patches.len(),
        1,
        "B's patch must survive partial publish"
    );
    assert_eq!(reloaded.patches[0].path, "posts/rec_b.json");
    assert_eq!(reloaded.patches[0].patch, serde_json::json!({"v": 2}));
}

mod discard_field_helper {
    use super::super::*;
    use crate::shared::accepted_patches::AcceptedPatchesFile;
    use crate::shared::re_anchor::{AnchoredPatch, PatchKind};
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
        // happen via the returned next_file_path_to_contents_map_in_worktree, not on disk.
        ConnectionContext {
            connection_id: "ca_test".into(),
            conn_dir_name: "HubSpot".into(),
            worktree_dir: tmp.path().to_path_buf(),
            scratch_dir: tmp.path().to_path_buf(),
            workspace_dir: tmp.path().to_path_buf(),
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

// ---------------------------------------------------------------------------
// Slice H.1.5 — public entry-point tests. Exercises the I/O-bundling
// `accept_field` / `drop_approved_field_and_restore_to_main_value` /
// `restore_record_from_main_after_dropping_delete_patch` /
// `drop_create_patch_and_delete_working_file` paths end-to-end against a
// real workspace + bare repo. The folder-scoped helpers
// (`accept_field_in_folder` etc.) have their own tests above; this block
// focuses on the per-record wrappers napi calls.
// ---------------------------------------------------------------------------

mod entry_points {
    use super::*;
    use crate::shared::accepted_patches::AcceptedPatchesFile;
    use crate::shared::layout::WorkspaceLayout;
    use crate::shared::re_anchor::PatchKind;
    use crate::shared::review_ops::{
        accept_field, drop_approved_field_and_restore_to_main_value,
        drop_create_patch_and_delete_working_file,
        restore_record_from_main_after_dropping_delete_patch, LockMode, ReviewOpEffect,
        ReviewOpError,
    };
    use serde_json::json;
    use std::io::Write;

    const CONN: &str = "HubSpot";
    const REPO_ID: &str = "conn1";

    struct EpFixture {
        _tmp: TempDir,
        workspace_dir: PathBuf,
        bare_repo: PathBuf,
        source_dir: PathBuf,
        connection_dir: PathBuf,
    }

    /// Build a workspace at <tmp>/ with one connection ("HubSpot") whose
    /// bare repo lives at <workspace>/.repos/conn1.git/ (matching the layout
    /// `WorkspaceLayout::for_cli(_).bare_repo_path("conn1")` resolves). Writes
    /// the `.scratchmd` workspace marker so `resolve_connection_paths` can
    /// find the connection.
    fn make_fixture() -> EpFixture {
        let tmp = TempDir::new().unwrap();
        let workspace_dir = tmp.path().to_path_buf();

        let layout = WorkspaceLayout::for_cli(&workspace_dir);
        let bare_repo = layout.bare_repo_path(REPO_ID);
        let scratch_root = layout.scratch_root();
        let source_dir = tmp.path().join("source");

        std::fs::create_dir_all(&scratch_root).unwrap();
        std::fs::create_dir_all(bare_repo.parent().unwrap()).unwrap();

        run_git(tmp.path(), &["init", "source"]);
        run_git(&source_dir, &["checkout", "-b", "main"]);
        // Need at least one commit on main so refs/heads/main resolves.
        std::fs::create_dir_all(source_dir.join(".scratch")).unwrap();
        std::fs::write(source_dir.join(".scratch/seed"), b"init").unwrap();
        commit_all(&source_dir, "init main");

        run_git(
            tmp.path(),
            &[
                "clone",
                "--bare",
                source_dir.to_str().unwrap(),
                bare_repo.to_str().unwrap(),
            ],
        );

        let marker = format!(
            "version: \"3\"\nworkbook:\n  id: wkb_test\n  name: Test\n  orgId: org_test\n  serverUrl: http://localhost\n  initializedAt: 2026-01-01T00:00:00Z\nconnections:\n  - id: conn_test\n    displayName: HubSpot\n    service: AIRTABLE\n    repoPath: {}\n    dirName: {}\n",
            REPO_ID, CONN,
        );
        std::fs::write(scratch_root.join(".scratchmd"), marker).unwrap();

        let connection_dir = layout.connection_root_path(CONN);
        std::fs::create_dir_all(&connection_dir).unwrap();

        EpFixture {
            _tmp: tmp,
            workspace_dir,
            bare_repo,
            source_dir,
            connection_dir,
        }
    }

    fn seed_main(fx: &EpFixture, rel_path: &str, content: &str) {
        write_file(&fx.source_dir.join(rel_path), content);
        commit_all(&fx.source_dir, &format!("seed {rel_path}"));
        run_git(
            &fx.bare_repo,
            &[
                "--git-dir",
                fx.bare_repo.to_str().unwrap(),
                "fetch",
                fx.source_dir.to_str().unwrap(),
                "main:main",
            ],
        );
    }

    fn load_patches(fx: &EpFixture) -> AcceptedPatchesFile {
        crate::shared::accepted_patches::load(&fx.connection_dir).unwrap()
    }

    /// Write a working-file record (under `<workspace>/<CONN>/<rel_path>`) so
    /// `accept_field` has something to read. `accept_field` is now disk-as-truth:
    /// the field's value is whatever the working file says it is when the
    /// entry point is called.
    fn write_working(fx: &EpFixture, rel_path: &str, content: &str) {
        let path = fx.workspace_dir.join(CONN).join(rel_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn accept_field_round_trip_persists_patch_file() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        seed_main(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\",\n  \"industry\": \"Other\"\n}\n",
        );
        // The new accept_field reads the field value from the working file —
        // caller (the desktop, or the CLI) is responsible for writing it
        // first.
        write_working(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}\n",
        );

        let result = accept_field(
            &fx.workspace_dir,
            CONN,
            "Companies/rec_acme.json",
            "industry",
            LockMode::DefaultBlocking,
        )
        .unwrap();

        assert!(result.patches_changed);
        assert!(!result.working_changed);
        assert_eq!(result.effect, ReviewOpEffect::PatchUpserted);
        assert_eq!(result.workspace_path, "HubSpot/Companies/rec_acme.json");

        let file = load_patches(&fx);
        assert_eq!(file.patches.len(), 1);
        let entry = &file.patches[0];
        assert_eq!(entry.path, "Companies/rec_acme.json");
        assert_eq!(entry.kind, PatchKind::Update);
        assert_eq!(entry.patch, json!({"industry": "SaaS"}));
    }

    #[test]
    fn accept_field_returns_lock_busy_when_held() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        seed_main(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\"\n}\n",
        );
        write_working(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}\n",
        );

        // Mimic another live process holding the lock by writing the lock file
        // with the current PID. workspace_lock checks liveness via kill(0).
        let lock_path = fx.workspace_dir.join(".scratch/lock");
        std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        writeln!(f, "{}", std::process::id()).unwrap();
        drop(f);

        let err = accept_field(
            &fx.workspace_dir,
            CONN,
            "Companies/rec_acme.json",
            "industry",
            LockMode::ShortWait,
        )
        .unwrap_err();
        match err {
            ReviewOpError::LockBusy { pid, .. } => {
                assert_eq!(pid, std::process::id());
            }
            other => panic!("expected LockBusy, got {other:?}"),
        }

        // Cleanup so the TempDir drop succeeds.
        let _ = std::fs::remove_file(&lock_path);
    }

    #[test]
    fn discard_field_drops_patch_entry_when_empty() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        seed_main(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\",\n  \"industry\": \"Other\"\n}\n",
        );
        write_working(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}\n",
        );

        // First accept a single-field change so the entry exists.
        accept_field(
            &fx.workspace_dir,
            CONN,
            "Companies/rec_acme.json",
            "industry",
            LockMode::DefaultBlocking,
        )
        .unwrap();
        assert_eq!(load_patches(&fx).patches.len(), 1);

        // Now discard that same field — entry should disappear since it
        // only held the one key.
        let result = drop_approved_field_and_restore_to_main_value(
            &fx.workspace_dir,
            CONN,
            "Companies/rec_acme.json",
            "industry",
            LockMode::DefaultBlocking,
        )
        .unwrap();
        assert!(result.patches_changed);
        assert!(matches!(result.effect, ReviewOpEffect::PatchDropped));
        assert!(load_patches(&fx).patches.is_empty());
    }

    #[test]
    fn restore_deleted_record_errors_on_non_delete_entry() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        seed_main(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\"\n}\n",
        );
        // Seed an Update entry, not a Delete.
        let file = AcceptedPatchesFile {
            patches: vec![crate::shared::re_anchor::AnchoredPatch {
                path: "Companies/rec_acme.json".into(),
                kind: PatchKind::Update,
                patch: json!({"industry": "SaaS"}),
            }],
        };
        crate::shared::accepted_patches::save_atomic(&fx.connection_dir, &file).unwrap();

        let err = restore_record_from_main_after_dropping_delete_patch(
            &fx.workspace_dir,
            CONN,
            "Companies/rec_acme.json",
            LockMode::DefaultBlocking,
        )
        .unwrap_err();
        assert!(matches!(err, ReviewOpError::NotAnApprovedDelete(_)));
    }

    #[test]
    fn discard_created_record_errors_when_main_has_path() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        // The record exists on main; can\u2019t be a "Create" lifecycle.
        seed_main(
            &fx,
            "Companies/rec_acme.json",
            "{\n  \"name\": \"Acme\"\n}\n",
        );
        let file = AcceptedPatchesFile {
            patches: vec![crate::shared::re_anchor::AnchoredPatch {
                path: "Companies/rec_acme.json".into(),
                kind: PatchKind::Create,
                patch: json!({"name": "Acme"}),
            }],
        };
        crate::shared::accepted_patches::save_atomic(&fx.connection_dir, &file).unwrap();

        let err = drop_create_patch_and_delete_working_file(
            &fx.workspace_dir,
            CONN,
            "Companies/rec_acme.json",
            LockMode::DefaultBlocking,
        )
        .unwrap_err();
        assert!(matches!(err, ReviewOpError::CreateClashesWithMain(_)));
    }

    // ── list_folder_filenames (D5: filename-only enumerator) ──────────────────

    fn write_patch_file(fx: &EpFixture, patches: serde_json::Value) {
        let body = serde_json::json!({ "patches": patches });
        std::fs::write(
            fx.connection_dir.join("accepted-patches.json"),
            serde_json::to_string_pretty(&body).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn list_folder_filenames_returns_main_union_with_accepted_patches() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        seed_main(&fx, "Companies/rec_acme.json", "{\"name\":\"Acme\"}\n");
        seed_main(&fx, "Companies/rec_widget.json", "{\"name\":\"Widget\"}\n");
        write_patch_file(
            &fx,
            serde_json::json!([
                { "path": "Companies/rec_new.json",    "kind": "create", "patch": { "name": "New Co" } },
                { "path": "Companies/rec_acme.json",   "kind": "update", "patch": { "industry": "SaaS" } },
                { "path": "Companies/rec_widget.json", "kind": "delete", "patch": null },
            ]),
        );

        let names =
            crate::shared::review_ops::list_folder_filenames(&fx.workspace_dir, CONN, "Companies")
                .unwrap();
        // Sorted, union of main + Create entries (Update/Delete on existing
        // main paths don't add new filenames; Create adds rec_new.json).
        assert_eq!(
            names,
            vec![
                "rec_acme.json".to_string(),
                "rec_new.json".to_string(),
                "rec_widget.json".to_string(),
            ]
        );
    }

    #[test]
    fn list_folder_filenames_is_non_recursive() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        seed_main(&fx, "Companies/rec_top.json", "{}\n");
        seed_main(&fx, "Companies/nested/rec_deep.json", "{}\n");
        write_patch_file(
            &fx,
            serde_json::json!([
                { "path": "Companies/nested/rec_patch.json", "kind": "create", "patch": { "x": 1 } },
            ]),
        );

        let top =
            crate::shared::review_ops::list_folder_filenames(&fx.workspace_dir, CONN, "Companies")
                .unwrap();
        assert_eq!(top, vec!["rec_top.json".to_string()]);

        let nested = crate::shared::review_ops::list_folder_filenames(
            &fx.workspace_dir,
            CONN,
            "Companies/nested",
        )
        .unwrap();
        assert_eq!(
            nested,
            vec!["rec_deep.json".to_string(), "rec_patch.json".to_string()]
        );
    }

    #[test]
    fn list_folder_filenames_empty_folder_returns_empty_vec() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();
        // No seeded files. The fixture's bare repo only has the `.scratch/seed`
        // marker which is excluded by `is_data_path_in_folder`.
        let names =
            crate::shared::review_ops::list_folder_filenames(&fx.workspace_dir, CONN, "Companies")
                .unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn list_folder_filenames_errors_on_unknown_connection() {
        let fx = make_fixture();
        let err = crate::shared::review_ops::list_folder_filenames(
            &fx.workspace_dir,
            "NonExistentConn",
            "Companies",
        )
        .unwrap_err();
        assert!(matches!(err, ReviewOpError::UnknownConnection(_)));
    }

    // C1 — verify the CLI dispatchers (accept/reject/discard/restore/…) hold
    // the workspace lock for the duration of their work. The lock library is
    // well-covered by its own tests; this asserts the dispatcher actually
    // calls into it (rather than skipping locking entirely).
    //
    // Mechanism: pre-write a garbage lockfile. `workspace_lock::acquire` treats
    // an unreadable owner PID as a stale lock and reclaims it; if the
    // dispatcher reaches the acquire call, the garbage lockfile gets replaced
    // by one owned by this PID, then dropped on return — leaving no lockfile.
    // If the dispatcher never acquires, the garbage file remains.
    #[test]
    fn run_restore_deleted_record_acquires_and_releases_workspace_lock() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let fx = make_fixture();

        let lock_path = fx.workspace_dir.join(".scratch/lock");
        std::fs::write(&lock_path, b"not-a-pid\n").unwrap();
        assert!(lock_path.exists());

        // Empty input_paths is a no-op past the lock acquire — by_conn empty,
        // for-loop runs zero times, reindex short-circuits. The lock is what
        // we're testing, not the work.
        super::super::run_restore_deleted_record(
            &fx.workspace_dir,
            "http://localhost",
            &[],
            /*json=*/ true,
        )
        .expect("dispatcher should succeed with empty input");

        assert!(
            !lock_path.exists(),
            "lock guard's Drop should have removed the lockfile",
        );
    }
}

// ---------------------------------------------------------------------------
// Slice F.1 — refuse to operate on pre-slice-F workspace layouts. The
// `WorkspaceLayout::detect_old_layout` unit tests live in `shared/layout.rs`;
// these cover the CLI-side wiring that bails when detection fires.
// ---------------------------------------------------------------------------

mod workspace_layout_check {
    use super::super::{check_workspace_layout_or_bail, markers};
    use super::workspace_marker;
    use crate::shared::layout::WorkspaceLayout;
    use tempfile::TempDir;

    fn marker_with_one_conn() -> markers::WorkspaceMarker {
        workspace_marker(&[("HubSpot", "org/wkb/conn")])
    }

    #[test]
    fn passes_on_fresh_new_layout() {
        let tmp = TempDir::new().unwrap();
        let marker = marker_with_one_conn();
        // Nothing planted — neither the master worktree nor a sparse-checkout
        // config exists.
        check_workspace_layout_or_bail(tmp.path(), &marker, /*json=*/ false).unwrap();
    }

    /// Helper: build the legacy pre-slice-F master worktree path inline since
    /// `WorkspaceLayout::master_worktree_path` is gone post-F.3.
    fn legacy_master_worktree(workspace: &std::path::Path, conn: &str) -> std::path::PathBuf {
        workspace
            .join(".scratch")
            .join("connections")
            .join("master")
            .join(conn)
    }

    #[test]
    fn bails_when_master_worktree_present() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(legacy_master_worktree(tmp.path(), "HubSpot")).unwrap();
        let marker = marker_with_one_conn();

        let err = check_workspace_layout_or_bail(tmp.path(), &marker, /*json=*/ true)
            .expect_err("expected check to bail on pre-F layout");
        assert!(
            err.to_string().contains("reinitialized"),
            "error message should mention reinitialized, got: {err}"
        );
    }

    #[test]
    fn bails_when_sparse_checkout_config_present() {
        let tmp = TempDir::new().unwrap();
        let layout = WorkspaceLayout::for_cli(tmp.path());
        let info = layout.worktree_path("HubSpot").join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("sparse-checkout"), "/*\n!.scratch/\n").unwrap();
        let marker = marker_with_one_conn();

        let err = check_workspace_layout_or_bail(tmp.path(), &marker, /*json=*/ false)
            .expect_err("expected check to bail on pre-F sparse-checkout");
        assert!(err.to_string().contains("reinitialized"));
    }

    #[test]
    fn bails_only_when_a_listed_connection_has_artifacts() {
        // The detection scans connection dir_names from the marker — a stray
        // master directory for a connection not in the marker should NOT
        // trigger the refusal (the user may have manually wiped that conn).
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(legacy_master_worktree(tmp.path(), "OldUnrelatedConn")).unwrap();
        let marker = marker_with_one_conn();

        check_workspace_layout_or_bail(tmp.path(), &marker, /*json=*/ false).unwrap();
    }
}

// ---------------------------------------------------------------------------
// `refresh_workbook_for_contexts` — programmatic refresh path used by linked
// CLI commands after a server-side mutation. Asserts the new lock + pre-flight
// behavior added on mr28: skip-and-warn when any worktree edits are
// unreviewed; otherwise advance local main + materialize blobs.
//
// Uses a custom inline fixture (rather than `create_bare_fixture`) because
// the latter seeds `syncs/a.json` on main, which `load_worktree_into_path_contents_map` filters
// out of worktree reads while `read_main_branch_contents` includes it from git — a
// known asymmetry that would spuriously trip pre-flight here.
// ---------------------------------------------------------------------------

struct RefreshFixture {
    _tmp: TempDir,
    source_dir: PathBuf,
    remote_bare: PathBuf,
    local_bare: PathBuf,
}

fn create_refresh_fixture() -> RefreshFixture {
    let tmp = TempDir::new().unwrap();
    let source_dir = tmp.path().join("source");
    let remote_bare = tmp.path().join("remote.git");
    let local_bare = tmp.path().join("local.git");

    run_git(tmp.path(), &["init", "source"]);
    run_git(&source_dir, &["checkout", "-b", "main"]);
    write_file(
        &source_dir.join("posts/seed.json"),
        "{\n  \"name\": \"Seed\"\n}\n",
    );
    commit_all(&source_dir, "seed main");

    run_git(tmp.path(), &["init", "--bare", "remote.git"]);
    run_git(
        &source_dir,
        &["remote", "add", "origin", remote_bare.to_str().unwrap()],
    );
    run_git(&source_dir, &["push", "origin", "main:main"]);

    run_git(
        tmp.path(),
        &[
            "clone",
            "--bare",
            remote_bare.to_str().unwrap(),
            local_bare.to_str().unwrap(),
        ],
    );

    RefreshFixture {
        _tmp: tmp,
        source_dir,
        remote_bare: remote_bare.clone(),
        local_bare,
    }
}

fn refresh_advance_remote(fixture: &RefreshFixture, rel_path: &str, content: &str, msg: &str) {
    run_git(&fixture.source_dir, &["checkout", "main"]);
    write_file(&fixture.source_dir.join(rel_path), content);
    commit_all(&fixture.source_dir, msg);
    run_git(&fixture.source_dir, &["push", "origin", "main:main"]);
    let _ = &fixture.remote_bare;
}

/// Materialize a non-sparse worktree of `main` at `ctx.worktree_dir`,
/// mirroring what F.2.b's `setup_connection` does in production. Tests for
/// the gix::status-backed pre-flight (post-mr35) need a real `.git` link
/// file; the prior slow tree-walk pre-flight worked off the bare repo only.
fn add_test_worktree(ctx: &ConnectionContext) {
    if let Some(parent) = ctx.worktree_dir.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    run_git(
        &ctx.bare_repo,
        &[
            "worktree",
            "add",
            "--no-checkout",
            ctx.worktree_dir.to_str().unwrap(),
            "main",
        ],
    );
    run_git(&ctx.worktree_dir, &["checkout", "main", "--", "."]);
}

#[test]
fn refresh_workbook_skips_when_any_field_is_unreviewed() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_refresh_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);
    add_test_worktree(&ctx);

    // Worktree starts in sync with main (added by `add_test_worktree`),
    // then the user types an unreviewed edit (local != approved == published).
    let unreviewed_content = "{\n  \"name\": \"User-typing\"\n}\n";
    write_file(
        &ctx.worktree_dir.join("posts/seed.json"),
        unreviewed_content,
    );

    // Server independently advances main while the user has unreviewed work.
    refresh_advance_remote(
        &fixture,
        "posts/other.json",
        "{\n  \"name\": \"Server-added\"\n}\n",
        "server adds other",
    );

    let local_main_before = git_rev_parse(&ctx.bare_repo, "refs/heads/main").unwrap();
    let folders: HashMap<String, Vec<DataFolder>> = HashMap::new();
    refresh_workbook_for_contexts(&workspace_dir, &[ctx.clone()], &folders, "test-token").unwrap();

    // Worktree untouched — user's in-flight typing preserved.
    let working = std::fs::read_to_string(ctx.worktree_dir.join("posts/seed.json")).unwrap();
    assert_eq!(
        working, unreviewed_content,
        "worktree must not be overwritten when unreviewed edits exist"
    );
    // Server's new file was NOT materialized.
    assert!(
        !ctx.worktree_dir.join("posts/other.json").exists(),
        "server-side changes must not be materialized when blocked"
    );
    // Local main unchanged.
    let local_main_after = git_rev_parse(&ctx.bare_repo, "refs/heads/main").unwrap();
    assert_eq!(
        local_main_before, local_main_after,
        "refresh must not advance refs/heads/main when blocked"
    );
}

#[test]
fn refresh_workbook_advances_main_when_clean() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_refresh_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);
    add_test_worktree(&ctx);

    // Worktree starts in sync with main (added by `add_test_worktree`):
    // local == approved == published.

    // Server advances main.
    refresh_advance_remote(
        &fixture,
        "posts/seed.json",
        "{\n  \"name\": \"After server\"\n}\n",
        "server change",
    );

    let folders: HashMap<String, Vec<DataFolder>> = HashMap::new();
    refresh_workbook_for_contexts(&workspace_dir, &[ctx.clone()], &folders, "test-token").unwrap();

    // Local main advanced.
    let local_main = git_rev_parse(&ctx.bare_repo, "refs/heads/main").unwrap();
    let origin_main = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/main").unwrap();
    assert_eq!(local_main, origin_main, "local main must advance to origin");

    // Worktree materialized with the new server content.
    let working = std::fs::read_to_string(ctx.worktree_dir.join("posts/seed.json")).unwrap();
    assert!(
        working.contains("After server"),
        "worktree must reflect new server content, got: {working}"
    );
}

// ---------------------------------------------------------------------------
// F8 — multi-connection publish atomicity: `print_publish_results` JSON shape
// must distinguish failed connections from succeeded ones, expose a `partial`
// status when both occur, and carry the per-connection phase/message so the
// desktop modal can render an actionable row per failure. Also locks the
// legacy `publishedConnections` + `skippedNoDiff` fields that
// `scratch-cli-tests/tests/publish.spec.ts` still asserts on.
// F9 — `PublishedWithReconcileWarning` is rendered as `status: "published"`
// with a sibling `warning.phase = "reconcile"` so a post-publish fetch
// failure doesn't flip the overall publish into "failed".
// ---------------------------------------------------------------------------

mod publish_results_formatting {
    use super::super::{print_publish_results, publish_outcome_to_json, PublishConnectionOutcome};

    fn parse_json_output(outcomes: &[PublishConnectionOutcome]) -> serde_json::Value {
        // print_publish_results writes to stdout; we can't capture that without
        // forking the process. Mirror its JSON branch via publish_outcome_to_json
        // — the shape is what we care about.
        let connections: Vec<serde_json::Value> =
            outcomes.iter().map(publish_outcome_to_json).collect();
        serde_json::json!({ "connections": connections })
    }

    #[test]
    fn all_succeeded_outputs_published_status() {
        let outcomes = vec![
            PublishConnectionOutcome::Published { name: "A".into() },
            PublishConnectionOutcome::NoDiff { name: "B".into() },
        ];
        // Tolerates the human path running on stdout (printed during cargo test).
        print_publish_results(&outcomes, 100, false).unwrap();
        print_publish_results(&outcomes, 100, true).unwrap();
        let json = parse_json_output(&outcomes);
        assert_eq!(json["connections"][0]["status"], "published");
        assert_eq!(json["connections"][1]["status"], "no_diff");
    }

    #[test]
    fn partial_failure_carries_phase_and_message() {
        let outcomes = vec![
            PublishConnectionOutcome::Published {
                name: "Airtable".into(),
            },
            PublishConnectionOutcome::Failed {
                name: "Stripe".into(),
                phase: "run-job",
                message: "Job failed: connector 401".into(),
            },
        ];
        let json = parse_json_output(&outcomes);
        assert_eq!(json["connections"][1]["status"], "failed");
        assert_eq!(json["connections"][1]["phase"], "run-job");
        assert!(json["connections"][1]["message"]
            .as_str()
            .unwrap()
            .contains("401"));
    }

    #[test]
    fn reconcile_warning_keeps_status_published() {
        let outcomes = vec![PublishConnectionOutcome::PublishedWithReconcileWarning {
            name: "HubSpot".into(),
            warning: "post-publish refresh failed: fetch_origin: network unreachable".into(),
        }];
        let json = parse_json_output(&outcomes);
        // F9: a reconcile failure must NOT degrade the publish to "failed".
        assert_eq!(json["connections"][0]["status"], "published");
        assert_eq!(json["connections"][0]["warning"]["phase"], "reconcile");
        assert!(json["connections"][0]["warning"]["message"]
            .as_str()
            .unwrap()
            .contains("fetch_origin"));
    }
}

// ---------------------------------------------------------------------------
// DEV-10222 Bug A — `list_unreviewed_entries_using_gix_status_then_disambiguate_against_main` collapses byte-only diffs against
// the expected post-publish content. Whitespace / trailing-newline drift on a
// path that has no entry in `accepted-patches.json` must not be reported as
// unreviewed (previously fired immediately because the legacy branch flagged
// any byte-different unpatched path without a semantic check).
// ---------------------------------------------------------------------------

fn setup_main_worktree_for_detector(
    canonical_path: &str,
    canonical_main_bytes: &str,
) -> (TempDir, BareFixture, ConnectionContext) {
    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    seed_main_with_record(&fixture, &ctx, canonical_path, canonical_main_bytes);
    crate::git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.worktree_dir, "refs/heads/main")
        .unwrap();
    (tmp, fixture, ctx)
}

#[test]
fn list_unreviewed_entries_using_gix_status_then_disambiguate_against_main_ignores_whitespace_only_diff_on_unpatched_path(
) {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    // Main holds the canonical record with a trailing newline. After setup
    // the worktree file matches main byte-for-byte.
    let (_tmp, _fixture, ctx) =
        setup_main_worktree_for_detector("posts/rec_acme.json", "{\n  \"name\": \"Acme\"\n}\n");

    // Rewrite the worktree file without the trailing newline. JSON value is
    // identical to main's; only the bytes differ.
    write_file(
        &ctx.worktree_dir.join("posts/rec_acme.json"),
        "{\n  \"name\": \"Acme\"\n}",
    );

    let entries =
        list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(&ctx, false)
            .unwrap();
    assert!(
        entries.is_empty(),
        "whitespace-only diff on an unpatched path must not be flagged; got {:?}",
        entries
    );
}

#[test]
fn list_unreviewed_entries_using_gix_status_then_disambiguate_against_main_flags_real_semantic_change_on_unpatched_path(
) {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, _fixture, ctx) =
        setup_main_worktree_for_detector("posts/rec_acme.json", "{\n  \"name\": \"Acme\"\n}\n");

    // Actual content change → must be reported as unreviewed.
    write_file(
        &ctx.worktree_dir.join("posts/rec_acme.json"),
        "{\n  \"name\": \"Globex\"\n}\n",
    );

    let entries =
        list_unreviewed_entries_using_gix_status_then_disambiguate_against_main(&ctx, false)
            .unwrap();
    assert_eq!(
        entries.len(),
        1,
        "expected one unreviewed entry, got {:?}",
        entries
    );
    assert_eq!(entries[0].path, "posts/rec_acme.json");
    assert_eq!(entries[0].status, "modified");
}

// ---------------------------------------------------------------------------
// DEV-10222 Bug B — `reconcile_accepted_after_publish` rewrites the worktree
// to the post-publish canonical state (the goal: after a successful publish
// the local working copy reflects main, like a hard reset). Without this,
// the CLI publish flow left the worktree byte-different from main forever
// because the next `files download` short-circuits as "up to date".
// ---------------------------------------------------------------------------

#[test]
fn reconcile_rewrites_worktree_to_canonical_bytes_after_publish() {
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
    crate::git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.worktree_dir, "refs/heads/main")
        .unwrap();

    // User accepted industry → SaaS. Worktree file holds the user's bytes,
    // which happen to be missing the trailing newline (simulating an editor
    // that serializes JSON without one).
    let connection_dir = accepted_patches_dir(&ctx);
    let accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: vec![crate::shared::re_anchor::AnchoredPatch {
            path: "posts/rec_acme.json".to_string(),
            kind: crate::shared::re_anchor::PatchKind::Update,
            patch: serde_json::json!({"industry": "SaaS"}),
        }],
    };
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();
    write_file(
        &ctx.worktree_dir.join("posts/rec_acme.json"),
        "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}",
    );

    // Server publishes the user's edit verbatim — canonical form (with the
    // trailing newline).
    let canonical_after_publish = "{\n  \"name\": \"Acme\",\n  \"industry\": \"SaaS\"\n}\n";
    advance_remote_main(
        &fixture,
        "posts/rec_acme.json",
        canonical_after_publish,
        "publish lands user's edit",
    );

    reconcile_accepted_after_publish(&ctx, &workspace_dir, "test-token").unwrap();

    // Patch dropped, main advanced, AND worktree now matches main byte-for-byte.
    let reloaded = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert!(reloaded.patches.is_empty());

    let on_disk = std::fs::read(ctx.worktree_dir.join("posts/rec_acme.json")).unwrap();
    assert_eq!(
        String::from_utf8(on_disk).unwrap(),
        canonical_after_publish,
        "worktree must snap to main's canonical bytes after publish"
    );
}

#[test]
fn reconcile_materializes_failed_publish_patch_value_to_worktree() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().to_path_buf();
    let ctx = make_connection_context(&workspace_dir, &fixture.local_bare);

    seed_main_with_record(&fixture, &ctx, "posts/rec_a.json", "{\n  \"v\": 1\n}\n");
    seed_main_with_record(&fixture, &ctx, "posts/rec_b.json", "{\n  \"v\": 1\n}\n");
    crate::git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.worktree_dir, "refs/heads/main")
        .unwrap();

    // Both accepted as v=2; both worktree files hold v=2 with a byte-level
    // wobble that we'll prove gets normalized.
    let connection_dir = accepted_patches_dir(&ctx);
    let accepted = crate::shared::accepted_patches::AcceptedPatchesFile {
        patches: vec![
            crate::shared::re_anchor::AnchoredPatch {
                path: "posts/rec_a.json".to_string(),
                kind: crate::shared::re_anchor::PatchKind::Update,
                patch: serde_json::json!({"v": 2}),
            },
            crate::shared::re_anchor::AnchoredPatch {
                path: "posts/rec_b.json".to_string(),
                kind: crate::shared::re_anchor::PatchKind::Update,
                patch: serde_json::json!({"v": 2}),
            },
        ],
    };
    crate::shared::accepted_patches::save_atomic(&connection_dir, &accepted).unwrap();
    write_file(
        &ctx.worktree_dir.join("posts/rec_a.json"),
        "{\"v\":2}", // compact bytes, no newline
    );
    write_file(
        &ctx.worktree_dir.join("posts/rec_b.json"),
        "{\"v\":2}", // compact bytes, no newline
    );

    // Connector succeeded for A only; main now has rec_a at v=2 and rec_b
    // still at v=1.
    advance_remote_main(
        &fixture,
        "posts/rec_a.json",
        "{\n  \"v\": 2\n}\n",
        "publish lands A",
    );

    reconcile_accepted_after_publish(&ctx, &workspace_dir, "test-token").unwrap();

    // rec_a's patch was dropped; rec_b's survives.
    let reloaded = crate::shared::accepted_patches::load(&connection_dir).unwrap();
    assert_eq!(reloaded.patches.len(), 1);
    assert_eq!(reloaded.patches[0].path, "posts/rec_b.json");

    // rec_a worktree = new_main canonical bytes (v=2 with trailing newline).
    let rec_a_on_disk = std::fs::read(ctx.worktree_dir.join("posts/rec_a.json")).unwrap();
    assert_eq!(
        String::from_utf8(rec_a_on_disk).unwrap(),
        "{\n  \"v\": 2\n}\n",
        "rec_a (published) must snap to main's canonical bytes"
    );

    // rec_b worktree = apply(new_main_blob_for_b, surviving_patch) canonical
    // bytes (v=2 with trailing newline — the user's intended value, NOT the
    // server's still-stale v=1).
    let rec_b_on_disk = std::fs::read(ctx.worktree_dir.join("posts/rec_b.json")).unwrap();
    assert_eq!(
        String::from_utf8(rec_b_on_disk).unwrap(),
        "{\n  \"v\": 2\n}\n",
        "rec_b (failed publish) must show apply(new_main, surviving_patch) canonical bytes"
    );
}
