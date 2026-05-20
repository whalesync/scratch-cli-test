//! RFC 7396 JSON Merge Patch — diff and apply.
//!
//! Used by the upload-patch flow to compute per-file patches between the local
//! `main` blob (server's known state) and the local `dirty` blob (the state the
//! user wants published). The server applies these patches via
//! `applyJsonMergePatch` in `server/src/publish-plan/apply-patches.service.ts`
//! — the two implementations MUST stay semantically equivalent.
//!
//! Lives in `shared/` (not `cli/`) so `shared/folder_index.rs` can apply
//! patches when computing approvedChanges / unapprovedChanges from
//! `accepted-patches.json`. The `service` binary doesn't use `diff` directly;
//! the module-level allow keeps that side warning-free.

#![allow(dead_code)]

use serde_json::Value as JsonValue;

/// RFC 7396 apply: produce `new` from `target` by applying `patch`.
///
/// Mirror of the server's `applyJsonMergePatch` in
/// `server/src/publish-plan/apply-patches.service.ts`.
///
///   - If `patch` is not an object (scalar, array, null), return `patch`
///     directly — a whole-value replacement.
///   - Otherwise, copy `target` (or start from `{}` if it isn't an object),
///     and for each key in `patch`: `null` deletes, an object value recurses,
///     anything else replaces.
///
/// Used by `re_anchor` to reconstruct user-intended content and by
/// `apply_patch_entry_to_blob` to synthesize the approved blob.
pub fn apply(target: &JsonValue, patch: &JsonValue) -> JsonValue {
    let patch_obj = match patch {
        JsonValue::Object(o) => o,
        _ => return patch.clone(),
    };
    let mut base = match target {
        JsonValue::Object(o) => o.clone(),
        _ => serde_json::Map::new(),
    };
    for (key, value) in patch_obj {
        match value {
            JsonValue::Null => {
                base.shift_remove(key);
            }
            JsonValue::Object(_) => {
                let current = base.get(key).cloned().unwrap_or(JsonValue::Null);
                base.insert(key.clone(), apply(&current, value));
            }
            _ => {
                base.insert(key.clone(), value.clone());
            }
        }
    }
    JsonValue::Object(base)
}

