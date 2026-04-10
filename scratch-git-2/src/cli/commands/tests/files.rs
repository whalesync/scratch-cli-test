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
        conn_dir_name: "Conn".to_string(),
        dirty_dir: tmp.path().join("Conn"),
        reviewed_dirty_dir: tmp.path().join(".scratch/connections/reviewed-dirty/Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
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
    materialize_local_repo(&ctx, &replacement).unwrap();

    assert!(ctx.dirty_dir.join("posts/next.json").exists());
    assert!(!ctx.dirty_dir.join("posts/rec1.json").exists());
    assert!(ctx.scratch_dir.join("posts/schema.json").exists());
    assert!(!ctx.scratch_dir.join(".publish-plans/1/plan.json").exists());
}

#[test]
fn prepare_upload_merge_keeps_schema_and_publish_plan_files() {
    let base = HashMap::from([("posts/rec.json".to_string(), b"{\"v\":1}".to_vec())]);
    let remote = base.clone();
    let local = HashMap::from([
        ("posts/rec.json".to_string(), b"{\"v\":2}".to_vec()),
        (
            ".scratch/posts/schema.json".to_string(),
            b"{\"schema\":{}}".to_vec(),
        ),
        (
            ".scratch/posts/publish-plan-123/edit/rec.json".to_string(),
            b"{\"content\":{}}".to_vec(),
        ),
        (
            ".scratch/.publish-plans/123/plan.json".to_string(),
            b"{\"summary\":{}}".to_vec(),
        ),
    ]);

    let (merged, result, _) = prepare_upload_merge(&base, &local, &remote, 0);

    assert_eq!(result.files_uploaded, 4);
    assert!(merged.contains_key(".scratch/posts/schema.json"));
    assert!(merged.contains_key(".scratch/posts/publish-plan-123/edit/rec.json"));
    assert!(merged.contains_key(".scratch/.publish-plans/123/plan.json"));
}

#[test]
fn sync_schema_files_from_master_restores_missing_schema() {
    let tmp = TempDir::new().unwrap();
    let ctx = ConnectionContext {
        conn_dir_name: "Conn".to_string(),
        dirty_dir: tmp.path().join("Conn"),
        reviewed_dirty_dir: tmp.path().join(".scratch/connections/reviewed-dirty/Conn"),
        scratch_dir: tmp.path().join(".scratch/connections/scratch/Conn"),
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
fn git_push_updates_remote_dirty_branch() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let parent = git_rev_parse(&fixture.local_bare, "dirty").unwrap();
    let files = HashMap::from([(
        "posts/rec1.json".to_string(),
        b"{\"id\":\"rec1\",\"fields\":{\"title\":\"Updated\"}}".to_vec(),
    )]);
    let commit_hash = commit_file_map_to_dirty_ref(
        &fixture.local_bare,
        Some(parent.as_str()),
        &files,
        "local update",
    )
    .unwrap();

    crate::git_ops::push_origin_dirty(&fixture.local_bare, "test-token").unwrap();

    let remote_dirty = git_rev_parse(&fixture.remote_bare, "dirty").unwrap();
    assert_eq!(remote_dirty, commit_hash);
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

    let push_err =
        crate::git_ops::push_origin_dirty(&fixture.local_bare, "test-token").unwrap_err();
    assert!(push_err.to_string().contains("git push failed"));

    crate::git_ops::force_push_origin_dirty(&fixture.local_bare, "test-token").unwrap();

    let remote_dirty = git_rev_parse(&fixture.remote_bare, "dirty").unwrap();
    assert_eq!(remote_dirty, local_commit);
}

#[test]
fn materialize_treeish_to_worktree_creates_plain_directory_without_git_metadata() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let fixture = create_bare_fixture();
    let work_tree = fixture._tmp.path().join("materialized");
    std::fs::create_dir_all(&work_tree).unwrap();
    std::fs::write(work_tree.join("stale.txt"), "stale").unwrap();

    materialize_treeish_to_worktree(&fixture.local_bare, "dirty", &work_tree).unwrap();

    assert!(work_tree.join("posts/rec1.json").exists());
    assert!(!work_tree.join("stale.txt").exists());
    assert!(!work_tree.join(".git").exists());
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

/// Verify that the TreeCache avoids redundant reads and returns consistent results.
#[test]
fn tree_cache_returns_same_result_on_repeated_reads() {
    let fixture = create_bare_fixture();
    let hash = git_rev_parse(&fixture.local_bare, "refs/heads/dirty").unwrap();

    let mut cache = TreeCache::new();
    let first = cached_read_git_tree(&mut cache, &fixture.local_bare, &hash)
        .unwrap()
        .clone();
    let second = cached_read_git_tree(&mut cache, &fixture.local_bare, &hash)
        .unwrap()
        .clone();

    assert_eq!(first, second);
    assert_eq!(first.len(), 2);
}

fn git_available() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn json_bytes(value: &str) -> Vec<u8> {
    value.as_bytes().to_vec()
}

fn empty_conn_ctx() -> ConnectionContext {
    ConnectionContext {
        conn_dir_name: "Conn".to_string(),
        dirty_dir: PathBuf::new(),
        scratch_dir: PathBuf::new(),
        master_dir: PathBuf::new(),
        reviewed_dirty_dir: PathBuf::new(),
        bare_repo: PathBuf::new(),
        db_path: PathBuf::new(),
    }
}

#[test]
fn accept_field_in_folder_accepts_modified_and_created_rows_but_ignores_deleted_rows() {
    let ctx = empty_conn_ctx();

    let base_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"name":"Before","ts":"a"}"#),
        ),
        (
            "public/smoke_records/record-3.json".to_string(),
            json_bytes(r#"{"id":3,"name":"Deleted dirty","ts":"c"}"#),
        ),
    ]);
    let local_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"name":"After","ts":"a"}"#),
        ),
        (
            "public/smoke_records/record-2.json".to_string(),
            json_bytes(r#"{"id":2,"name":"Created","ts":"b"}"#),
        ),
    ]);

    let (accepted_map, result) =
        accept_field_in_folder(&ctx, "public/smoke_records", "name", &base_map, &local_map)
            .unwrap();

    assert_eq!(
        String::from_utf8(accepted_map["public/smoke_records/record-1.json"].clone()).unwrap(),
        "{\n  \"id\": 1,\n  \"name\": \"After\",\n  \"ts\": \"a\"\n}"
    );
    assert_eq!(
        String::from_utf8(accepted_map["public/smoke_records/record-2.json"].clone()).unwrap(),
        "{\n  \"name\": \"Created\"\n}"
    );
    assert!(accepted_map.contains_key("public/smoke_records/record-3.json"));
    assert_eq!(
        result.changed_paths,
        vec![
            "Conn/public/smoke_records/record-1.json".to_string(),
            "Conn/public/smoke_records/record-2.json".to_string(),
        ]
    );
    assert!(result.dirty_changed);
}

