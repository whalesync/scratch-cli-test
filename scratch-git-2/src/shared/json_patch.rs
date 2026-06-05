//! RFC 6902 JSON Patch — full applier + constrained differ.
//!
//! Replaces RFC 7396 JSON Merge Patch (`merge_patch.rs`) as the representation
//! of the "approved delta" — the difference between what is published
//! (`refs/heads/main`) and what the user has approved. The defining win over
//! RFC 7396 is that **`null` is an ordinary value here, not the deletion
//! sentinel.** Setting a field to null is `{"op":"add","path":"/f","value":null}`;
//! deleting a field is `{"op":"remove","path":"/f"}`. The two are distinct, so
//! reconstruction round-trips losslessly for documents that contain explicit
//! nulls — the property RFC 7396 provably cannot satisfy (DEV-10237).
//!
//! ## Two halves, deliberately asymmetric
//!
//! * [`apply`] implements the **complete** RFC 6902 standard — all six ops
//!   (`add`, `remove`, `replace`, `move`, `copy`, `test`) with full RFC 6901
//!   JSON Pointer addressing, including array-index ops. Reading the whole
//!   standard costs little and makes us interoperable with libraries, agents,
//!   and hand-authored or externally-generated patches.
//! * [`diff`] **emits only a constrained, conformant subset**: `add` (upsert an
//!   object member — new or changed) and `remove` (delete an object member).
//!   It never emits `replace`/`move`/`copy`/`test`, and never emits
//!   index-addressed array ops — arrays are always whole-value `add` at the
//!   array's object-member path. See [`diff`] for the rationale.
//!
//! The server's `applyJsonPatch` in
//! `server/src/publish-plan/apply-patches.service.ts` mirrors [`apply`] exactly;
//! the shared parity corpus in `src/shared/testdata/json_patch/` is the contract
//! that keeps the two engines equivalent.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// One RFC 6902 operation.
///
/// Serializes to / deserializes from the standard wire shape, e.g.
/// `{"op":"add","path":"/a","value":1}`, `{"op":"remove","path":"/a"}`,
/// `{"op":"move","from":"/a","path":"/b"}`. The `op` discriminator is lowercase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    Add { path: String, value: JsonValue },
    Remove { path: String },
    Replace { path: String, value: JsonValue },
    Move { from: String, path: String },
    Copy { from: String, path: String },
    Test { path: String, value: JsonValue },
}

impl Op {
    /// The primary target pointer of this operation (the `path` for all ops).
    pub fn path(&self) -> &str {
        match self {
            Op::Add { path, .. }
            | Op::Remove { path }
            | Op::Replace { path, .. }
            | Op::Move { path, .. }
            | Op::Copy { path, .. }
            | Op::Test { path, .. } => path,
        }
    }
}

// ── RFC 6901 JSON Pointer ────────────────────────────────────────────────────

/// Escape a single object key into an RFC 6901 reference token: `~` → `~0` and
/// `/` → `~1`. The `~` substitution MUST happen first so `/` → `~1` cannot be
/// re-escaped. This is strictly more correct than dot-path field addressing,
/// which cannot represent a key that itself contains a `.`.
pub fn encode_pointer_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

/// Decode a single RFC 6901 reference token: `~1` → `/` then `~0` → `~`. The
/// order is mandated by RFC 6901 §4 so `~01` decodes to `~1`, not `/`.
fn decode_pointer_token(token: &str) -> String {
    token.replace("~1", "/").replace("~0", "~")
}

/// Append `token` (a raw, unescaped object key) to a JSON Pointer prefix. The
/// empty prefix is the document root, so `pointer_push("", "a")` is `"/a"` and
/// `pointer_push("/a", "b")` is `"/a/b"`.
pub fn pointer_push(prefix: &str, token: &str) -> String {
    format!("{prefix}/{}", encode_pointer_token(token))
}

/// Parse a JSON Pointer into its sequence of decoded reference tokens. The empty
/// string parses to an empty token list (the whole document). Any non-empty
/// pointer must begin with `/`.
fn parse_pointer(pointer: &str) -> anyhow::Result<Vec<String>> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    let rest = pointer.strip_prefix('/').ok_or_else(|| {
        anyhow::anyhow!("invalid JSON pointer (must be empty or start with '/'): {pointer:?}")
    })?;
    Ok(rest.split('/').map(decode_pointer_token).collect())
}

