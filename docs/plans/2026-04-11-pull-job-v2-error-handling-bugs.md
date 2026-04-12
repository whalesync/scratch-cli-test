# Pull job V2 — error handling gaps

**Status:** triaged, not yet fixed
**Discovered:** 2026-04-11, while shipping the Affinity tenant-tables feature

## Context

The V2 pull job (`pull-linked-folder-files-v2.job.ts`) splits folder pulling into two phases:

- **Phase 1 (`runPhase1Fetch`)** — parallel fetch across folders via `runWithConcurrency`. Each folder's connector is called to stream records into the staging directory.
- **Phase 2 (`processFolder` loop)** — sequential per-folder processing: read staged files, update DB indexes, commit to git, delete stale files, finalize.

The whole point of the Phase 1 / Phase 2 split (vs. V1's single sequential `pullFolder`) is to improve multi-folder resilience: one folder failing in Phase 1 should not abort the rest of the job. V1 had a fail-fast bug where the first failed folder threw, the throw propagated up to the BullMQ worker, and every folder after the failure was silently dropped from the job.

V2 fixes that resilience problem correctly, but the per-folder error handling in Phase 1 is incomplete. The catch block only does one of the things V1's catch (and V2's own Phase 2 catch) do, and that incompleteness produces three distinct symptoms.

## How the bugs were discovered

While shipping the Affinity tenant-tables feature, I introduced a regression: the new `listAllPersons` and `listAllCompanies` API client methods passed `fieldTypes=list` to `/v2/persons` and `/v2/companies`, which Affinity rejects with HTTP 400 (`'list'` is not a valid field type on tenant-wide endpoints — only `enriched` / `global` / `relationship-intelligence` are). The connector-side bug was easy to find and fix once I had the data; the _interesting_ part was the symptoms it produced:

- The user reported "the Companies and People folders have no records" in the workbook sidebar.
- Database inspection showed the folders were stuck with `lock: 'pull'` from a job that had completed days earlier.
- Server logs showed `Phase 1 fetch failed for folder` errors for both folders, immediately followed by `Job completed successfully`.
- No user-facing failure notification was ever sent.

The connector bug was a single-line fix. The fact that **a permanently stuck lock + silently-successful job + missing failure notification** all surfaced from one transient API error pointed to a structural problem in the error handling path, not just a one-off connector mistake.

## The three bugs

All three live in `runPhase1Fetch` at `pull-linked-folder-files-v2.job.ts:455-463`:

```typescript
try {
  const result = await this.fetchFolder({...});
  results.set(folderId, result);
  jobProgress.folderFetchStatus[folderId] = 'fetched';
} catch (error) {
  jobProgress.folderFetchStatus[folderId] = 'failed';
  WSLogger.error({
    source: LOG_SOURCE,
    message: 'Phase 1 fetch failed for folder',
    dataFolderId: folderId,
    errorDetails: folderCtx.connector.extractConnectorErrorDetails(error),
  });
}
```

Compare with what V1's `pullFolder` catch does (`pull-linked-folder-files.job.ts:363-406`) — five things, of which the V2 Phase 1 catch only does two.

### Bug 1: Phase 1 catch leaks the data folder lock

When the user triggers a pull, each `DataFolder` is marked with `lock: 'pull'` to prevent concurrent operations. The lock is supposed to be cleared when the folder finishes (success path) or fails (error path). In V2:

- ✅ V2 Phase 2's catch (`:241-244`) clears the lock correctly when Phase 2 throws.
- ❌ V2 Phase 1's catch does **not** clear the lock when Phase 1 throws.

So any folder that fails in Phase 1 stays locked forever. The user can't re-pull it, can't delete it cleanly, and there's no in-app way to recover. The only fix today is manual SQL: `UPDATE "DataFolder" SET lock = NULL WHERE id IN (...)`.

This is the most user-visible bug because the stuck lock is observable in the UI (folders show as "pulling" or otherwise locked) and the only way out is database surgery.

### Bug 2: Phase 2 silently skips failed Phase 1 folders without cleanup or notification

The Phase 2 loop (`:202-208`) does:

```typescript
for (const folderCtx of folderContexts) {
  if (abortSignal.aborted) break;

  const fetchResult = fetchResults.get(folderCtx.dataFolder.id);
  if (!fetchResult || jobProgress.folderFetchStatus?.[folderCtx.dataFolder.id] === 'failed') {
    continue;
  }
  ...
}
```

