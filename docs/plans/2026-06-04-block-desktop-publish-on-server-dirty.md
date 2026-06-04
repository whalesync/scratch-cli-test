# Block desktop publish/upload when the server has unpublished changes

**Status**: Planned
**Author**: Curtis Fonger
**Created**: 2026-06-04
**Linear**: [DEV-10316](https://linear.app/whalesync/issue/DEV-10316/publish-from-desktop-app-also-pushed-dirty-changes-from-web-app)

## TL;DR

Publishing from the desktop app published ~330 records when the user had only approved ~10. The extra ~320 were unpublished changes the web's automated sync had already staged on the server, which the desktop publish swept up without the user ever seeing or approving them.

We're adding a guardrail: **the desktop can't upload its approved changes while the server still has unpublished changes waiting for the same connection.** When it's blocked, the only way forward is to go to the web, publish or discard those pending changes there (where they're visible), and come back to the desktop later. This is the same principle we already apply locally — you can't move on to publishing while you still have unreviewed edits sitting around; you have to decide first.

This plan is a guardrail only. It does **not** change how publish works, and it does **not** address the secondary "three publish runs" oddity from the ticket. See [Out of scope](#out-of-scope--follow-ups).

## What went wrong

Three facts combine into the bug:

1. **The staging area is shared.** Every connection has one "dirty branch" on the server — a staging area for changes that are approved/pending but not yet published. Both the desktop user's uploaded edits **and** the web's automated sync write into that same staging area.
2. **The automated sync stages but doesn't publish.** When sync runs on the web, it drops its results into the dirty branch and leaves them there for a human to publish or discard. In this customer's workbook, ~320 such changes were sitting unpublished.
3. **Publish ships the whole staging area.** Publishing doesn't ship "the records you approved" — it ships everything currently in the dirty branch versus what's already live. So the desktop user's 10 approved edits rode out alongside the sync's 320 staged changes.

Worse, the desktop **misrepresented** what would happen. The "Ready to publish" preview was computed from the user's own local approved edits (~10 records, the right number). But the actual publish was computed from the full server staging area (~330). The preview and the executed publish came from two different places, so the screen told the user one thing and the system did another.

This breaks our core promise: **nothing is published that the user didn't explicitly approve.**

## The fix, conceptually

Keep the desktop from ever piling its changes onto a staging area that isn't already clean.

If the desktop is only allowed to upload when the server's staging area for that connection is empty, then after its upload the staging area contains **exactly** the user's approved changes — nothing else. Publish then ships exactly those changes, and the preview matches what actually happens. The bug becomes impossible.

A connection's staging area returns to "clean" the moment its pending changes are published or discarded, so this isn't a permanent wall — it's a "resolve the pending stuff first" gate.

## How it behaves

- **The desktop detects and redirects — it never acts on the pending changes itself.** Those changes usually aren't the desktop user's (they came from the automated sync, another user, or a half-finished earlier publish), and the desktop app can only show the user their *local* files, not the server's staging area. So it can't meaningfully let the user review or publish them in place. The web review screen is built exactly for that — it lists the pending changes per connection, shows each one's diff, and lets the user publish or discard them. So the desktop points there.
- **It reuses the shape of a gate we already have.** When the server has moved ahead of you (someone else published since you last refreshed), the desktop already blocks the upload and tells you to refresh first. This new gate is the sibling of that one: same "the server isn't in a state to accept your upload — here's how to fix it" pattern, just for unpublished-changes instead of you-being-behind.
- **Pending changes are handled before staleness.** If a connection is both "has unpublished changes" and "you're behind," we surface the unpublished-changes block first — resolving it on the web is the precondition, and doing so may then ask the user to refresh, which the existing gate already handles on the next attempt.
- **Block the whole publish if any connection has pending changes.** A workspace can have several connections. If any one of them has unpublished changes, the publish is blocked with that connection called out — matching how the existing "you're behind" gate already stops the whole upload rather than letting some connections through.

## The user flow

The desktop's publish modal gains one new blocking screen. When the user tries to publish and the server still has pending changes for a connection:

```
┌─ Publish changes ──────────────────────────────────┐
│ ⚠  Unpublished changes on the server                │
│ Airtable · CRM has 47 changes waiting to be         │
│ published. Publish or discard them on the web,      │
│ then come back here to publish your edits.          │
│                                                     │
│   Airtable · CRM        47 changes                  │
│     +30 added · ~17 modified                        │
│     /Contacts/rec123.json                           │
│     /Contacts/rec456.json                           │
│     … and 45 more                                   │
│                                                     │
│              [Close]        [Review on web ↗]       │
└─────────────────────────────────────────────────────┘
```

- Copy avoids internal terms like "dirty branch" — to the user it's "unpublished changes on the server," matching the web's language.
- It shows a count, a quick added/modified/deleted breakdown, and a handful of example paths so the user has enough context to recognize what's pending (e.g. "oh, that's the sync's stuff").
- **"Review on web ↗"** opens the workbook's review screen, where the user publishes or discards.
- There's no "recheck" or "retry" button. The user resolves on the web and reopens Publish later; the check simply re-runs then. Keeps the screen — and the work — minimal.

The same protection covers the `scratchmd` CLI for free, since it goes through the same server step; there it just prints a clear message instead of showing a modal.

## Decisions (locked in discussion)

1. **Guardrail, not a publish redesign.** We stop the desktop from uploading onto a non-clean staging area. We are *not* (here) changing publish to ship only the user's approved subset, nor changing where the automated sync stages its work — those are deeper directions, noted below.
2. **Web-only resolution.** The desktop detects and redirects; it never offers in-app publish/discard of the pending changes. Acting on changes the user can't see would just re-create the footgun.
3. **Block-all scope.** If any connection has pending changes, the whole upload is blocked (matches the existing staleness gate). A per-connection "let the clean ones through" refinement is a possible follow-up.
4. **Show a sample.** Count + breakdown + a few example paths, not just a bare number.
5. **Pending-changes check runs before the staleness check.**

## Out of scope / follow-ups

- **"Three publish runs" (ticket bug #2).** Each publish surfaces as three runs — an apply step, a ~1-second planning run that does no real work, and the actual publish. That's the existing decoupled architecture, not part of this fix. Worth a separate UX cleanup (collapse or label the planning run).
- **Publishing only the approved subset.** The deeper fix — making publish ship just the user's approved records, and/or keeping the automated sync out of the user's staging area — is a larger architectural change. This plan is the guardrail that makes today's model safe for the desktop; those remain open directions.
- **Showing the pending-changes count earlier.** We could surface it the moment the publish modal opens, instead of when the user tries to upload. It's a nicety we can add later; the server-side block is the real protection and is enough on its own.

---

# Implementation

Everything below is for the engineer implementing the plan. Line numbers are against the current tree.

## Approach

Mirror the existing `blocked_stale` (D8) gate end to end. That gate is: the server throws a `409` with a structured body → the CLI maps the `409` to a discriminated-union variant → the desktop main process parses it into a typed result → the publish modal pattern-matches on `status` and renders a dedicated mode. We add a parallel `blocked_dirty` path through each of those layers.

**No separate client pre-flight.** The modal auto-starts the upload right after its local checks pass (`loadInitialState` → `startUpload`), so a server-`409`-driven block surfaces almost immediately and carries the count + sample paths in its payload. The server refuse is also the only thing that closes the race where the automated sync stages a change between modal-open and upload, so it's required regardless. (Surfacing the count at modal open is the optional later nicety noted above.)

## Why the gate establishes the invariant

"Clean" means the connection's `dirty` branch equals its `merge_base` tag — the existing `has-dirty` / `status` semantics (`scratch-git-2/src/service/routes/diff.rs` `status` `:12-41`, `has-dirty` `:43-73`, `count` `:75-104`), which already filter to visible, root-level, non-dotfile record changes. After any successful publish, the post-publish `rebaseDirty` resets `dirty` back to `main`/`merge_base` (`server/src/publish-plan/publish-plan-run.service.ts` → `rebaseDirty`; `scratch-git-2/src/service/git/rebase.rs:8-126`), so a connection naturally returns to clean once its pending changes are published or discarded.

The contamination today comes from two writers sharing that branch: the desktop user's uploaded patches (`server/src/publish-plan/apply-patches.service.ts:94`) and the web's automated sync (`server/src/sync/sync.service.ts`, `commitFilesToBranch(DIRTY_BRANCH, …)`), and from publish building its plan off the full `merge_base → dirty` diff (`server/src/publish-plan/publish-plan-build.service.ts:223`). The preview/executed mismatch is in the modal: the preview comes from the upload result (`PublishChangesModal.tsx:1089-1135`, `aggregateTotals` `:1008`), the executed plan from `publishApi.startPlanJob` (`:760`).

## Contract changes, layer by layer

### 1. shared-types — `packages/shared-types/src/dto/upload-patch/upload-patch.dto.ts`

- Add a `refuseIfDirty?: boolean` field to `UploadPatchCommitDto` (after `refuseIfStale`, `:59`). New, independent flag; default falsy keeps legacy behavior. The only callers of `/upload-patch/commit` are the CLI and desktop, both of which will pass `true`.
- Add the refusal DTO, a sibling of `UploadPatchBlockedStaleResponseDto` (`:78-86`):

  ```ts
  export interface UploadPatchBlockedDirtyResponseDto {
    status: 'blocked_dirty';
    connectorAccountId: string;
    /** Count of pending (unpublished) record changes on the connection's dirty branch. */
    dirtyCount: number;
    added: number;
    modified: number;
    deleted: number;
    /** First N paths, for a preview list in the modal. */
    samplePaths: string[];
    message?: string;
  }
  ```

### 2. Server — `server/src/cli/upload-patch.controller.ts`

In `commit()` (`:110-189`), **before** the staleness gate (`:130`) and therefore before `enqueueApplyPatchesJob` (`:156`) and the audit log (`:167`) — so a refusal leaves zero side effects:

```ts
if (body.refuseIfDirty === true) {
  const repoId = await this.scratchGitService.resolveConnectionRepoPath(body.connectorAccountId);
  const dirty = await this.scratchGitService.getRepoStatus(repoId); // FileChange[] (merge_base → dirty)
  if (dirty.length > 0) {
    const payload: UploadPatchBlockedDirtyResponseDto = {
      status: 'blocked_dirty',
      connectorAccountId: body.connectorAccountId,
      dirtyCount: dirty.length,
      added: dirty.filter((c) => c.status === 'added').length,
      modified: dirty.filter((c) => c.status === 'modified').length,
      deleted: dirty.filter((c) => c.status === 'deleted').length,
      samplePaths: dirty.slice(0, 5).map((c) => c.path),
      message:
        'This connection has unpublished changes on the server. Publish or discard them on the web, then retry.',
    };
    WSLogger.info({ source: 'UploadPatchController.commit', message: 'Refused upload-patch commit due to dirty server branch', workbookId, userId: actor.userId, data: { connectorAccountId: body.connectorAccountId, dirtyCount: dirty.length } });
    throw new ConflictException(payload);
  }
}
```

- `getRepoStatus` / `hasDirtyFiles` / `getRepoStatusCount` already exist on `ScratchGitService` (`server/src/scratch-git/scratch-git.service.ts:~313/317/321`). `getRepoStatus` is the right call: one round-trip yields count, per-status breakdown, and the sample.
- `resolveConnectionRepoPath` is already used here via `lookupRemoteHead` (`:203`) — resolve once and reuse if convenient.

### 3. CLI api — `scratch-git-2/src/cli/api/mod.rs`

- Add a `BlockedDirtyResponse` struct next to `BlockedStaleResponse` (`:847`), with serde field names matching the DTO.
- Add a `BlockedDirty(BlockedDirtyResponse)` variant to `UploadPatchCommitResult` (`:865-867`).
- In the `409` parse block (`:753-761`), discriminate on the `status` tag — try `blocked_dirty` and `blocked_stale`, returning the matching variant.
- Add a `refuse_if_dirty: bool` parameter to `upload_patch_commit` (`:728-735`) and include `refuseIfDirty` in the request body.

### 4. CLI command — `scratch-git-2/src/cli/commands/files.rs`

- `UploadResult`: add `blocked_dirty: Option<crate::api::BlockedDirtyResponse>` next to `blocked_stale` (`:398`).
- `upload_single_repo_via_patches` (`:4130`): pass `refuse_if_dirty: true` in the `upload_patch_commit` call (`:4222-4235`), and add a `UploadPatchCommitResult::BlockedDirty(d)` match arm (next to the `BlockedStale` arm at `:4239-4250`) returning `UploadResult { status: "blocked_dirty", blocked_dirty: Some(d), .. }`.
- `run_upload` (`:827`): fail-fast on the first `blocked_dirty` connection, parallel to the `blocked_stale` handling at `:861`; collect into a `blocked_dirty_connections` vec and call a new `print_blocked_dirty_result` (sibling of `print_blocked_stale_result`, `:3480`). JSON shape:

  ```json
  { "status": "blocked_dirty", "blockedCount": 1,
    "connections": [{ "connectionName": "…", "dirtyCount": 47, "added": 30, "modified": 17, "deleted": 0, "samplePaths": ["…"] }],
    "elapsedMs": 1234 }
  ```

  Human-mode stderr: `"47 unpublished change(s) on the server for <conn> — publish or discard them on the web, then retry."`

### 5. Desktop main — `scratch-desktop/src/main/scratchmd.ts`

- Add `BlockedDirtyConnection` + `UploadWorkspaceBlockedDirty` interfaces (parallel to `:84-96`).
- Extend `UploadWorkspaceResult` (`:104`) to include `UploadWorkspaceBlockedDirty`.
- Generalize `parseBlockedStalePayload` (`:684-699`) into a single `parseUploadRefusalPayload` recognizing both `blocked_stale` and `blocked_dirty`, or add a parallel `parseBlockedDirtyPayload`. `uploadWorkspaceChanges` (`:668-681`) already routes a non-zero exit through the parser; extend it to return the dirty payload as a non-throwing result.

### 6. Desktop modal — `scratch-desktop/src/renderer/src/pages/workspace/PublishChangesModal.tsx`

- Add `'dirty'` to the `PublishMode` union (`:36`).
- Add `blockedDirty` state (parallel to `blockedStale`, `:401`).
- In `startUpload` (`:434`), add a branch mirroring the `blocked_stale` handling (`:440-454`): on `result.status === 'blocked_dirty'`, `setBlockedDirty(result)` and `setMode('dirty')`.
- Render the `'dirty'` mode (parallel to `'stale'`, `:1186-1218`) per the mockup above. Reuse `handleReviewOnWeb` (`:730-735`), which already opens `${webUrl}/workbook/${workspaceId}/review`.

## Implementation decisions

- **New `refuseIfDirty` flag**, independent of `refuseIfStale`; CLI + desktop pass both `true`. Alternative considered: always enforce (safe, since only CLI/desktop call this endpoint) — the flag is the more conservative choice.
- **Dirty checked before stale** in `commit()`.

## Test plan

- **Server unit** (`server/src/cli/__tests__/upload-patch.controller.spec.ts` or sibling): `commit` with `refuseIfDirty: true` and a non-empty `getRepoStatus` → throws `ConflictException` with a `blocked_dirty` body; **no** `enqueueApplyPatchesJob`, **no** audit log. Clean status → proceeds. `refuseIfDirty` falsy → proceeds even when dirty (back-compat). Both gates triggerable → `blocked_dirty` wins.
- **CLI**: `upload_patch_commit` parses a `409` `blocked_dirty` body into `UploadPatchCommitResult::BlockedDirty`; `run_upload` emits the structured JSON and fails fast.
- **Desktop main** (vitest): `parseUploadRefusalPayload` recognizes a `blocked_dirty` stdout payload and `uploadWorkspaceChanges` returns it as a non-throwing result.
- **Manual**: stage changes on a connection's dirty branch (trigger a web sync), then publish from desktop → modal shows the `dirty` block with the correct count, "Review on web" deep-links to the review page; publish/discard there; reopen desktop Publish → proceeds and publishes only the user's records.

## Acceptance criteria

- With unpublished changes on a connection's dirty branch, the desktop publish modal **cannot** upload `accepted-patches.json`; it shows the `dirty` mode with an accurate count + sample and a working "Review on web ↗".
- `scratchmd files upload` is refused identically (structured `blocked_dirty` JSON; clear human-mode stderr).
- After the pending changes are published or discarded on the web, the desktop upload + publish proceeds and the executed plan equals the user's approved changes (preview == plan).
- A refused `commit` enqueues no job and writes no audit log.
- No regression in the `blocked_stale` path or the legacy (`refuseIfStale`/`refuseIfDirty` falsy) soft path.