/// Parse an array reference token per RFC 6901 §4 / RFC 6902 array semantics.
/// `allow_end` permits the `-` token (the position just past the last element,
/// used by `add`/`move`/`copy` to append) and an index equal to `len` (append).
/// Returns the resolved index. Leading zeros are rejected (only "0" itself is a
/// valid representation of zero).
fn parse_array_index(token: &str, len: usize, allow_end: bool) -> anyhow::Result<usize> {
    if token == "-" {
        if allow_end {
            return Ok(len);
        }
        anyhow::bail!("array index '-' is only valid as an insertion/append target");
    }
    if token.len() > 1 && token.starts_with('0') {
        anyhow::bail!("invalid array index with leading zero: {token:?}");
    }
    let idx: usize = token
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid array index: {token:?}"))?;
    let max = if allow_end {
        len
    } else {
        len.saturating_sub(1)
    };
    if idx > max || (!allow_end && len == 0) {
        anyhow::bail!("array index {idx} out of bounds (len {len}, allow_end {allow_end})");
    }
    Ok(idx)
}

// ── apply (full RFC 6902 standard) ───────────────────────────────────────────

/// Apply a sequence of RFC 6902 operations to `target`, returning the new
/// document. The original is not mutated. Operations apply in order; if any
/// operation fails (missing target, failed `test`, out-of-bounds index, …) the
/// whole patch fails and an error is returned (RFC 6902 §5: a patch is applied
/// atomically — callers that need atomicity discard the error result).
pub fn apply(target: &JsonValue, ops: &[Op]) -> anyhow::Result<JsonValue> {
    let mut doc = target.clone();
    for (index, op) in ops.iter().enumerate() {
        apply_one(&mut doc, op)
            .map_err(|err| anyhow::anyhow!("op[{index}] ({}) failed: {err}", op.path()))?;
    }
    Ok(doc)
}

/// Convenience wrapper: deserialize a patch stored as a [`JsonValue`] array of
/// op objects (the on-disk / wire shape) and apply it to `target`.
pub fn apply_value(target: &JsonValue, patch: &JsonValue) -> anyhow::Result<JsonValue> {
    let ops = ops_from_value(patch)?;
    apply(target, &ops)
}

fn apply_one(doc: &mut JsonValue, op: &Op) -> anyhow::Result<()> {
    match op {
        Op::Add { path, value } => add(doc, path, value.clone()),
        Op::Remove { path } => remove(doc, path).map(|_| ()),
        Op::Replace { path, value } => replace(doc, path, value.clone()),
        Op::Move { from, path } => {
            if is_proper_prefix(from, path) {
                anyhow::bail!("'from' ({from}) MUST NOT be a proper prefix of 'path' ({path})");
            }
            let value = remove(doc, from)?;
            add(doc, path, value)
        }
        Op::Copy { from, path } => {
            let value = resolve(doc, &parse_pointer(from)?)
                .ok_or_else(|| anyhow::anyhow!("'from' location does not exist: {from}"))?
                .clone();
            add(doc, path, value)
        }
        Op::Test { path, value } => {
            let actual = resolve(doc, &parse_pointer(path)?)
                .ok_or_else(|| anyhow::anyhow!("'test' target does not exist: {path}"))?;
            if actual != value {
                anyhow::bail!("'test' failed at {path}: expected {value}, found {actual}");
            }
            Ok(())
        }
    }
}

/// RFC 6902 §4.1 `add`. Upserts an object member; inserts (shifting) into an
/// array at the given index or `-` (append); an empty path replaces the whole
/// document.
fn add(doc: &mut JsonValue, path: &str, value: JsonValue) -> anyhow::Result<()> {
    let tokens = parse_pointer(path)?;
    let Some((last, parent_tokens)) = tokens.split_last() else {
        *doc = value;
        return Ok(());
    };
    let parent = resolve_mut(doc, parent_tokens)?;
    match parent {
        JsonValue::Object(map) => {
            map.insert(last.clone(), value);
            Ok(())
        }
        JsonValue::Array(arr) => {
            let idx = parse_array_index(last, arr.len(), true)?;
            arr.insert(idx, value);
            Ok(())
        }
        _ => anyhow::bail!("cannot add member {last:?} to non-container at {path}"),
    }
}

/// RFC 6902 §4.2 `remove`. The target location MUST exist. Returns the removed
/// value (so `move` can reuse it).
fn remove(doc: &mut JsonValue, path: &str) -> anyhow::Result<JsonValue> {
    let tokens = parse_pointer(path)?;
    let Some((last, parent_tokens)) = tokens.split_last() else {
        anyhow::bail!("cannot remove the whole document (empty path)");
    };
    let parent = resolve_mut(doc, parent_tokens)?;
    match parent {
        JsonValue::Object(map) => map
            .shift_remove(last)
            .ok_or_else(|| anyhow::anyhow!("remove target does not exist: {path}")),
        JsonValue::Array(arr) => {
            let idx = parse_array_index(last, arr.len(), false)?;
            Ok(arr.remove(idx))
        }
        _ => anyhow::bail!("cannot remove member {last:?} from non-container at {path}"),
    }
}