`continue` — that's it. No lock cleanup (because Bug 1 means it's still set), no `job-failed` event, no error in the user's notification feed, no entry in any failure tracker. The Phase 2 catch (which does all of these things correctly) is never reached because the folder gets skipped before any Phase 2 work starts.

Phase 2 _was_ the natural place where failed folders should have been cleaned up and reported, since Phase 1 catches per-folder for resilience reasons and can't itself afford to throw. But the cleanup never happens anywhere.

### Bug 3: Job reports success even when one or more folders failed

`pullStats.failed` is the flag that determines whether the job reports success or failure to the BullMQ worker, the analytics pipeline (`postHogService.trackPullCompleted`), and the user-facing event system. It's only set in two places:

- **Phase 2 catch** (`:231`): `pullStats.failed = true` when Phase 2 throws.
- **Nowhere else.**

Specifically: a Phase 1-only failure never flips `pullStats.failed`. Combined with Bugs 1 and 2, this means the job exits the main loop, runs the post-processing (rebase, GC, index rebuild), reports `result: 'success'` to PostHog, and logs `Job completed successfully` — all while one or more folders sit locked and stranded. There is no signal anywhere that anything went wrong other than the single Phase 1 error log line, which is easy to miss in a busy log file.

## Comparison with V1

| Behavior                            | V1 (`pull-linked-folder-files.job.ts`) | V2 Phase 1 catch                      | V2 Phase 2 catch             |
| ----------------------------------- | -------------------------------------- | ------------------------------------- | ---------------------------- |
| Set status to 'failed'              | ✅ `publicProgress.status = 'failed'`  | ✅ `folderFetchStatus[id] = 'failed'` | ✅ `pullStats.failed = true` |
| Clear the lock                      | ✅                                     | ❌ **(Bug 1)**                        | ✅                           |
| Log the error                       | ✅                                     | ✅                                    | ✅                           |
| Send `job-failed` event             | ✅                                     | ❌ **(Bug 2 partial)**                | ✅                           |
| Propagate to job-level failure flag | ✅ (via re-throw)                      | ❌ **(Bug 3)**                        | ✅                           |
| Continue processing other folders   | ❌ (fail-fast bug — re-throws)         | ✅ (correct, the whole point of V2)   | ✅                           |

V1 gets the failure handling right per-folder but has a fail-fast bug at the job level. V2 fixes the fail-fast bug correctly but forgot to copy V1's per-folder cleanup code into the Phase 1 catch. The fix is to bring V2 Phase 1's catch up to parity with V2 Phase 2's catch — minus the re-throw, which would re-introduce V1's fail-fast bug.

## Proposed fix

Single focused change in `runPhase1Fetch`. Bring its catch up to parity with Phase 2's:

```typescript
} catch (error) {
  jobProgress.folderFetchStatus[folderId] = 'failed';
  pullStats.failed = true;                   // (3) propagate failure to job-level flag

  WSLogger.error({
    source: LOG_SOURCE,
    message: 'Phase 1 fetch failed for folder',
    workbookId: folderCtx.dataFolder.workbookId,
    dataFolderId: folderId,
    errorDetails: folderCtx.connector.extractConnectorErrorDetails(error),
  });

  // (1) clear the lock so the next pull can run
  await this.prisma.dataFolder.update({
    where: { id: folderId },
    data: { lock: null },
  });

  // (2) tell the workbook clients about the per-folder failure
  this.workbookEventService.sendWorkbookEvent(
    folderCtx.dataFolder.workbookId as WorkbookId,
    {
      type: 'job-failed',
      data: {
        entityId: folderId,
        source: 'job',
        message: 'Pull failed for data folder',
        jobId,
      },
    },
  );
}
```

### Wiring concerns

`pullStats` is currently scoped to the outer `run` method, not `runPhase1Fetch`. Two reasonable options to thread the failure flag through:

- **Option A**: pass `pullStats` into `runPhase1Fetch` as a parameter. Mutates the same reference the rest of `run` uses. Smallest change, looks slightly weird because `pullStats` becomes a side-effecting parameter.
- **Option B**: have `runPhase1Fetch` return a `failedFolderIds: Set<DataFolderId>` alongside its existing `Map<DataFolderId, FolderFetchResult>`, and have the caller in `run` set `pullStats.failed = true` based on whether the set is non-empty. Cleaner functional shape, slightly more glue code.

