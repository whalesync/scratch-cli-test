//! Re-anchor user patches when local `main` advances during pull.
//!
//! Phase 4 of the simplify-local-workspace plan (see
//! `docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md`).
//!
//! A patch in `working-patches.json` or `accepted-patches.json` describes the
//! delta from `old_head[path]` (the snapshot the user was editing against) to
//! the user's intended content. When `git fetch` advances `main` from
//! `old_head` to `new_head`, those patches need to be re-encoded as deltas
//! against `new_head[path]` so they can be replayed on the new worktree.
//!
//! The re-anchor routine is intentionally pure: callers supply blob lookups
//! for old and new HEADs, the routine returns a fresh patch set plus a list
//! of paths where the user's edits collided with server edits (`user-wins`
//! semantics — the patch value is preserved, but the collision is logged for
//! audit and telemetry).
//!
//! `compute_entry` is wired into accept-time paths today (single-path,
//! field, and _all). `re_anchor_one` / `re_anchor_patches` ship as helpers
//! for slice D's pull rewrite — kept compiling so the next slice can hook
//! them in without resurrecting deleted code.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::shared::merge_patch;

/// Kind of patch entry. Persisted in `working-patches.json` and
/// `accepted-patches.json` (Phase 5). Matches the on-wire `kind` field of the
/// upload-patch DTO.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchKind {
    Create,
    Update,
    Delete,
}

/// One entry in a per-connection patch file (working-patches.json or
/// accepted-patches.json).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnchoredPatch {
    pub path: String,
    pub kind: PatchKind,
    /// RFC 7396 merge patch. `null` for delete; full content for create; merge
    /// patch object for update.
    pub patch: JsonValue,
    /// True when this patch was produced by `files revert-plan` reviving a
    /// previously-deleted record. The patch body carries a
    /// `scratch_pending_recreate_<old_id>` sentinel in its id field; the
    /// server strips the sentinel before sending to the connector, captures
    /// the new remote id after success, and writes the mapping to
    /// `RecreatedIdMap` so sibling reverts that FK-reference the old id can be
    /// rewritten to the new id at publish time. Omitted from JSON (defaults
    /// false) for all other patches.
    #[serde(default, skip_serializing_if = "is_false")]
    pub revert: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A same-field collision or path-lifecycle conflict detected during
/// re-anchoring. Emitted to `.scratch/conflicts.log` and the
/// `desktop.pull.conflict` PostHog event (path pattern only — no record
/// content leaves the user's machine).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatchConflict {
    pub path: String,
    /// Top-level keys where the user and the server both made changes. May be
    /// `["*"]` when the conflict is at the file level (path deleted by the
    /// server, or whole-file replacement on both sides) — see [`WHOLE_FILE_KEY`].
    pub conflicting_keys: Vec<String>,
}

/// Sentinel emitted in [`PatchConflict::conflicting_keys`] when the conflict
/// is at the whole-file level (path deleted remotely; whole-file scalar
/// replacement) rather than a specific set of fields.
pub const WHOLE_FILE_KEY: &str = "*";

/// Result of re-anchoring a single patch.
#[derive(Debug, Clone, PartialEq)]
pub struct ReAnchoredOne {
    /// The rewritten entry valid against `new`. `None` means the patch is a
    /// no-op against the new HEAD (server already has the user's intent, or
    /// the file is gone on both sides) and should be dropped.
    pub anchored: Option<AnchoredPatch>,
    /// Conflict info, present iff the user's patch and the server's change
    /// overlapped. The patch is still preserved (user-wins); the conflict is
    /// for the audit log / PostHog event only.
    pub conflict: Option<PatchConflict>,
}

/// Output of [`re_anchor_patches`]: the surviving (re-anchored) patches plus
/// a list of conflicts to log.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReAnchorOutput {
    pub patches: Vec<AnchoredPatch>,
    pub conflicts: Vec<PatchConflict>,
}