/// RFC 6902 §4.3 `replace`. Functionally `remove` then `add` at the same
/// location: the target MUST already exist.
fn replace(doc: &mut JsonValue, path: &str, value: JsonValue) -> anyhow::Result<()> {
    let tokens = parse_pointer(path)?;
    let Some((last, parent_tokens)) = tokens.split_last() else {
        *doc = value;
        return Ok(());
    };
    let parent = resolve_mut(doc, parent_tokens)?;
    match parent {
        JsonValue::Object(map) => {
            if !map.contains_key(last) {
                anyhow::bail!("replace target does not exist: {path}");
            }
            map.insert(last.clone(), value);
            Ok(())
        }
        JsonValue::Array(arr) => {
            let idx = parse_array_index(last, arr.len(), false)?;
            arr[idx] = value;
            Ok(())
        }
        _ => anyhow::bail!("cannot replace member {last:?} in non-container at {path}"),
    }
}

/// Resolve an immutable reference to the value at `tokens`, or `None` if any
/// intermediate is missing or not a container.
fn resolve<'a>(root: &'a JsonValue, tokens: &[String]) -> Option<&'a JsonValue> {
    let mut current = root;
    for token in tokens {
        current = match current {
            JsonValue::Object(map) => map.get(token)?,
            JsonValue::Array(arr) => {
                let idx = parse_array_index(token, arr.len(), false).ok()?;
                arr.get(idx)?
            }
            _ => return None,
        };
    }
    Some(current)
}

/// Resolve a mutable reference to the value at `tokens` (used to reach the
/// parent container before mutating its last member). Errors if any
/// intermediate is missing or not a container.
fn resolve_mut<'a>(
    root: &'a mut JsonValue,
    tokens: &[String],
) -> anyhow::Result<&'a mut JsonValue> {
    let mut current = root;
    for token in tokens {
        current = match current {
            JsonValue::Object(map) => map
                .get_mut(token)
                .ok_or_else(|| anyhow::anyhow!("path traverses missing object key {token:?}"))?,
            JsonValue::Array(arr) => {
                let idx = parse_array_index(token, arr.len(), false)?;
                arr.get_mut(idx).ok_or_else(|| {
                    anyhow::anyhow!("path traverses out-of-bounds array index {token:?}")
                })?
            }
            _ => anyhow::bail!("path traverses non-container at {token:?}"),
        };
    }
    Ok(current)
}

/// Whether `prefix` is a *proper* prefix of `path` at reference-token
/// granularity (used to reject `move`ing a location into one of its own
/// children). String prefix alone is insufficient — `/a` is not a prefix of
/// `/ab`, but is a prefix of `/a/b`.
fn is_proper_prefix(prefix: &str, path: &str) -> bool {
    let (Ok(prefix_tokens), Ok(path_tokens)) = (parse_pointer(prefix), parse_pointer(path)) else {
        return false;
    };
    prefix_tokens.len() < path_tokens.len() && path_tokens.starts_with(&prefix_tokens)
}

// ── diff (constrained, conformant subset) ────────────────────────────────────

/// Compute the constrained RFC 6902 patch that turns `old` into `new`.
///
/// Emits only two op kinds, addressed by RFC 6901 JSON Pointers:
///
/// * `add` — the object member should be present with this value (new **or**
///   changed). RFC 6902 `add` upserts object members, so one verb covers both
///   cases. We deliberately do **not** emit `replace`: no consumer branches on
///   the `add`-vs-`replace` verb, and `add` is more robust because our patches
///   are applied against *drifting bases* (re-anchored when `main` advances; the
///   server applies onto the dirty branch). `add` tolerates a member that has
///   since vanished upstream; `replace` would hard-error ("target MUST exist").
/// * `remove` — the object member is present in `old`, absent in `new`.
///
/// Rules (the control flow of `merge_patch::diff`, minus the null special case):
///
/// * **Recurse objects, atomic arrays.** Descend into a key only when *both*
///   sides are JSON objects there; otherwise emit a single whole-value `add` at
///   that path. Arrays are always whole-value, never index-addressed.
/// * **`null` is a value.** A field changing to null is `add /field null`; a
///   field being removed is `remove /field`. No overloading.
pub fn diff(old: &JsonValue, new: &JsonValue) -> Vec<Op> {
    let mut ops = Vec::new();
    diff_into("", old, new, &mut ops);
    ops
}

