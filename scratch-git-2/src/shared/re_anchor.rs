//! Re-anchor user patches when local `main` advances during pull.
//!
//! Phase 4 of the simplify-local-workspace plan (see
//! `docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md`).
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
/// The strategy is **value-based**, which makes it dialect-agnostic (it reads
/// RFC 6902 op arrays and legacy RFC 7396 merge patches alike) and robust to
/// arbitrary server drift:
///
///   1. Reconstruct the user's intended value against the base they edited
///      (`apply(old, patch)`), dual-read by shape.
///   2. Layer those edits onto the server's `new` state, user-wins per touched
///      key, preserving the server's changes to keys the user didn't touch
///      (`rebase_onto`). This is pure value work — a `remove` the server already
///      performed, or a nested parent the server deleted, never errors the way
///      replaying op-by-op against a drifted base would.
///   3. Re-emit a fresh entry against `new` via [`compute_entry`], which yields
///      a clean RFC 6902 body and drops the entry entirely when the server
///      already reflects the user's intent (no-op).
///
/// Server-deleted paths (`new = None`) with a surviving `Update`/`Create` intent
/// re-emit as a `Create` of the reconstructed value; a user `Delete` survives as
/// a `Delete` (user-wins).
pub fn re_anchor_one(
    path: &str,
    kind: PatchKind,
    patch: &JsonValue,
    revert: bool,
    old: Option<&JsonValue>,
    new: Option<&JsonValue>,
) -> anyhow::Result<ReAnchoredOne> {
    let anchored = re_anchor_entry(path, kind, patch, revert, old, new)?;
    let conflict = detect_conflict(path, kind, patch, old, new)?;
    Ok(ReAnchoredOne { anchored, conflict })
}

fn re_anchor_entry(
    path: &str,
    kind: PatchKind,
    patch: &JsonValue,
    revert: bool,
    old: Option<&JsonValue>,
    new: Option<&JsonValue>,
) -> anyhow::Result<Option<AnchoredPatch>> {
    // Revert-create special case: the patch was produced by `files revert-plan`
    // reviving a deleted record, the publish landed (path now exists on new
    // main), so the server consumed our `scratch_pending_recreate_<old_id>`
    // sentinel and wrote the new id to main + RecreatedIdMap. Drop the patch
    // unconditionally — the normal re-base + no-op dance can't succeed here
    // because the patch body still carries the sentinel id while main has the
    // server-assigned id; byte-equality would never match. The new id is
    // canonical on main; download will replay it into the worktree.
    if revert && kind == PatchKind::Create && new.is_some() {
        return Ok(None);
    }

    // Delete carries no value to rebase.
    match (kind, new) {
        (PatchKind::Delete, None) => return Ok(None), // both sides agree the file is gone
        (PatchKind::Delete, Some(_)) => {
            return Ok(Some(AnchoredPatch {
                path: path.to_string(),
                kind: PatchKind::Delete,
                patch: JsonValue::Null,
                revert,
            }));
        }
        _ => {}
    }

    // Reconstruct the user's intended value against the base they edited, then
    // re-emit it against `new`.
    let user_intended = reconstruct_user_intended(kind, patch, old)?;
    let re_emitted = match new {
        // Server deleted the path; re-create the user's intended content.
        None => compute_entry(path, None, Some(&user_intended)),
        // Path still exists on new: layer the user's edits onto it (user-wins),
        // then diff against new to produce the re-anchored 6902 entry.
        Some(n) => {
            let rebased = rebase_onto(old, &user_intended, n);
            compute_entry(path, Some(n), Some(&rebased))
        }
    };
    Ok(re_emitted.map(|mut entry| {
        entry.revert = revert;
        entry
    }))
}