/// RFC 7396 diff of `old` → `new` as JSON values. Returns `None` when the two
/// values are equal (no patch needed).
///
///   - If `new` is a non-object value (number, string, array, bool, null),
///     the patch is `new` itself (whole-value replacement).
///   - If `new` is an object and `old` is not, the patch is `new` itself.
///   - If both are objects, the patch is an object containing only the keys
///     that differ. Keys present in `old` but absent in `new` are emitted as
///     `null` (deletion). Recursive on nested objects.
///
/// Per RFC 7396, arrays are atomic: any array difference produces a full
/// replacement of that field, not an element-level diff.
pub fn diff(old: &JsonValue, new: &JsonValue) -> Option<JsonValue> {
    if old == new {
        return None;
    }
    let (old_obj, new_obj) = match (old, new) {
        (JsonValue::Object(o), JsonValue::Object(n)) => (o, n),
        _ => return Some(new.clone()),
    };

    let mut patch = serde_json::Map::new();
    for (key, new_value) in new_obj {
        match old_obj.get(key) {
            Some(old_value) if old_value == new_value => continue,
            Some(old_value) => {
                if let Some(sub_patch) = diff(old_value, new_value) {
                    patch.insert(key.clone(), sub_patch);
                }
            }
            None => {
                patch.insert(key.clone(), new_value.clone());
            }
        }
    }
    for key in old_obj.keys() {
        if !new_obj.contains_key(key) {
            patch.insert(key.clone(), JsonValue::Null);
        }
    }

    Some(JsonValue::Object(patch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn equal_values_produce_no_patch() {
        assert_eq!(diff(&json!({"a": 1}), &json!({"a": 1})), None);
        assert_eq!(diff(&json!(42), &json!(42)), None);
        assert_eq!(diff(&json!(null), &json!(null)), None);
    }

    #[test]
    fn whole_value_replacement_for_non_objects() {
        assert_eq!(diff(&json!(1), &json!(2)), Some(json!(2)));
        assert_eq!(diff(&json!("a"), &json!("b")), Some(json!("b")));
        assert_eq!(diff(&json!([1, 2]), &json!([1, 3])), Some(json!([1, 3])));
    }

    #[test]
    fn added_key_appears_in_patch() {
        assert_eq!(
            diff(&json!({"a": 1}), &json!({"a": 1, "b": 2})),
            Some(json!({"b": 2}))
        );
    }

    #[test]
    fn removed_key_is_null_in_patch() {
        assert_eq!(
            diff(&json!({"a": 1, "b": 2}), &json!({"a": 1})),
            Some(json!({"b": null}))
        );
    }

    #[test]
    fn changed_scalar_key_appears() {
        assert_eq!(
            diff(&json!({"a": 1, "b": 2}), &json!({"a": 1, "b": 3})),
            Some(json!({"b": 3}))
        );
    }

    #[test]
    fn nested_object_diff_is_recursive() {
        let old = json!({"meta": {"x": 1, "y": 2}});
        let new = json!({"meta": {"x": 1, "y": 3}});
        assert_eq!(diff(&old, &new), Some(json!({"meta": {"y": 3}})));
    }

    #[test]
    fn array_changes_replace_whole_array() {
        let old = json!({"items": [1, 2, 3]});
        let new = json!({"items": [1, 2, 4]});
        assert_eq!(diff(&old, &new), Some(json!({"items": [1, 2, 4]})));
    }

    #[test]
    fn object_replaced_by_scalar_is_whole_replacement() {
        let old = json!({"a": {"x": 1}});
        let new = json!({"a": 5});
        assert_eq!(diff(&old, &new), Some(json!({"a": 5})));
    }

    #[test]
    fn scalar_replaced_by_object_uses_object_as_patch() {
        // When the new value is an object but the old is a scalar, the patch
        // is the whole new object — the RFC's "if target is not an object,
        // treat it as empty" rule applies at apply time. The server's
        // `applyJsonMergePatch` already handles this; we emit the full object.
        let old = json!({"a": 5});
        let new = json!({"a": {"x": 1}});
        assert_eq!(diff(&old, &new), Some(json!({"a": {"x": 1}})));
    }

    // ── apply ───────────────────────────────────────────────────────────────

    #[test]
    fn apply_non_object_patch_replaces_target() {
        assert_eq!(apply(&json!({"a": 1}), &json!(42)), json!(42));
        assert_eq!(apply(&json!({"a": 1}), &json!([1, 2])), json!([1, 2]));
        assert_eq!(apply(&json!({"a": 1}), &json!(null)), json!(null));
    }

    #[test]
    fn apply_null_key_deletes() {
        assert_eq!(
            apply(&json!({"a": 1, "b": 2}), &json!({"b": null})),
            json!({"a": 1})
        );
    }

    #[test]
    fn apply_adds_and_replaces_scalar_keys() {
        assert_eq!(
            apply(&json!({"a": 1}), &json!({"a": 2, "b": 3})),
            json!({"a": 2, "b": 3})
        );
    }

    #[test]
    fn apply_recurses_into_nested_objects() {
        let target = json!({"meta": {"x": 1, "y": 2}});
        let patch = json!({"meta": {"y": 3, "z": 4}});
        assert_eq!(
            apply(&target, &patch),
            json!({"meta": {"x": 1, "y": 3, "z": 4}})
        );
    }

    #[test]
    fn apply_replaces_array_atomically() {
        assert_eq!(
            apply(&json!({"items": [1, 2, 3]}), &json!({"items": [9]})),
            json!({"items": [9]})
        );
    }

    #[test]
    fn apply_treats_non_object_target_as_empty() {
        // Per RFC: when patch is an object and target is not, start from {}.
        assert_eq!(apply(&json!(5), &json!({"a": 1})), json!({"a": 1}));
        assert_eq!(apply(&json!(null), &json!({"a": 1})), json!({"a": 1}));
    }

    #[test]
    fn diff_apply_round_trip() {
        // diff produces a patch; apply against old must recover new.
        let cases = [
            (json!({"a": 1}), json!({"a": 2})),
            (json!({"a": 1, "b": 2}), json!({"a": 1})),
            (json!({}), json!({"a": 1})),
            (json!({"meta": {"x": 1}}), json!({"meta": {"x": 1, "y": 2}})),
            (json!({"a": 1}), json!({"a": {"x": 1}})),
        ];
        for (old, new) in cases {
            let patch = diff(&old, &new).expect("expected a patch");
            assert_eq!(
                apply(&old, &patch),
                new,
                "round trip failed for {old} → {new}"
            );
        }
    }
}