fn diff_into(base_ptr: &str, old: &JsonValue, new: &JsonValue, ops: &mut Vec<Op>) {
    if old == new {
        return;
    }
    let (old_obj, new_obj) = match (old, new) {
        (JsonValue::Object(old_obj), JsonValue::Object(new_obj)) => (old_obj, new_obj),
        // At least one side is a non-object (scalar, null, array): whole-value
        // upsert at this path. At the document root this becomes `add ""`
        // (replace the document); at a nested leaf it is `add /…/key value`.
        _ => {
            ops.push(Op::Add {
                path: base_ptr.to_string(),
                value: new.clone(),
            });
            return;
        }
    };

    // Removed keys first: present in old, absent in new.
    for key in old_obj.keys() {
        if !new_obj.contains_key(key) {
            ops.push(Op::Remove {
                path: pointer_push(base_ptr, key),
            });
        }
    }
    // Added or changed keys.
    for (key, new_value) in new_obj {
        match old_obj.get(key) {
            Some(old_value) if old_value == new_value => {}
            Some(old_value) if old_value.is_object() && new_value.is_object() => {
                // Recurse so a one-field change in a large nested envelope
                // produces one leaf op, not a whole-subtree replace.
                diff_into(&pointer_push(base_ptr, key), old_value, new_value, ops);
            }
            _ => {
                // New key, changed leaf, atomic array, or object↔scalar swap.
                ops.push(Op::Add {
                    path: pointer_push(base_ptr, key),
                    value: new_value.clone(),
                });
            }
        }
    }
}

// ── conversions to/from the stored JsonValue array shape ─────────────────────

/// Serialize an op list to the [`JsonValue`] array shape stored in
/// `accepted-patches.json` (for `kind = Update`) and sent over the wire.
pub fn ops_to_value(ops: &[Op]) -> JsonValue {
    serde_json::to_value(ops).expect("Vec<Op> always serializes to a JSON array")
}

/// Deserialize an op list from the [`JsonValue`] array shape. Errors if the
/// value is not a well-formed array of RFC 6902 op objects.
pub fn ops_from_value(patch: &JsonValue) -> anyhow::Result<Vec<Op>> {
    serde_json::from_value(patch.clone()).map_err(|err| {
        anyhow::anyhow!("invalid RFC 6902 patch (expected an array of op objects): {err}")
    })
}

/// Whether a stored patch body is in the RFC 6902 (v2) dialect rather than the
/// RFC 7396 (v1) merge-patch dialect. For an `Update` entry the two are
/// structurally disjoint: a 6902 patch is always a JSON **array** of ops; a 7396
/// merge patch is always a JSON **object**. This lets reconstruction pick the
/// applier by shape during the dual-read window, independent of the file
/// version marker.
pub fn is_json_patch_dialect(patch: &JsonValue) -> bool {
    patch.is_array()
}

