# Publish History — leftover tasks

**Branch**: `DEV-10235-migrate-publish-history-dt`
**Compiled**: 2026-05-29 (post-rebase against master `72a583bc2`)

Tracks open work for the desktop publish-history + rollback feature before a
wider rollout. Items are grouped by category; the priority-ranked closing list
is at the bottom.

---

## Revert edge cases — open / partly handled

| Item | Status |
|---|---|
| **Reverting deletes** (publish deleted a record → roll back recreates it locally) | Code should handle it (CLI writes pre-publish blob → file reappears), **never verified end-to-end** |
| **Reverting creates** (publish created a record → roll back deletes the local file) | Implemented, but UI doesn't warn the user "this will delete N local files." Toast just says "X written, Y deleted" after the fact |
| **Mixed batch confirmation copy** | Bulk modal copy is generic; doesn't break down the count by edit / create / delete so the user can't see "this will delete 3 files and rewrite 47" before confirming |
| **Cross-connection plans** | Server rejects with 400, UI hides the buttons silently. No tooltip or empty-state explaining why. User just sees missing controls |

---

## Drift / staleness warnings — gap

| Item | Status |
|---|---|
| **"Latest known value is different"** warning | Only shown in the **full-diff modal** (Before/After mode). Hook: `usePublishPlanPostDiffersFromCurrent` |
| **Inline expand** — no warning when current ≠ post-publish | Open |
| **Single-record rollback confirmation** — no warning | Open. User can roll back to a stale value without being told the current state has drifted |
| **Bulk rollback confirmation** — no warning, no batched drift check | Open and the most dangerous: rolling back 200 records could silently overwrite newer publishes |

---

## Flag-gating gaps (from earlier audit)

| Item | Status |
|---|---|
| Sidebar button gated on `ENABLE_PUBLISH_HISTORY` | ✅ |
| `PublishHistoryPage` deep-link route | ❌ ungated — sets store and opens panel |
| `PublishPlanDetailPage` deep-link route | ❌ ungated |
| `WorkspaceContent` panel render | ❌ ungated — any code path that sets `showPublishHistoryPanel = true` opens it |

---

## Server bugs documented but not fixed

In [`docs/publish-pk-stringification-bug.md`](./publish-pk-stringification-bug.md):

- **A (shipped)** — PK overwrite guard with pending-publish sentinel handling
- **B / C** — durable PK type preservation (discriminator column, etc.) — open
- **Bug #1** — Connectors get full record, not `changedFieldsArray`. Risk: overwriting out-of-band changes
- **Bug #2** — Commit uses our **sent** payload, not the connector's **persisted** response. Hides DB triggers, normalizers, computed columns

---

## UX polish noted but not done

- **Records summary** (`affectedRecords` / `totalOperations` / filter dropdowns) belong on `usePublishPlan` load, not refetched per page change. Currently masked with `keepPreviousData`; proper split open
- Inline diff loader gating is now correct but the **modal**'s loader gating has been iterated 3× — worth one more pass to confirm no flash in all 3 mode transitions

---

## Test coverage gaps

- `revert-plan` CLI has no integration test
- New `cli-workbook.controller` `getPublishPlan` / `getPublishPlanRecords` shims have no test coverage (added the mock for `publishPlanCrudService` but no asserting test)
- The new option-A PK-fix path has no explicit unit test ensuring integer PKs survive (only validated via the existing `sync-publish-e2e` suite which doesn't actually check the committed blob's type)

---

## Priority ranking for closing this out before a wide rollout

1. **Bulk-rollback drift warning** (highest risk, silently destructive)
2. **Flag-gate the deep-link routes + panel render** (privacy / correctness)
3. **Revert-deletes verification** (functional gap, demoable)
4. **Bulk confirmation copy with phase breakdown** (UX)
5. **Cross-connection plan empty-state** (cheap; just a tooltip)
6. The server bug doc items — separate ticket(s); not blocking for v1 rollout but should be filed in Linear before this feature ships beyond the demo audience