/// Re-anchor a single patch when HEAD advances from `old` to `new` at this
/// path. `old` and `new` are the JSON content of the file at that path in the
/// respective trees (`None` if the path didn't exist there).
///
/// The strategy is to preserve the user's RFC 7396 patch verbatim wherever
/// possible — a merge patch like `{"industry": "SaaS"}` only mentions the
/// keys the user touched, and re-applying it on a different `new` head is
/// already the correct semantic for "set these keys, leave the rest alone."
/// The only times the entry has to change shape are:
///
///   - **Server deleted the path** (`new = None`) while the user had an
///     `Update`: convert to `Create` with `apply(old, patch)` so the user's
///     edit survives as a fresh record.
///   - **Server created the path** (`old = None`, `new = Some`) while the
///     user also had a `Create`: convert to `Update` with the same patch —
///     RFC 7396 semantics will merge the user's keys onto the server's
///     content (user wins per-key).
///
/// No-op detection drops patches that would produce no change against the
/// new head (e.g. user-update value already matches server's new value).
pub fn re_anchor_one(
    path: &str,
    kind: PatchKind,
    patch: &JsonValue,
    revert: bool,
    old: Option<&JsonValue>,
    new: Option<&JsonValue>,
) -> ReAnchoredOne {
    let anchored = re_anchor_entry(path, kind, patch, revert, old, new);
    let conflict = detect_conflict(path, kind, patch, old, new);
    ReAnchoredOne { anchored, conflict }
}

fn re_anchor_entry(
    path: &str,
    kind: PatchKind,
    patch: &JsonValue,
    revert: bool,
    old: Option<&JsonValue>,
    new: Option<&JsonValue>,
) -> Option<AnchoredPatch> {
    // Revert-create special case: the patch was produced by `files revert-plan`
    // reviving a deleted record, the publish landed (path now exists on new
    // main), so the server consumed our `scratch_pending_recreate_<old_id>`
    // sentinel and wrote the new id to main + RecreatedIdMap. Drop the patch
    // unconditionally — the normal Create→Update + no-op-detection dance
    // can't succeed here because the patch body still carries the sentinel id
    // while main has the server-assigned id; byte-equality would never match.
    // The new id is canonical on main; download will replay it into the
    // worktree.
    if revert && kind == PatchKind::Create && new.is_some() {
        return None;
    }

    let candidate = match (kind, new) {
        (PatchKind::Delete, None) => None, // both sides agree the file is gone
        (PatchKind::Delete, Some(_)) => Some(AnchoredPatch {
            path: path.to_string(),
            kind: PatchKind::Delete,
            patch: JsonValue::Null,
            revert,
        }),
        (PatchKind::Update, None) => {
            // Server deleted the file out from under us. Reconstruct the user's
            // intended content from old + patch and re-emit as a Create.
            let base = old.cloned().unwrap_or(JsonValue::Null);
            let reconstructed = merge_patch::apply(&base, patch);
            Some(AnchoredPatch {
                path: path.to_string(),
                kind: PatchKind::Create,
                patch: reconstructed,
                revert,
            })
        }
        (PatchKind::Update, Some(_)) => Some(AnchoredPatch {
            path: path.to_string(),
            kind: PatchKind::Update,
            patch: patch.clone(),
            revert,
        }),
        (PatchKind::Create, None) => Some(AnchoredPatch {
            path: path.to_string(),
            kind: PatchKind::Create,
            patch: patch.clone(),
            revert,
        }),
        (PatchKind::Create, Some(_)) => {
            // Server created the same path while the user was also creating.
            // Merge the user's keys onto the server's content via Update — RFC
            // 7396 will user-win per key. (revert+Create+new.is_some was
            // short-circuited above.)
            Some(AnchoredPatch {
                path: path.to_string(),
                kind: PatchKind::Update,
                patch: patch.clone(),
                revert,
            })
        }
    };

    candidate.filter(|a| !is_noop_against(a, new))
}

/// Returns true if applying `entry` against `new` would produce no change to
/// the file's content.
fn is_noop_against(entry: &AnchoredPatch, new: Option<&JsonValue>) -> bool {
    match (entry.kind, new) {
        (PatchKind::Delete, None) => true,
        (PatchKind::Delete, Some(_)) => false,
        (PatchKind::Create, None) => false,
        (PatchKind::Create, Some(n)) => n == &entry.patch,
        (PatchKind::Update, None) => false,
        (PatchKind::Update, Some(n)) => &merge_patch::apply(n, &entry.patch) == n,
    }
}