/// The value the user intended at this path, computed against the base they
/// edited (`old`). `Create` carries the full content verbatim; `Update` applies
/// the patch (dual-read by shape) onto `old`.
fn reconstruct_user_intended(
    kind: PatchKind,
    patch: &JsonValue,
    old: Option<&JsonValue>,
) -> anyhow::Result<JsonValue> {
    match kind {
        PatchKind::Create => Ok(patch.clone()),
        PatchKind::Update => {
            let base = old.cloned().unwrap_or(JsonValue::Null);
            crate::shared::json_patch::apply_update_patch(&base, patch)
        }
        // Delete is handled by the caller before reaching here.
        PatchKind::Delete => Ok(JsonValue::Null),
    }
}

/// Layer the user's edits (`base` → `ours`) on top of the server's `theirs`
/// state, user-wins per touched key. Pure value op; never errors. The server's
/// changes to keys the user didn't touch are preserved; keys the user deleted
/// are removed from the result. Recurses into nested objects so a deep leaf edit
/// stays disjoint from a sibling the server changed.
fn rebase_onto(base: Option<&JsonValue>, ours: &JsonValue, theirs: &JsonValue) -> JsonValue {
    let base_map = base.and_then(|v| v.as_object());
    match (ours.as_object(), theirs.as_object()) {
        (Some(ours_obj), Some(theirs_obj)) => {
            let mut result = theirs_obj.clone();
            // Keys the user added or changed (relative to base).
            for (key, ours_value) in ours_obj {
                let base_value = base_map.and_then(|b| b.get(key));
                if base_value == Some(ours_value) {
                    continue; // user didn't touch this key
                }
                let merged = match (base_value, theirs_obj.get(key)) {
                    (Some(base_child), Some(theirs_child))
                        if base_child.is_object()
                            && ours_value.is_object()
                            && theirs_child.is_object() =>
                    {
                        rebase_onto(Some(base_child), ours_value, theirs_child)
                    }
                    _ => ours_value.clone(),
                };
                result.insert(key.clone(), merged);
            }
            // Keys the user deleted (present in base, absent in ours).
            if let Some(base_obj) = base_map {
                for key in base_obj.keys() {
                    if !ours_obj.contains_key(key) {
                        result.shift_remove(key);
                    }
                }
            }
            JsonValue::Object(result)
        }
        // The user's intended value is a non-object (scalar / array / null), or
        // the server replaced the record with a non-object — user wins wholesale.
        _ => ours.clone(),
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
///   - snapshot=Some, working=Some, different → Update (patch = the RFC 6902
///     op array `json_patch::diff(snap, work)`)
///
/// Used by the accept-time path: every accept / accept-field / accept-all
/// flows through this to produce the entry written into
/// `accepted-patches.json`. This is the single chokepoint that makes accepted
/// `Update` bodies RFC 6902 (so a `field: null` accept round-trips and DEV-10237
/// converges); `Create` keeps the full verbatim record and `Delete` keeps the
/// `kind` discriminator, both already null-safe.
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
        (Some(s), Some(w)) => {
            // s != w here (the equal case is handled above), so the op list is
            // non-empty; the guard is just defensive.
            let ops = crate::shared::json_patch::diff(s, w);
            if ops.is_empty() {
                None
            } else {
                Some(AnchoredPatch {
                    path: path.to_string(),
                    kind: PatchKind::Update,
                    patch: crate::shared::json_patch::ops_to_value(&ops),
                    revert: false,
                })
            }
        }
    }
}

