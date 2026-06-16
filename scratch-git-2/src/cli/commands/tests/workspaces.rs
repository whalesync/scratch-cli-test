use super::*;
use crate::shared::git_exec::git_command;
use tempfile::TempDir;

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

fn workbook_with_repo_paths(repo_paths: &[&str]) -> Workbook {
    Workbook {
        id: "wkb_test".to_string(),
        name: "Test".to_string(),
        org_id: "org123".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
        table_count: 0,
        version: 2,
        connector_accounts: repo_paths
            .iter()
            .enumerate()
            .map(|(i, repo_path)| ConnectorAccount {
                id: format!("ca_{i}"),
                display_name: format!("Conn {i}"),
                service: "AIRTABLE".to_string(),
                repo_path: (*repo_path).to_string(),
                git_url: String::new(),
                version: 1,
                data_folders: vec![],
            })
            .collect(),
        git_url: String::new(),
    }
}

#[test]
fn derive_workbook_repo_id_uses_shared_repo_prefix() {
    let wb = workbook_with_repo_paths(&["org123/wkb_test/ca_1", "org123/wkb_test/ca_2"]);
    assert_eq!(
        derive_workbook_repo_id(&wb).as_deref(),
        Some("org123/wkb_test/wkb_test")
    );
}

#[test]
fn derive_workbook_org_id_prefers_workbook_field_then_repo_path_prefix() {
    let explicit = workbook_with_repo_paths(&["org123/wkb_test/ca_1"]);
    assert_eq!(derive_workbook_org_id(&explicit), "org123");

    let mut derived = workbook_with_repo_paths(&["org999/wkb_test/ca_1"]);
    derived.org_id.clear();
    assert_eq!(derive_workbook_org_id(&derived), "org999");
}