/// Compute an `AnchoredPatch` for a single file from a `(snapshot, working)`
/// pair. The snapshot is the file's content as of the last server-known
/// state (post-Phase-5: `refs/heads/main`); working is the user's worktree
/// content. Returns `None` when the file is unchanged.
///
/// Maps to the four valid transitions:
///
///   - snapshot=None, working=None → no change
///   - snapshot=Some, working=Some, equal → no change
///   - snapshot=None, working=Some → Create (patch = the working content)
///   - snapshot=Some, working=None → Delete (patch = null)
///   - snapshot=Some, working=Some, different → Update (patch = `diff(snap, work)`)
///
/// Used by the accept-time path: every accept / accept-field / accept-all
/// flows through this to produce the entry written into
/// `accepted-patches.json`.
pub fn compute_entry(
    path: &str,
    snapshot: Option<&JsonValue>,
    working: Option<&JsonValue>,
) -> Option<AnchoredPatch> {
    match (snapshot, working) {
        (None, None) => None,
        (Some(s), Some(w)) if s == w => None,
        (Some(_), None) => Some(AnchoredPatch {
            path: path.to_string(),
            kind: PatchKind::Delete,
            patch: JsonValue::Null,
            revert: false,
        }),
        (None, Some(w)) => Some(AnchoredPatch {
            path: path.to_string(),
            kind: PatchKind::Create,
            patch: w.clone(),
            revert: false,
        }),
        (Some(s), Some(w)) => merge_patch::diff(s, w).map(|p| AnchoredPatch {
            path: path.to_string(),
            kind: PatchKind::Update,
            patch: p,
            revert: false,
        }),
    }
}

/// Re-anchor a batch of patches. `old_at` and `new_at` look up file content
/// per path; either may return an error which is propagated.
pub fn re_anchor_patches<F1, F2>(
    patches: &[AnchoredPatch],
    mut old_at: F1,
    mut new_at: F2,
) -> anyhow::Result<ReAnchorOutput>
where
    F1: FnMut(&str) -> anyhow::Result<Option<JsonValue>>,
    F2: FnMut(&str) -> anyhow::Result<Option<JsonValue>>,
{
    let mut out = ReAnchorOutput::default();
    for entry in patches {
        let old = old_at(&entry.path)?;
        let new = new_at(&entry.path)?;
        let result = re_anchor_one(
            &entry.path,
            entry.kind,
            &entry.patch,
            entry.revert,
            old.as_ref(),
            new.as_ref(),
        );
        if let Some(a) = result.anchored {
            out.patches.push(a);
        }
        if let Some(c) = result.conflict {
            out.conflicts.push(c);
        }
    }
    Ok(out)
}

/// Top-level keys of an RFC 7396 merge patch object. Returns `None` for a
/// non-object patch (whole-file replacement / delete) — caller should treat
/// such patches as touching the whole file.
fn patch_top_keys(patch: &JsonValue) -> Option<Vec<String>> {
    match patch {
        JsonValue::Object(o) => Some(o.keys().cloned().collect()),
        _ => None,
    }
}

/// Top-level keys where `old` and `new` differ. Both `None` → empty. Either
/// side missing → all top-level keys of the present side. Both present →
/// per-key inequality (recursive comparison via direct `!=` — sufficient for
/// JSON value equality).
fn server_changed_keys(old: Option<&JsonValue>, new: Option<&JsonValue>) -> Vec<String> {
    match (old, new) {
        (None, None) => Vec::new(),
        (Some(JsonValue::Object(o)), Some(JsonValue::Object(n))) => {
            let mut keys: Vec<String> = Vec::new();
            for (k, v) in o {
                if n.get(k) != Some(v) {
                    keys.push(k.clone());
                }
            }
            for k in n.keys() {
                if !o.contains_key(k) && !keys.contains(k) {
                    keys.push(k.clone());
                }
            }
            keys
        }
        (Some(a), Some(b)) if a == b => Vec::new(),
        // One side is a non-object (or scalar) and the values differ — treat
        // it as a whole-file change.
        _ => vec![WHOLE_FILE_KEY.to_string()],
    }
}