/// True when `intended` is a **publish no-op** against `main` — i.e. the server's
/// publish pipeline would compute empty `changedFields` and never call the
/// connector for it. Mirrors `computeChangedFields`
/// (`server/src/publish-plan/diff-utils.ts`): it walks only the keys present in
/// `intended`, recurses into plain (non-array) objects, compares everything else
/// by value, and — crucially — **ignores keys present on `main` but absent from
/// `intended`** (a removed key is deliberately not a publishable change).
///
/// The publish reconcile (DEV-10048) uses this to drop a stranded no-op edit
/// (classically a removed JSON key) that `main` never advanced for: re-anchor
/// keeps such a patch (its outcome still differs from `main` by the removal), but
/// the publish would never act on it, so it must be dropped instead of staying
/// stuck as "accepted".
///
/// Leaf/array comparison is by JSON value equality (slightly more lenient than
/// the server's `JSON.stringify` only for the pathological case of arrays of
/// objects with reordered keys — semantically equal there, which is the more
/// correct call).
pub fn is_publish_no_op_against_main(main: Option<&JsonValue>, intended: &JsonValue) -> bool {
    match intended {
        JsonValue::Object(intended_obj) => {
            let main_obj = main.and_then(|m| m.as_object());
            for (key, intended_val) in intended_obj {
                let main_val = main_obj.and_then(|m| m.get(key));
                let both_plain_objects =
                    intended_val.is_object() && main_val.map(JsonValue::is_object).unwrap_or(false);
                if both_plain_objects {
                    if !is_publish_no_op_against_main(main_val, intended_val) {
                        return false;
                    }
                } else if main_val != Some(intended_val) {
                    return false;
                }
            }
            true
        }
        // A non-object intended value (scalar / array / null) is a no-op only when
        // it already equals `main` exactly.
        _ => main == Some(intended),
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
        )?;
        if let Some(a) = result.anchored {
            out.patches.push(a);
        }
        if let Some(c) = result.conflict {
            out.conflicts.push(c);
        }
    }
    Ok(out)
}

/// Coalesce an empty conflicting-key list to the whole-file sentinel.
fn nonempty_or_whole_file(keys: Vec<String>) -> Vec<String> {
    if keys.is_empty() {
        vec![WHOLE_FILE_KEY.to_string()]
    } else {
        keys
    }
}

/// Top-level keys where the user's intended value differs from the base they
/// edited — the dialect-free analogue of "the keys the patch mentions". Returns
/// the whole-file sentinel when the intended value isn't an object.
fn touched_top_level_keys(old: Option<&JsonValue>, intended: &JsonValue) -> Vec<String> {
    let old_map = old.and_then(|v| v.as_object());
    let Some(intended_map) = intended.as_object() else {
        return vec![WHOLE_FILE_KEY.to_string()];
    };
    let mut keys: Vec<String> = Vec::new();
    for (key, intended_value) in intended_map {
        if old_map.and_then(|o| o.get(key)) != Some(intended_value) {
            keys.push(key.clone());
        }
    }
    if let Some(old_obj) = old_map {
        for key in old_obj.keys() {
            if !intended_map.contains_key(key) && !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    keys
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
) -> anyhow::Result<Option<PatchConflict>> {
    if old == new {
        return Ok(None); // server didn't touch this path
    }

    // Outcome the user wanted, regardless of what's on the server (dual-read).
    let user_intended: Option<JsonValue> = match kind {
        PatchKind::Delete => None,
        _ => Some(reconstruct_user_intended(kind, patch, old)?),
    };

    if user_intended.as_ref() == new {
        // user and server agree on final state — even if they got there
        // independently, there's no override happening.
        return Ok(None);
    }

    // Path-deleted remotely while user had a non-Delete edit.
    if new.is_none() {
        let intended = user_intended.as_ref().unwrap();
        return Ok(Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: nonempty_or_whole_file(touched_top_level_keys(old, intended)),
        }));
    }

    // User wants Delete on a server-modified file — all server-changed keys
    // are being lost.
    if kind == PatchKind::Delete {
        return Ok(Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: nonempty_or_whole_file(server_changed_keys(old, new)),
        }));
    }

    // Update / Create where the file exists on the new head: walk the
    // reconstructed values. A key path (e.g. "properties.city") is "conflicting"
    // iff (a) the user touched it, (b) the server changed it, AND (c) the user's
    // intended value differs from the server's new value. Walking values rather
    // than the patch makes this dialect-free and keeps the audit log specific
    // (properties.city, not the whole "properties" subtree).
    let intended = user_intended.as_ref().unwrap();
    let new_value = new.unwrap();
    if !intended.is_object() || !new_value.is_object() {
        // Whole-file scalar/array replacement — a single conflicting scope.
        return Ok(Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: vec![WHOLE_FILE_KEY.to_string()],
        }));
    }

    let mut conflicting: Vec<String> = Vec::new();
    collect_value_conflicts(old, intended, new_value, "", &mut conflicting);

    Ok(if conflicting.is_empty() {
        None
    } else {
        Some(PatchConflict {
            path: path.to_string(),
            conflicting_keys: conflicting,
        })
    })
}

