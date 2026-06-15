<!-- ⛔ DO NOT DELETE. Maintained by the `/connector-build` skill: IMPLEMENTED plans,
     moved here from PLAN.md once they ship. Write-mostly history — NOT read in the
     normal loop. Open it only to revisit how a past change was made. -->

# Attio — Implemented (Archive)

> Shipped changes, newest first. Each entry records *how* a past change was made so a
> later investigation (e.g. a change that turns out problematic) can reconstruct it
> without digging through git or the transcript.

## A1 — Make the publish pipeline id-path aware (nested record ids)
**Shipped:** 2026-06-12 · **MR:** !2696 (`dev-publish-nested-record-id`, separate **general pipeline** MR — not the Attio connector MR).
**Did not transit PLAN:** this was a reactive find-and-fix during the live CRUD run, recorded here as history per the backfill.

**What was wrong.** `publish-plan-run.service.ts` read/wrote each record's remote id with plain property access (`record[idColumnRemoteId]`), but `idColumnRemoteId` is a lodash dot-path. Every connector except Attio uses a flat `id`, so a nested `id.record_id` silently resolved to `undefined`, causing three failures, all confirmed live against Attio:
- **create wrote no FileIndex row** → the created record could never be updated/deleted (`Could not resolve remote ID`) while the CLI still printed `Published` (silent failure);
- **delete filters** were built as an unreadable flat `{ "id.record_id": v }` key;
- the **CLI revert-recreate sentinel** (written at the id-path *root*, `id: "scratch_pending_recreate_<old>"`) was read at the leaf and missed → `RecreatedIdMap` row dropped → sibling FK relinking after a reverted delete broke silently. (Found by an adversarial review pass, not the happy-path run.)

**How it was fixed.** Made create/update/delete dispatch path-aware via the existing `IdPath` helpers (the pattern the retired `publish-from-git.service.ts`, deleted in `8f658c73`, had used) plus three new immutable helpers in `connectors/types.ts`:
- `readRecordIdForSentinelDetection` — leaf value, falling back to a sentinel string occupying the path root (the CLI revert-recreate shape);
- `recordWithIdCleared` / `recordWithIdWritten` — immutable, clone **only** the objects along the id path (O(path depth), not O(record size)), **literal-own-key first** (a flat column literally named `"user.id"` still resolves), and prune empty ancestor husks (`id: {}`).

**Deliberate behavior deltas for flat-id connectors** (otherwise byte-identical): a numeric `0` id is now indexed (was dropped by a truthiness check); an unusable id is now error-logged instead of silently skipped.

**Known residual (NOT fixed here, deliberately out of scope).** A flat PK column whose *name* contains lodash path metacharacters (a Postgres/Supabase column literally named `"user.id"`) still can't be represented in a fresh delete-stub/id-fill — documented on `recordWithId` in `connectors/types.ts`. Proper fix is bracket-escaping at `idPath(...)` construction in the owning connector. Candidate for a separate Linear ticket; affects no shipped connector today (Attio is `id.record_id`; others use simple keys).

**Verification.** 50 new unit/integration tests (`publish-plan-run.service.spec.ts`, `connectors/__tests__/types.spec.ts`) covering flat vs nested paths, all three sentinel shapes, delete-filter shapes, boundary ids (`0`/`''`/`NaN`), and the connector-returned identity assertion; lint/typecheck/build green; live create→edit-without-repull→delete on Attio and an edit→push round-trip on a flat-id connector (Copper). Three adversarial review passes; their HIGH (root-sentinel) and medium (literal dotted key) findings are folded in above.