Lean toward Option A — it's three lines and mirrors how `jobProgress` is already passed in by reference. The "side-effecting parameter" smell is mild and consistent with the existing pattern.

### Defensive cleanup as a backstop

Even with the Phase 1 catch fixed, it would be worth adding a final cleanup pass at the end of `run` (in the `finally` block, alongside the existing staging cleanup) that walks the folder contexts and ensures any folder still holding `lock: 'pull'` gets it cleared. This is belt-and-braces — it covers any future bug class where a path-through-the-job forgets to clear a lock, not just this specific one. Cheap to add, hard to regret.

## Tests

Should include:

1. **Unit test for Phase 1 failure cleanup.** Stub a connector to throw on `pullRecordFiles`, run the V2 job for a single folder, assert:
   - The DataFolder's `lock` is `null` after the job
   - A `job-failed` event was sent for that folder via `workbookEventService`
   - `pullStats.failed === true` (observable via the job's PostHog tracking call)
   - `Job completed successfully` is **not** logged
2. **Unit test for partial failure resilience.** Stub two connectors (one throwing, one succeeding) for two folders in the same job. Assert:
   - The succeeding folder commits files normally and clears its lock
   - The failing folder has `lock: null` and a `job-failed` event
   - `pullStats.failed === true`
   - The succeeding folder is **not** affected by the other one's failure (regression guard against accidentally re-introducing V1's fail-fast behavior while fixing V2)
3. **Integration test for the Affinity tenant pull case.** Now that the fake-affinity server has been tightened to reject `fieldTypes=list` on tenant endpoints with HTTP 400 (see `2026-04-11` Affinity feature commit), an end-to-end test could deliberately misconfigure the connector to trigger that 400, run a pull, and assert the same lock-cleanup + event invariants. This is the scenario that originally surfaced these bugs and is the most realistic regression test.

## Open questions / decisions to make

1. **Should the V2 job have a `finally`-block lock-cleanup backstop?** As described above, this is mild scope creep but cheap. My recommendation is yes. Counter-argument: explicit per-error-path cleanup is easier to reason about than a "magic" cleanup-everything-at-the-end pass.

2. **Should the Phase 2 skip-on-failed-fetch path also send a `job-failed` event?** Currently with the proposed fix, the event is sent from the Phase 1 catch. The Phase 2 skip just `continue`s. That's fine if Phase 1's event always fires for failed folders, but if there's any future code path where a folder ends up with `folderFetchStatus = 'failed'` _without_ going through Phase 1's catch (e.g. set externally on resume), the user would never see the failure event. Worth making the Phase 2 skip path also defensively emit the event, OR adding an invariant comment that `folderFetchStatus = 'failed'` is only ever set by Phase 1's catch.

3. **Are there other consumers of `folderFetchStatus` that depend on its current `'fetching' | 'fetched' | 'failed'` lifecycle?** The fix doesn't change the state machine, but it's worth a `grep` pass before landing.

4. **Should V1's fail-fast bug also be fixed in this work, or left alone?** V1 is presumably being phased out (`PULL_JOB_V2=true` is set in `server/.env`) and fixing both is more scope. My recommendation: leave V1 alone unless we discover anyone depends on its fail-fast behavior, and instead make sure V2 is the recommended path everywhere. If V1 is going to be deleted soon, fixing it is wasted work; if V1 is going to live for a while, we should fix the fail-fast separately.

## Background

These bugs were discovered while debugging an Affinity tenant-tables pull failure. The connector was passing `fieldTypes=list` to `/v2/persons` and `/v2/companies`, which Affinity rejects with HTTP 400 because `'list'` is only valid for list-entry endpoints (where there's actual list context). The connector-side fix was a one-line constant change — see the `2026-04-11` Affinity feature commit for `TENANT_FIELD_TYPES`.

The interesting part wasn't the connector bug. It was the _combined symptom_: a transient HTTP 400 from a connector produced (a) a permanently stuck lock requiring manual SQL to recover, (b) a job that reported success despite failing to pull two of its 21 folders, and (c) zero user-visible signal that anything had gone wrong. None of that was inevitable from the connector error — every piece of it traces back to the V2 Phase 1 catch block's missing four lines of cleanup code.

The fix is small and surgical, and is more impactful than its size suggests because it catches a whole class of "transient connector errors leave permanent stranded state" failures, not just the specific Affinity case that surfaced it.
