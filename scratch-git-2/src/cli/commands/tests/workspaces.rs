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
fn sync_schema_files_from_master_checkout_copies_schema_into_connection_scratch() {
    let tmp = TempDir::new().unwrap();
    let master_dir = tmp.path().join(".scratch/connections/master/conn");
    let scratch_dir = tmp.path().join(".scratch/connections/scratch/conn");

    std::fs::create_dir_all(master_dir.join(".scratch/posts")).unwrap();
    std::fs::write(
        master_dir.join(".scratch/posts/schema.json"),
        "{\"schema\":{}}",
    )
    .unwrap();

    sync_schema_files_from_master_checkout(&master_dir, &scratch_dir).unwrap();

    assert_eq!(
        std::fs::read_to_string(scratch_dir.join("posts/schema.json")).unwrap(),
        "{\"schema\":{}}"
    );
}

#[test]
fn git_checkout_branch_from_bare_allows_empty_branch_tree() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

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
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

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
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

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

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}