#[test]
fn reject_field_in_folder_discards_unreviewed_and_undoes_unpublished_for_one_field() {
    let ctx = empty_conn_ctx();

    let base_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"name":"Dirty","ts":"a"}"#),
        ),
        (
            "public/smoke_records/record-3.json".to_string(),
            json_bytes(r#"{"id":3,"name":"Created approved"}"#),
        ),
        (
            "public/smoke_records/record-4.json".to_string(),
            json_bytes(r#"{"id":4,"name":"Deleted dirty"}"#),
        ),
    ]);
    let local_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"name":"Local edit","ts":"a"}"#),
        ),
        (
            "public/smoke_records/record-2.json".to_string(),
            json_bytes(r#"{"id":2,"name":"Created local"}"#),
        ),
        (
            "public/smoke_records/record-3.json".to_string(),
            json_bytes(r#"{"id":3,"name":"Created approved"}"#),
        ),
    ]);
    let master_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"name":"Dirty","ts":"a"}"#),
        ),
        (
            "public/smoke_records/record-3.json".to_string(),
            json_bytes(r#"{"id":3}"#),
        ),
    ]);

    let (next_local_map, next_dirty_map, result) = reject_field_in_folder(
        &ctx,
        "public/smoke_records",
        "name",
        &base_map,
        &local_map,
        &master_map,
    )
    .unwrap();

    assert_eq!(
        String::from_utf8(next_local_map["public/smoke_records/record-1.json"].clone()).unwrap(),
        "{\n  \"id\": 1,\n  \"name\": \"Dirty\",\n  \"ts\": \"a\"\n}"
    );
    assert_eq!(
        String::from_utf8(next_local_map["public/smoke_records/record-2.json"].clone()).unwrap(),
        "{\n  \"id\": 2\n}"
    );
    assert_eq!(
        String::from_utf8(next_local_map["public/smoke_records/record-3.json"].clone()).unwrap(),
        "{\n  \"id\": 3\n}"
    );
    assert_eq!(
        String::from_utf8(next_dirty_map["public/smoke_records/record-3.json"].clone()).unwrap(),
        "{\n  \"id\": 3\n}"
    );
    assert!(next_dirty_map.contains_key("public/smoke_records/record-4.json"));
    assert_eq!(
        result.changed_paths,
        vec![
            "Conn/public/smoke_records/record-1.json".to_string(),
            "Conn/public/smoke_records/record-2.json".to_string(),
            "Conn/public/smoke_records/record-3.json".to_string(),
        ]
    );
    assert!(result.dirty_changed);
}

