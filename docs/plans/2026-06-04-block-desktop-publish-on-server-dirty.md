# Block desktop publish/upload when the server has unpublished changes

**Status**: In Progress — PR1 (server + CLI) complete, reviewed & green; PR2 (desktop) not started
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

A connection's staging area returns to "clean" the moment its pending changes are published or discarded, so this isn't a permanent wall — it's a "resolve the pending stuff first" gate. To keep the guarantee true all the way through, we hold it at two points: at upload (refuse onto a non-clean staging area) and again at publish (if the server changed while the user was reviewing, stop rather than ship the surprise).

## How it behaves

- **The desktop detects and redirects — it never acts on the pending changes itself.** Those changes usually aren't the desktop user's (they came from the automated sync, another user, or a half-finished earlier publish), and the desktop app can only show the user their *local* files, not the server's staging area. The web review screen is built exactly for that — it lists the pending changes per connection, shows each one's diff, and lets the user publish or discard them. So the desktop points there.
- **It reuses the shape of a gate we already have.** When the server has moved ahead of you (someone else published since you last refreshed), the desktop already blocks the upload and tells you to refresh first. This new gate is the sibling of that one: same "the server isn't in a state to accept your upload — here's how to fix it" pattern, just for unpublished-changes instead of you-being-behind.
- **It checks every connection up front, then blocks the whole publish.** A workspace can have several connections. The desktop checks all of them before applying *any* patches; if any one has pending changes, the entire publish is blocked with that connection called out, and nothing is uploaded. This matches how the existing "you're behind" gate stops the whole upload rather than letting some connections through, and it avoids a half-applied state.
- **A routine pull doesn't trip it.** "Has pending changes" means real unpublished record changes measured against what's currently live — so pulling fresh data (which doesn't add pending edits) never falsely blocks the user.
- **Pending changes are surfaced before staleness.** If a connection both has unpublished changes and you're behind, the unpublished-changes block comes first; resolving it on the web is the precondition, and any remaining "you're behind" is handled by the existing gate on the next attempt.
- **If the server can't be checked, it holds rather than guesses.** When the check itself can't run (the git service is down or busy), the publish is held with a "couldn't verify — try again" message instead of risking an unguarded upload.
- **The guarantee holds through publish.** If new changes land on the server between your upload and your publish, the publish stops and points you to the web — so the executed publish always equals what you reviewed.

The same protection covers the `scratchmd` CLI for free, since it goes through the same server step; there it prints a clear message instead of showing a modal.

## The user flow

The desktop's publish modal gains a blocking screen. When the user tries to publish and the server still has pending changes:

```
┌─ Publish changes ──────────────────────────────────┐
│ ⚠  Unpublished changes on the server                │
│ Publish or discard these on the web, then come      │
│ back here. (Someone with web access may need to     │
│ resolve changes you didn't make.)                   │
│                                                     │
│   Airtable · CRM        47 changes                  │
│   Webflow · Blog        12 changes                  │
│   Notion · Docs          3 changes                  │
│                                                     │
│              [Close]        [Review on web ↗]       │
└─────────────────────────────────────────────────────┘
```

- Copy avoids internal terms like "dirty branch" — to the user it's "unpublished changes on the server," matching the web's language.
- **Count-only:** each dirty connection shows its name and a total count, nothing more. No per-record breakdown, no sample paths — the screen stays minimal.
- **"Review on web ↗"** opens the workbook's review screen, where the user publishes or discards.
- This screen has **no** "retry" button. The user resolves on the web and reopens Publish later; the check simply re-runs then.
- If the server check itself fails, a distinct screen appears — "Couldn't verify the server's state — try again" — and this one **does** have a **Try again** button (the failure is usually transient).
- If the server changed while the user was reviewing "Ready to publish," the same unpublished-changes screen appears, led by one line: "The server changed while you were reviewing — there are now unpublished changes to resolve first."

All modal states use the existing `'stale'`-mode component vocabulary (Mantine `<Alert>` / `<Stack>` / `<Group>` / `<Anchor>` + `scratch-desktop/UI_SYSTEM.md`); the connection list sits in a `<ScrollArea>` with a max-height. Full state map:

```
STATE        | USER SEES
-------------|------------------------------------------------------------
loading      | ProgressStepList incl. a "Checking server state…" step
dirty        | yellow Alert + count-only connection list + Close / Review on web ↗
checkFailed  | red Alert "Couldn't verify the server's state" + Close / Try again  (503, retryable)
toctou-abort | dirty surface + lead "The server changed while you were reviewing…"
success      | existing publish-complete flow (unchanged)
empty        | n/a — the modal only appears when changes exist
```

## Decisions

1. **Guardrail, not a publish redesign.** We stop the desktop from uploading onto a non-clean staging area. We do not (here) change publish to ship only the user's approved subset, nor change where the automated sync stages its work — that deeper fix is a committed follow-up below.
2. **Web-only resolution.** The desktop detects and redirects; it never offers in-app publish/discard of the pending changes. Acting on changes the user can't see would just re-create the footgun.
3. **Block-all, checked up front.** Every connection is checked before any patches are applied; a single dirty connection blocks the whole publish with nothing uploaded.
4. **Count-only redirect.** Show each dirty connection's name + total count — not a breakdown or example paths.
5. **Pending-changes check runs before the staleness check.**
6. **Compare against live `main`, read-only.** The gate measures pending changes against `main`, so a routine pull (which can leave the older `merge_base` tag lagging) doesn't false-trip it.
7. **Fail-closed.** If the check can't run, hold the publish with a retryable error rather than upload unguarded.
8. **Hold the invariant through publish.** Re-check at publish time and abort if the server changed since the user's upload.
9. **Disable-able.** A server-side kill switch can turn the gate off without shipping a new desktop/CLI build.

## Out of scope / follow-ups

- **Deeper fix (committed).** Make publish ship only the user's approved subset, and/or keep the automated sync out of the user's staging area. This is the real cure that removes the wall entirely; this guardrail is the stopgap that makes today's model safe for the desktop.
- **Atomic all-or-nothing apply** across connections — eliminates the residual multi-connection deadlock (see [Review record](#review-record)). Promote if the gate-fire metric shows it happening.
- **Notify-an-admin / request-resolution** flow, for desktop users who lack web access to resolve someone else's pending changes.
- **"Three publish runs" (ticket bug #2).** Each publish surfaces as three runs (an apply step, a ~1s no-op planning run, and the real publish). That's the existing decoupled architecture; worth a separate UX cleanup.
- **Showing the pending-changes count at modal-open**, instead of when the user tries to upload. A nicety; the server-side block is the real protection.
- **Harden the `merge_base`-tag lockstep invariant** (surfaced verifying risk #7). Make `resolve_merge_base_or_main` log loudly — or have publish-plan-build assert — when the `merge_base` tag is missing, instead of silently falling back to `main` (the only construible over-publish path, and only if the invariant is ever broken). Cheap defensive follow-up.

---

# Implementation

Everything below is for the engineer implementing the plan. Line numbers are against the current tree.

## Landing in two PRs

- **PR1 — server + CLI.** shared-types DTO, the server gate (read-only-vs-`main` check, fail-closed 503, kill switch), and the CLI two-pass. The gate only fires when a client sends `refuseIfDirty: true`, which only updated clients do — so PR1 is **no regression** for un-updated desktops and protects `scratchmd` immediately.
- **PR2 — desktop + TOCTOU.** The modal modes (count-only `dirty`, `checkFailed`, the TOCTOU lead) and the publish-time drift re-check. This carries the riskiest, most coupling-heavy piece on its own. (Risk #7 — whether `rebaseDirty` could over-publish non-user records — was **verified and refuted** before implementation; see [Resolved — risk #7](#resolved--risk-7-rebasedirty-does-not-over-publish-non-user-records). The HEAD-snapshot re-check is sound as specified.)

## PR1 implementation status — DONE (on branch `dev-10316-mr1`)

Server + CLI landed. Deltas from the spec discovered during implementation (all faithful to the decisions, just different plumbing than the pseudocode assumed):

- **Feature flag.** The controller pseudocode assumed `this.flags.isEnabled(...)`; the real server primitive is PostHog-backed `ExperimentsService`. Added `SystemFeatureFlag.DESKTOP_DIRTY_GATE_ENABLED` and a new **`ExperimentsService.getBooleanFlagForOrg(flag, default, orgId)`** (org id as the PostHog distinct id — this codebase wires no PostHog *group* analytics, so org-scoping rides on the distinct id; a flag with a `distinct_id` release condition / percentage rollout enables specific orgs first). Code-level default is **off** (gate active only when the flag evaluates true); a flag-read failure degrades to off, while the *git check* failure is the fail-closed 503.
- **PostHog.** `PostHogService.captureEvent(PostHogEventName.DESKTOP_PUBLISH_BLOCKED_DIRTY, actor, { connectorAccountId, dirtyCount })`.
- **vs-`main` count.** Implemented as a **`?base=main` query param on the existing scratch-git `count` route** (`diff.rs`), not a new route — backed by `ScratchGitService.getPendingChangeCountVsMain` → `ScratchGitClient.getStatusCountVsMain`. Returns 0 (clean) on a missing `main`/`dirty` ref, consistent with the existing count route.
- **CLI two-pass / `checkOnly`.** The controller validates `uploadId` before the gate, so a `checkOnly` probe still carries an `uploadId`. Pass 1 therefore does `init` + `commit(checkOnly=true, refuseIfDirty=true)` per connection (no GCS PUT — the server's `checkOnly` path never reads the payload). **Pass 1 skips connections whose `accepted-patches.json` is empty** — a connection the user isn't publishing to must not be gated on its staging-area state. Pass 2 is the real `init`+PUT+`commit(apply)` with `refuseIfDirty` retained.
- **`check_failed` precedence.** When pass 1 turns up both `blocked_dirty` and `check_failed` connections, the CLI's aggregated output reports `check_failed` (the "couldn't verify → try again" action re-probes everything) over the partial dirty redirect.
- **`checkOnly` ordering.** `checkOnly` returns right after the dirty gate and **before** the staleness gate, so the probe never reports `blocked_stale` (decision #5: pending-changes before staleness; the apply pass enforces staleness).

Tests: Rust route premise (`count_vs_main` vs lagging `merge_base`), CLI serde parse + structural discrimination, server unit + controller-level e2e for the full gate matrix (409 `blocked_dirty`, 503 `check_failed`, `checkOnly` no-side-effects, kill-switch off, dirty-wins-over-stale, legacy soft path). Full monorepo `yarn build` green; `cargo test` (864) green.

## Approach

Mirror the existing `blocked_stale` (D8) gate end to end: the server throws a `409` with a structured body → the CLI maps it to a discriminated-union variant → the desktop main process parses it into a typed result → the publish modal pattern-matches on `status` and renders a dedicated mode. We add a parallel `blocked_dirty` path plus a distinct `check_failed` (503) outcome.

`commit()` therefore has **four** outcomes the layers must each handle: `blocked_stale` (409), `blocked_dirty` (409), `check_failed` (503), and the legacy soft path (`refuseIf*` falsy). The CLI runs a **two-pass** upload: a `checkOnly` pass over all connections first, and only if every connection is clean, the real apply pass (the gate is retained on the apply pass too). There is no separate client-side pre-flight beyond this two-pass — the server is the source of truth, which also closes the race where the automated sync stages a change between modal-open and upload.

## Why the gate establishes the invariant

"Clean" means the connection has no pending visible record changes measured against **live `main`** (a read-only diff). The gate must compare against `main`, **not** the `merge_base` tag, because the tag lags `main` after a pull-without-rebase and would false-positive (`publish-plan-build.service.ts:191-193` keeps `rebaseDirty` for exactly this reason). The relevant scratch-git routes are `scratch-git-2/src/service/routes/diff.rs` (`status` `:12-41`, `has-dirty` `:43-73`, `count` `:75-104`); note `status`/`compare_commits` recurses into subdirectories, while `has-dirty` is the root-level variant — so pick the read that matches "what publish would ship versus `main`" and verify the exact ref in code.

The contamination today comes from two writers sharing the dirty branch — the desktop user's uploaded patches (`server/src/publish-plan/apply-patches.service.ts:94`) and the web's automated sync (`server/src/sync/sync.service.ts`, `commitFilesToBranch(DIRTY_BRANCH, …)`) — and from publish building its plan off the full `merge_base → dirty` diff (`server/src/publish-plan/publish-plan-build.service.ts:223`). The preview/executed mismatch is in the modal: the preview comes from the upload result (`PublishChangesModal.tsx:1089-1135`, `aggregateTotals` `:1008`), the executed plan from `publishApi.startPlanJob` (`:760`).

The upload-time gate makes the staging area clean before the user's patches land. To keep it clean **through** publish, snapshot the connection's post-apply dirty HEAD and, at `publish-plan-build`, abort if the current dirty HEAD has drifted — compared **before** `rebaseDirty` runs (it force-moves the HEAD).

## Contract changes, layer by layer

### 1. shared-types — `packages/shared-types/src/dto/upload-patch/upload-patch.dto.ts`

- Add `refuseIfDirty?: boolean` and `checkOnly?: boolean` to `UploadPatchCommitDto` (after `refuseIfStale`, `:59`). Both default falsy → legacy behavior. The only callers are the CLI and desktop.
- Add `expectedBaseDirtyHead?: string` to the publish-plan-build request DTO (the client-carried TOCTOU token).
- Add the count-only refusal DTO (sibling of `UploadPatchBlockedStaleResponseDto`, `:78-86`):

  ```ts
  export interface UploadPatchBlockedDirtyResponseDto {
    status: 'blocked_dirty';
    connectorAccountId: string;
    /** Total pending (unpublished) record changes on the connection. Count-only UI. */
    dirtyCount: number;
    message?: string;
  }
  ```

- Represent the check failure as a distinct retryable shape (`status: 'check_failed'`, served with HTTP 503).

### 2. Server — `server/src/cli/upload-patch.controller.ts`

In `commit()` (`:110-189`), **before** the staleness gate (`:130`) and therefore before `enqueueApplyPatchesJob` (`:156`) and the audit log (`:167`) — so a refusal or a check-only probe leaves zero side effects:

```ts
if (body.refuseIfDirty === true && (await this.flags.isEnabled('desktop_dirty_gate_enabled'))) {
  let pendingCount: number;
  try {
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(body.connectorAccountId);
    pendingCount = await this.scratchGitService.getPendingChangeCountVsMain(repoId); // read-only diff vs main
  } catch (err) {
    // Fail closed: can't verify -> distinct retryable error, never an unguarded upload.
    throw new ServiceUnavailableException({
      status: 'check_failed',
      message: "Couldn't verify the server's state. Try again.",
    });
  }
  if (pendingCount > 0) {
    const payload: UploadPatchBlockedDirtyResponseDto = {
      status: 'blocked_dirty',
      connectorAccountId: body.connectorAccountId,
      dirtyCount: pendingCount,
      message: 'This connection has unpublished changes on the server. Publish or discard them on the web, then retry.',
    };
    WSLogger.info({ source: 'UploadPatchController.commit', message: 'Refused upload-patch commit due to pending server changes', workbookId, userId: actor.userId, data: { connectorAccountId: body.connectorAccountId, dirtyCount: pendingCount } });
    this.posthogService.capture(actor, 'desktop_publish_blocked_dirty', { connectorAccountId: body.connectorAccountId, dirtyCount: pendingCount });
    throw new ConflictException(payload);
  }
}
if (body.checkOnly === true) return { ok: true }; // two-pass probe: never applies
```

- A single dirty-check helper backs both the `checkOnly` probe and the `refuseIfDirty` gate (DRY) — do not duplicate the count logic.
- `getPendingChangeCountVsMain` is the read-only-vs-`main` count. The existing `getRepoStatus` / `getRepoStatusCount` (`server/src/scratch-git/scratch-git.service.ts:~313/321`) diff the `merge_base` tag; add or adapt to compare against `main`. `resolveConnectionRepoPath` is already used here via `lookupRemoteHead` (`:203`).

### 3. CLI api — `scratch-git-2/src/cli/api/mod.rs`

- Add `BlockedDirtyResponse` (count-only) and a `CheckFailed` shape next to `BlockedStaleResponse` (`:847`), with serde names matching the DTOs.
- Add `BlockedDirty(...)` and `CheckFailed(...)` variants to `UploadPatchCommitResult` (`:865-867`).
- In the `409`/`503` parse block (`:753-761`), discriminate on the `status` tag / HTTP status.
- Add `refuse_if_dirty: bool` and `check_only: bool` params to `upload_patch_commit` (`:728-735`) and include them in the request body.

### 4. CLI command — `scratch-git-2/src/cli/commands/files.rs`

- `run_upload` (`:827`) runs **two passes**: pass 1 calls `upload_patch_commit(check_only: true, refuse_if_dirty: true)` for every connection; if any returns `BlockedDirty`/`CheckFailed`, collect and fail fast — **no** connection proceeds to apply. Pass 2 runs the real apply (`refuse_if_dirty: true` retained) only if pass 1 was all-clean.
- `UploadResult`: add `blocked_dirty` / `check_failed` next to `blocked_stale` (`:398`); add match arms next to `BlockedStale` (`:4239-4250`).
- Add `print_blocked_dirty_result` (sibling of `print_blocked_stale_result`, `:3480`). Count-only JSON:

  ```json
  { "status": "blocked_dirty", "blockedCount": 1,
    "connections": [{ "connectionName": "…", "dirtyCount": 47 }],
    "elapsedMs": 1234 }
  ```

  Human-mode stderr: `"47 unpublished change(s) on the server for <conn> — publish or discard them on the web, then retry."`

### 5. Desktop main — `scratch-desktop/src/main/scratchmd.ts`

- Add `BlockedDirtyConnection` + `UploadWorkspaceBlockedDirty` (count-only) and a `check_failed` result (parallel to `:84-96`); extend `UploadWorkspaceResult` (`:104`).
- Generalize `parseBlockedStalePayload` (`:684-699`) into one `parseUploadRefusalPayload` recognizing `blocked_stale`, `blocked_dirty`, and `check_failed`; `uploadWorkspaceChanges` (`:668-681`) returns each as a non-throwing typed result.
- Capture the post-apply dirty HEAD from the apply-job result so the renderer can pass it to publish.

### 6. Desktop modal — `scratch-desktop/src/renderer/src/pages/workspace/PublishChangesModal.tsx`

- Add `'dirty'` and `'checkFailed'` to the `PublishMode` union (`:36`); add `blockedDirty` / `checkFailed` state (parallel to `blockedStale`, `:401`).
- In `startUpload` (`:434`), branch on `result.status` (parallel to `blocked_stale`, `:440-454`): `'blocked_dirty'` → `setMode('dirty')`; `'check_failed'` → `setMode('checkFailed')`.
- Render `'dirty'` as a **count-only** connection list (one `<Text>` row per connection, `dirtyCount.toLocaleString()`), in a `<ScrollArea>`; reuse `handleReviewOnWeb` (`:730-735`). Render `'checkFailed'` as a red `<Alert>` + `Close` / **`Try again`**. Truncate long connection names; give "Review on web ↗" an accessible label.
- Pass the captured post-apply dirty HEAD to `startPlanJob` as `expectedBaseDirtyHead`. When the publish job aborts on drift, route that result back into `'dirty'` mode with the lead line "The server changed while you were reviewing…".

### 7. Publish-plan-build (PR2) — `server/src/publish-plan/publish-plan-build.service.ts`

- Read `expectedBaseDirtyHead` from the request; **before** `rebaseDirty` (`:193`), if the current dirty HEAD differs, abort with a structured `blocked_dirty`-shaped result and emit `publish_aborted_dirty_drift`. No drift → build the plan as today.

## Observability & kill switch

- **PostHog:** `desktop_publish_blocked_dirty` on gate-fire (with `connectorAccountId`, `dirtyCount`), `publish_aborted_dirty_drift` on TOCTOU abort. The gate-fire rate is the signal for whether the wall is hitting the common case — i.e. whether the deeper fix is urgent.
- **Kill switch:** `desktop_dirty_gate_enabled` (OpenFeature/PostHog). Org-scoped, logged loudly. Note in the runbook that flipping it **off restores the original over-publish behavior** — it is break-glass, not a neutral toggle.

## Test plan

- **Server unit** (`server/src/cli/__tests__/upload-patch.controller.spec.ts`): `refuseIfDirty: true` + pending>0 → `409` count-only `blocked_dirty`, **no** job, **no** audit; clean → proceeds; `checkOnly: true` → probes and returns without enqueueing; `refuseIfDirty` falsy → legacy soft path; both gates → `blocked_dirty` wins; check throws → `503` `check_failed`, no job/audit; kill switch off → gate skipped; post-pull (`merge_base` lags `main`, no real pending) → **not** blocked.
- **Two-pass integration:** one dirty connection → assert **zero** connections enqueued an apply job (the deadlock regression guard).
- **TOCTOU integration:** dirty HEAD drifts between apply and plan-build → publish aborts + redirect (compare runs **before** `rebaseDirty`); no drift → publishes the user's edits.
- **CLI:** parses `blocked_dirty` / `check_failed`; two-pass emits structured JSON and fails fast.
- **Desktop main** (vitest): `parseUploadRefusalPayload` recognizes `blocked_dirty` and `check_failed` as non-throwing results.
- **Desktop modal:** `'dirty'` count-only render; `'checkFailed'` with `Try again`; TOCTOU lead copy; plan-build abort routed into `'dirty'`.
- **Regression:** `blocked_stale` path and the legacy soft path unchanged.
- **Manual:** stage changes via a web sync, publish from desktop → count-only `dirty` block with correct counts, "Review on web" deep-links; resolve there; reopen desktop Publish → proceeds and publishes only the user's records.

## Acceptance criteria

- With pending changes on any connection, the publish modal **cannot** upload `accepted-patches.json`; it shows the count-only `dirty` mode and a working "Review on web ↗".
- `preview == plan`: holds because of the publish-time drift re-check (abort on drift), not merely a clean-at-upload branch.
- Multi-connection: one dirty connection blocks the whole publish with **zero** connections applied (modulo the accepted sub-second residual — see [Review record](#review-record)).
- A check failure yields the distinct retryable `503` with a **Try again** affordance — never a silent proceed, never a generic 500.
- No post-pull false-positive: a connection with only a lagging `merge_base` tag (no real pending changes) is **not** blocked.
- The gate can be disabled via `desktop_dirty_gate_enabled` without shipping a client.
- `scratchmd files upload` is refused identically (count-only structured JSON; clear human-mode stderr).
- A refused or check-only `commit` enqueues no job and writes no audit log.
- No regression in the `blocked_stale` path or the legacy (`refuseIf*` falsy) soft path.

---

# Review record

The rationale and audit trail behind the spec above — why these choices, what was rejected, and the open items. Decisions themselves are stated once, in the spec.

## Strategic call (CEO review — HOLD SCOPE)

The premise was challenged: the guardrail can block the **common** case, not the edge case. The bug report itself establishes that the automated sync routinely leaves the staging area non-empty, so in sync-heavy workbooks "staging area is clean" is the exception — the gate may frequently redirect a desktop user to the web to resolve changes they didn't make. We shipped it anyway as the **correctness-first stopgap**: blocking and redirecting is strictly safer than silently over-publishing, and it never publishes unapproved data. The deeper fix (publish ships only the approved subset, and/or sync stages outside the user's staging area) is the real cure that removes the wall; it's a committed follow-up. The gate-fire metric exists precisely to tell us how urgent that follow-up is.

## Outside voice (independent Claude subagent) — 13 findings

- **Adopted:** the gate must diff against `main`, not the lagging `merge_base` tag (else it false-positives after every pull); the fail-closed 503 needs a real retry affordance; the kill switch restores the bug when flipped, so it must be framed/guarded as break-glass.
- **Rejected (kept the original):** swapping the post-apply HEAD-snapshot TOCTOU mechanism for a "plan ⊆ uploaded paths" assertion. The HEAD-snapshot approach stands — see the open risk below.

## Resolved — risk #7 (rebaseDirty does not over-publish non-user records)

**Verdict: refuted for normal operation** (verified 2026-06-04 by direct reading of `scratch-git-2/src/service/git/rebase.rs` plus a three-lens adversarial check). `rebase_dirty` forces `dirty` to `main` (`:72`), re-applies **only** the user's extracted edits on top (`:78–118`), and **advances the `merge_base` tag to `main` in the same call** (`:123`). The publish diff (`compare_commits(merge_base, dirty)`, `diff.rs:31`) therefore compares main's tree against main+{user edits}; main's records sit on **both** sides of the diff and cancel by blob-OID equality (`compare.rs`), leaving only the user's edits in the plan. This is exactly what the existing Rust tests show — `rebase_preserves_user_edits` / `rebase_no_user_edits_fast_forwards`: dirty's *tree* gains main's content, but the *diff* does not. The earlier "GAP" reading conflated "dirty's tree contains main's records" with "the diff contains them."

The real contamination DEV-10316 fixes is the **dirty-branch-sharing** path (the automated sync writes records into `dirty` that are not on `main`), which the upload-time gate and the publish-time HEAD-snapshot re-check both guard — and the re-check must run **before** `rebaseDirty` (it force-moves the HEAD), exactly as the spec already states. The HEAD-snapshot TOCTOU mechanism is sound; no rework needed.

**Latent fragility (noted, not a blocker, candidate follow-up).** The over-publish protection rests on one invariant: `dirty` never advances without the `merge_base` tag advancing with it. Today every code path holds this, and a `write_tag` failure throws — short-circuiting publish-plan-build at `:193` before the diff at `:223` ever runs. The two adversarial lenses that produced an "over-publish" verdict could only do so by *breaking* that invariant (a hypothetical swallowed `write_tag` failure, or a missing/corrupt `merge_base` tag, where `resolve_merge_base_or_main` silently falls back to `main`). Neither occurs in current code. Cheap hardening for a later PR: have `resolve_merge_base_or_main` log loudly (or publish-plan-build assert) when the tag is missing instead of silently using `main`. Out of scope for this guardrail. (Aside: the publish path's rebase runs the `diff3` strategy — `write.rs:511` — which 3-way-merges a record the user *did* edit when main also changed it; that is in-scope merge behavior, not over-publish of untouched records.)

## Accepted residual — two-pass narrows the deadlock, doesn't eliminate it

Two-pass (check all connections, then apply) kills the *common* multi-connection deadlock, but a sub-second sync write between the check pass and a later connection's apply can still re-create the "blocked on your own just-uploaded patches" state. Accepted for v1: it's a rare usability event (not data loss — the publish-time re-check still makes over-publish impossible), and the gate-fire metric watches for it. True elimination needs all-or-nothing apply across connections — the deferred follow-up.

## Failure modes registry

```
CODEPATH                       | FAILURE MODE              | TEST?      | ERROR HANDLED? | USER SEES        | SILENT?
-------------------------------|---------------------------|------------|----------------|------------------|--------
commit() dirty gate            | pending changes present   | unit+integ | Y (409)        | "review on web"  | no
commit() check                 | scratch-git down/gc       | unit       | Y (503+retry)  | "try again"      | no
two-pass pass1 -> pass2        | sync writes mid-pass      | integ      | Y (apply gate) | "review on web"  | no (rare residual deadlock — accepted, metered)
plan-build drift               | sync wrote post-apply     | integ      | Y (abort+redir)| "review on web"  | no
post-pull merge_base lag       | false-positive block      | unit       | FIXED (vs main)| nothing (passes) | n/a
rebaseDirty pulls main (#7)    | non-user records in plan  | rust tests | YES (lockstep) | nothing (cancels)| no - REFUTED
merge_base tag stale/missing   | false baseline -> leak    | NONE       | partial        | over-publish?    | latent (invariant-break only; follow-up)
```

The `#7` row is **refuted** (see [Resolved — risk #7](#resolved--risk-7-rebasedirty-does-not-over-publish-non-user-records)): `rebaseDirty` advances `merge_base` and `dirty` in lockstep, so main's records cancel in the publish diff. The only way to manufacture over-publish is to break that lockstep invariant (swallowed `write_tag` failure or a missing `merge_base` tag) — neither occurs in current code; tracked as a defensive follow-up.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | reviewed | HOLD SCOPE; premise upheld; guardrail as stopgap, deeper fix committed as follow-up |
| Outside Voice | Claude subagent | Independent 2nd opinion | 1 | issues_found | 13 findings; 3 adopted (main-baseline, 503 retry, kill-switch framing), 1 rejected (kept HEAD-snapshot); #7 since verified + refuted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | reviewed | Two-PR split, client-carried snapshot token, unit+integration strategy; 1 potential critical gap (#7) tracked |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | reviewed | 6/10 → 9/10; count-only modal, checkFailed retry, TOCTOU lead; 5 states spec'd |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |
| PR1 Diff Review | 4-dim adversarial + verify | Post-implementation correctness | 1 | reviewed | 9 findings, 0 confirmed bugs (3 positive confirmations of correct design, 6 verified false positives); 1 comment-clarity tweak applied (flag-read degrades-open vs git-check fail-closed asymmetry) |

- **CROSS-MODEL:** CEO review + outside voice agree on the two-pass residual and the strategic risk (gate can block the common case). They diverged on the TOCTOU mechanism; the HEAD-snapshot approach was kept. #7 (rebaseDirty contamination) has since been **verified and refuted** (2026-06-04, direct code read + 3-lens adversarial check) — the HEAD-snapshot mechanism stands unchanged.
- **UNRESOLVED:** 0 decisions open. 0 open verifications (#7 resolved). 1 accepted residual (two-pass sub-second deadlock) and 1 latent fragility (merge_base-tag lockstep invariant) — both tracked as follow-ups, neither a blocker.
- **VERDICT:** CEO + ENG + DESIGN reviewed; #7 verified. Scope, execution, and UI states pinned. Ready to implement (PR1 first; design specs apply to PR2).