#[test]
fn sync_schema_files_from_worktree_copies_schema_and_view_into_cache() {
    // Post-slice-F: the user-facing worktree is non-sparse on `main`, so
    // schemas + views live natively at `<worktree>/.scratch/<folder>/`.
    // `sync_schema_files_from_worktree_paths` copies them into the per-
    // connection cache `<workspace>/.scratch/connections/scratch/<conn>/`
    // for the broader codebase's readers (validators, index).
    let tmp = TempDir::new().unwrap();
    let worktree_dir = tmp.path().join("HubSpot");
    let scratch_dir = tmp.path().join("scratch");
    write_file(
        &worktree_dir.join(".scratch/Posts/schema.json"),
        r#"{"type":"object","properties":{"title":{"type":"string"}}}"#,
    );
    write_file(
        &worktree_dir.join(".scratch/Posts/views/default.json"),
        r#"{"name":"Default","cols":[]}"#,
    );
    write_file(&worktree_dir.join("Posts/rec1.json"), r#"{"id":"rec1"}"#);

    crate::shared::review_ops::sync_schema_files_from_worktree_paths(&worktree_dir, &scratch_dir)
        .unwrap();

    let schema_path = scratch_dir.join("Posts/schema.json");
    assert!(
        schema_path.exists(),
        "schema.json should exist at {}",
        schema_path.display()
    );
    assert_eq!(
        std::fs::read_to_string(&schema_path).unwrap(),
        r#"{"type":"object","properties":{"title":{"type":"string"}}}"#
    );

    let view_path = scratch_dir.join("Posts/views/default.json");
    assert!(
        view_path.exists(),
        "views/default.json should exist at {}",
        view_path.display()
    );
    assert_eq!(
        std::fs::read_to_string(&view_path).unwrap(),
        r#"{"name":"Default","cols":[]}"#
    );
}

/// Full integration test for `init_v2`: creates a fake remote git repo with data files and
/// schemas, then runs init and verifies the workspace directory structure matches what the
/// desktop app expects.
#[test]
fn init_v2_produces_workspace_structure_expected_by_desktop() {
    let tmp = TempDir::new().unwrap();
    let source_dir = tmp.path().join("source");
    let remote_bare = tmp.path().join("remote.git");
    let workspace_dir = tmp.path().join("workspace");

    // ── Build a source repo with main + dirty branches ──

    run_git(tmp.path(), &["init", "source"]);
    run_git(&source_dir, &["checkout", "-b", "main"]);

    // Data files (these live on main)
    write_file(
        &source_dir.join("Posts/hello-world.json"),
        r#"{"id":"1","title":"Hello World"}"#,
    );
    write_file(
        &source_dir.join("Posts/second-post.json"),
        r#"{"id":"2","title":"Second Post"}"#,
    );

    // Schema files under .scratch/ (committed to main, excluded by sparse checkout)
    let schema_content =
        r#"{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"}}}"#;
    write_file(
        &source_dir.join(".scratch/Posts/schema.json"),
        schema_content,
    );
    let view_content = r#"{"name":"Default","cols":[]}"#;
    write_file(
        &source_dir.join(".scratch/Posts/views/default.json"),
        view_content,
    );

    commit_all(&source_dir, "main: data + schema + view");

    // Create dirty branch (same tree as main — just needs the ref to exist)
    run_git(&source_dir, &["checkout", "-b", "dirty"]);

    // Push both branches to a bare remote
    run_git(tmp.path(), &["init", "--bare", "remote.git"]);
    run_git(
        &source_dir,
        &["remote", "add", "origin", remote_bare.to_str().unwrap()],
    );
    run_git(&source_dir, &["push", "origin", "main:main"]);
    run_git(&source_dir, &["push", "origin", "dirty:dirty"]);

    // ── Build Workbook struct (mocking the API response) ──

    let wb = Workbook {
        id: "wkb_test123".to_string(),
        name: "Test Workspace".to_string(),
        org_id: "org_test".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
        table_count: 1,
        version: 2,
        connector_accounts: vec![ConnectorAccount {
            id: "ca_conn1".to_string(),
            display_name: "My CMS".to_string(),
            service: "WORDPRESS".to_string(),
            repo_path: "org_test/wkb_test123/ca_conn1".to_string(),
            git_url: remote_bare.to_str().unwrap().to_string(),
            version: 1,
            data_folders: vec![],
        }],
        git_url: String::new(), // no workbook config repo — init_workbook_repo will skip
    };

    // ── Run init ──

    init_v2(&wb, &workspace_dir, "http://localhost:3010", "fake-token").unwrap();

    let conn_dir_name = "My CMS";

    // ── Assert: data files appear in the user-facing worktree ──
    let worktree_dir = workspace_dir.join(conn_dir_name);
    assert!(
        worktree_dir.join("Posts/hello-world.json").exists(),
        "data file should exist in main worktree"
    );
    assert!(
        worktree_dir.join("Posts/second-post.json").exists(),
        "data file should exist in main worktree"
    );

    // ── Post-slice-F: .scratch/ IS in the non-sparse main worktree ──
    assert!(
        worktree_dir.join(".scratch/Posts/schema.json").exists(),
        ".scratch/Posts/schema.json should be checked out in the non-sparse main worktree",
    );
    assert!(
        worktree_dir
            .join(".scratch/Posts/views/default.json")
            .exists(),
        ".scratch/Posts/views/default.json should be checked out in the non-sparse main worktree",
    );

    // ── Post-slice-F: no sparse-checkout config left behind ──
    assert!(
        !worktree_dir.join(".git/info/sparse-checkout").exists(),
        ".git/info/sparse-checkout should NOT exist on a non-sparse worktree",
    );

    // ── Assert: schema lands in connections/scratch/ (cache read by desktop app) ──
    let schema_path = workspace_dir
        .join(".scratch/connections/scratch")
        .join(conn_dir_name)
        .join("Posts/schema.json");
    assert!(
        schema_path.exists(),
        "schema.json should exist in cache at {}",
        schema_path.display()
    );
    assert_eq!(
        std::fs::read_to_string(&schema_path).unwrap(),
        schema_content,
    );

    // ── Post-slice-F: NO master worktree at .scratch/connections/master/ ──
    let master_dir = workspace_dir
        .join(".scratch/connections/master")
        .join(conn_dir_name);
    assert!(
        !master_dir.exists(),
        "master worktree should NOT be created post-slice-F",
    );

    // ── Assert: view file lands in connections/scratch/ alongside schema ──
    let view_path = workspace_dir
        .join(".scratch/connections/scratch")
        .join(conn_dir_name)
        .join("Posts/views/default.json");
    assert!(
        view_path.exists(),
        "views/default.json should exist in cache at {}",
        view_path.display()
    );
    assert_eq!(std::fs::read_to_string(&view_path).unwrap(), view_content,);

    // ── Assert: reviewed-dirty worktree is NOT created (removed in Phase 3 of DEV-10144) ──
    let reviewed_worktree_dir = workspace_dir
        .join(".scratch/connections/dirty")
        .join(conn_dir_name);
    assert!(
        !reviewed_worktree_dir.exists(),
        "reviewed-dirty worktree should not be created at init"
    );

    // ── Assert: bare repo exists in .repos/ ──
    let bare_repo = workspace_dir.join(".repos/ca_conn1.git");
    assert!(bare_repo.exists(), "bare repo should exist in .repos/");

    // ── Assert: .scratch/workspace/ directory exists ──
    assert!(
        workspace_dir.join(".scratch/workspace").exists(),
        ".scratch/workspace/ should exist"
    );

    // ── Slice F.2.b idempotency: re-running init against the same workspace
    //    succeeds without duplicate work. The worktree, bare repo, and
    //    schema cache remain valid; no error bubbles up.
    init_v2(&wb, &workspace_dir, "http://localhost:3010", "fake-token")
        .expect("re-init on existing workspace should be a no-op");
    assert!(
        worktree_dir.join("Posts/hello-world.json").exists(),
        "re-init should preserve worktree data files",
    );
    assert!(
        schema_path.exists(),
        "re-init should preserve cached schema",
    );
}

#[test]
fn git_checkout_branch_from_bare_allows_empty_branch_tree() {
    let tmp = TempDir::new().unwrap();
    let repo_dir = tmp.path().join("repo");
    let bare_dir = tmp.path().join("repo.git");
    let work_tree = tmp.path().join("checkout");

    run_git(tmp.path(), &["init", "repo"]);
    run_git(&repo_dir, &["checkout", "-b", "dirty"]);
    run_git(
        &repo_dir,
        &[
            "-c",
            "user.name=Scratch",
            "-c",
            "user.email=scratch@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "empty",
        ],
    );
    run_git(tmp.path(), &["init", "--bare", "repo.git"]);
    run_git(
        &repo_dir,
        &["remote", "add", "origin", bare_dir.to_str().unwrap()],
    );
    run_git(&repo_dir, &["push", "origin", "dirty:dirty"]);

    git_checkout_branch_from_bare(&bare_dir, "dirty", &work_tree).unwrap();

    assert!(work_tree.exists());
    // Sparse worktrees have a .git file; data files should be absent for an empty branch.
    let non_git_entries: Vec<_> = std::fs::read_dir(&work_tree)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name() != ".git")
        .collect();
    assert!(non_git_entries.is_empty());
}

