# Pull job V2 — structural cleanup opportunities

**Status:** noted, not yet planned
**Discovered:** 2026-04-12, during code review of V2 pull job

These are design issues that aren't causing bugs today but make the code harder to reason about and increase the surface area for future mistakes. Separate from the error handling bugs documented in `2026-04-11-pull-job-v2-error-handling-bugs.md`.

## 1. Phase 2 catch re-throws — fail-fast in disguise

`processFolder`'s catch block (line 230-257) does proper per-folder cleanup (clears lock, sends `job-failed` event, sets `pullStats.failed`), then re-throws:

```typescript
throw exceptionForConnectorError(error, folderCtx.connector);
```

This exits the `for` loop in `run`. If folder 3 of 10 fails in Phase 2, folders 4-10 are never processed. Their locks are never cleared. This is the same class of fail-fast bug that V2 was designed to fix for Phase 1 — it just lives in Phase 2 instead.

Phase 2 operates on local staged data (not network calls), so it's less likely to throw than Phase 1. But it's not impossible — a Prisma error during index updates, a scratch-git failure during commit, or an OOM on a large folder would all trigger this path.

**Fix:** Remove the re-throw. The catch already does everything needed (cleanup, events, stats). After the catch, `continue` to the next folder. This makes Phase 2 match Phase 1's resilience model.

## 2. Post-processing skipped on Phase 2 throw

Lines 273-317 (rebase, GC, index rebuild, PostHog tracking) are outside the `try/finally` block. Because Phase 2's catch re-throws, these never run when any folder fails in Phase 2. This means:

- Successfully pulled folders don't get rebased or GC'd
- The git index isn't rebuilt
- PostHog never records the pull (success or failure)

**Fix:** Move post-processing into a `finally` block, or remove the Phase 2 re-throw (which fixes this as a side effect).

## 3. Progress state mutated across call depths

Three mutable objects (`publicProgress`, `jobProgress`, `pullStats`) are created in `run` and passed by reference through 4+ levels of nested calls. The worst case is `publicProgress`, which is mutated inside `fetchFolder`'s `onBatch` callback — a closure that runs concurrently across multiple folders during Phase 1.

JS single-threading prevents torn reads, but the interleaving makes checkpoint values nondeterministic (folder A's batch can bump `totalFiles` between folder B's read and write).

Not causing bugs today — the mutated fields are progress/display data, not control flow. But it makes the code harder to follow and increases risk of future mistakes.

**Fix (future refactor):** Each phase returns a result value; the caller in `run` merges results. `fetchFolder` returns its file count instead of incrementing `publicProgress.totalFiles`. `processFolder` already returns `{ created, updated, deleted }` — apply that pattern consistently.

## 4. `loadFolderAndConnector` failures abort the entire job

Lines 136-139 load all folder contexts in a `for` loop before any work begins. If folder 15 of 21 has a deleted connector account, the thrown error aborts the job before any folder gets pulled.

This might be intentional (bad data = don't start), but it's worth being explicit about the tradeoff. An alternative is to load contexts lazily or catch per-folder load failures the same way Phase 1 catches per-folder fetch failures.

## 5. `runWithConcurrency` silently swallows errors

The rejection handler (line 887) is `() => { executing.delete(p); }`. If the Phase 1 catch block itself throws (e.g., `WSLogger.error` or the checkpoint call fails), that error is eaten silently. The folder disappears from results with no trace.

**Fix:** Add error logging in the rejection handler, or let it propagate and handle at the `runPhase1Fetch` level.