#[test]
fn field_commands_handle_nested_paths_and_prune_empty_parents() {
    let ctx = empty_conn_ctx();

    let base_map = HashMap::from([(
        "public/smoke_records/record-1.json".to_string(),
        json_bytes(r#"{"id":1,"author":{"name":"Before","role":"editor"}}"#),
    )]);
    let accept_local_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"author":{"name":"After","role":"editor"}}"#),
        ),
        (
            "public/smoke_records/record-2.json".to_string(),
            json_bytes(r#"{"id":2,"author":{"name":"Created"}}"#),
        ),
    ]);
    let reject_local_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"author":{"name":"After","role":"editor"}}"#),
        ),
        (
            "public/smoke_records/record-2.json".to_string(),
            json_bytes(r#"{"id":2,"author":{"name":"Created"}}"#),
        ),
        (
            "public/smoke_records/record-3.json".to_string(),
            json_bytes(r#"{"id":3,"author":{"name":"Approved nested"}}"#),
        ),
    ]);
    let dirty_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"author":{"name":"Before","role":"editor"}}"#),
        ),
        (
            "public/smoke_records/record-3.json".to_string(),
            json_bytes(r#"{"id":3,"author":{"name":"Approved nested"}}"#),
        ),
    ]);
    let master_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"author":{"name":"Before","role":"editor"}}"#),
        ),
        (
            "public/smoke_records/record-3.json".to_string(),
            json_bytes(r#"{"id":3}"#),
        ),
    ]);

    let (accepted_map, accept_result) = accept_field_in_folder(
        &ctx,
        "public/smoke_records",
        "author.name",
        &base_map,
        &accept_local_map,
    )
    .unwrap();

    assert_eq!(
        String::from_utf8(accepted_map["public/smoke_records/record-1.json"].clone()).unwrap(),
        "{\n  \"author\": {\n    \"name\": \"After\",\n    \"role\": \"editor\"\n  },\n  \"id\": 1\n}"
    );
    assert_eq!(
        String::from_utf8(accepted_map["public/smoke_records/record-2.json"].clone()).unwrap(),
        "{\n  \"author\": {\n    \"name\": \"Created\"\n  }\n}"
    );
    assert_eq!(accept_result.changed_paths.len(), 2);

    let (next_local_map, next_dirty_map, reject_result) = reject_field_in_folder(
        &ctx,
        "public/smoke_records",
        "author.name",
        &dirty_map,
        &reject_local_map,
        &master_map,
    )
    .unwrap();

    assert_eq!(
        String::from_utf8(next_local_map["public/smoke_records/record-1.json"].clone()).unwrap(),
        "{\n  \"author\": {\n    \"name\": \"Before\",\n    \"role\": \"editor\"\n  },\n  \"id\": 1\n}"
    );
    assert_eq!(
        String::from_utf8(next_local_map["public/smoke_records/record-2.json"].clone()).unwrap(),
        "{\n  \"id\": 2\n}"
    );
    assert_eq!(
        String::from_utf8(next_local_map["public/smoke_records/record-3.json"].clone()).unwrap(),
        "{\n  \"id\": 3\n}"
    );
    assert_eq!(
        String::from_utf8(next_dirty_map["public/smoke_records/record-3.json"].clone()).unwrap(),
        "{\n  \"id\": 3\n}"
    );
    assert_eq!(reject_result.changed_paths.len(), 3);
    assert!(reject_result.dirty_changed);
}