/// Detect a divergence between the user's intended outcome and the server's
/// new state at this path.
///
/// Rule: emit a conflict iff there is at least one user-touched scope (whole
/// file or top-level key) where the user's intended value differs from the
/// server's new value AND the server actually changed that scope. If the user
/// and server independently arrived at the same outcome, no conflict.
fn detect_conflict(
    path: &str,
    kind: PatchKind,
    patch: &JsonValue,
    old: Option<&JsonValue>,
    new: Option<&JsonValue>,
) -> Option<PatchConflict> {
    if old == new {
        return None; // server didn't touch this path
    }

    // Outcome the user wanted, regardless of what's on the server.
    let user_intended: Option<JsonValue> = match kind {
        PatchKind::Create => Some(patch.clone()),
        PatchKind::Update => {
            let base = old.cloned().unwrap_or(JsonValue::Null);
            Some(merge_patch::apply(&base, patch))
        }
        PatchKind::Delete => None,
    };

    if user_intended.as_ref() == new {
        // user and server agree on final state — even if they got there
        // independently, there's no override happening.
        return None;
    }

    // Path-deleted remotely while user had a non-Delete edit.
    if new.is_none() {
        let keys = patch_top_keys(patch).unwrap_or_else(|| vec![WHOLE_FILE_KEY.to_string()]);
        return Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: if keys.is_empty() {
                vec![WHOLE_FILE_KEY.to_string()]
            } else {
                keys
            },
        });
    }

    // User wants Delete on a server-modified file — all server-changed keys
    // are being lost.
    if kind == PatchKind::Delete {
        let server_changed = server_changed_keys(old, new);
        return Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: if server_changed.is_empty() {
                vec![WHOLE_FILE_KEY.to_string()]
            } else {
                server_changed
            },
        });
    }

    // Update / Create where the file exists on the new head: walk the patch
    // recursively. A key path (e.g. "properties.city") is "conflicting" iff
    // (a) user touched it, (b) the server changed it, AND (c) the user's
    // intended value differs from the server's new value. Recursing into
    // nested objects is what makes the audit log specific enough to act on —
    // top-level-only reporting (the old behavior) flagged ["properties"]
    // when the user actually only collided on properties.city.
    let new_obj = new.unwrap();
    let intended_obj = user_intended.as_ref().unwrap();
    if patch_top_keys(patch).is_none() {
        // Whole-file scalar/array replacement (or null) — treat as a single
        // conflicting scope. Recursion only makes sense for object patches.
        return Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: vec![WHOLE_FILE_KEY.to_string()],
        });
    }

    let mut conflicting: Vec<String> = Vec::new();
    collect_nested_conflicts(patch, intended_obj, new_obj, old, "", &mut conflicting);

    if conflicting.is_empty() {
        None
    } else {
        Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: conflicting,
        })
    }
}

