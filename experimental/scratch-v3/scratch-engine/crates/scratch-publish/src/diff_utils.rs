use serde_json::Value;

/// Deep-diff two JSON objects, return sparse object with only changed paths.
///
/// Behavior:
/// - Iterates over keys of `dirty` only
/// - For nested plain objects, recurses and only includes changed sub-paths
/// - Arrays are compared atomically via serialization (if different, include entire array)
/// - Removed keys (present in main but absent in dirty) are NOT tracked.
///   Users should set fields to `null` or `""` to clear them, not delete JSON keys.
///   Key removal typically indicates schema changes or reference cleaning, not user intent.
/// - Returns `{}` if nothing changed
pub fn compute_changed_fields(main: &Value, dirty: &Value) -> Value {
    let mut result = serde_json::Map::new();

    let dirty_obj = match dirty.as_object() {
        Some(obj) => obj,
        None => {
            // If dirty isn't an object, compare directly
            if main != dirty {
                return dirty.clone();
            }
            return Value::Object(result);
        }
    };

    let main_obj = main.as_object();

    for (key, dirty_val) in dirty_obj {
        let main_val = main_obj.and_then(|m| m.get(key));

        match (dirty_val, main_val) {
            // Both are plain objects — recurse
            (Value::Object(_), Some(Value::Object(_))) => {
                let nested = compute_changed_fields(main_val.unwrap(), dirty_val);
                if let Value::Object(ref map) = nested {
                    if !map.is_empty() {
                        result.insert(key.clone(), nested);
                    }
                }
            }
            // Compare via serialization for deep equality (handles arrays, primitives, null)
            (dirty_v, Some(main_v)) => {
                if dirty_v != main_v {
                    result.insert(key.clone(), dirty_v.clone());
                }
            }
            // Key absent in main — include
            (dirty_v, None) => {
                result.insert(key.clone(), dirty_v.clone());
            }
        }
    }

    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- Basic behavior ---

    #[test]
    fn returns_empty_for_identical_flat_objects() {
        let result = compute_changed_fields(&json!({"a": 1, "b": "hello"}), &json!({"a": 1, "b": "hello"}));
        assert_eq!(result, json!({}));
    }

    #[test]
    fn returns_only_changed_field_for_single_change() {
        let result = compute_changed_fields(&json!({"a": 1, "b": 2}), &json!({"a": 1, "b": 3}));
        assert_eq!(result, json!({"b": 3}));
    }

    #[test]
    fn returns_multiple_changed_fields() {
        let result = compute_changed_fields(
            &json!({"a": 1, "b": 2, "c": 3}),
            &json!({"a": 10, "b": 2, "c": 30}),
        );
        assert_eq!(result, json!({"a": 10, "c": 30}));
    }

    #[test]
    fn returns_full_dirty_when_all_changed() {
        let result = compute_changed_fields(&json!({"a": 1, "b": 2}), &json!({"a": 10, "b": 20}));
        assert_eq!(result, json!({"a": 10, "b": 20}));
    }

    #[test]
    fn includes_new_fields_added_in_dirty() {
        let result = compute_changed_fields(&json!({"a": 1}), &json!({"a": 1, "b": 2}));
        assert_eq!(result, json!({"b": 2}));
    }

    #[test]
    fn ignores_removed_keys() {
        let result = compute_changed_fields(&json!({"a": 1, "b": 2}), &json!({"a": 1}));
        assert_eq!(result, json!({}));
    }

    // --- Nested objects ---

    #[test]
    fn diffs_nested_field_changes() {
        let result = compute_changed_fields(
            &json!({"fields": {"Name": "Old", "Notes": "Same"}}),
            &json!({"fields": {"Name": "New", "Notes": "Same"}}),
        );
        assert_eq!(result, json!({"fields": {"Name": "New"}}));
    }

    #[test]
    fn includes_only_changed_sibling_in_nested() {
        let main = json!({"meta": {"a": 1, "b": 2}, "other": "x"});
        let dirty = json!({"meta": {"a": 1, "b": 99}, "other": "x"});
        assert_eq!(compute_changed_fields(&main, &dirty), json!({"meta": {"b": 99}}));
    }

    #[test]
    fn handles_deeply_nested_changes() {
        let main = json!({"l1": {"l2": {"l3": "old"}}});
        let dirty = json!({"l1": {"l2": {"l3": "new"}}});
        assert_eq!(
            compute_changed_fields(&main, &dirty),
            json!({"l1": {"l2": {"l3": "new"}}})
        );
    }

    #[test]
    fn includes_new_nested_objects_added_in_dirty() {
        let result = compute_changed_fields(&json!({"a": 1}), &json!({"a": 1, "nested": {"x": 1}}));
        assert_eq!(result, json!({"nested": {"x": 1}}));
    }

    #[test]
    fn ignores_removed_nested_keys() {
        let result = compute_changed_fields(&json!({"a": 1, "nested": {"x": 1}}), &json!({"a": 1}));
        assert_eq!(result, json!({}));
    }

    #[test]
    fn handles_mixed_nested_some_changed_some_not() {
        let main = json!({"fields": {"Name": "Same", "Slug": "old", "Notes": "Same"}});
        let dirty = json!({"fields": {"Name": "Same", "Slug": "new", "Notes": "Same"}});
        assert_eq!(
            compute_changed_fields(&main, &dirty),
            json!({"fields": {"Slug": "new"}})
        );
    }

    #[test]
    fn excludes_parent_when_all_nested_identical() {
        let main = json!({"fields": {"Name": "Same"}, "id": "abc"});
        let dirty = json!({"fields": {"Name": "Same"}, "id": "abc"});
        assert_eq!(compute_changed_fields(&main, &dirty), json!({}));
    }

    // --- Arrays (atomic comparison) ---

    #[test]
    fn treats_identical_arrays_as_unchanged() {
        let result = compute_changed_fields(&json!({"tags": [1, 2, 3]}), &json!({"tags": [1, 2, 3]}));
        assert_eq!(result, json!({}));
    }

    #[test]
    fn includes_entire_array_when_element_changes() {
        let result = compute_changed_fields(&json!({"tags": [1, 2, 3]}), &json!({"tags": [1, 99, 3]}));
        assert_eq!(result, json!({"tags": [1, 99, 3]}));
    }

    #[test]
    fn includes_entire_array_when_length_changes() {
        let result = compute_changed_fields(&json!({"tags": [1, 2]}), &json!({"tags": [1, 2, 3]}));
        assert_eq!(result, json!({"tags": [1, 2, 3]}));
    }

    #[test]
    fn includes_entire_array_of_objects_when_changed() {
        let main = json!({"items": [{"id": 1}, {"id": 2}]});
        let dirty = json!({"items": [{"id": 1}, {"id": 3}]});
        assert_eq!(
            compute_changed_fields(&main, &dirty),
            json!({"items": [{"id": 1}, {"id": 3}]})
        );
    }

    #[test]
    fn treats_nested_array_within_object_atomically() {
        let main = json!({"fields": {"Tags": ["a", "b"]}});
        let dirty = json!({"fields": {"Tags": ["a", "c"]}});
        assert_eq!(
            compute_changed_fields(&main, &dirty),
            json!({"fields": {"Tags": ["a", "c"]}})
        );
    }

    // --- Type/edge cases ---

    #[test]
    fn includes_null_when_key_missing_in_main() {
        let result = compute_changed_fields(&json!({}), &json!({"a": null}));
        assert_eq!(result, json!({"a": null}));
    }

    #[test]
    fn includes_empty_string_when_key_missing_in_main() {
        let result = compute_changed_fields(&json!({}), &json!({"a": ""}));
        assert_eq!(result, json!({"a": ""}));
    }

    #[test]
    fn includes_empty_object_when_key_missing_in_main() {
        let result = compute_changed_fields(&json!({}), &json!({"a": {}}));
        assert_eq!(result, json!({"a": {}}));
    }

    #[test]
    fn treats_both_null_as_no_change() {
        let result = compute_changed_fields(&json!({"a": null}), &json!({"a": null}));
        assert_eq!(result, json!({}));
    }

    #[test]
    fn detects_number_change() {
        assert_eq!(
            compute_changed_fields(&json!({"a": 1}), &json!({"a": 2})),
            json!({"a": 2})
        );
    }

    #[test]
    fn detects_boolean_change() {
        assert_eq!(
            compute_changed_fields(&json!({"a": true}), &json!({"a": false})),
            json!({"a": false})
        );
    }

    #[test]
    fn detects_string_change() {
        assert_eq!(
            compute_changed_fields(&json!({"a": "old"}), &json!({"a": "new"})),
            json!({"a": "new"})
        );
    }

    #[test]
    fn detects_type_change_string_vs_number() {
        assert_eq!(
            compute_changed_fields(&json!({"a": "1"}), &json!({"a": 1})),
            json!({"a": 1})
        );
    }

    // --- Connector-specific structures ---

    #[test]
    fn diffs_airtable_style_records() {
        let main = json!({"id": "rec1", "fields": {"Name": "Old", "Notes": "Same"}});
        let dirty = json!({"id": "rec1", "fields": {"Name": "New", "Notes": "Same"}});
        assert_eq!(
            compute_changed_fields(&main, &dirty),
            json!({"fields": {"Name": "New"}})
        );
    }

    #[test]
    fn diffs_webflow_style_records() {
        let main = json!({"id": "abc", "fieldData": {"slug": "old", "name": "Same"}});
        let dirty = json!({"id": "abc", "fieldData": {"slug": "new", "name": "Same"}});
        assert_eq!(
            compute_changed_fields(&main, &dirty),
            json!({"fieldData": {"slug": "new"}})
        );
    }

    #[test]
    fn diffs_notion_style_records() {
        let main = json!({"id": "page1", "properties": {"Title": {"rich_text": [{"text": "Old"}]}, "Status": "Done"}});
        let dirty =
            json!({"id": "page1", "properties": {"Title": {"rich_text": [{"text": "New"}]}, "Status": "Done"}});
        assert_eq!(
            compute_changed_fields(&main, &dirty),
            json!({"properties": {"Title": {"rich_text": [{"text": "New"}]}}})
        );
    }

    #[test]
    fn returns_full_dirty_when_main_empty() {
        let dirty = json!({"a": 1, "b": "hello"});
        assert_eq!(compute_changed_fields(&json!({}), &dirty), dirty);
    }
}