#[test]
fn reject_field_in_folder_deletes_created_file_when_last_field_is_removed() {
    let ctx = empty_conn_ctx();

    let base_map = HashMap::new();
    let local_map = HashMap::from([(
        "public/smoke_records/record-1.json".to_string(),
        json_bytes(r#"{"name":"Only field"}"#),
    )]);
    let master_map = HashMap::new();

    let (next_local_map, next_dirty_map, result) = reject_field_in_folder(
        &ctx,
        "public/smoke_records",
        "name",
        &base_map,
        &local_map,
        &master_map,
    )
    .unwrap();

    assert!(!next_local_map.contains_key("public/smoke_records/record-1.json"));
    assert!(next_dirty_map.is_empty());
    assert_eq!(
        result.changed_paths,
        vec!["Conn/public/smoke_records/record-1.json".to_string()]
    );
    assert!(!result.dirty_changed);
}

#[test]
fn field_commands_are_noop_when_target_field_has_no_relevant_changes() {
    let ctx = empty_conn_ctx();

    let base_map = HashMap::from([(
        "public/smoke_records/record-1.json".to_string(),
        json_bytes(r#"{"id":1,"name":"Stable","ts":"a"}"#),
    )]);
    let local_map = HashMap::from([(
        "public/smoke_records/record-1.json".to_string(),
        json_bytes(r#"{"id":1,"name":"Stable","ts":"a"}"#),
    )]);
    let master_map = base_map.clone();

    let (accepted_map, accept_result) =
        accept_field_in_folder(&ctx, "public/smoke_records", "name", &base_map, &local_map)
            .unwrap();
    let (next_local_map, next_dirty_map, reject_result) = reject_field_in_folder(
        &ctx,
        "public/smoke_records",
        "name",
        &base_map,
        &local_map,
        &master_map,
    )
    .unwrap();

    assert_eq!(accepted_map, base_map);
    assert!(accept_result.changed_paths.is_empty());
    assert!(!accept_result.dirty_changed);
    assert_eq!(next_local_map, local_map);
    assert_eq!(next_dirty_map, base_map);
    assert!(reject_result.changed_paths.is_empty());
    assert!(!reject_result.dirty_changed);
}

#[test]
fn field_commands_only_touch_requested_folder() {
    let ctx = empty_conn_ctx();

    let base_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"name":"Before"}"#),
        ),
        (
            "public/other_records/record-1.json".to_string(),
            json_bytes(r#"{"id":10,"name":"Other before"}"#),
        ),
    ]);
    let local_map = HashMap::from([
        (
            "public/smoke_records/record-1.json".to_string(),
            json_bytes(r#"{"id":1,"name":"After"}"#),
        ),
        (
            "public/other_records/record-1.json".to_string(),
            json_bytes(r#"{"id":10,"name":"Other after"}"#),
        ),
    ]);
    let master_map = base_map.clone();

    let (accepted_map, accept_result) =
        accept_field_in_folder(&ctx, "public/smoke_records", "name", &base_map, &local_map)
            .unwrap();
    let (next_local_map, next_dirty_map, reject_result) = reject_field_in_folder(
        &ctx,
        "public/smoke_records",
        "name",
        &base_map,
        &local_map,
        &master_map,
    )
    .unwrap();

    assert_eq!(
        String::from_utf8(accepted_map["public/smoke_records/record-1.json"].clone()).unwrap(),
        "{\n  \"id\": 1,\n  \"name\": \"After\"\n}"
    );
    assert_eq!(
        accepted_map["public/other_records/record-1.json"],
        base_map["public/other_records/record-1.json"]
    );
    assert_eq!(
        String::from_utf8(next_local_map["public/smoke_records/record-1.json"].clone()).unwrap(),
        "{\n  \"id\": 1,\n  \"name\": \"Before\"\n}"
    );
    assert_eq!(
        next_local_map["public/other_records/record-1.json"],
        local_map["public/other_records/record-1.json"]
    );
    assert_eq!(
        next_dirty_map["public/other_records/record-1.json"],
        base_map["public/other_records/record-1.json"]
    );
    assert_eq!(
        accept_result.changed_paths,
        vec!["Conn/public/smoke_records/record-1.json".to_string()]
    );
    assert_eq!(
        reject_result.changed_paths,
        vec!["Conn/public/smoke_records/record-1.json".to_string()]
    );
}

#[test]
fn accept_field_in_folder_ignores_unpublished_only_changes() {
    let ctx = empty_conn_ctx();

    let base_map = HashMap::from([(
        "public/smoke_records/record-1.json".to_string(),
        json_bytes(r#"{"id":1,"name":"Approved value"}"#),
    )]);
    let local_map = base_map.clone();

    let (accepted_map, result) =
        accept_field_in_folder(&ctx, "public/smoke_records", "name", &base_map, &local_map)
            .unwrap();

    assert_eq!(accepted_map, base_map);
    assert!(result.changed_paths.is_empty());
    assert!(!result.dirty_changed);
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