/// Reconstruct the approved value for an `Update` entry from its base blob,
/// dispatching by dialect: a 6902 op array (v2) goes through [`apply_value`]; a
/// 7396 merge-patch object (v1) goes through the legacy `merge_patch::apply`.
///
/// This is the dual-read bridge every reconstruction site uses during the
/// migration window. The **shape** of the stored patch — not a file-version
/// marker — selects the applier, so a file with a mix of v1 and v2 entries (as
/// happens when only some records have been re-touched since the cutover)
/// reconstructs correctly entry-by-entry.
pub fn apply_update_patch(base: &JsonValue, patch: &JsonValue) -> anyhow::Result<JsonValue> {
    if is_json_patch_dialect(patch) {
        apply_value(base, patch)
    } else {
        Ok(crate::shared::merge_patch::apply(base, patch))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── JSON Pointer (RFC 6901) ──────────────────────────────────────────────

    #[test]
    fn pointer_escapes_tilde_and_slash_in_order() {
        assert_eq!(encode_pointer_token("a/b"), "a~1b");
        assert_eq!(encode_pointer_token("a~b"), "a~0b");
        assert_eq!(encode_pointer_token("m~n/o"), "m~0n~1o");
        // ~ must be escaped first so the resulting ~1 isn't re-escaped.
        assert_eq!(encode_pointer_token("~1"), "~01");
        assert_eq!(decode_pointer_token("~01"), "~1");
    }

    #[test]
    fn pointer_round_trips_exotic_keys() {
        for key in [
            "plain",
            "with.dot",
            "with/slash",
            "with~tilde",
            "with space",
            "Asked for Intro?",
            "emoji🎉key",
            "",
        ] {
            let encoded = encode_pointer_token(key);
            assert_eq!(
                decode_pointer_token(&encoded),
                key,
                "round trip failed for {key:?}"
            );
        }
    }

    #[test]
    fn parse_pointer_handles_root_and_escapes() {
        assert_eq!(parse_pointer("").unwrap(), Vec::<String>::new());
        assert_eq!(
            parse_pointer("/a/b").unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(parse_pointer("/a~1b").unwrap(), vec!["a/b".to_string()]);
        assert_eq!(
            parse_pointer("/with.dot").unwrap(),
            vec!["with.dot".to_string()]
        );
        assert!(parse_pointer("no-leading-slash").is_err());
    }

    // ── differ ───────────────────────────────────────────────────────────────

    #[test]
    fn diff_equal_values_produce_no_ops() {
        assert!(diff(&json!({"a": 1}), &json!({"a": 1})).is_empty());
        assert!(diff(&json!(42), &json!(42)).is_empty());
        assert!(diff(&json!(null), &json!(null)).is_empty());
    }

    #[test]
    fn diff_added_key_is_add() {
        assert_eq!(
            diff(&json!({"a": 1}), &json!({"a": 1, "b": 2})),
            vec![Op::Add {
                path: "/b".into(),
                value: json!(2)
            }]
        );
    }

    #[test]
    fn diff_removed_key_is_remove() {
        assert_eq!(
            diff(&json!({"a": 1, "b": 2}), &json!({"a": 1})),
            vec![Op::Remove { path: "/b".into() }]
        );
    }

    #[test]
    fn diff_field_set_to_null_is_add_null_not_remove() {
        // THE DEV-10237 distinction RFC 7396 could not express: changing a field
        // to null is an `add` of the value null — NOT a `remove`.
        assert_eq!(
            diff(&json!({"a": 1}), &json!({"a": null})),
            vec![Op::Add {
                path: "/a".into(),
                value: json!(null)
            }]
        );
    }

    #[test]
    fn diff_field_removed_distinct_from_set_null() {
        // Removing a field that was null is a `remove`, distinct from the above.
        assert_eq!(
            diff(&json!({"a": null, "b": 2}), &json!({"b": 2})),
            vec![Op::Remove { path: "/a".into() }]
        );
    }

    #[test]
    fn diff_changed_scalar_is_add() {
        assert_eq!(
            diff(&json!({"a": 1, "b": 2}), &json!({"a": 1, "b": 3})),
            vec![Op::Add {
                path: "/b".into(),
                value: json!(3)
            }]
        );
    }

    #[test]
    fn diff_recurses_into_nested_objects() {
        let old = json!({"meta": {"x": 1, "y": 2}});
        let new = json!({"meta": {"x": 1, "y": 3}});
        assert_eq!(
            diff(&old, &new),
            vec![Op::Add {
                path: "/meta/y".into(),
                value: json!(3)
            }]
        );
    }

    #[test]
    fn diff_treats_arrays_atomically() {
        let old = json!({"tags": [1, 2, 3]});
        let new = json!({"tags": [1, 2, 4]});
        assert_eq!(
            diff(&old, &new),
            vec![Op::Add {
                path: "/tags".into(),
                value: json!([1, 2, 4])
            }]
        );
    }

    #[test]
    fn diff_object_replaced_by_scalar_and_vice_versa() {
        assert_eq!(
            diff(&json!({"a": {"x": 1}}), &json!({"a": 5})),
            vec![Op::Add {
                path: "/a".into(),
                value: json!(5)
            }]
        );
        assert_eq!(
            diff(&json!({"a": 5}), &json!({"a": {"x": 1}})),
            vec![Op::Add {
                path: "/a".into(),
                value: json!({"x": 1})
            }]
        );
    }

    #[test]
    fn diff_newly_introduced_subtree_is_single_add() {
        // Cannot `add /parent/child` when `/parent` is absent, so a new object
        // subtree is emitted as one whole-value add at the parent.
        assert_eq!(
            diff(&json!({}), &json!({"parent": {"child": 1}})),
            vec![Op::Add {
                path: "/parent".into(),
                value: json!({"child": 1})
            }]
        );
    }

    #[test]
    fn diff_escapes_pointer_for_keys_with_dot_slash_tilde() {
        let old = json!({});
        let new = json!({"a.b": 1, "c/d": 2, "e~f": 3});
        let ops = diff(&old, &new);
        let paths: Vec<&str> = ops.iter().map(|op| op.path()).collect();
        assert!(paths.contains(&"/a.b"));
        assert!(paths.contains(&"/c~1d"));
        assert!(paths.contains(&"/e~0f"));
    }

    // ── applier: the constrained ops we emit ─────────────────────────────────

    #[test]
    fn apply_add_upserts_object_member() {
        // New member.
        assert_eq!(
            apply(
                &json!({"a": 1}),
                &[Op::Add {
                    path: "/b".into(),
                    value: json!(2)
                }]
            )
            .unwrap(),
            json!({"a": 1, "b": 2})
        );
        // Existing member is replaced (upsert).
        assert_eq!(
            apply(
                &json!({"a": 1}),
                &[Op::Add {
                    path: "/a".into(),
                    value: json!(9)
                }]
            )
            .unwrap(),
            json!({"a": 9})
        );
    }

    #[test]
    fn apply_add_null_sets_null_value() {
        assert_eq!(
            apply(
                &json!({"a": 1}),
                &[Op::Add {
                    path: "/a".into(),
                    value: json!(null)
                }]
            )
            .unwrap(),
            json!({"a": null})
        );
    }

    #[test]
    fn apply_remove_deletes_object_member() {
        assert_eq!(
            apply(
                &json!({"a": 1, "b": 2}),
                &[Op::Remove { path: "/b".into() }]
            )
            .unwrap(),
            json!({"a": 1})
        );
    }

    #[test]
    fn apply_remove_missing_member_errors() {
        assert!(apply(
            &json!({"a": 1}),
            &[Op::Remove {
                path: "/missing".into()
            }]
        )
        .is_err());
    }

    #[test]
    fn apply_add_is_robust_to_drifted_base_unlike_replace() {
        // `add` upserts even when the member vanished upstream; this is why the
        // differ emits `add` for changed leaves (robust under re-anchor/dirty drift).
        let drifted = json!({"other": true});
        assert_eq!(
            apply(
                &drifted,
                &[Op::Add {
                    path: "/a".into(),
                    value: json!(1)
                }]
            )
            .unwrap(),
            json!({"other": true, "a": 1})
        );
        // `replace` against the same drifted base would hard-error.
        assert!(apply(
            &drifted,
            &[Op::Replace {
                path: "/a".into(),
                value: json!(1)
            }]
        )
        .is_err());
    }

    // ── applier: the full standard (ops we never emit but must apply) ─────────

    #[test]
    fn apply_replace_requires_existing_target() {
        assert_eq!(
            apply(
                &json!({"a": 1}),
                &[Op::Replace {
                    path: "/a".into(),
                    value: json!(2)
                }]
            )
            .unwrap(),
            json!({"a": 2})
        );
        assert!(apply(
            &json!({"a": 1}),
            &[Op::Replace {
                path: "/b".into(),
                value: json!(2)
            }]
        )
        .is_err());
    }

    #[test]
    fn apply_array_index_ops_insert_replace_remove_append() {
        // add at index inserts (shifts).
        assert_eq!(
            apply(
                &json!({"t": [1, 2, 3]}),
                &[Op::Add {
                    path: "/t/1".into(),
                    value: json!(9)
                }]
            )
            .unwrap(),
            json!({"t": [1, 9, 2, 3]})
        );
        // add at '-' appends.
        assert_eq!(
            apply(
                &json!({"t": [1, 2]}),
                &[Op::Add {
                    path: "/t/-".into(),
                    value: json!(3)
                }]
            )
            .unwrap(),
            json!({"t": [1, 2, 3]})
        );
        // replace at index.
        assert_eq!(
            apply(
                &json!({"t": [1, 2, 3]}),
                &[Op::Replace {
                    path: "/t/0".into(),
                    value: json!(9)
                }]
            )
            .unwrap(),
            json!({"t": [9, 2, 3]})
        );
        // remove at index shifts down.
        assert_eq!(
            apply(
                &json!({"t": [1, 2, 3]}),
                &[Op::Remove {
                    path: "/t/1".into()
                }]
            )
            .unwrap(),
            json!({"t": [1, 3]})
        );
    }

    #[test]
    fn apply_array_index_out_of_bounds_and_leading_zero_error() {
        assert!(apply(
            &json!({"t": [1]}),
            &[Op::Remove {
                path: "/t/5".into()
            }]
        )
        .is_err());
        assert!(apply(
            &json!({"t": [1, 2]}),
            &[Op::Replace {
                path: "/t/01".into(),
                value: json!(9)
            }]
        )
        .is_err());
        // add allows index == len (append position) but not beyond.
        assert!(apply(
            &json!({"t": [1, 2]}),
            &[Op::Add {
                path: "/t/3".into(),
                value: json!(9)
            }]
        )
        .is_err());
        assert_eq!(
            apply(
                &json!({"t": [1, 2]}),
                &[Op::Add {
                    path: "/t/2".into(),
                    value: json!(9)
                }]
            )
            .unwrap(),
            json!({"t": [1, 2, 9]})
        );
    }

    #[test]
    fn apply_move_copy_test() {
        // move
        assert_eq!(
            apply(
                &json!({"a": 1, "b": 2}),
                &[Op::Move {
                    from: "/a".into(),
                    path: "/c".into()
                }]
            )
            .unwrap(),
            json!({"b": 2, "c": 1})
        );
        // copy
        assert_eq!(
            apply(
                &json!({"a": {"x": 1}}),
                &[Op::Copy {
                    from: "/a".into(),
                    path: "/b".into()
                }]
            )
            .unwrap(),
            json!({"a": {"x": 1}, "b": {"x": 1}})
        );
        // test pass is a no-op
        assert_eq!(
            apply(
                &json!({"a": 1}),
                &[Op::Test {
                    path: "/a".into(),
                    value: json!(1)
                }]
            )
            .unwrap(),
            json!({"a": 1})
        );
        // test fail aborts the whole patch
        assert!(apply(
            &json!({"a": 1}),
            &[Op::Test {
                path: "/a".into(),
                value: json!(2)
            }]
        )
        .is_err());
    }

    #[test]
    fn apply_move_into_own_child_is_rejected() {
        assert!(apply(
            &json!({"a": {"b": 1}}),
            &[Op::Move {
                from: "/a".into(),
                path: "/a/b".into()
            }]
        )
        .is_err());
    }

    #[test]
    fn apply_root_path_replaces_whole_document() {
        assert_eq!(
            apply(
                &json!({"a": 1}),
                &[Op::Add {
                    path: "".into(),
                    value: json!([1, 2])
                }]
            )
            .unwrap(),
            json!([1, 2])
        );
        assert_eq!(
            apply(
                &json!({"a": 1}),
                &[Op::Replace {
                    path: "".into(),
                    value: json!(null)
                }]
            )
            .unwrap(),
            json!(null)
        );
    }

    #[test]
    fn apply_atomic_failure_does_not_partially_mutate_returned_value() {
        // Second op fails; apply returns Err and the caller keeps its original.
        let original = json!({"a": 1});
        let result = apply(
            &original,
            &[
                Op::Add {
                    path: "/b".into(),
                    value: json!(2),
                },
                Op::Remove {
                    path: "/missing".into(),
                },
            ],
        );
        assert!(result.is_err());
        assert_eq!(original, json!({"a": 1}));
    }

    // ── the property RFC 7396 provably fails ─────────────────────────────────

    #[test]
    fn null_round_trip_property() {
        // For arbitrary objects including explicit nulls, apply(base, diff(base, target)) == target.
        let cases = [
            (json!({"a": 1}), json!({"a": null})),
            (json!({"a": null}), json!({"a": 1})),
            (json!({"a": null}), json!({})),
            (json!({}), json!({"a": null})),
            (json!({"a": null, "b": null}), json!({"a": null, "b": 2})),
            (
                json!({"meta": {"x": null}}),
                json!({"meta": {"x": null, "y": null}}),
            ),
            (json!({"meta": {"x": 1}}), json!({"meta": {"x": null}})),
            (json!({"a": 1, "b": 2, "c": 3}), json!({"a": 1, "b": null})),
            (json!({"tags": [1, 2]}), json!({"tags": [1, 2, null]})),
            (
                json!({"a": {"deep": {"v": 1}}}),
                json!({"a": {"deep": {"v": null}}}),
            ),
        ];
        for (base, target) in cases {
            let patch = diff(&base, &target);
            let applied = apply(&base, &patch).expect("apply must succeed");
            assert_eq!(
                applied, target,
                "round trip failed for {base} → {target} via {patch:?}"
            );
        }
    }

    #[test]
    fn diff_emits_no_replace_move_copy_test() {
        // The constrained subset guarantee: only Add/Remove ever come out of diff.
        let old = json!({"keep": 1, "change": 2, "drop": 3, "obj": {"a": 1}});
        let new = json!({"keep": 1, "change": 9, "obj": {"a": 2}, "added": null});
        for op in diff(&old, &new) {
            match op {
                Op::Add { .. } | Op::Remove { .. } => {}
                other => panic!("diff emitted a forbidden op: {other:?}"),
            }
        }
    }

    // ── op wire serialization ────────────────────────────────────────────────

    #[test]
    fn ops_serialize_to_rfc6902_wire_shape() {
        let ops = vec![
            Op::Add {
                path: "/a".into(),
                value: json!(1),
            },
            Op::Remove { path: "/b".into() },
            Op::Replace {
                path: "/c".into(),
                value: json!(null),
            },
            Op::Move {
                from: "/d".into(),
                path: "/e".into(),
            },
            Op::Copy {
                from: "/f".into(),
                path: "/g".into(),
            },
            Op::Test {
                path: "/h".into(),
                value: json!(true),
            },
        ];
        let value = ops_to_value(&ops);
        assert_eq!(
            value,
            json!([
                {"op": "add", "path": "/a", "value": 1},
                {"op": "remove", "path": "/b"},
                {"op": "replace", "path": "/c", "value": null},
                {"op": "move", "from": "/d", "path": "/e"},
                {"op": "copy", "from": "/f", "path": "/g"},
                {"op": "test", "path": "/h", "value": true},
            ])
        );
        // Round-trips back to the same ops.
        assert_eq!(ops_from_value(&value).unwrap(), ops);
    }

    #[test]
    fn add_null_value_survives_wire_round_trip() {
        // Critical: a serialized `add` of null must deserialize back to a present
        // `value: null`, not a missing field. serde_json includes the null.
        let ops = vec![Op::Add {
            path: "/a".into(),
            value: json!(null),
        }];
        let value = ops_to_value(&ops);
        assert_eq!(value, json!([{"op": "add", "path": "/a", "value": null}]));
        assert_eq!(ops_from_value(&value).unwrap(), ops);
    }

    #[test]
    fn is_json_patch_dialect_distinguishes_array_from_object() {
        assert!(is_json_patch_dialect(
            &json!([{"op": "add", "path": "/a", "value": 1}])
        ));
        assert!(is_json_patch_dialect(&json!([]))); // empty 6902 patch
        assert!(!is_json_patch_dialect(&json!({"a": 1}))); // 7396 merge patch
        assert!(!is_json_patch_dialect(&json!({}))); // empty 7396 merge patch
        assert!(!is_json_patch_dialect(&json!(null))); // 7396 whole-record delete
    }

    // ── shared parity corpus + RFC 6902 Appendix A golden vectors ────────────

    #[derive(serde::Deserialize)]
    struct ApplyFixture {
        description: String,
        base: JsonValue,
        patch: JsonValue,
        #[serde(default)]
        expected: JsonValue,
        #[serde(default)]
        error: bool,
    }

    #[derive(serde::Deserialize)]
    struct DiffFixture {
        description: String,
        old: JsonValue,
        new: JsonValue,
        patch: JsonValue,
    }

    fn fixture_paths(subdir: &str) -> Vec<std::path::PathBuf> {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/shared/testdata/json_patch")
            .join(subdir);
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("testdata/json_patch/{subdir} dir must exist: {e}"))
            .map(|e| e.expect("dir entry").path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        entries.sort();
        assert!(!entries.is_empty(), "no fixtures found in {dir:?}");
        entries
    }

    #[test]
    fn apply_parity_corpus_and_appendix_a() {
        let mut failures = Vec::new();
        for path in fixture_paths("apply") {
            let content = std::fs::read_to_string(&path).unwrap();
            let fixture: ApplyFixture = serde_json::from_str(&content)
                .unwrap_or_else(|e| panic!("invalid fixture {path:?}: {e}"));
            let name = path.file_name().unwrap().to_string_lossy();
            let result = apply_value(&fixture.base, &fixture.patch);
            if fixture.error {
                if result.is_ok() {
                    failures.push(format!(
                        "FAIL {name} ({}): expected error, got {:?}",
                        fixture.description, result
                    ));
                }
            } else {
                match result {
                    Ok(got) if got == fixture.expected => {}
                    Ok(got) => failures.push(format!(
                        "FAIL {name} ({})\n  expected: {}\n  got:      {got}",
                        fixture.description, fixture.expected
                    )),
                    Err(e) => failures.push(format!(
                        "FAIL {name} ({}): unexpected error: {e}",
                        fixture.description
                    )),
                }
            }
        }
        assert!(
            failures.is_empty(),
            "apply corpus failures:\n\n{}",
            failures.join("\n\n")
        );
    }

    #[test]
    fn diff_parity_corpus() {
        let mut failures = Vec::new();
        for path in fixture_paths("diff") {
            let content = std::fs::read_to_string(&path).unwrap();
            let fixture: DiffFixture = serde_json::from_str(&content)
                .unwrap_or_else(|e| panic!("invalid fixture {path:?}: {e}"));
            let name = path.file_name().unwrap().to_string_lossy();
            // (a) the differ emits exactly the fixture's op array (parity + minimality).
            let emitted = ops_to_value(&diff(&fixture.old, &fixture.new));
            if emitted != fixture.patch {
                failures.push(format!(
                    "FAIL {name} ({}) — differ output mismatch\n  expected: {}\n  got:      {emitted}",
                    fixture.description, fixture.patch
                ));
            }
            // (b) applying the fixture's patch to old reconstructs new (correctness).
            match apply_value(&fixture.old, &fixture.patch) {
                Ok(got) if got == fixture.new => {}
                Ok(got) => failures.push(format!(
                    "FAIL {name} ({}) — apply mismatch\n  expected: {}\n  got:      {got}",
                    fixture.description, fixture.new
                )),
                Err(e) => failures.push(format!(
                    "FAIL {name} ({}): apply error: {e}",
                    fixture.description
                )),
            }
        }
        assert!(
            failures.is_empty(),
            "diff corpus failures:\n\n{}",
            failures.join("\n\n")
        );
    }
}
