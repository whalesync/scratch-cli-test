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
    )
    .unwrap();

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
        serde_json::to_string_pretty(&json!({"id":"rec1","fields":{"title":"Committed"}})).unwrap(),
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
        serde_json::to_string_pretty(&json!({"id":"rec1","fields":{"title":"Committed"}})).unwrap(),
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
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join(".scratch")).unwrap();
    std::fs::write(
        root.join(".scratch/.scratchmd"),
        "version: \"3\"\nworkbook:\n  id: wkb_test\n  name: Test\n  serverUrl: http://localhost\n  initializedAt: \"2024-01-01T00:00:00Z\"\nconnections:\n  - id: cid\n    displayName: C\n    service: airtable\n    repoPath: org123/wkb_test/cid\n    dirName: c\n",
    )
    .unwrap();
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