/// Recursively walk the user's patch and accumulate dot-separated key paths
/// where the user's intended value diverges from the server's new value AND
/// the server actually changed that scope. `prefix` is the dot-prefix for the
/// current recursion depth (empty at the top level). Mirrors RFC 7396's merge
/// semantics: an object value in the patch means "recurse into this key";
/// any non-object (scalar, array, null) is a leaf-level replacement.
fn collect_nested_conflicts(
    patch: &JsonValue,
    intended: &JsonValue,
    new: &JsonValue,
    old: Option<&JsonValue>,
    prefix: &str,
    out: &mut Vec<String>,
) {
    let JsonValue::Object(patch_obj) = patch else {
        return;
    };
    let intended_map = intended.as_object();
    let new_map = new.as_object();
    let old_map = old.and_then(|v| v.as_object());

    for (k, patch_v) in patch_obj {
        let key_path = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        let intended_v = intended_map
            .and_then(|o| o.get(k))
            .cloned()
            .unwrap_or(JsonValue::Null);
        let new_v = new_map
            .and_then(|o| o.get(k))
            .cloned()
            .unwrap_or(JsonValue::Null);
        let old_v = old_map
            .and_then(|o| o.get(k))
            .cloned()
            .unwrap_or(JsonValue::Null);

        // Recurse into the sub-object only when all four sides are objects;
        // otherwise the comparison happens at this level (the values are
        // wholly replaced rather than recursively merged per RFC 7396).
        if patch_v.is_object() && intended_v.is_object() && new_v.is_object() && old_v.is_object() {
            collect_nested_conflicts(patch_v, &intended_v, &new_v, Some(&old_v), &key_path, out);
            continue;
        }

        if intended_v == new_v {
            continue; // user got what they wanted at this key
        }
        if old_v != new_v {
            out.push(key_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn update(path: &str, patch: JsonValue) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind: PatchKind::Update,
            patch,
            revert: false,
        }
    }
    fn create(path: &str, content: JsonValue) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind: PatchKind::Create,
            patch: content,
            revert: false,
        }
    }
    fn delete(path: &str) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind: PatchKind::Delete,
            patch: JsonValue::Null,
            revert: false,
        }
    }

    // ── server didn't touch path ────────────────────────────────────────────

    #[test]
    fn update_unchanged_path_is_valid_as_is() {
        let old = json!({"a": 1, "b": 2});
        let new = old.clone();
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &json!({"a": 9}),
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Update,
                patch: json!({"a": 9}),
                revert: false,
            })
        );
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn create_when_new_head_still_lacks_path() {
        let r = re_anchor_one(
            "p",
            PatchKind::Create,
            &json!({"name": "Acme"}),
            false,
            None,
            None,
        );
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Create,
                patch: json!({"name": "Acme"}),
                revert: false,
            })
        );
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn delete_when_new_head_still_has_path_unchanged() {
        let old = json!({"a": 1});
        let new = old.clone();
        let r = re_anchor_one(
            "p",
            PatchKind::Delete,
            &JsonValue::Null,
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Delete,
                patch: JsonValue::Null,
                revert: false,
            })
        );
        assert_eq!(r.conflict, None);
    }

    // ── no-op detection (drop) ──────────────────────────────────────────────

    #[test]
    fn drop_when_server_already_has_users_intent() {
        // user wanted {"a": 9}; server's new head has {"a": 9}; user's patch
        // is now a no-op and user and server agree on the outcome → no log.
        let old = json!({"a": 1});
        let new = json!({"a": 9});
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &json!({"a": 9}),
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(r.anchored, None);
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn drop_create_when_server_created_identically() {
        let server_content = json!({"name": "Acme"});
        let r = re_anchor_one(
            "p",
            PatchKind::Create,
            &server_content,
            false,
            None,
            Some(&server_content),
        );
        assert_eq!(r.anchored, None);
        // Both sides arrived at identical content — no override happened.
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn drop_delete_when_server_also_deleted() {
        let old = json!({"a": 1});
        let r = re_anchor_one(
            "p",
            PatchKind::Delete,
            &JsonValue::Null,
            false,
            Some(&old),
            None,
        );
        assert_eq!(r.anchored, None);
        assert_eq!(r.conflict, None);
    }

    // ── path-deleted remotely ──────────────────────────────────────────────

    #[test]
    fn server_deleted_path_user_had_update_converts_to_create() {
        let old = json!({"a": 1, "b": 2});
        let user_patch = json!({"a": 9}); // user changed `a` to 9
        let r = re_anchor_one("p", PatchKind::Update, &user_patch, false, Some(&old), None);
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Create,
                patch: json!({"a": 9, "b": 2}), // user_intended = apply(old, patch),
                revert: false,
            })
        );
        assert_eq!(
            r.conflict,
            Some(PatchConflict {
                path: "p".into(),
                conflicting_keys: vec!["a".into()]
            })
        );
    }

    #[test]
    fn server_deleted_path_user_had_delete_drops_entry_no_conflict() {
        let old = json!({"a": 1});
        let r = re_anchor_one(
            "p",
            PatchKind::Delete,
            &JsonValue::Null,
            false,
            Some(&old),
            None,
        );
        assert_eq!(r.anchored, None);
        assert_eq!(r.conflict, None);
    }

    // ── same-field collision ───────────────────────────────────────────────

    #[test]
    fn server_changed_disjoint_key_no_conflict() {
        let old = json!({"a": 1, "b": 2});
        let new = json!({"a": 1, "b": 99}); // server changed b
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &json!({"a": 9}),
            false,
            Some(&old),
            Some(&new),
        );
        // User patch is preserved verbatim — RFC 7396 semantics naturally
        // leave keys-not-mentioned alone, so replaying {"a": 9} on the new
        // head yields {"a": 9, "b": 99}, keeping the server's b=99.
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Update,
                patch: json!({"a": 9}),
                revert: false,
            })
        );
        // No conflict: server touched b, user only touched a — disjoint.
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn server_changed_same_key_emits_conflict_user_wins() {
        let old = json!({"a": 1});
        let new = json!({"a": 5}); // server set a=5
        let user = json!({"a": 9}); // user set a=9
        let r = re_anchor_one("p", PatchKind::Update, &user, false, Some(&old), Some(&new));
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Update,
                patch: json!({"a": 9}),
                revert: false,
            })
        );
        assert_eq!(
            r.conflict,
            Some(PatchConflict {
                path: "p".into(),
                conflicting_keys: vec!["a".into()]
            })
        );
    }

    #[test]
    fn user_delete_on_server_modified_path_records_all_server_keys() {
        let old = json!({"a": 1, "b": 2});
        let new = json!({"a": 1, "b": 99, "c": 3});
        let r = re_anchor_one(
            "p",
            PatchKind::Delete,
            &JsonValue::Null,
            false,
            Some(&old),
            Some(&new),
        );
        // User-wins: still delete.
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Delete,
                patch: JsonValue::Null,
                revert: false,
            })
        );
        let c = r.conflict.expect("expected conflict");
        assert_eq!(c.path, "p");
        // Server changed b and c.
        let mut keys = c.conflicting_keys.clone();
        keys.sort();
        assert_eq!(keys, vec!["b".to_string(), "c".to_string()]);
    }

    // ── batched re_anchor_patches ──────────────────────────────────────────

    #[test]
    fn batch_re_anchor_two_paths() {
        use std::collections::HashMap;
        let old: HashMap<&str, JsonValue> = [("p1", json!({"a": 1})), ("p2", json!({"x": 10}))]
            .into_iter()
            .collect();
        let new: HashMap<&str, JsonValue> =
            [("p1", json!({"a": 5})), ("p2", json!({"x": 10, "y": 20}))]
                .into_iter()
                .collect();
        let patches = vec![
            update("p1", json!({"a": 9})),  // same-field collision on p1
            update("p2", json!({"y": 50})), // disjoint with p2's server change (y was added on server)
        ];
        let result = re_anchor_patches(
            &patches,
            |p| Ok(old.get(p).cloned()),
            |p| Ok(new.get(p).cloned()),
        )
        .unwrap();
        assert_eq!(result.patches.len(), 2);
        // p1: re-anchored to set a=9 against new head where a=5 → patch {"a": 9}.
        assert_eq!(result.patches[0].patch, json!({"a": 9}));
        // p2: re-anchored to set y=50 against new head where y=20 → patch {"y": 50}.
        assert_eq!(result.patches[1].patch, json!({"y": 50}));
        // Only p1 should produce a conflict (p2's y was added by the server
        // and is being overwritten — collision on `y`).
        let conflict_paths: Vec<&str> = result.conflicts.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(conflict_paths, vec!["p1", "p2"]);
        // p1 conflicting_keys = ["a"]; p2 conflicting_keys = ["y"].
        assert_eq!(result.conflicts[0].conflicting_keys, vec!["a"]);
        assert_eq!(result.conflicts[1].conflicting_keys, vec!["y"]);
    }

    // ── serde shapes ───────────────────────────────────────────────────────

    #[test]
    fn anchored_patch_serializes_lowercase_kind() {
        let entry = update("Companies/rec_1.json", json!({"industry": "SaaS"}));
        let s = serde_json::to_string(&entry).unwrap();
        assert!(s.contains(r#""kind":"update""#), "got: {s}");
        let round: AnchoredPatch = serde_json::from_str(&s).unwrap();
        assert_eq!(round, entry);
    }

    #[test]
    fn patch_kind_round_trips_through_json() {
        for kind in [PatchKind::Create, PatchKind::Update, PatchKind::Delete] {
            let s = serde_json::to_string(&kind).unwrap();
            let round: PatchKind = serde_json::from_str(&s).unwrap();
            assert_eq!(round, kind);
        }
    }

    // Suppress unused-warning for `create` / `delete` helpers if a test
    // is removed later.
    #[test]
    fn helper_constructors_compile() {
        let _ = create("p", json!({}));
        let _ = delete("p");
    }

    // ── compute_entry ──────────────────────────────────────────────────────

    #[test]
    fn compute_entry_unchanged_returns_none() {
        let v = json!({"a": 1});
        assert_eq!(compute_entry("p", Some(&v), Some(&v)), None);
        assert_eq!(compute_entry("p", None, None), None);
    }

    #[test]
    fn compute_entry_creates_when_snapshot_absent() {
        let w = json!({"name": "Acme"});
        assert_eq!(
            compute_entry("p", None, Some(&w)),
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Create,
                patch: json!({"name": "Acme"}),
                revert: false,
            })
        );
    }

    #[test]
    fn compute_entry_deletes_when_working_absent() {
        let s = json!({"a": 1});
        assert_eq!(
            compute_entry("p", Some(&s), None),
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Delete,
                patch: JsonValue::Null,
                revert: false,
            })
        );
    }

    #[test]
    fn compute_entry_updates_with_merge_patch() {
        let s = json!({"a": 1, "b": 2});
        let w = json!({"a": 9, "b": 2});
        assert_eq!(
            compute_entry("p", Some(&s), Some(&w)),
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Update,
                patch: json!({"a": 9}),
                revert: false,
            })
        );
    }
}
