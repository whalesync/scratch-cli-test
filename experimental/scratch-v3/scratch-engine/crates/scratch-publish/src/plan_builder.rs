use serde_json::Value;
use std::collections::{HashMap, HashSet};

use scratch_core::filename::is_pending_publish_id;
use scratch_core::types::*;

use super::diff_utils::compute_changed_fields;
use super::ref_manager::{strip_deleted_refs, strip_pseudo_refs};

/// Parse a file path into folder path and filename components.
///
/// ```text
/// "articles/my-post.json" -> ("articles", "my-post.json")
/// "nested/path/file.json" -> ("nested/path", "file.json")
/// "file.json"             -> ("", "file.json")
/// ```
fn parse_path(file_path: &str) -> (&str, &str) {
    match file_path.rfind('/') {
        Some(idx) => (&file_path[..idx], &file_path[idx + 1..]),
        None => ("", file_path),
    }
}

/// Build a publish plan from pre-loaded data. Zero I/O.
///
/// This is a pure function that takes all required data as parameters and produces
/// a `PublishPlan` containing ordered `PublishOperation` entries for edit, create,
/// delete, backfill, and rename-files phases.
///
/// # Parameters
///
/// - `changes` - List of `FileChange` (path + status) from git diff
/// - `file_contents` - Dirty branch file contents, keyed by path
/// - `main_contents` - Main branch file contents, keyed by path
/// - `schemas` - JSON schemas keyed by folder path
/// - `file_index` - Path to remote_record_id mapping
/// - `folder_lookup` - File path to data_folder_id mapping
pub fn build_publish_plan(
    changes: &[FileChange],
    file_contents: &HashMap<String, Value>,
    main_contents: &HashMap<String, Value>,
    schemas: &HashMap<String, Value>,
    file_index: &HashMap<String, String>,
    folder_lookup: &HashMap<String, String>,
) -> PublishPlan {
    let mut operations: Vec<PublishOperation> = Vec::new();

    // Classify changes by status
    let modified: Vec<&FileChange> = changes
        .iter()
        .filter(|c| c.status == FileChangeStatus::Modified)
        .collect();
    let added: Vec<&FileChange> = changes
        .iter()
        .filter(|c| c.status == FileChangeStatus::Added)
        .collect();
    let deleted: Vec<&FileChange> = changes
        .iter()
        .filter(|c| c.status == FileChangeStatus::Deleted)
        .collect();

    // 1. Collect deleted record IDs for ref stripping
    let deleted_ids: HashSet<String> = deleted
        .iter()
        .filter_map(|c| file_index.get(&c.path).cloned())
        .collect();

    // --- Phase 1: Edit ---
    // Process modified files
    let mut backfill_ops: Vec<PublishOperation> = Vec::new();

    for change in &modified {
        let dirty_content = match file_contents.get(&change.path) {
            Some(c) => c,
            None => continue,
        };

        let (folder_path, _filename) = parse_path(&change.path);
        let schema = schemas.get(folder_path);
        let data_folder_id = folder_lookup.get(&change.path).cloned();

        // Two-pass stripping on a clone
        let mut pass1 = dirty_content.clone();
        if let Some(s) = schema {
            strip_deleted_refs(&mut pass1, s, &deleted_ids);
        }

        let mut pass2 = pass1.clone();
        let pseudo_stripped = schema
            .map(|s| strip_pseudo_refs(&mut pass2, s))
            .unwrap_or(false);

        // Compute changed_fields by diffing main vs dirty (after stripping)
        let changed_fields = match main_contents.get(&change.path) {
            Some(main_obj) => compute_changed_fields(main_obj, &pass2),
            None => pass2.clone(),
        };

        operations.push(PublishOperation {
            phase: PublishPhase::Edit,
            path: change.path.clone(),
            content: Some(pass2.clone()),
            changed_fields: Some(changed_fields),
            remote_record_id: None,
            data_folder_id: data_folder_id.clone(),
        });

        // Backfill: if pseudo-ref stripping changed the content, queue a backfill
        if pseudo_stripped {
            let backfill_changed = compute_changed_fields(&pass2, &pass1);
            backfill_ops.push(PublishOperation {
                phase: PublishPhase::Backfill,
                path: change.path.clone(),
                content: Some(pass1),
                changed_fields: Some(backfill_changed),
                remote_record_id: None,
                data_folder_id,
            });
        }
    }

    // --- Phase 2: Create ---
    let mut rename_ops: Vec<PublishOperation> = Vec::new();

    for change in &added {
        let dirty_content = match file_contents.get(&change.path) {
            Some(c) => c,
            None => continue,
        };

        let (folder_path, filename) = parse_path(&change.path);
        let schema = schemas.get(folder_path);
        let data_folder_id = folder_lookup.get(&change.path).cloned();

        // Two-pass stripping on a clone
        let mut pass1 = dirty_content.clone();
        if let Some(s) = schema {
            strip_deleted_refs(&mut pass1, s, &deleted_ids);
        }

        let mut pass2 = pass1.clone();
        let pseudo_stripped = schema
            .map(|s| strip_pseudo_refs(&mut pass2, s))
            .unwrap_or(false);

        operations.push(PublishOperation {
            phase: PublishPhase::Create,
            path: change.path.clone(),
            content: Some(pass2.clone()),
            changed_fields: None,
            remote_record_id: None,
            data_folder_id: data_folder_id.clone(),
        });

        // Check if this is a pending publish file that needs renaming
        if is_pending_publish_id(filename) {
            rename_ops.push(PublishOperation {
                phase: PublishPhase::RenameFiles,
                path: change.path.clone(),
                content: Some(Value::Object(serde_json::Map::new())),
                changed_fields: None,
                remote_record_id: None,
                data_folder_id: data_folder_id.clone(),
            });
        }

        // Backfill for create
        if pseudo_stripped {
            backfill_ops.push(PublishOperation {
                phase: PublishPhase::Backfill,
                path: change.path.clone(),
                content: Some(pass1),
                changed_fields: None,
                remote_record_id: None,
                data_folder_id,
            });
        }
    }

    // --- Phase 3: Delete ---
    for change in &deleted {
        let (_, _filename) = parse_path(&change.path);
        let remote_record_id = file_index.get(&change.path).cloned();
        let data_folder_id = folder_lookup.get(&change.path).cloned();

        operations.push(PublishOperation {
            phase: PublishPhase::Delete,
            path: change.path.clone(),
            content: Some(Value::Object(serde_json::Map::new())),
            changed_fields: None,
            remote_record_id,
            data_folder_id,
        });
    }

    // --- Append backfill and rename operations ---
    operations.extend(backfill_ops);
    operations.extend(rename_ops);

    PublishPlan { operations }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_changes(items: &[(&str, FileChangeStatus)]) -> Vec<FileChange> {
        items
            .iter()
            .map(|(path, status)| FileChange {
                path: path.to_string(),
                status: *status,
            })
            .collect()
    }

    fn make_map(items: &[(&str, Value)]) -> HashMap<String, Value> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn make_str_map(items: &[(&str, &str)]) -> HashMap<String, String> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    // --- Edit operations ---

    #[test]
    fn edit_creates_operation_for_modified_file() {
        let changes = make_changes(&[("articles/post.json", FileChangeStatus::Modified)]);
        let file_contents = make_map(&[("articles/post.json", json!({"title": "New Title"}))]);
        let main_contents = make_map(&[("articles/post.json", json!({"title": "Old Title"}))]);
        let schemas = HashMap::new();
        let file_index = HashMap::new();
        let folder_lookup = make_str_map(&[("articles/post.json", "df_articles")]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &schemas,
            &file_index,
            &folder_lookup,
        );

        assert_eq!(plan.operations.len(), 1);
        let op = &plan.operations[0];
        assert_eq!(op.phase, PublishPhase::Edit);
        assert_eq!(op.path, "articles/post.json");
        assert_eq!(op.changed_fields, Some(json!({"title": "New Title"})));
        assert_eq!(op.data_folder_id.as_deref(), Some("df_articles"));
    }

    #[test]
    fn edit_computes_changed_fields_only_for_changed_keys() {
        let changes = make_changes(&[("articles/post.json", FileChangeStatus::Modified)]);
        let file_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "New", "body": "Same", "slug": "same"}),
        )]);
        let main_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "Old", "body": "Same", "slug": "same"}),
        )]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].changed_fields,
            Some(json!({"title": "New"}))
        );
    }

    #[test]
    fn edit_computes_nested_changed_fields() {
        let changes = make_changes(&[("articles/post.json", FileChangeStatus::Modified)]);
        let file_contents = make_map(&[(
            "articles/post.json",
            json!({"id": "rec1", "fields": {"Name": "New", "Notes": "Same"}}),
        )]);
        let main_contents = make_map(&[(
            "articles/post.json",
            json!({"id": "rec1", "fields": {"Name": "Old", "Notes": "Same"}}),
        )]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(
            plan.operations[0].changed_fields,
            Some(json!({"fields": {"Name": "New"}}))
        );
    }

    #[test]
    fn edit_sets_full_content_as_changed_when_main_missing() {
        let changes = make_changes(&[("articles/post.json", FileChangeStatus::Modified)]);
        let file_contents = make_map(&[("articles/post.json", json!({"title": "New"}))]);
        let main_contents = HashMap::new();

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(
            plan.operations[0].changed_fields,
            Some(json!({"title": "New"}))
        );
    }

    #[test]
    fn edit_empty_changed_fields_when_content_identical() {
        let changes = make_changes(&[("articles/post.json", FileChangeStatus::Modified)]);
        let content = json!({"title": "Same"});
        let file_contents = make_map(&[("articles/post.json", content.clone())]);
        let main_contents = make_map(&[("articles/post.json", content)]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(plan.operations[0].changed_fields, Some(json!({})));
    }

    #[test]
    fn edit_skips_file_not_in_file_contents() {
        let changes = make_changes(&[("articles/ghost.json", FileChangeStatus::Modified)]);
        let file_contents = HashMap::new();
        let main_contents = HashMap::new();

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert!(plan.operations.is_empty());
    }

    // --- Create operations ---

    #[test]
    fn create_operation_for_added_file() {
        let changes = make_changes(&[("articles/new.json", FileChangeStatus::Added)]);
        let file_contents = make_map(&[("articles/new.json", json!({"title": "New Article"}))]);
        let folder_lookup = make_str_map(&[("articles/new.json", "df_articles")]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &folder_lookup,
        );

        assert_eq!(plan.operations.len(), 1);
        let op = &plan.operations[0];
        assert_eq!(op.phase, PublishPhase::Create);
        assert_eq!(op.path, "articles/new.json");
        assert_eq!(op.content, Some(json!({"title": "New Article"})));
        assert!(op.changed_fields.is_none());
        assert_eq!(op.data_folder_id.as_deref(), Some("df_articles"));
    }

    #[test]
    fn create_skips_file_not_in_dirty() {
        let changes = make_changes(&[("articles/ghost.json", FileChangeStatus::Added)]);
        let file_contents = HashMap::new();

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert!(plan.operations.is_empty());
    }

    #[test]
    fn create_does_not_set_changed_fields() {
        let changes = make_changes(&[("articles/new.json", FileChangeStatus::Added)]);
        let file_contents = make_map(&[("articles/new.json", json!({"title": "New"}))]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert!(plan.operations[0].changed_fields.is_none());
    }

    // --- Delete operations ---

    #[test]
    fn delete_operation_for_deleted_file() {
        let changes = make_changes(&[("articles/old.json", FileChangeStatus::Deleted)]);
        let file_index = make_str_map(&[("articles/old.json", "rec_old")]);
        let folder_lookup = make_str_map(&[("articles/old.json", "df_articles")]);

        let plan = build_publish_plan(
            &changes,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &file_index,
            &folder_lookup,
        );

        assert_eq!(plan.operations.len(), 1);
        let op = &plan.operations[0];
        assert_eq!(op.phase, PublishPhase::Delete);
        assert_eq!(op.path, "articles/old.json");
        assert_eq!(op.remote_record_id.as_deref(), Some("rec_old"));
        assert_eq!(op.data_folder_id.as_deref(), Some("df_articles"));
        assert!(op.changed_fields.is_none());
    }

    #[test]
    fn delete_with_no_record_id_still_creates_operation() {
        let changes = make_changes(&[("articles/orphan.json", FileChangeStatus::Deleted)]);

        let plan = build_publish_plan(
            &changes,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(plan.operations.len(), 1);
        let op = &plan.operations[0];
        assert_eq!(op.phase, PublishPhase::Delete);
        assert!(op.remote_record_id.is_none());
    }

    // --- Backfill operations ---

    #[test]
    fn backfill_triggered_when_pseudo_refs_stripped_on_edit() {
        let changes = make_changes(&[("articles/post.json", FileChangeStatus::Modified)]);
        let file_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "Hello", "ref": "@/new/record.json"}),
        )]);
        let main_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "Hello", "ref": "rec_existing"}),
        )]);
        let mut schemas = HashMap::new();
        schemas.insert(
            "articles".to_string(),
            json!({
                "properties": {
                    "ref": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_other"
                    }
                }
            }),
        );

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &schemas,
            &HashMap::new(),
            &HashMap::new(),
        );

        // Should have edit + backfill
        let phases: Vec<_> = plan.operations.iter().map(|op| op.phase).collect();
        assert!(phases.contains(&PublishPhase::Edit));
        assert!(phases.contains(&PublishPhase::Backfill));

        let backfill = plan
            .operations
            .iter()
            .find(|op| op.phase == PublishPhase::Backfill)
            .unwrap();
        assert_eq!(backfill.path, "articles/post.json");
        // Backfill content is the pass1 version (with @/ ref still present)
        let backfill_content = backfill.content.as_ref().unwrap();
        assert_eq!(backfill_content["ref"], "@/new/record.json");
    }

    #[test]
    fn backfill_triggered_when_pseudo_refs_stripped_on_create() {
        let changes = make_changes(&[("articles/new.json", FileChangeStatus::Added)]);
        let file_contents = make_map(&[(
            "articles/new.json",
            json!({"title": "New", "ref": "@/other/item.json"}),
        )]);
        let mut schemas = HashMap::new();
        schemas.insert(
            "articles".to_string(),
            json!({
                "properties": {
                    "ref": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_other"
                    }
                }
            }),
        );

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &HashMap::new(),
            &schemas,
            &HashMap::new(),
            &HashMap::new(),
        );

        let phases: Vec<_> = plan.operations.iter().map(|op| op.phase).collect();
        assert!(phases.contains(&PublishPhase::Create));
        assert!(phases.contains(&PublishPhase::Backfill));
    }

    #[test]
    fn no_backfill_when_no_pseudo_refs() {
        let changes = make_changes(&[("articles/post.json", FileChangeStatus::Modified)]);
        let file_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "New", "ref": "rec_123"}),
        )]);
        let main_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "Old", "ref": "rec_123"}),
        )]);
        let mut schemas = HashMap::new();
        schemas.insert(
            "articles".to_string(),
            json!({
                "properties": {
                    "ref": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_other"
                    }
                }
            }),
        );

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &schemas,
            &HashMap::new(),
            &HashMap::new(),
        );

        let has_backfill = plan.operations.iter().any(|op| op.phase == PublishPhase::Backfill);
        assert!(!has_backfill);
    }

    // --- Rename-files detection ---

    #[test]
    fn rename_files_for_pending_publish_id_filename() {
        let changes = make_changes(&[("articles/spub_abc123.json", FileChangeStatus::Added)]);
        let file_contents = make_map(&[(
            "articles/spub_abc123.json",
            json!({"title": "Pending"}),
        )]);
        let folder_lookup = make_str_map(&[("articles/spub_abc123.json", "df_articles")]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &folder_lookup,
        );

        let phases: Vec<_> = plan.operations.iter().map(|op| op.phase).collect();
        assert!(phases.contains(&PublishPhase::Create));
        assert!(phases.contains(&PublishPhase::RenameFiles));

        let rename = plan
            .operations
            .iter()
            .find(|op| op.phase == PublishPhase::RenameFiles)
            .unwrap();
        assert_eq!(rename.path, "articles/spub_abc123.json");
        assert_eq!(rename.data_folder_id.as_deref(), Some("df_articles"));
    }

    #[test]
    fn no_rename_for_normal_filename() {
        let changes = make_changes(&[("articles/normal.json", FileChangeStatus::Added)]);
        let file_contents = make_map(&[("articles/normal.json", json!({"title": "Normal"}))]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        let has_rename = plan
            .operations
            .iter()
            .any(|op| op.phase == PublishPhase::RenameFiles);
        assert!(!has_rename);
    }

    // --- Deleted ref stripping in edits ---

    #[test]
    fn edit_strips_deleted_record_refs() {
        let changes = make_changes(&[
            ("articles/post.json", FileChangeStatus::Modified),
            ("articles/deleted.json", FileChangeStatus::Deleted),
        ]);
        let file_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "Post", "author": "rec_deleted"}),
        )]);
        let main_contents = make_map(&[(
            "articles/post.json",
            json!({"title": "Post", "author": "rec_deleted"}),
        )]);
        let file_index = make_str_map(&[("articles/deleted.json", "rec_deleted")]);
        let mut schemas = HashMap::new();
        schemas.insert(
            "articles".to_string(),
            json!({
                "properties": {
                    "author": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_users"
                    }
                }
            }),
        );

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &schemas,
            &file_index,
            &HashMap::new(),
        );

        let edit_op = plan
            .operations
            .iter()
            .find(|op| op.phase == PublishPhase::Edit)
            .unwrap();
        // The content should have the ref nullified
        let content = edit_op.content.as_ref().unwrap();
        assert_eq!(content["author"], Value::Null);
    }

    // --- Mixed operations ---

    #[test]
    fn plan_with_all_operation_types() {
        let changes = make_changes(&[
            ("articles/modified.json", FileChangeStatus::Modified),
            ("articles/new.json", FileChangeStatus::Added),
            ("articles/deleted.json", FileChangeStatus::Deleted),
        ]);
        let file_contents = make_map(&[
            ("articles/modified.json", json!({"title": "Updated"})),
            ("articles/new.json", json!({"title": "New"})),
        ]);
        let main_contents = make_map(&[("articles/modified.json", json!({"title": "Old"}))]);
        let file_index = make_str_map(&[("articles/deleted.json", "rec_del")]);
        let folder_lookup = make_str_map(&[
            ("articles/modified.json", "df_1"),
            ("articles/new.json", "df_1"),
            ("articles/deleted.json", "df_1"),
        ]);

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &HashMap::new(),
            &file_index,
            &folder_lookup,
        );

        let phases: Vec<_> = plan.operations.iter().map(|op| op.phase).collect();
        assert!(phases.contains(&PublishPhase::Edit));
        assert!(phases.contains(&PublishPhase::Create));
        assert!(phases.contains(&PublishPhase::Delete));
    }

    #[test]
    fn empty_changes_produce_empty_plan() {
        let plan = build_publish_plan(
            &[],
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );

        assert!(plan.operations.is_empty());
    }

    // --- Operation ordering ---

    #[test]
    fn operations_ordered_edit_create_delete_backfill_rename() {
        let changes = make_changes(&[
            ("articles/modified.json", FileChangeStatus::Modified),
            ("articles/spub_new.json", FileChangeStatus::Added),
            ("articles/deleted.json", FileChangeStatus::Deleted),
        ]);
        let file_contents = make_map(&[
            (
                "articles/modified.json",
                json!({"title": "Mod", "ref": "@/new/item.json"}),
            ),
            ("articles/spub_new.json", json!({"title": "New"})),
        ]);
        let main_contents = make_map(&[(
            "articles/modified.json",
            json!({"title": "Old", "ref": "rec_123"}),
        )]);
        let mut schemas = HashMap::new();
        schemas.insert(
            "articles".to_string(),
            json!({
                "properties": {
                    "ref": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_other"
                    }
                }
            }),
        );

        let plan = build_publish_plan(
            &changes,
            &file_contents,
            &main_contents,
            &schemas,
            &HashMap::new(),
            &HashMap::new(),
        );

        let phases: Vec<_> = plan.operations.iter().map(|op| op.phase).collect();

        // Edits come first, then creates, then deletes, then backfills, then renames
        let edit_idx = phases.iter().position(|p| *p == PublishPhase::Edit).unwrap();
        let create_idx = phases.iter().position(|p| *p == PublishPhase::Create).unwrap();
        let delete_idx = phases.iter().position(|p| *p == PublishPhase::Delete).unwrap();
        let backfill_idx = phases.iter().position(|p| *p == PublishPhase::Backfill).unwrap();
        let rename_idx = phases
            .iter()
            .position(|p| *p == PublishPhase::RenameFiles)
            .unwrap();

        assert!(edit_idx < create_idx);
        assert!(create_idx < delete_idx);
        assert!(delete_idx < backfill_idx);
        assert!(backfill_idx < rename_idx);
    }

    // --- parse_path ---

    #[test]
    fn parse_path_with_folder() {
        let (folder, filename) = parse_path("articles/my-post.json");
        assert_eq!(folder, "articles");
        assert_eq!(filename, "my-post.json");
    }

    #[test]
    fn parse_path_nested_folder() {
        let (folder, filename) = parse_path("deep/nested/path/file.json");
        assert_eq!(folder, "deep/nested/path");
        assert_eq!(filename, "file.json");
    }

    #[test]
    fn parse_path_no_folder() {
        let (folder, filename) = parse_path("file.json");
        assert_eq!(folder, "");
        assert_eq!(filename, "file.json");
    }
}