#[test]
fn materialize_workbook_checkout_prefers_main_when_dirty_is_empty() {
    let tmp = TempDir::new().unwrap();
    let repo_dir = tmp.path().join("repo");
    let bare_dir = tmp.path().join("repo.git");
    let work_tree = tmp.path().join("workspace");

    run_git(tmp.path(), &["init", "repo"]);
    run_git(&repo_dir, &["checkout", "-b", "main"]);
    std::fs::create_dir_all(repo_dir.join("syncs")).unwrap();
    std::fs::write(repo_dir.join("syncs/a.json"), "{}").unwrap();
    run_git(&repo_dir, &["add", "syncs/a.json"]);
    run_git(
        &repo_dir,
        &[
            "-c",
            "user.name=Scratch",
            "-c",
            "user.email=scratch@example.com",
            "commit",
            "-m",
            "main content",
        ],
    );
    run_git(&repo_dir, &["checkout", "--orphan", "dirty"]);
    run_git(&repo_dir, &["rm", "-rf", "."]);
    run_git(
        &repo_dir,
        &[
            "-c",
            "user.name=Scratch",
            "-c",
            "user.email=scratch@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "empty dirty",
        ],
    );
    run_git(tmp.path(), &["init", "--bare", "repo.git"]);
    run_git(
        &repo_dir,
        &["remote", "add", "origin", bare_dir.to_str().unwrap()],
    );
    run_git(&repo_dir, &["push", "origin", "main:main"]);
    run_git(&repo_dir, &["push", "origin", "dirty:dirty"]);

    let branch = materialize_workbook_checkout(&bare_dir, &work_tree).unwrap();

    assert_eq!(branch, "main");
    assert!(work_tree.join("syncs/a.json").exists());
}

