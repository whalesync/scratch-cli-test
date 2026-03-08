use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Metadata about a foreign key path found in a JSON Schema.
#[derive(Debug, Clone)]
pub struct FkPath {
    /// Path segments to the FK field. `"[]"` represents array iteration.
    pub path: Vec<String>,
    /// The remote table ID that this FK points to.
    pub target_remote_table_id: Option<String>,
    /// Optional map configuration (e.g., for lookup fields).
    pub map: Option<String>,
}

/// Extract foreign key paths from a JSON Schema.
///
/// Walks properties, items, oneOf/anyOf/allOf looking for `x-scratch-foreign-key`.
/// Returns a list of FK path descriptors.
pub fn extract_fk_paths(schema: &Value) -> Vec<FkPath> {
    let mut results = Vec::new();
    walk_schema(schema, &[], &mut results);
    results
}

fn walk_schema(node: &Value, current_path: &[String], results: &mut Vec<FkPath>) {
    let obj = match node.as_object() {
        Some(o) => o,
        None => return,
    };

    // Check for x-scratch-foreign-key
    if let Some(fk) = obj.get("x-scratch-foreign-key") {
        let (linked_table_id, map) = match fk {
            Value::String(s) => (Some(s.clone()), None),
            Value::Object(fk_obj) => {
                let linked = fk_obj
                    .get("linkedTableId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let map_val = fk_obj
                    .get("map")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                (linked, map_val)
            }
            _ => (None, None),
        };

        if let Some(table_id) = linked_table_id {
            results.push(FkPath {
                path: current_path.to_vec(),
                target_remote_table_id: Some(table_id),
                map,
            });
        }
    }

    // Recurse into properties
    if let Some(Value::Object(props)) = obj.get("properties") {
        for (key, prop) in props {
            let mut child_path = current_path.to_vec();
            child_path.push(key.clone());
            walk_schema(prop, &child_path, results);
        }
    }

    // Recurse into items (for array schemas)
    if let Some(items) = obj.get("items") {
        if !items.is_array() {
            // Single schema (not tuple validation)
            let mut child_path = current_path.to_vec();
            child_path.push("[]".to_string());
            walk_schema(items, &child_path, results);
        }
    }

    // Handle oneOf, anyOf, allOf — these do NOT increase the data path depth
    for combinator in &["oneOf", "anyOf", "allOf"] {
        if let Some(Value::Array(sub_schemas)) = obj.get(*combinator) {
            for sub_schema in sub_schemas {
                walk_schema(sub_schema, current_path, results);
            }
        }
    }
}

/// Strip values matching deleted record IDs from FK fields.
///
/// Walks FK paths from the schema, then for each path navigates into the content
/// and nullifies or filters out values that match the deleted IDs.
pub fn strip_deleted_refs(content: &mut Value, schema: &Value, deleted_ids: &HashSet<String>) {
    if deleted_ids.is_empty() {
        return;
    }
    let fk_paths = extract_fk_paths(schema);
    for fk in &fk_paths {
        strip_at_nodes(content, &fk.path, &|value| deleted_ids.contains(value));
    }
}

/// Strip pseudo-refs (`@/` prefixed values) from content.
///
/// Returns `true` if any values were stripped.
pub fn strip_pseudo_refs(content: &mut Value, schema: &Value) -> bool {
    let fk_paths = extract_fk_paths(schema);
    let mut any_changed = false;
    for fk in &fk_paths {
        if strip_at_nodes(content, &fk.path, &|value| value.starts_with("@/")) {
            any_changed = true;
        }
    }
    any_changed
}

/// Resolve pseudo-refs: replace `@/path.json` values with real record IDs from `file_index`.
///
/// Walks all string values recursively and replaces `@/...` references with the
/// corresponding record ID from the file index lookup.
pub fn resolve_pseudo_refs(content: &mut Value, file_index: &HashMap<String, String>) {
    resolve_pseudo_refs_recursive(content, file_index);
}

fn resolve_pseudo_refs_recursive(value: &mut Value, file_index: &HashMap<String, String>) {
    match value {
        Value::String(s) => {
            if s.starts_with("@/") {
                let target_path = &s[2..];
                if let Some(record_id) = file_index.get(target_path) {
                    *value = Value::String(record_id.clone());
                }
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                resolve_pseudo_refs_recursive(item, file_index);
            }
        }
        Value::Object(map) => {
            for (_key, val) in map.iter_mut() {
                resolve_pseudo_refs_recursive(val, file_index);
            }
        }
        _ => {}
    }
}

/// Recursive traversal to strip values at a given path that match a predicate.
///
/// Handles `[]` in the path (iterate all array elements) and arrays as terminal values
/// (filter out matching elements). For scalar terminal values, replaces with null if matched.
///
/// Returns `true` if any change was made.
fn strip_at_nodes(root: &mut Value, path: &[String], predicate: &dyn Fn(&str) -> bool) -> bool {
    if path.is_empty() {
        return false;
    }

    let head = &path[0];
    let tail = &path[1..];

    if head == "[]" {
        // Iterate array elements
        if let Value::Array(arr) = root {
            let mut changed = false;
            for item in arr.iter_mut() {
                if tail.is_empty() {
                    if check_and_strip(item, predicate) {
                        changed = true;
                    }
                } else if strip_at_nodes(item, tail, predicate) {
                    changed = true;
                }
            }
            changed
        } else {
            false
        }
    } else {
        // Navigate into object by key
        if let Value::Object(map) = root {
            if let Some(child) = map.get_mut(head) {
                if tail.is_empty() {
                    check_and_strip(child, predicate)
                } else {
                    strip_at_nodes(child, tail, predicate)
                }
            } else {
                false
            }
        } else {
            false
        }
    }
}

/// Check a value against a predicate and strip matching entries.
///
/// - For arrays: filters out elements matching the predicate.
/// - For strings/numbers: replaces with null if matching.
///
/// Returns `true` if any change was made.
fn check_and_strip(value: &mut Value, predicate: &dyn Fn(&str) -> bool) -> bool {
    match value {
        Value::Array(arr) => {
            let original_len = arr.len();
            arr.retain(|item| {
                let s = value_as_string(item);
                match s {
                    Some(ref sv) => !predicate(sv),
                    None => true,
                }
            });
            arr.len() != original_len
        }
        _ => {
            if let Some(s) = value_as_string(value) {
                if predicate(&s) {
                    *value = Value::Null;
                    return true;
                }
            }
            false
        }
    }
}

/// Convert a JSON value to its string representation for predicate matching.
/// Matches the TypeScript behavior: strings and numbers are converted to string form.
fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- extract_fk_paths ---

    #[test]
    fn extract_fk_paths_simple_string_fk() {
        let schema = json!({
            "properties": {
                "author": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_users"
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, vec!["author"]);
        assert_eq!(paths[0].target_remote_table_id.as_deref(), Some("tbl_users"));
        assert!(paths[0].map.is_none());
    }

    #[test]
    fn extract_fk_paths_object_fk_with_map() {
        let schema = json!({
            "properties": {
                "category": {
                    "type": "string",
                    "x-scratch-foreign-key": {
                        "linkedTableId": "tbl_categories",
                        "map": "name"
                    }
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, vec!["category"]);
        assert_eq!(
            paths[0].target_remote_table_id.as_deref(),
            Some("tbl_categories")
        );
        assert_eq!(paths[0].map.as_deref(), Some("name"));
    }

    #[test]
    fn extract_fk_paths_nested_in_properties() {
        let schema = json!({
            "properties": {
                "fields": {
                    "type": "object",
                    "properties": {
                        "linked_record": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": "tbl_other"
                            }
                        }
                    }
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, vec!["fields", "linked_record", "[]"]);
        assert_eq!(paths[0].target_remote_table_id.as_deref(), Some("tbl_other"));
    }

    #[test]
    fn extract_fk_paths_with_any_of() {
        let schema = json!({
            "properties": {
                "ref_field": {
                    "anyOf": [
                        {"type": "string", "x-scratch-foreign-key": "tbl_a"},
                        {"type": "null"}
                    ]
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, vec!["ref_field"]);
        assert_eq!(paths[0].target_remote_table_id.as_deref(), Some("tbl_a"));
    }

    #[test]
    fn extract_fk_paths_returns_empty_for_no_fks() {
        let schema = json!({
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "number"}
            }
        });
        let paths = extract_fk_paths(&schema);
        assert!(paths.is_empty());
    }

    #[test]
    fn extract_fk_paths_multiple_fks() {
        let schema = json!({
            "properties": {
                "author": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_users"
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_tags"
                    }
                }
            }
        });
        let paths = extract_fk_paths(&schema);
        assert_eq!(paths.len(), 2);
    }

    // --- strip_deleted_refs ---

    #[test]
    fn strip_deleted_refs_nullifies_scalar_fk() {
        let schema = json!({
            "properties": {
                "author": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_users"
                }
            }
        });
        let mut content = json!({"author": "rec_123", "title": "Hello"});
        let deleted = HashSet::from(["rec_123".to_string()]);

        strip_deleted_refs(&mut content, &schema, &deleted);
        assert_eq!(content, json!({"author": null, "title": "Hello"}));
    }

    #[test]
    fn strip_deleted_refs_nullifies_array_elements_via_items_fk() {
        // When FK is on `items`, the path is ["tags", "[]"].
        // Each array element is checked individually as a scalar -> nullified (not filtered).
        let schema = json!({
            "properties": {
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_tags"
                    }
                }
            }
        });
        let mut content = json!({"tags": ["rec_1", "rec_2", "rec_3"]});
        let deleted = HashSet::from(["rec_2".to_string()]);

        strip_deleted_refs(&mut content, &schema, &deleted);
        // Each element is individually check_and_stripped as a scalar -> null
        assert_eq!(content, json!({"tags": ["rec_1", null, "rec_3"]}));
    }

    #[test]
    fn strip_deleted_refs_handles_nested_object_with_array_fk() {
        // FK path is ["fields", "related", "[]"]. Each element is individually nullified.
        let schema = json!({
            "properties": {
                "fields": {
                    "type": "object",
                    "properties": {
                        "related": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "x-scratch-foreign-key": "tbl_items"
                            }
                        }
                    }
                }
            }
        });
        let mut content = json!({"fields": {"related": ["rec_a", "rec_b"], "name": "Test"}});
        let deleted = HashSet::from(["rec_a".to_string()]);

        strip_deleted_refs(&mut content, &schema, &deleted);
        assert_eq!(
            content,
            json!({"fields": {"related": [null, "rec_b"], "name": "Test"}})
        );
    }

    #[test]
    fn strip_deleted_refs_no_change_when_no_matching_ids() {
        let schema = json!({
            "properties": {
                "author": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_users"
                }
            }
        });
        let mut content = json!({"author": "rec_999", "title": "Hello"});
        let deleted = HashSet::from(["rec_123".to_string()]);

        strip_deleted_refs(&mut content, &schema, &deleted);
        assert_eq!(content, json!({"author": "rec_999", "title": "Hello"}));
    }

    #[test]
    fn strip_deleted_refs_no_change_when_deleted_ids_empty() {
        let schema = json!({
            "properties": {
                "author": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_users"
                }
            }
        });
        let mut content = json!({"author": "rec_123"});
        let deleted = HashSet::new();

        strip_deleted_refs(&mut content, &schema, &deleted);
        assert_eq!(content, json!({"author": "rec_123"}));
    }

    // --- strip_pseudo_refs ---

    #[test]
    fn strip_pseudo_refs_nullifies_scalar() {
        let schema = json!({
            "properties": {
                "ref_field": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_other"
                }
            }
        });
        let mut content = json!({"ref_field": "@/articles/new-post.json", "title": "Hello"});

        let changed = strip_pseudo_refs(&mut content, &schema);
        assert!(changed);
        assert_eq!(content, json!({"ref_field": null, "title": "Hello"}));
    }

    #[test]
    fn strip_pseudo_refs_nullifies_array_elements() {
        // FK on items -> path is ["refs", "[]"]. Each element is checked individually.
        let schema = json!({
            "properties": {
                "refs": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "x-scratch-foreign-key": "tbl_other"
                    }
                }
            }
        });
        let mut content = json!({"refs": ["rec_1", "@/new/item.json", "rec_2"]});

        let changed = strip_pseudo_refs(&mut content, &schema);
        assert!(changed);
        assert_eq!(content, json!({"refs": ["rec_1", null, "rec_2"]}));
    }

    #[test]
    fn strip_pseudo_refs_returns_false_when_none_present() {
        let schema = json!({
            "properties": {
                "ref_field": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_other"
                }
            }
        });
        let mut content = json!({"ref_field": "rec_123"});

        let changed = strip_pseudo_refs(&mut content, &schema);
        assert!(!changed);
        assert_eq!(content, json!({"ref_field": "rec_123"}));
    }

    #[test]
    fn strip_pseudo_refs_handles_null_field() {
        let schema = json!({
            "properties": {
                "ref_field": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_other"
                }
            }
        });
        let mut content = json!({"ref_field": null});

        let changed = strip_pseudo_refs(&mut content, &schema);
        assert!(!changed);
        assert_eq!(content, json!({"ref_field": null}));
    }

    // --- resolve_pseudo_refs ---

    #[test]
    fn resolve_pseudo_refs_replaces_refs() {
        let mut content = json!({
            "author": "@/users/john.json",
            "title": "Hello"
        });
        let mut index = HashMap::new();
        index.insert("users/john.json".to_string(), "rec_john_123".to_string());

        resolve_pseudo_refs(&mut content, &index);
        assert_eq!(
            content,
            json!({"author": "rec_john_123", "title": "Hello"})
        );
    }

    #[test]
    fn resolve_pseudo_refs_handles_arrays() {
        let mut content = json!({
            "tags": ["@/tags/rust.json", "@/tags/wasm.json", "rec_existing"]
        });
        let mut index = HashMap::new();
        index.insert("tags/rust.json".to_string(), "rec_rust".to_string());
        index.insert("tags/wasm.json".to_string(), "rec_wasm".to_string());

        resolve_pseudo_refs(&mut content, &index);
        assert_eq!(
            content,
            json!({"tags": ["rec_rust", "rec_wasm", "rec_existing"]})
        );
    }

    #[test]
    fn resolve_pseudo_refs_leaves_unmatched_refs() {
        let mut content = json!({"ref": "@/unknown/path.json"});
        let index = HashMap::new();

        resolve_pseudo_refs(&mut content, &index);
        assert_eq!(content, json!({"ref": "@/unknown/path.json"}));
    }

    #[test]
    fn resolve_pseudo_refs_nested_objects() {
        let mut content = json!({
            "fields": {
                "author": "@/users/alice.json",
                "name": "Post"
            }
        });
        let mut index = HashMap::new();
        index.insert("users/alice.json".to_string(), "rec_alice".to_string());

        resolve_pseudo_refs(&mut content, &index);
        assert_eq!(
            content,
            json!({"fields": {"author": "rec_alice", "name": "Post"}})
        );
    }

    // --- strip_at_nodes helper (tested indirectly through strip_*) ---

    #[test]
    fn strip_at_nodes_handles_missing_path() {
        let schema = json!({
            "properties": {
                "nonexistent": {
                    "type": "string",
                    "x-scratch-foreign-key": "tbl_foo"
                }
            }
        });
        let mut content = json!({"title": "Hello"});
        let deleted = HashSet::from(["rec_1".to_string()]);

        strip_deleted_refs(&mut content, &schema, &deleted);
        assert_eq!(content, json!({"title": "Hello"}));
    }

    #[test]
    fn strip_at_nodes_handles_array_bracket_in_path_with_objects() {
        // Schema: properties.items.items.properties.ref has FK
        // Data path: ["items", "[]", "ref"]
        // Only elements whose "ref" field starts with "@/" should be nullified.
        let schema = json!({
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ref": {
                                "type": "string",
                                "x-scratch-foreign-key": "tbl_other"
                            }
                        }
                    }
                }
            }
        });
        let mut content = json!({
            "items": [
                {"ref": "rec_1", "name": "A"},
                {"ref": "@/new/item.json", "name": "B"},
                {"ref": "rec_2", "name": "C"}
            ]
        });

        let changed = strip_pseudo_refs(&mut content, &schema);
        assert!(changed);
        assert_eq!(
            content,
            json!({
                "items": [
                    {"ref": "rec_1", "name": "A"},
                    {"ref": null, "name": "B"},
                    {"ref": "rec_2", "name": "C"}
                ]
            })
        );
    }

    #[test]
    fn strip_pseudo_refs_in_array_of_objects() {
        let schema = json!({
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ref": {
                                "type": "string",
                                "x-scratch-foreign-key": "tbl_other"
                            }
                        }
                    }
                }
            }
        });
        let mut content = json!({
            "items": [
                {"ref": "rec_1", "name": "A"},
                {"ref": "@/new/item.json", "name": "B"},
                {"ref": "rec_2", "name": "C"}
            ]
        });

        let changed = strip_pseudo_refs(&mut content, &schema);
        assert!(changed);
        assert_eq!(
            content,
            json!({
                "items": [
                    {"ref": "rec_1", "name": "A"},
                    {"ref": null, "name": "B"},
                    {"ref": "rec_2", "name": "C"}
                ]
            })
        );
    }

    #[test]
    fn strip_deleted_refs_with_array_fk_field_value() {
        // FK path points to a field whose value is an array of IDs
        let schema = json!({
            "properties": {
                "linked": {
                    "type": "array",
                    "x-scratch-foreign-key": "tbl_items"
                }
            }
        });
        // path = ["linked"], terminal value is an array
        let mut content = json!({"linked": ["rec_1", "rec_2", "rec_3"]});
        let deleted = HashSet::from(["rec_2".to_string()]);

        strip_deleted_refs(&mut content, &schema, &deleted);
        assert_eq!(content, json!({"linked": ["rec_1", "rec_3"]}));
    }
}
