# Migrate the review/publish patch format from RFC 7396 (JSON Merge Patch) to RFC 6902 (JSON Patch)

Author: Curtis Fonger
Created: 2026-06-05
Status: Planned
Linear: [DEV-10237 — Stuck with "1 field needs review"](https://linear.app/whalesync/issue/DEV-10237) — tracked under this issue (the migration is the fix for the symptom).

**Commit & tracking convention:** every commit, branch, and PR for this work **must include `DEV-10237` in the title** so Linear auto-links it to the issue. The working branch already carries the id; keep the scoped-prefix style and append/lead with the id, e.g. `[shared-types] DEV-10237 add RFC 6902 json_patch applier`.

## Problem

The review/publish pipeline represents the "approved delta" — the difference between what is published (`refs/heads/main`) and what the user has approved — as an **RFC 7396 JSON Merge Patch**, stored per record in `accepted-patches.json` and sent over the wire to update the dirty branch. RFC 7396 has one defining limitation: **`null` is overloaded as the deletion sentinel.** A `null` value in a merge patch means "delete this key," so the format provably **cannot represent "set this field to `null`" and cannot round-trip any document that contains explicit nulls.** The RFC says so itself — it is only appropriate for documents that "do not make use of explicit null values."

Scratch is exactly the system the RFC warns against. The **Preserve external data fidelity** principle requires storing the verbatim API response, and Airtable / Notion / HubSpot / Webflow routinely return explicit `null` for empty fields. So we are required by principle to keep nulls on disk, while using a delta format defined to be unable to carry them.

The concrete failure (DEV-10237 — "stuck with 1 field needs review"):

```
diff({a: 1}, {a: null})   →  {a: null}      // "a changed to null"
apply({a: 1}, {a: null})  →  {}             // "a deleted"  — round-trip is lossy
```

A working record holding `"field": null` can never agree with its reconstructed approved state (`apply(main, patch)` strips the null), so:

- the row-level `unapprovedChanges` bit ([`folder_index.rs::compute_review_bits`](../../scratch-git-2/src/shared/folder_index.rs)) flags the record (`working != approved`);
- the desktop per-field badge ([`local-files.ts::compareFlattenedRecordVersions`](../../scratch-desktop/src/main/local-files.ts)) shows "1 field needs review";
- **accept cannot clear it** ([`review_ops.rs::accept_field_in_folder`](../../scratch-git-2/src/shared/review_ops.rs)) — folding `field: null` into the patch and reconstructing strips it again (non-convergent);
- **reject only "clears" it by deleting the field from the working file**, discarding a real value; the next pull re-adds `field: null` and re-flags it ("hit this again on yesterday's build").

This is not a code slip — it is the format's documented limitation colliding with a product invariant. The fix is to stop overloading `null`: migrate the delta format to **RFC 6902 JSON Patch**, where `null` is an ordinary value and deletion is an explicit `remove` operation.

## Goals

- Replace RFC 7396 merge patches with **RFC 6902 JSON Patch** as the representation of the approved delta (the `Update` patch body in `accepted-patches.json` and the upload-patch wire payload).
- Make `null` a first-class value end to end: `{"op":"replace","path":"/field","value":null}` sets null; `{"op":"remove","path":"/field"}` deletes. Reconstruction of the approved state is lossless for documents containing nulls.
- Eliminate the stuck "needs review" state (DEV-10237) by construction: a working record's nulls survive into the reconstructed approved value, so a record that genuinely matches approved is never flagged, and a record that genuinely differs can be approved and converges.
- Keep both engines (Rust `shared` + server TypeScript) **semantically equivalent**, verified by a shared parity test corpus.
- Adopt a documented, standard format with mature tooling and broad model/agent familiarity.
- Provide a deterministic, lossless one-shot migration for existing on-disk `accepted-patches.json` files.

## Non-goals

- **No array element surgery.** We keep today's atomic-array semantics: any array difference emits a single whole-array `replace` (or `add`) at the array's object-member path. We never emit index-addressed array ops (`/tags/3`, `/tags/-`). This is a deliberate, conformant subset of RFC 6902.
- **No per-connector null-publishing plumbing.** The merge/json patch is primarily an *internal* representation; the actual publish to a service is computed later from dirty-vs-main by the publish-plan job. Giving connectors the ability to push `field → null` (vs omit) to a specific service is a separate effort, tracked independently. This migration makes the internal state *correct*; it does not change what bytes a connector sends.
- **No change to object recursion behavior.** We continue to recurse into nested objects key-by-key (matching `merge_patch::diff` today), only treating arrays as atomic. This keeps patches small and diffs legible.
- **No canonicalization of user edits on accept/upload.** Editors still produce whatever JSON they produce; the detector absorbs harmless byte differences (unchanged from [2026-05-27-unreviewed-detection-semantic-compare](./resolved/2026-05-27-unreviewed-detection-semantic-compare.md)).

## Background — where the format lives today

RFC 7396 is load-bearing in three engines that must stay equivalent, and `null` is overloaded at two levels (whole-patch `null` = delete record; field `null` = delete field).

| Consumer | File | Role |
| --- | --- | --- |
| `merge_patch::diff` / `apply` | [scratch-git-2/src/shared/merge_patch.rs](../../scratch-git-2/src/shared/merge_patch.rs) | Generate + apply the merge patch (null-deletes at line 42) |
| `compute_entry`, `re_anchor_patches` | [scratch-git-2/src/shared/re_anchor.rs](../../scratch-git-2/src/shared/re_anchor.rs) | Build patch from (snapshot, working); re-anchor pending patches when main advances (preserves the user's patch verbatim, per-key conflict detection) |
| `AnchoredPatch`, `remove_field`, `upsert_entry` | [scratch-git-2/src/shared/accepted_patches.rs](../../scratch-git-2/src/shared/accepted_patches.rs) | On-disk `accepted-patches.json` schema + field-level edits to the patch |
| `apply_patch_entry_to_blob`, `accept/reject/discard_field_in_folder`, `approved_object_for_path` | [scratch-git-2/src/shared/review_ops.rs](../../scratch-git-2/src/shared/review_ops.rs) | Reconstruct approved blob; field-level review actions |
| `approved_json_for_entry`, `compute_review_bits` | [scratch-git-2/src/shared/folder_index.rs](../../scratch-git-2/src/shared/folder_index.rs) | Row-level `approved`/`unapproved` bit compute |
| `RecordBlobs.approved` reconstruction | [scratch-git-2/napi/src/lib.rs](../../scratch-git-2/napi/src/lib.rs) | Approved/published snapshots consumed by the desktop |
| `applyJsonMergePatch`, top-level-null delete | [server/src/publish-plan/apply-patches.service.ts](../../server/src/publish-plan/apply-patches.service.ts) | Apply the wire patch onto the dirty branch (null-deletes at line ~225; whole-patch null = delete file at line ~62) |
| `UploadPatchPayload` DTO | `@spinner/shared-types` | Wire shape of the upload-patch payload (`patch` field) |
| `compareFlattenedRecordVersions` | [scratch-desktop/src/main/local-files.ts](../../scratch-desktop/src/main/local-files.ts) | Per-field "needs review" badge (compares working vs reconstructed approved) |

`AnchoredPatch` is the unit ([re_anchor.rs:44](../../scratch-git-2/src/shared/re_anchor.rs)):

```rust
pub struct AnchoredPatch {
    pub path: String,
    pub kind: PatchKind,   // Create | Update | Delete
    pub patch: JsonValue,  // TODAY: null for delete; full content for create; 7396 merge patch for update
    pub revert: bool,
}
```

The key insight that bounds the work: **only the `Update` patch body changes.** `Create` keeps the full verbatim record (already null-safe — it is just the value). `Delete` keeps `kind = Delete` (record lifecycle stays a discriminator, which also cleanly retires the whole-patch-`null` overload). Everything else is reconstruction, field addressing, and the wire/parity surface around that one field.

## Design

### 1. The patch dialect we emit (constrained, conformant RFC 6902)

An `Update` patch body becomes a JSON array of operations. We **emit** only two op types, addressed by **RFC 6901 JSON Pointers**:

- `{"op":"add","path":"/<ptr>","value":<v>}` — the field should be present with value `<v>` (new **or** changed). RFC 6902 `add` upserts object members: it creates a missing member and replaces an existing one, so one op covers both cases.
- `{"op":"remove","path":"/<ptr>"}` — the field is present in the snapshot, absent in working.

We deliberately do **not** emit `replace` (nor `move`/`copy`/`test`). Rationale: no consumer branches on the `add`-vs-`replace` verb (the applier only cares about pre-existence; re-anchor conflict detection is pointer-set based; the desktop reconstructs and compares values; the publish plan is computed from dirty-vs-main). Meanwhile our patches are applied against **drifting bases** — `accepted-patches.json` is re-anchored when `main` advances, and the server applies onto the *dirty branch*, not the user's local `main`. `add` upserts and tolerates a field that has since vanished upstream; `replace` would hard-error mid-apply ("target location MUST exist", §4.3). So `add`-only is simpler (two differ cases, no "did this key exist before?" lookup), more robust, and more idempotent under drift. The lost new-vs-changed legibility is cosmetic and unused. (We still *apply* the full standard — see §2.)

Rules:

- **Recurse objects, atomic arrays.** Descend into a path only when *both* sides are JSON objects there; otherwise emit a single `add`/`replace`/`remove` for the whole subtree. Arrays are always whole-value (`replace /tags <array>`), never index-addressed. This is exactly the control flow of `merge_patch::diff` today, minus the null special case.
- **`null` is a value.** A field changing to null is `replace /field null`; a field being removed is `remove /field`. No overloading.
- **JSON Pointer escaping (RFC 6901):** `~` → `~0`, `/` → `~1`. This is strictly *more* correct than today's dot-split field addressing (`read_nested_json_value` splits on `.` and cannot address a key that itself contains a `.`). Pointers handle connector keys with dots, slashes, spaces, and emoji unambiguously.

### 2. The applier (full standard)

Implement a **complete** RFC 6902 applier (`add`, `remove`, `replace`, `move`, `copy`, `test`) on both engines, even though our differ emits only the `add`/`remove` subset (§1). Reading the full standard costs little extra and makes us genuinely interoperable (libraries, agents, hand-authored or externally-generated patches that may use `replace`/`move`/`copy`/`test`). Validate against RFC 6902 Appendix A vectors as golden tests on both engines.

Array semantics in the applier are standard (index `add` inserts, `-` appends); we simply never *generate* those ops. If a non-conformant or externally-authored patch contains an index op, the applier still applies it correctly.

### 3. The differ

Port `merge_patch::diff` to emit an op array. Pseudocode (mirrors today's structure):

```
fn diff_6902(base_ptr, old, new, out):
    if old == new: return
    if old and new are both objects:
        for key in old not in new:           out.push(remove, ptr(base,key))
        for key in new not in old:           out.push(add,    ptr(base,key), new[key])     # new key
        for key in both where old[k]!=new[k]:
            if old[k] and new[k] both objects: diff_6902(ptr(base,key), old[k], new[k], out)  # recurse (smaller patches)
            else:                              out.push(add, ptr(base,key), new[k])           # changed leaf; arrays atomic; null is a value
    else:
        out.push(add, base_ptr, new)   # whole-value upsert at this path (root for an Update is always object→object, so this is the nested-leaf case)
```

`add` is the single verb for "field should hold this value," whether new or changed (§1). Object recursion is retained so a one-field change in a large nested envelope produces one leaf op, not a whole-subtree replace. The recursion guard (descend only when *both* sides are objects) means a newly-introduced subtree is emitted as a single `add /parent {…}`, which is required anyway since you cannot `add /parent/child` when `/parent` is absent.

`compute_entry` ([re_anchor.rs:237](../../scratch-git-2/src/shared/re_anchor.rs)) keeps its `(snapshot, working)` → `Create`/`Update`/`Delete` shape; only the `Update` branch swaps `merge_patch::diff` for `diff_6902`. `Create`/`Delete` are unchanged.

### 4. Data model + on-disk format

- `AnchoredPatch.patch` for `kind = Update` now holds a 6902 op array (`JsonValue::Array`). Doc comment updated.
- Add a format version to `AcceptedPatchesFile` (the wrapper already anticipates this: "add metadata (schema version) later without breaking older clients"). E.g. `{"version": 2, "patches": [...]}`. Absent/`1` = legacy 7396; `2` = 6902. Readers branch on it during the dual-read window.
- `working-patches.json` (same `AnchoredPatch` shape) migrates identically.

### 5. Reconstruction of the approved state

`apply_patch_entry_to_blob` ([review_ops.rs:383](../../scratch-git-2/src/shared/review_ops.rs)) and `approved_object_for_path` swap `merge_patch::apply` for the 6902 applier on `Update`. Because the applier preserves nulls, the reconstructed approved value now faithfully carries `field: null`, which makes:

- `compute_review_bits` correct (working `{f:null}` == approved `{f:null}` → not flagged);
- the napi `approved` snapshot faithful, so the **desktop needs no comparison-logic change** — `compareFlattenedRecordVersions` already treats null-vs-absent as different, which is now the *correct* answer (and an approvable one).

### 6. Field-level review actions (`review_ops.rs`)

`accept` / `reject` / `discard_field_in_folder` currently address fields by dot path via `read_nested_json_value` / `apply_nested_json_value`. They keep operating on the **reconstructed approved/working objects** (not on raw patch internals), so the field-edit logic is largely unchanged — the change is:

- The composed approved object is re-diffed with `diff_6902` (via `compute_entry`) instead of merge-patch diff. The null trap is gone: accepting a `field: null` produces `replace /field null`, which reconstructs back to `field: null` → converges.
- `accepted_patches::remove_field` ([accepted_patches.rs:139](../../scratch-git-2/src/shared/accepted_patches.rs)) currently deletes a key from the merge-patch object. With op arrays it must drop the op(s) whose pointer targets that field (and its descendants). Alternatively — and more robustly — recompute the whole entry from (main, edited-approved) via `compute_entry` and let it emit the minimal op list, avoiding hand-editing the op array. **Preferred: recompute, don't hand-edit.**

### 7. Re-anchoring (`re_anchor_patches`)

This is the most correctness-sensitive consumer. When `main` advances on pull, pending patches are re-anchored against the new base, with per-key conflict detection ("user touched `industry`, server also changed `industry`"). The strategy ports directly because a 6902 op list, like a 7396 patch, **mentions only the paths the user touched**:

- "Keys the user touched" = the set of pointers appearing in the op array (top-level component for conflict granularity).
- Conflict = a touched pointer that the server also changed between `old` and `new`.
- Re-anchor = re-base the op list against `new` (drop ops the server already satisfied; preserve the rest user-wins).

Implementation note: because reconstruction is lossless now, the simplest correct re-anchor is value-based — reconstruct the user's intended approved value against `old`, then `compute_entry(path, new, intended_value)` to re-emit against `new` — rather than rewriting ops in place. Conflict detection still compares touched-pointer sets. Preserve the existing `PatchConflict` / `WHOLE_FILE_KEY` reporting contract.

### 8. Server publish-apply

- Rename/replace `applyJsonMergePatch` → `applyJsonPatch` (RFC 6902 applier) in [apply-patches.service.ts](../../server/src/publish-plan/apply-patches.service.ts), mirroring the Rust applier exactly (shared parity corpus).
- The whole-record delete signal moves off "top-level `null` patch" (line ~62) onto the explicit `kind = Delete` discriminator that the DTO already carries. (`PatchKind` already matches the wire `kind` field — see [re_anchor.rs:30](../../scratch-git-2/src/shared/re_anchor.rs).) Deletes stop being encoded as a magic null.
- Apply `Update` op arrays onto the dirty-branch base; `Create` writes the full record; `Delete` removes the file.

### 9. Wire format (`@spinner/shared-types`)

- `UploadPatchPayload.patches[].patch` for `Update` becomes the op array. Add the format version / `kind` plumbing so the server can distinguish dialects during rollout.
- The CLI upload-patch construction reads `accepted-patches.json` and forwards the (already-6902) `Update` bodies unchanged.

### 10. Desktop

No comparison-logic change required (see §5). One mapping concern: the grid addresses columns by dotted-quoted leaf ids (e.g. `properties."Asked for Intro?".checkbox`) while patches use JSON Pointers. Field-level accept/reject already round-trips through the Rust field commands; ensure the desktop→Rust field identifier and the Rust pointer encoding agree on keys containing `.` / `/` / quotes. This is a net correctness improvement over the current dot-split.

## Migration / backward compatibility

Existing workspaces have `accepted-patches.json` files in 7396 form. The conversion is **deterministic and lossless precisely because 7396 could not express set-null** — no legacy approved value ever contained an intentional null:

```
For each Update entry, given main_blob at that path:
    approved_value = apply_7396(main_blob, old_update_patch)   # final read with legacy semantics
    new_op_list    = diff_6902(main_blob, approved_value)
    rewrite entry.patch = new_op_list
Bump file version 1 → 2.
```

`Create` / `Delete` entries are copied verbatim (`Delete` already implied by `kind`; we drop the now-meaningless `patch: null` body for deletes).

Rollout ordering (client + server ship independently):

- **Dual-read window.** Both engines read v1 (7396) and v2 (6902), keyed on the file/DTO version. They **write** v2 only after the server can read v2.
- **Server first** (read both, apply both) → **CLI/desktop next** (convert-on-write to v2, send v2) → drop v1 read after a deprecation window once telemetry shows no v1 traffic.
- **In-flight uploads:** the upload DTO carries its version; the server dispatches to the matching applier. A v1 client talking to a v2 server keeps working throughout.
- **Lazy convert-on-write only.** A v1 `accepted-patches.json` is converted to v2 the first time a review action mutates it (`save_atomic`), never by a proactive sweep — we never rewrite a workspace the user isn't touching. Until then it is *read* via the v1 (7396) path. There is no separate maintenance subcommand. A purely-read workspace can stay v1 indefinitely without harm, since reconstruction handles both dialects during the dual-read window. (Consequence: the v1 read path cannot be removed until effectively all active workspaces have had at least one write since the cutover — gate removal on telemetry, not a fixed date.)

## Testing & two-engine equivalence

- **Parity corpus.** A shared JSON fixture set of `(base, patch, expected)` triples exercised by *both* the Rust applier and the TS applier, asserting byte-identical (canonicalized) results. This is the contract that keeps the engines equivalent — extend it whenever either side changes.
- **RFC 6902 Appendix A golden vectors** on both appliers (full op set, including the ops we don't emit).
- **Null round-trip property test** (the bug we are fixing): for arbitrary JSON objects including explicit nulls, `apply_6902(base, diff_6902(base, target)) == target`. This is the property `merge_patch` provably fails today.
- **Differ minimality / atomic-array tests:** array change → single whole-array `add` at the array path (never index ops); nested object change → recursive single leaf op; field set to null → `add /field null`, **not** `remove` (the exact behavior 7396 could not express); field removed → `remove`.
- **Review-action convergence tests:** accept a `field: null` edit → row bit clears, badge clears, second accept is a no-op (regression test for DEV-10237). Reject restores the approved value (incl. null) without mutating unrelated fields.
- **Re-anchor tests:** port the existing `re_anchor` suite; add null-bearing patches and pointer-keyed conflict cases.
- **Migration tests:** legacy v1 files convert to equivalent v2 (reconstructed approved value identical pre/post conversion).
- **End-to-end:** confirm against a DEV-10237 repro workspace once Joel's zip lands (grep for working records with explicit null leaves absent from reconstructed approved) — verify the migration clears them.

## Suggested sequencing (phased PRs)

1. **Core dialect (Rust):** `json_patch` module — full applier + constrained differ + parity/Appendix-A/round-trip tests. No wiring yet.
2. **Reconstruction + review actions (Rust):** swap `apply_patch_entry_to_blob`, `approved_object_for_path`, `folder_index`, `compute_entry`, `accept/reject/discard`, `remove_field` (recompute strategy). File-format v2 + dual-read. Convergence + DEV-10237 regression tests.
3. **Re-anchoring (Rust):** port `re_anchor_patches` to value-based re-base + pointer-set conflicts.
4. **napi + desktop:** faithful approved snapshot; field-identifier ↔ pointer mapping; desktop comparison verified unchanged.
5. **Server + shared-types:** `applyJsonPatch`, DTO version plumbing, delete-via-kind, server-side parity tests against the shared corpus.
6. **Migration:** lazy convert-on-write (v1→v2 on first `save_atomic` of a legacy file); deprecation telemetry on v1 reads; drop the v1 read path only once telemetry shows it's effectively unused.

## Risks & mitigations

- **Two engines drift.** Mitigated by the shared parity corpus as the single source of truth; CI runs it on both.
- **Re-anchor regressions** (conflict detection is subtle). Mitigated by porting the existing suite first and adding null/pointer cases; prefer value-based re-base over in-place op rewriting.
- **Mixed-version fleet during rollout.** Mitigated by versioned files + DTO and a server-reads-both-first ordering.
- **JSON Pointer ↔ dotted-id mapping bugs** for exotic keys. Mitigated by explicit escaping tests (`.`, `/`, `~`, quotes, emoji) and by routing all desktop field edits through the Rust pointer encoder.
- **Scope creep into null-publishing.** Explicitly a non-goal; this migration stops at making the internal state correct.

## Decisions (confirmed 2026-06-05)

1. **Tracking:** run under **DEV-10237** (no separate ticket). Every commit/branch/PR title includes `DEV-10237` for Linear auto-linking — see Commit & tracking convention at top.
2. **Differ verbs:** **`add` + `remove` only**, no `replace` (apply the full standard, emit the robust subset) — see §1 for the drift-robustness rationale.
3. **Object recursion:** **keep recursing** nested objects to minimal leaf ops (smaller patches), arrays atomic.
4. **Migration trigger:** **lazy convert-on-write only**; no maintenance subcommand; v1 read path retired on telemetry.
5. **Whole-array encoding:** always whole-array `add` (no index ops), revisit only if payload size becomes a problem.

## Open questions

- None blocking. (Re-open #5 if large-array payloads prove costly in practice.)
