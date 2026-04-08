use super::*;
use std::process::Command;
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
fn include_schemas_then_sync_copies_schema_into_scratch_dir() {
    let tmp = TempDir::new().unwrap();
    let source_dir = tmp.path().join("source");
    let bare_dir = tmp.path().join("repo.git");
    let master_dir = tmp.path().join("master");
    let scratch_dir = tmp.path().join("scratch");

    // Create a source repo with data + schema on the main branch.
    run_git(tmp.path(), &["init", "source"]);
    run_git(&source_dir, &["checkout", "-b", "main"]);
    write_file(
        &source_dir.join(".scratch/Posts/schema.json"),
        r#"{"type":"object","properties":{"title":{"type":"string"}}}"#,
    );
    write_file(&source_dir.join("Posts/rec1.json"), r#"{"id":"rec1"}"#);
    commit_all(&source_dir, "initial with schema");

    // Push to a bare repo.
    run_git(tmp.path(), &["init", "--bare", "repo.git"]);
    run_git(
        &source_dir,
        &["remote", "add", "origin", bare_dir.to_str().unwrap()],
    );
    run_git(&source_dir, &["push", "origin", "main:main"]);

    // Create a sparse master worktree (excludes .scratch/ by default).
    git_checkout_branch_from_bare(&bare_dir, "main", &master_dir).unwrap();
    assert!(
        !master_dir.join(".scratch").exists(),
        ".scratch/ should be excluded before include_schemas_in_sparse_checkout"
    );

    // Include schemas and sync them.
    include_schemas_in_sparse_checkout(&master_dir).unwrap();
    sync_schema_files_from_master_checkout(&master_dir, &scratch_dir).unwrap();

    let schema_path = scratch_dir.join("Posts/schema.json");
    assert!(schema_path.exists(), "schema.json should exist at {}", schema_path.display());
    assert_eq!(
        std::fs::read_to_string(&schema_path).unwrap(),
        r#"{"type":"object","properties":{"title":{"type":"string"}}}"#
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
    write_file(&source_dir.join("Posts/hello-world.json"), r#"{"id":"1","title":"Hello World"}"#);
    write_file(&source_dir.join("Posts/second-post.json"), r#"{"id":"2","title":"Second Post"}"#);

    // Schema files under .scratch/ (committed to main, excluded by sparse checkout)
    let schema_content = r#"{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"}}}"#;
    write_file(&source_dir.join(".scratch/Posts/schema.json"), schema_content);

    commit_all(&source_dir, "main: data + schema");

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
            data_folders: vec![],
        }],
        git_url: String::new(), // no workbook config repo — init_workbook_repo will skip
    };

    // ── Run init ──

    init_v2(&wb, &workspace_dir, "http://localhost:3010", "fake-token").unwrap();

    let conn_dir_name = "WORDPRESS - My CMS";

    // ── Assert: data files appear in the dirty checkout ──
    let dirty_dir = workspace_dir.join(conn_dir_name);
    assert!(
        dirty_dir.join("Posts/hello-world.json").exists(),
        "data file should exist in dirty checkout"
    );
    assert!(
        dirty_dir.join("Posts/second-post.json").exists(),
        "data file should exist in dirty checkout"
    );

    // ── Assert: .scratch/ is NOT in the dirty checkout (sparse checkout excludes it) ──
    assert!(
        !dirty_dir.join(".scratch").exists(),
        ".scratch/ should be excluded from sparse dirty checkout"
    );

    // ── Assert: schema lands in connections/scratch/ (read by desktop app) ──
    let schema_path = workspace_dir
        .join(".scratch/connections/scratch")
        .join(conn_dir_name)
        .join("Posts/schema.json");
    assert!(
        schema_path.exists(),
        "schema.json should exist at {}",
        schema_path.display()
    );
    assert_eq!(
        std::fs::read_to_string(&schema_path).unwrap(),
        schema_content,
    );

    // ── Assert: master worktree exists with data ──
    let master_dir = workspace_dir
        .join(".scratch/connections/master")
        .join(conn_dir_name);
    assert!(
        master_dir.join("Posts/hello-world.json").exists(),
        "data file should exist in master worktree"
    );
    // .scratch/ in master contains only schema files (included via sparse-checkout add)
    assert!(
        master_dir.join(".scratch/Posts/schema.json").exists(),
        "schema.json should be included in master worktree via sparse checkout"
    );

    // ── Assert: reviewed-dirty worktree exists ──
    let reviewed_dirty_dir = workspace_dir
        .join(".scratch/connections/dirty")
        .join(conn_dir_name);
    assert!(
        reviewed_dirty_dir.exists(),
        "reviewed-dirty worktree should exist"
    );

    // ── Assert: bare repo exists in .repos/ ──
    let bare_repo = workspace_dir.join(".repos/ca_conn1.git");
    assert!(bare_repo.exists(), "bare repo should exist in .repos/");

    // ── Assert: .scratch/workspace/ directory exists ──
    assert!(
        workspace_dir.join(".scratch/workspace").exists(),
        ".scratch/workspace/ should exist"
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

    let dirty_ref = Command::new("git")
        .arg(format!("--git-dir={}", local_bare.display()))
        .args(["rev-parse", "dirty"])
        .output()
        .unwrap();
    assert!(dirty_ref.status.success());

    let main_ref = Command::new("git")
        .arg(format!("--git-dir={}", local_bare.display()))
        .args(["rev-parse", "main"])
        .output()
        .unwrap();
    assert!(main_ref.status.success());

    let origin_url = Command::new("git")
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

fn run_git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
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
}