#[test]
fn git_clone_bare_clones_remote_refs_and_origin() {
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

    git_clone_bare(remote_bare.to_str().unwrap(), &local_bare, "test-token").unwrap();

    let dirty_ref = git_command()
        .arg(format!("--git-dir={}", local_bare.display()))
        .args(["rev-parse", "dirty"])
        .output()
        .unwrap();
    assert!(dirty_ref.status.success());

    let main_ref = git_command()
        .arg(format!("--git-dir={}", local_bare.display()))
        .args(["rev-parse", "main"])
        .output()
        .unwrap();
    assert!(main_ref.status.success());

    let origin_url = git_command()
        .arg(format!("--git-dir={}", local_bare.display()))
        .args(["config", "--get", "remote.origin.url"])
        .output()
        .unwrap();
    assert!(origin_url.status.success());
    let expected_origin = std::fs::canonicalize(&remote_bare).unwrap();
    let actual_origin =
        std::fs::canonicalize(String::from_utf8_lossy(&origin_url.stdout).trim()).unwrap();
    assert_eq!(actual_origin, expected_origin);
}

#[test]
fn find_existing_workspace_reads_marker_from_scratch_dir() {
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().join("My Workspace");
    std::fs::create_dir_all(workspace_dir.join(".scratch")).unwrap();
    std::fs::write(
        workspace_dir.join(".scratch/.scratchmd"),
        r#"version: "3"
workbook:
  id: wkb_test
  name: Test
  serverUrl: http://localhost
  initializedAt: "2026-01-01T00:00:00Z"
connections: []
"#,
    )
    .unwrap();

    assert_eq!(
        find_existing_workspace(tmp.path().to_str().unwrap(), "wkb_test"),
        Some(workspace_dir)
    );
}

/// Slice F.2.b: `materialize_main_worktree` must fail loudly when the
/// worktree directory exists but isn't a valid git worktree (no `.git`
/// gitlink + non-empty). Silent nuke would clobber user state that a manual
/// `workspaces unsync` could have preserved.
#[test]
fn materialize_main_worktree_refuses_to_overwrite_non_worktree_dir() {
    let tmp = TempDir::new().unwrap();
    let bare = tmp.path().join("repo.git");
    let worktree = tmp.path().join("HubSpot");
    let scratch = tmp.path().join(".scratch/connections/scratch/HubSpot");

    // Set up a minimal bare repo with a `main` ref.
    let source = tmp.path().join("source");
    run_git(tmp.path(), &["init", "source"]);
    run_git(&source, &["checkout", "-b", "main"]);
    write_file(&source.join("Posts/rec1.json"), "{}");
    commit_all(&source, "init main");
    run_git(tmp.path(), &["init", "--bare", "repo.git"]);
    run_git(
        &source,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    run_git(&source, &["push", "origin", "main:main"]);

    // Plant a non-empty directory at the worktree path with no `.git` gitlink —
    // simulates a half-broken workspace that the user (or another process)
    // partially set up.
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join("user-file.txt"), "preserved").unwrap();

    let err = materialize_main_worktree(&bare, &worktree, &scratch)
        .expect_err("should refuse to overwrite a non-worktree directory");
    assert!(
        err.to_string().contains("isn't a git worktree"),
        "error should mention the missing gitlink, got: {err}"
    );
    // The user file is still on disk — nothing got clobbered.
    assert!(
        worktree.join("user-file.txt").exists(),
        "the user file should not be deleted by the refusal path"
    );
}

