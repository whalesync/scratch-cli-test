/// Unit tests for `plan_publish::run`.
///
/// # What plan_publish does
///
/// Given a workspace with a connection, `run` diffs the reviewed-dirty checkout
/// against the master checkout and produces a publish plan — a set of phase files
/// (edit / create / delete / backfill / rename) written under
/// `.scratch/connections/scratch/<conn>/<folder>/publish-plan-<ts>/`.
///
/// ## Pseudo-reference FK stripping
///
/// Record files may contain FK fields whose value starts with `@/` — a
/// "pseudo-reference" pointing at another local file by path (e.g.
/// `"@/public/authors/author-1.json"`).  These cannot be sent to the remote
/// service directly because the target record may not have a remote ID yet.
///
/// `plan_publish` strips them in three passes before writing phase files:
///
/// 1. **Deleted-ref pass** – clear FKs pointing at locally-deleted files.
/// 2. **Pseudo-ref pass** (`strip_pseudo_refs`) – clear `@/…` FKs declared in
///    the folder's `schema.json` (`x-scratch-foreign-key`).  Without a schema
///    entry the field is left untouched.
/// 3. **Asset-pseudo-ref pass** (`strip_asset_pseudo_refs`) – clear `@asset/…`
///    asset references everywhere in the record (no schema needed).
///
/// If stripping produced any change (pass3 ≠ pass1), a **Backfill** phase entry
/// is added alongside the Edit/Create entry.  The backfill content is pass1
/// (the original value with the `@/` reference intact) so the server can resolve
/// it to a real remote ID after creates complete.
///
/// ## Source of dirty files
///
/// `run` reads dirty files from the *reviewed-dirty* checkout
/// (`.scratch/connections/dirty/<conn>/`), not the working-tree checkout.
/// Unreviewed working-tree edits are invisible to the plan.
use super::*;
use serde_json::{json, Value};
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

    // worktree_path (conn_dir) must exist for the existence check in plan_publish::run
    let conn_dir = root.join(conn);
    std::fs::create_dir_all(&conn_dir).unwrap();

    // reviewed_worktree_path is the actual dirty source used by plan_publish::run
    let reviewed_worktree_dir = root
        .join(".scratch")
        .join("connections")
        .join("dirty")
        .join(conn);
    std::fs::create_dir_all(&reviewed_worktree_dir).unwrap();

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

    (tmp, reviewed_worktree_dir, master_dir, scratch_dir, db_path)
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

    run(tmp.path(), None).unwrap();

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

    run(tmp.path(), None).unwrap();

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

    run(tmp.path(), None).unwrap();

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

    run(tmp.path(), None).unwrap();

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

    run(tmp.path(), None).unwrap();

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
fn uses_reviewed_worktree_dir_not_working_tree() {
    let (tmp, reviewed_worktree_dir, master_dir, scratch_dir, _) = make_workspace("my-conn");
    let root = tmp.path();

    // reviewed_worktree_dir matches master — no changes to publish
    write_json(
        &master_dir,
        "posts/rec1.json",
        &json!({"id": "rec1", "fields": {"title": "Committed"}}),
    );
    write_json(
        &reviewed_worktree_dir,
        "posts/rec1.json",
        &json!({"id": "rec1", "fields": {"title": "Committed"}}),
    );
    // conn_dir (dirty working tree) has an unreviewed change — should be ignored
    write_json(
        &root.join("my-conn"),
        "posts/rec1.json",
        &json!({"id": "rec1", "fields": {"title": "Unreviewed"}}),
    );

    run(root, None).unwrap();

    assert!(
        find_plan_root(&scratch_dir).is_none(),
        "plan should use reviewed_worktree_dir, ignoring unreviewed working-tree changes"
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
    let reviewed_worktree_dir = root.join(".scratch/connections/dirty/c");
    std::fs::create_dir_all(&reviewed_worktree_dir).unwrap();
    let master_dir = root.join(".scratch/connections/master/c");
    let scratch_dir = root.join(".scratch/connections/scratch/c");
    std::fs::create_dir_all(&master_dir).unwrap();
    write_json(&master_dir, "t/r.json", &master);
    write_json(&reviewed_worktree_dir, "t/r.json", &dirty);

    run(root, None).unwrap();

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

/// Write a schema.json with a single FK field declaration so that
/// `strip_pseudo_refs` recognises the given `fk_field` as a pseudo-ref path.
fn write_fk_schema(master_dir: &Path, folder: &str, fk_field: &str) {
    let schema = json!({
        "schema": {
            "properties": {
                fk_field: {
                    "x-scratch-foreign-key": { "linkedTableId": "tbl_target" }
                }
            }
        }
    });
    write_json(
        master_dir,
        &format!(".scratch/{folder}/schema.json"),
        &schema,
    );
}

#[test]
fn test_pseudo_ref_fk_stripped_on_edit_produces_backfill() {
    // Existing post with authorId changed to a pseudo-ref.
    // Edit phase must strip it to null; a backfill entry must carry the original @/ value.
    let (tmp, conn_dir, master_dir, scratch_dir, _) = make_workspace("my-conn");

    write_fk_schema(&master_dir, "public/posts", "authorId");

    // title also changes so there is a real edit entry (stripped dirty != master).
    write_json(
        &master_dir,
        "public/posts/post-1.json",
        &json!({"id": "rec1", "title": "Old", "authorId": null}),
    );
    write_json(
        &conn_dir,
        "public/posts/post-1.json",
        &json!({"id": "rec1", "title": "New", "authorId": "@/public/authors/author-1.json"}),
    );

    run(tmp.path(), None).unwrap();

    let plan_root = find_plan_root(&scratch_dir).expect("plan dir not created");
    let plan = read_plan_json(&plan_root);

    assert_eq!(plan["summary"]["edit"], 1, "should have one edit");
    assert_eq!(plan["summary"]["backfill"], 1, "should have one backfill");

    // Edit file: { "content": ..., "changedFields": ... }.  authorId stripped to null.
    let edit_file = phase_file(
        &scratch_dir,
        &plan_root,
        "public/posts",
        "edit",
        "post-1.json",
    );
    let edit: Value = serde_json::from_str(&std::fs::read_to_string(edit_file).unwrap()).unwrap();
    assert!(
        edit["content"]["authorId"].is_null(),
        "edit content should strip pseudo-ref to null"
    );
    assert_eq!(edit["content"]["title"], "New");

    // Backfill file: { "content": ..., "changedFields": ... }.  authorId has @/ value.
    let backfill_file = phase_file(
        &scratch_dir,
        &plan_root,
        "public/posts",
        "backfill",
        "post-1.json",
    );
    let backfill: Value =
        serde_json::from_str(&std::fs::read_to_string(backfill_file).unwrap()).unwrap();
    assert_eq!(
        backfill["content"]["authorId"], "@/public/authors/author-1.json",
        "backfill content should keep the pseudo-ref"
    );
    assert!(
        !backfill["changedFields"].is_null(),
        "backfill should have changedFields"
    );
}

#[test]
fn test_pseudo_ref_fk_stripped_on_create_produces_backfill() {
    // New post (no master entry) with a pseudo-ref authorId.
    // Create phase must strip it; backfill must carry the original value.
    let (tmp, conn_dir, master_dir, scratch_dir, _) = make_workspace("my-conn");

    write_fk_schema(&master_dir, "public/posts", "authorId");

    write_json(
        &conn_dir,
        "public/posts/new-post.json",
        &json!({"title": "New", "authorId": "@/public/authors/author-1.json"}),
    );

    run(tmp.path(), None).unwrap();

    let plan_root = find_plan_root(&scratch_dir).expect("plan dir not created");
    let plan = read_plan_json(&plan_root);

    assert_eq!(plan["summary"]["create"], 1);
    assert_eq!(plan["summary"]["backfill"], 1);

    let create_file = phase_file(
        &scratch_dir,
        &plan_root,
        "public/posts",
        "create",
        "new-post.json",
    );
    let create: Value =
        serde_json::from_str(&std::fs::read_to_string(create_file).unwrap()).unwrap();
    assert!(
        create["content"]["authorId"].is_null(),
        "create content should strip pseudo-ref to null"
    );

    let backfill_file = phase_file(
        &scratch_dir,
        &plan_root,
        "public/posts",
        "backfill",
        "new-post.json",
    );
    // Create backfill has no changedFields, so file_value = entry.content directly (no wrapper).
    let backfill: Value =
        serde_json::from_str(&std::fs::read_to_string(backfill_file).unwrap()).unwrap();
    assert_eq!(
        backfill["authorId"], "@/public/authors/author-1.json",
        "create backfill is written as raw content (no wrapper)"
    );
    assert!(
        backfill.get("changedFields").is_none(),
        "create backfill should not have a changedFields key"
    );
}

#[test]
fn test_pseudo_ref_fk_not_stripped_without_schema() {
    // Without a schema declaring the FK field, @/ values are left in the edit content
    // and no backfill is generated.
    let (tmp, conn_dir, master_dir, scratch_dir, _) = make_workspace("my-conn");

    // No schema written — fk_paths will be empty.

    write_json(
        &master_dir,
        "public/posts/post-1.json",
        &json!({"id": "rec1", "authorId": null}),
    );
    write_json(
        &conn_dir,
        "public/posts/post-1.json",
        &json!({"id": "rec1", "authorId": "@/public/authors/author-1.json"}),
    );

    run(tmp.path(), None).unwrap();

    let plan_root = find_plan_root(&scratch_dir).expect("plan dir not created");
    let plan = read_plan_json(&plan_root);

    assert_eq!(plan["summary"]["edit"], 1);
    assert_eq!(
        plan["summary"]["backfill"], 0,
        "no backfill without schema FK declaration"
    );

    let edit_file = phase_file(
        &scratch_dir,
        &plan_root,
        "public/posts",
        "edit",
        "post-1.json",
    );
    let edit: Value = serde_json::from_str(&std::fs::read_to_string(edit_file).unwrap()).unwrap();
    assert_eq!(
        edit["content"]["authorId"], "@/public/authors/author-1.json",
        "pseudo-ref should be preserved when no schema FK is declared"
    );
}
