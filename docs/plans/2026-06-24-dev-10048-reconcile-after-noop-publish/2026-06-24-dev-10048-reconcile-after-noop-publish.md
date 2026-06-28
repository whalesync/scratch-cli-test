# DEV-10048 — Better reconciling of dirty and remote branches after a no-op publish

- **Status:** Cancelled — folded into the publish redesign (see
  [`2026-06-24-publish-failed-patches-redesign.md`](../2026-06-24-publish-failed-patches-redesign/2026-06-24-publish-failed-patches-redesign.md)).
- **Author:** Curtis Fonger
- **Created:** 2026-06-24
- Linear: https://linear.app/whalesync/issue/DEV-10048

> **Note:** The targeted two-surface fix below is superseded by the publish redesign,
> which fixes this bug structurally (rebuilding `dirty` from `main` instead of
> re-accumulating un-publishable deltas). The root-cause analysis here is retained as
> reference — it is the "why" behind the redesign.

## Symptom

After publishing, a record/field still shows as **accepted / unpublished** even though
the user just published it. "The no-op push keeps old dirty value for field, so your
change is still 'accepted' even though you just published it."

## Root cause

There are two different definitions of "is this a change?" on the two sides of publish,
and they disagree on **removed JSON keys** (and any delta that collapses to nothing under
the publish-side rule):

- **Publish side** — `computeChangedFields` (`server/src/publish-plan/diff-utils.ts`) walks
  only the keys present in `dirty` and **intentionally ignores keys removed relative to
  `main`** ("Users should set fields to null/empty to clear them, not delete JSON keys").
  So an edit whose only net change is a key removal produces `changedFields === {}`.

- **Review side** — `json_patch::diff` (RFC 6902, `scratch-git-2/src/shared/json_patch.rs`)
  emits a `remove` op for that same key, so the review model considers the record to have a
  pending change.

The flow that strands state:

1. User removes a key (e.g. edits the JSON file, or a UI action that drops a key), accepts,
   publishes.
2. `publish-plan-build` sees the file as `modified` (blob differs) and emits an `edit` op,
   but with `changedFields: {}`.
3. `publish-plan-run` **skips** the op (`publish-plan-run.service.ts:1087-1090`,
   `if (Object.keys(entry.changedFields).length === 0) continue;`): the connector is not
   called and **`main` is never advanced** for that record.
4. `rebaseDirty` re-applies the user's edit onto `dirty`, so **`dirty` stays diverged from
   `main`** by the (un-publishable) removal — a permanent phantom.
5. The accepted state can never clear:
   - **Desktop / CLI**: `reconcile_accepted_after_publish` re-anchors `accepted-patches.json`
     against the new `main`. Because `main` didn't move, `re_anchor` re-emits the patch
     verbatim → the patch survives → the desktop badge keeps showing "unpublished"
     (badge is computed locally from `accepted-patches.json`).
   - **Web**: the web's pending/accepted view and the DEV-10316 dirty-gate both come from
     `getRepoStatus` (blob-level `dirty` vs `main`), which still reports the phantom as a
     pending change.

## Decision: reconcile, don't publish

Publishing key removals is explicitly out of scope by product decision, and changing the
review model to ignore removals broadly is too wide a blast radius (it would change
accept-time and pull semantics and break existing tests). So we **reconcile after a no-op
publish**: a record whose only remaining delta against `main` is something the publish
pipeline would treat as a no-op converges back to the published state. The un-publishable
removal is dropped, and the restored value is surfaced (the worktree / grid shows it again),
never silently swallowed.

"Publish-no-op against `main`" is defined identically to the publish side:
`computeChangedFields(main, intendedValue)` is empty.

## Fix (two surfaces, one definition)

### A. Desktop / CLI — drop publish-no-op patches in the post-publish reconcile (Rust)

In `re_anchor_accepted_patches_against_published_main` /
`reconcile_accepted_after_publish` (`scratch-git-2/src/cli/commands/files.rs`), after
re-anchoring against the post-publish `main`, drop any surviving **Update** patch that is a
publish-no-op against `new_main`:

- `intended = apply_patch_entry_to_blob(new_main[path], patch)`
- drop iff `compute_changed_fields(new_main[path], intended)` is empty.

Only Update patches with an existing `main` blob are eligible (Create/Delete are never
publish-no-ops in this sense). Scope is the **post-publish** reconcile only — general
`files download` / pull and accept-time tracking are untouched, so removing a key and then
*pulling* still tracks the edit; it only reconciles away once the user actually *publishes*.

Add a `compute_changed_fields` helper mirroring the TS `computeChangedFields` exactly
(iterate the intended side's keys, recurse plain objects, compare arrays/primitives/null by
value, ignore keys only present on `main`).

### B. Web / server — converge `dirty` → `main` for no-op edits (TypeScript)

In `publish-plan-run.service.ts`, collect the file paths of edit-phase ops skipped as
no-ops (`changedFields === {}`). Before `rebaseDirty`, write `main`'s current content for
those paths onto the `dirty` branch so `dirty` matches `main` for them; `rebaseDirty` then
sees no user change and won't re-introduce the phantom. This clears the web pending view and
removes the dirty-gate inflation. The reset only ever discards an un-publishable delta (the
op had no publishable change by definition).

## Tests

- Rust: `re_anchor` / reconcile test — a removed-key Update patch, `main` unchanged across
  the "publish", is dropped (not re-emitted); a real surviving edit still survives; a
  delete/create is unaffected. Unit tests for `compute_changed_fields`.
- Server: publish-run test — an edit-phase op with `changedFields: {}` results in `dirty`
  being reset to `main`'s content for that path before `rebaseDirty` (no phantom); a mixed
  batch leaves real edits intact.

## Status

- [ ] A — Rust client reconcile drop + `compute_changed_fields` + tests
- [ ] B — Server dirty reconcile + tests
- [ ] `yarn build` / `yarn lint` (root) + `server/ yarn lint-strict`
- [ ] `cargo test` (scratch-git-2) + targeted server jest