/// Slice F.2.b: `materialize_main_worktree` is idempotent when the worktree
/// already exists and is valid (re-running init succeeds without rebuilding).
#[test]
fn materialize_main_worktree_is_idempotent_on_valid_worktree() {
    let tmp = TempDir::new().unwrap();
    let bare = tmp.path().join("repo.git");
    let worktree = tmp.path().join("HubSpot");
    let scratch = tmp.path().join(".scratch/connections/scratch/HubSpot");

    let source = tmp.path().join("source");
    run_git(tmp.path(), &["init", "source"]);
    run_git(&source, &["checkout", "-b", "main"]);
    write_file(&source.join("Posts/rec1.json"), "{}");
    commit_all(&source, "init main");
    run_git(tmp.path(), &["init", "--bare", "repo.git"]);
    run_git(
        &source,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    run_git(&source, &["push", "origin", "main:main"]);

    // First call creates the worktree.
    materialize_main_worktree(&bare, &worktree, &scratch).unwrap();
    assert!(worktree.join(".git").is_file(), "gitlink should exist");
    assert!(worktree.join("Posts/rec1.json").exists());

    // Plant a user edit; the second call must NOT overwrite it.
    std::fs::write(worktree.join("Posts/rec1.json"), "{\"edit\":1}").unwrap();
    materialize_main_worktree(&bare, &worktree, &scratch).unwrap();
    assert_eq!(
        std::fs::read_to_string(worktree.join("Posts/rec1.json")).unwrap(),
        "{\"edit\":1}",
        "second materialize call should be a no-op — user edits preserved"
    );
}

fn run_git(cwd: &Path, args: &[&str]) {
    let output = git_command().current_dir(cwd).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Helper: build a bare remote with a single record on `main`. Returns the
/// bare repo path the workbook should point to.
fn make_remote_with_record(tmp_root: &Path, slug: &str, record_path: &str) -> PathBuf {
    let source = tmp_root.join(format!("source-{slug}"));
    let bare = tmp_root.join(format!("remote-{slug}.git"));
    run_git(
        tmp_root,
        &["init", &source.file_name().unwrap().to_string_lossy()],
    );
    run_git(&source, &["checkout", "-b", "main"]);
    write_file(&source.join(record_path), &format!(r#"{{"id":"{slug}"}}"#));
    commit_all(&source, "init");
    run_git(
        tmp_root,
        &[
            "init",
            "--bare",
            &bare.file_name().unwrap().to_string_lossy(),
        ],
    );
    run_git(
        &source,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    run_git(&source, &["push", "origin", "main:main"]);
    bare
}

/// Phase 6: `init_v2` fans connections out via rayon; ensure 3 connections
/// each get their own bare repo + worktree with the right data, even though
/// they're set up in parallel.
#[test]
fn init_v2_sets_up_multiple_connections_in_parallel() {
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().join("workspace");

    let conns = [
        ("a", "Posts/rec_a.json"),
        ("b", "Posts/rec_b.json"),
        ("c", "Posts/rec_c.json"),
    ];
    let bare_paths: Vec<PathBuf> = conns
        .iter()
        .map(|(slug, rec)| make_remote_with_record(tmp.path(), slug, rec))
        .collect();

    let wb = Workbook {
        id: "wkb_multi".to_string(),
        name: "Multi".to_string(),
        org_id: "org_test".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
        table_count: 0,
        version: 2,
        connector_accounts: conns
            .iter()
            .zip(bare_paths.iter())
            .enumerate()
            .map(|(i, ((slug, _), bare))| ConnectorAccount {
                id: format!("ca_{slug}"),
                display_name: format!("Conn {i}"),
                service: "WORDPRESS".to_string(),
                repo_path: format!("org_test/wkb_multi/ca_{slug}"),
                git_url: bare.to_str().unwrap().to_string(),
                version: 1,
                data_folders: vec![],
            })
            .collect(),
        git_url: String::new(),
    };

    init_v2(&wb, &workspace_dir, "http://localhost:3010", "fake-token").unwrap();

    for (i, (_slug, rec)) in conns.iter().enumerate() {
        let worktree = workspace_dir.join(format!("Conn {i}"));
        assert!(
            worktree.join(rec).exists(),
            "connection {i} should have {rec} in its worktree",
        );
    }
    for (i, _) in conns.iter().enumerate() {
        let bare = workspace_dir.join(format!(".repos/ca_{}.git", conns[i].0));
        assert!(bare.exists(), "bare repo for connection {i} should exist");
    }
}

/// Phase 6: when 1/N connections fails (bad git URL), init logs a warning
/// and continues with the remaining N-1 — the workspace is left in a
/// partial-but-usable state.
#[test]
fn init_v2_continues_when_one_connection_fails() {
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().join("workspace");
    let good_bare = make_remote_with_record(tmp.path(), "good", "Posts/rec_good.json");

    let wb = Workbook {
        id: "wkb_partial".to_string(),
        name: "Partial".to_string(),
        org_id: "org_test".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
        table_count: 0,
        version: 2,
        connector_accounts: vec![
            ConnectorAccount {
                id: "ca_good".to_string(),
                display_name: "Good".to_string(),
                service: "WORDPRESS".to_string(),
                repo_path: "org_test/wkb_partial/ca_good".to_string(),
                git_url: good_bare.to_str().unwrap().to_string(),
                version: 1,
                data_folders: vec![],
            },
            ConnectorAccount {
                id: "ca_bad".to_string(),
                display_name: "Bad".to_string(),
                service: "WORDPRESS".to_string(),
                repo_path: "org_test/wkb_partial/ca_bad".to_string(),
                git_url: tmp
                    .path()
                    .join("does-not-exist.git")
                    .to_str()
                    .unwrap()
                    .to_string(),
                version: 1,
                data_folders: vec![],
            },
        ],
        git_url: String::new(),
    };

    init_v2(&wb, &workspace_dir, "http://localhost:3010", "fake-token")
        .expect("init should succeed when at least one connection succeeds");

    assert!(
        workspace_dir.join("Good/Posts/rec_good.json").exists(),
        "the good connection's worktree should be populated",
    );
}

/// Phase 6: when 0/N connections succeed, init exits non-zero so the user
/// knows nothing got set up (vs the prior behaviour of silently producing
/// an empty workspace).
#[test]
fn init_v2_bails_when_all_connections_fail() {
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().join("workspace");

    let wb = Workbook {
        id: "wkb_all_fail".to_string(),
        name: "AllFail".to_string(),
        org_id: "org_test".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
        table_count: 0,
        version: 2,
        connector_accounts: vec![
            ConnectorAccount {
                id: "ca_a".to_string(),
                display_name: "A".to_string(),
                service: "WORDPRESS".to_string(),
                repo_path: "org_test/wkb_all_fail/ca_a".to_string(),
                git_url: tmp.path().join("nope-a.git").to_str().unwrap().to_string(),
                version: 1,
                data_folders: vec![],
            },
            ConnectorAccount {
                id: "ca_b".to_string(),
                display_name: "B".to_string(),
                service: "WORDPRESS".to_string(),
                repo_path: "org_test/wkb_all_fail/ca_b".to_string(),
                git_url: tmp.path().join("nope-b.git").to_str().unwrap().to_string(),
                version: 1,
                data_folders: vec![],
            },
        ],
        git_url: String::new(),
    };

    let err = init_v2(&wb, &workspace_dir, "http://localhost:3010", "fake-token")
        .expect_err("init should fail when every connection fails");
    let msg = err.to_string();
    assert!(
        msg.contains("all 2 connection(s) failed"),
        "error should name the count, got: {msg}"
    );
}

/// Phase 6: a workbook with no connectors is a degenerate but legitimate
/// case (e.g. a freshly created workbook). Init should succeed with an
/// empty workspace, not be tripped up by the 0/N guard.
#[test]
fn init_v2_succeeds_with_zero_connections() {
    let tmp = TempDir::new().unwrap();
    let workspace_dir = tmp.path().join("workspace");

    let wb = Workbook {
        id: "wkb_empty".to_string(),
        name: "Empty".to_string(),
        org_id: "org_test".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
        table_count: 0,
        version: 2,
        connector_accounts: vec![],
        git_url: String::new(),
    };

    init_v2(&wb, &workspace_dir, "http://localhost:3010", "fake-token")
        .expect("init should succeed when the workbook has no connectors");
    assert!(workspace_dir.join(".scratch/workspace").exists());
}

// ── Non-destructive forced re-clone salvage (DEV-9698 T5) ────────────────────

/// Build a minimal on-disk workspace (marker + one connection) for salvage
/// tests, optionally seeding a non-empty `accepted-patches.json`.
fn make_fake_workspace(parent: &Path, conn_dir: &str, with_pending: bool) -> std::path::PathBuf {
    let ws = parent.join("My Workbook");
    std::fs::create_dir_all(ws.join(".scratch")).unwrap();
    let conn = markers::ConnectionEntry {
        id: "ca_0".to_string(),
        display_name: conn_dir.to_string(),
        service: "WEBFLOW".to_string(),
        repo_path: "org/wkb/ca_0".to_string(),
        dir_name: conn_dir.to_string(),
        structure_version: 1,
    };
    markers::write_workspace(
        &ws,
        "wkb_test",
        "My Workbook",
        "org",
        "http://localhost",
        &[conn],
    )
    .unwrap();
    if with_pending {
        let layout = WorkspaceLayout::for_cli(&ws);
        let conn_root = layout.connection_root_path(conn_dir);
        let file = crate::shared::accepted_patches::AcceptedPatchesFile {
            patches: vec![crate::shared::re_anchor::AnchoredPatch {
                path: format!("{conn_dir}/rec_1.json"),
                kind: crate::shared::re_anchor::PatchKind::Update,
                patch: serde_json::json!({ "name": "edited" }),
                revert: false,
            }],
        };
        crate::shared::accepted_patches::save_atomic(&conn_root, &file).unwrap();
    }
    ws
}

#[test]
fn workspace_has_pending_accepted_edits_true_with_nonempty_accepted_patches() {
    let tmp = TempDir::new().unwrap();
    let ws = make_fake_workspace(tmp.path(), "Webflow Site", true);
    assert!(workspace_has_pending_accepted_edits(&ws));
}

#[test]
fn workspace_has_pending_accepted_edits_false_without_accepted_patches() {
    let tmp = TempDir::new().unwrap();
    let ws = make_fake_workspace(tmp.path(), "Webflow Site", false);
    assert!(!workspace_has_pending_accepted_edits(&ws));
}

#[test]
fn clear_preserves_workspace_with_pending_edits_instead_of_deleting() {
    let tmp = TempDir::new().unwrap();
    let ws = make_fake_workspace(tmp.path(), "Webflow Site", true);

    let salvaged_to = clear_existing_workspace_preserving_pending_edits(&ws).unwrap();

    let salvage_path =
        salvaged_to.expect("a workspace with pending edits must be preserved, not deleted");
    assert!(
        !ws.exists(),
        "original workspace path should be vacated by the move"
    );
    assert!(salvage_path.exists(), "salvage directory should exist");
    assert!(
        salvage_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".salvaged-"),
        "salvage dir should be named <name>.salvaged-<ts>"
    );
    // The accepted-patches.json (the upload wire format) must survive the move.
    let preserved_patches = salvage_path
        .join(".scratch")
        .join("connections")
        .join("Webflow Site")
        .join("accepted-patches.json");
    assert!(
        preserved_patches.exists(),
        "accepted edits must be preserved in the salvage dir"
    );
}

#[test]
fn clear_deletes_workspace_without_pending_edits() {
    let tmp = TempDir::new().unwrap();
    let ws = make_fake_workspace(tmp.path(), "Webflow Site", false);

    let salvaged_to = clear_existing_workspace_preserving_pending_edits(&ws).unwrap();

    assert!(
        salvaged_to.is_none(),
        "a clean workspace should be deleted, not salvaged"
    );
    assert!(!ws.exists(), "workspace should be removed");
}

#[test]
fn choose_salvage_path_is_a_timestamped_sibling() {
    let tmp = TempDir::new().unwrap();
    let ws = tmp.path().join("My Workbook");
    std::fs::create_dir_all(&ws).unwrap();
    let salvage = choose_salvage_path(&ws);
    assert_eq!(salvage.parent(), ws.parent());
    let name = salvage.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("My Workbook.salvaged-"), "got {name}");
    assert!(!salvage.exists(), "the chosen path must not already exist");
}

#[test]
fn workspace_has_pending_accepted_edits_true_when_patches_file_is_unparseable() {
    // A corrupt or newer-format accepted-patches.json must be treated as "might
    // have pending work" — never deleted out from under the user.
    let tmp = TempDir::new().unwrap();
    let ws = make_fake_workspace(tmp.path(), "Webflow Site", false);
    let conn_root = WorkspaceLayout::for_cli(&ws).connection_root_path("Webflow Site");
    std::fs::create_dir_all(&conn_root).unwrap();
    // version 999 — a file a newer scratchmd wrote; `load` refuses it.
    std::fs::write(
        conn_root.join("accepted-patches.json"),
        br#"{"version":999,"patches":[]}"#,
    )
    .unwrap();

    assert!(workspace_has_pending_accepted_edits(&ws));
    let salvaged_to = clear_existing_workspace_preserving_pending_edits(&ws).unwrap();
    assert!(
        salvaged_to.is_some(),
        "an unparseable patches file must be preserved, not deleted"
    );
}

#[test]
fn find_existing_workspace_ignores_salvage_backups() {
    let tmp = TempDir::new().unwrap();
    let out = tmp.path();
    // A live workspace and a salvaged backup, both with the same workbook id.
    make_fake_workspace(out, "Webflow Site", false); // "My Workbook"
    let salvage_dir = out.join("My Workbook.salvaged-20260101-000000");
    std::fs::create_dir_all(salvage_dir.join(".scratch")).unwrap();
    markers::write_workspace(
        &salvage_dir,
        "wkb_test",
        "My Workbook",
        "org",
        "http://localhost",
        &[],
    )
    .unwrap();

    let found = find_existing_workspace(out.to_str().unwrap(), "wkb_test")
        .expect("the live workspace should be found");
    assert!(
        !found.to_string_lossy().contains(".salvaged-"),
        "must not return the salvage backup, got {}",
        found.display()
    );
    assert_eq!(found.file_name().unwrap(), "My Workbook");
}

#[test]
fn find_existing_workspace_skips_lone_salvage_backup() {
    let tmp = TempDir::new().unwrap();
    let out = tmp.path();
    let salvage_dir = out.join("My Workbook.salvaged-20260101-000000");
    std::fs::create_dir_all(salvage_dir.join(".scratch")).unwrap();
    markers::write_workspace(
        &salvage_dir,
        "wkb_test",
        "My Workbook",
        "org",
        "http://localhost",
        &[],
    )
    .unwrap();

    assert!(
        find_existing_workspace(out.to_str().unwrap(), "wkb_test").is_none(),
        "a salvage backup alone must not count as an existing workspace"
    );
}