/// Recursively walk the user's reconstructed intended value against `old` and
/// `new`, accumulating dot-separated key paths where the user touched a key,
/// the server also changed it, and the two outcomes differ. Dialect-free: it
/// compares values, not patch structure. A missing key is treated as `null`
/// (matching the legacy merge-patch comparison) so the conflict report is
/// stable across the dialect migration.
fn collect_value_conflicts(
    old: Option<&JsonValue>,
    intended: &JsonValue,
    new: &JsonValue,
    prefix: &str,
    out: &mut Vec<String>,
) {
    let Some(intended_map) = intended.as_object() else {
        return;
    };
    let new_map = new.as_object();
    let old_map = old.and_then(|v| v.as_object());

    // Keys present in the intended value plus keys the user deleted (in old,
    // absent from intended).
    let mut keys: Vec<&String> = intended_map.keys().collect();
    if let Some(old_obj) = old_map {
        for key in old_obj.keys() {
            if !intended_map.contains_key(key) {
                keys.push(key);
            }
        }
    }

    for key in keys {
        let key_path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        let intended_v = intended_map.get(key).cloned().unwrap_or(JsonValue::Null);
        let new_v = new_map
            .and_then(|o| o.get(key))
            .cloned()
            .unwrap_or(JsonValue::Null);
        let old_v = old_map
            .and_then(|o| o.get(key))
            .cloned()
            .unwrap_or(JsonValue::Null);

        if old_v == intended_v {
            continue; // user didn't touch this key
        }

        // Recurse into the sub-object only when all three sides are objects;
        // otherwise the comparison happens at this level (the values are wholly
        // replaced rather than recursively merged).
        if intended_v.is_object() && new_v.is_object() && old_v.is_object() {
            collect_value_conflicts(Some(&old_v), &intended_v, &new_v, &key_path, out);
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

    /// Test shadow: re-anchoring a well-formed patch against its own base never
    /// fails, so unwrap the `Result` for terse assertions. Shadows the
    /// glob-imported `super::re_anchor_one`.
    fn re_anchor_one(
        path: &str,
        kind: PatchKind,
        patch: &JsonValue,
        revert: bool,
        old: Option<&JsonValue>,
        new: Option<&JsonValue>,
    ) -> ReAnchoredOne {
        super::re_anchor_one(path, kind, patch, revert, old, new).unwrap()
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
                // Re-emitted as a 6902 op array against the (unchanged) new head.
                patch: json!([{"op": "add", "path": "/a", "value": 9}]),
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
        // User only touched `a`; re-basing onto new keeps the server's b=99 and
        // re-emits just the `a` edit as a 6902 op — disjoint, no conflict.
        assert_eq!(
            r.anchored,
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Update,
                patch: json!([{"op": "add", "path": "/a", "value": 9}]),
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
                patch: json!([{"op": "add", "path": "/a", "value": 9}]),
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
        // p1: re-anchored to set a=9 against new head where a=5 → 6902 add /a 9.
        assert_eq!(
            result.patches[0].patch,
            json!([{"op": "add", "path": "/a", "value": 9}])
        );
        // p2: re-anchored to set y=50 against new head where y=20 → 6902 add /y 50.
        assert_eq!(
            result.patches[1].patch,
            json!([{"op": "add", "path": "/y", "value": 50}])
        );
        // Only p1 should produce a conflict (p2's y was added by the server
        // and is being overwritten — collision on `y`).
        let conflict_paths: Vec<&str> = result.conflicts.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(conflict_paths, vec!["p1", "p2"]);
        // p1 conflicting_keys = ["a"]; p2 conflicting_keys = ["y"].
        assert_eq!(result.conflicts[0].conflicting_keys, vec!["a"]);
        assert_eq!(result.conflicts[1].conflicting_keys, vec!["y"]);
    }

    // ── 6902-native input, null + remove robustness, pointer conflicts ──────

    #[test]
    fn re_anchor_6902_input_reemits_6902() {
        // Native path: the incoming patch is already a 6902 op array.
        let old = json!({"a": 1, "b": 2});
        let new = old.clone();
        let patch = json!([{"op": "add", "path": "/a", "value": 9}]);
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &patch,
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(
            r.anchored.unwrap().patch,
            json!([{"op": "add", "path": "/a", "value": 9}])
        );
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn re_anchor_preserves_set_null_across_rebase() {
        // DEV-10237 carried through re-anchor: a field set to null survives the
        // re-base and re-emits as `add /a null` (the server's disjoint `b` is
        // left alone).
        let old = json!({"a": 1});
        let new = json!({"a": 1, "b": 7});
        let patch = json!([{"op": "add", "path": "/a", "value": null}]);
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &patch,
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(
            r.anchored.unwrap().patch,
            json!([{"op": "add", "path": "/a", "value": null}])
        );
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn re_anchor_remove_is_tolerant_when_server_already_removed() {
        // The robustness win over verbatim op replay: the user removed `b`, and
        // the server independently removed `b` too. Replaying `remove /b`
        // op-by-op against the new head would error (target missing); value-based
        // re-base sees the intent already satisfied and drops the entry.
        let old = json!({"a": 1, "b": 2});
        let new = json!({"a": 1});
        let patch = json!([{"op": "remove", "path": "/b"}]);
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &patch,
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(r.anchored, None, "user and server both removed b → no-op");
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn re_anchor_remove_reemits_when_server_kept_key() {
        let old = json!({"a": 1, "b": 2});
        let new = json!({"a": 1, "b": 2});
        let patch = json!([{"op": "remove", "path": "/b"}]);
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &patch,
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(
            r.anchored.unwrap().patch,
            json!([{"op": "remove", "path": "/b"}])
        );
        assert_eq!(r.conflict, None);
    }

    #[test]
    fn re_anchor_revert_create_drops_entry_once_publish_landed() {
        // A `files revert-plan` Create whose body still carries the
        // scratch_pending_recreate_<id> sentinel: the publish landed (the path
        // now exists on new main under a server-assigned id), so the patch is
        // dropped unconditionally — byte-equality could never match the sentinel.
        let sentinel_body = json!({"id": "scratch_pending_recreate_old123", "name": "Revived"});
        let server_assigned = json!({"id": "rec_new999", "name": "Revived"});
        let r = re_anchor_one(
            "p",
            PatchKind::Create,
            &sentinel_body,
            true, // revert
            None,
            Some(&server_assigned),
        );
        assert_eq!(
            r.anchored, None,
            "revert-create drops once the publish lands"
        );
    }

    #[test]
    fn re_anchor_null_wins_and_conflicts_when_server_set_same_field() {
        // Same-field collision where the user's intended value is an explicit
        // null: user-wins (re-emits `add /a null`) AND the collision is reported.
        let old = json!({"a": 1});
        let new = json!({"a": 5}); // server set a=5
        let patch = json!([{"op": "add", "path": "/a", "value": null}]); // user set a=null
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &patch,
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(
            r.anchored.unwrap().patch,
            json!([{"op": "add", "path": "/a", "value": null}])
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
    fn re_anchor_nested_conflict_reports_dotted_path_and_keeps_sibling() {
        // Conflict granularity: the user edited properties.city, the server
        // changed both city and zip. Re-base is user-wins on city (server's zip
        // preserved) and the conflict is reported precisely as properties.city —
        // not the whole "properties" subtree, and zip is not flagged.
        let old = json!({"properties": {"city": "Paris", "zip": "75001"}});
        let new = json!({"properties": {"city": "Berlin", "zip": "10115"}});
        let patch = json!([{"op": "add", "path": "/properties/city", "value": "London"}]);
        let r = re_anchor_one(
            "p",
            PatchKind::Update,
            &patch,
            false,
            Some(&old),
            Some(&new),
        );
        assert_eq!(
            r.anchored.unwrap().patch,
            json!([{"op": "add", "path": "/properties/city", "value": "London"}])
        );
        let c = r.conflict.expect("city collides");
        assert_eq!(c.conflicting_keys, vec!["properties.city".to_string()]);
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
    fn compute_entry_updates_with_json_patch_op_array() {
        let s = json!({"a": 1, "b": 2});
        let w = json!({"a": 9, "b": 2});
        assert_eq!(
            compute_entry("p", Some(&s), Some(&w)),
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Update,
                // RFC 6902 op array, not a merge-patch object.
                patch: json!([{"op": "add", "path": "/a", "value": 9}]),
                revert: false,
            })
        );
    }

    #[test]
    fn compute_entry_update_setting_field_to_null_is_add_null() {
        // The DEV-10237 case: accepting a field set to null emits `add null`,
        // which reconstructs back to `field: null` (vs RFC 7396's lossy delete).
        let s = json!({"a": 1});
        let w = json!({"a": null});
        assert_eq!(
            compute_entry("p", Some(&s), Some(&w)),
            Some(AnchoredPatch {
                path: "p".into(),
                kind: PatchKind::Update,
                patch: json!([{"op": "add", "path": "/a", "value": null}]),
                revert: false,
            })
        );
    }

    // ── is_publish_no_op_against_main (DEV-10048) ───────────────────────────

    #[test]
    fn no_op_when_intended_only_removes_keys() {
        // The DEV-10048 case: the user's intent drops key `b`; the publish ignores
        // removed keys, so it's a no-op against main.
        let main = json!({"a": 1, "b": 2});
        let intended = json!({"a": 1});
        assert!(is_publish_no_op_against_main(Some(&main), &intended));
    }

    #[test]
    fn not_no_op_when_a_value_changed() {
        let main = json!({"a": 1, "b": 2});
        let intended = json!({"a": 9, "b": 2});
        assert!(!is_publish_no_op_against_main(Some(&main), &intended));
    }

    #[test]
    fn not_no_op_when_a_key_added() {
        let main = json!({"a": 1});
        let intended = json!({"a": 1, "c": 3});
        assert!(!is_publish_no_op_against_main(Some(&main), &intended));
    }

    #[test]
    fn no_op_for_nested_removed_key_only() {
        let main = json!({"props": {"a": 1, "b": 2}});
        let intended = json!({"props": {"a": 1}});
        assert!(is_publish_no_op_against_main(Some(&main), &intended));
    }

    #[test]
    fn not_no_op_for_nested_changed_value() {
        let main = json!({"props": {"a": 1, "b": 2}});
        let intended = json!({"props": {"a": 1, "b": 9}});
        assert!(!is_publish_no_op_against_main(Some(&main), &intended));
    }

    #[test]
    fn not_no_op_for_create_against_missing_main() {
        let intended = json!({"name": "Acme"});
        assert!(!is_publish_no_op_against_main(None, &intended));
    }

    #[test]
    fn no_op_when_equal() {
        let v = json!({"a": 1, "b": [1, 2, 3]});
        assert!(is_publish_no_op_against_main(Some(&v), &v.clone()));
    }
}
