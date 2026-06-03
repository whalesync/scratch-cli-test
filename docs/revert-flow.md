# Revert Flow

How a user undoes a previously-published change. Covers both simple reverts (re-edit a field) and the hard case: re-creating a deleted record whose foreign-key children also got reverted.

## What revert does

A revert produces an accepted patch on the CLI that, when published, **restores the pre-publish state** of one or more records. The catch: a record that was deleted and then revived is *not* the same record on the other end — the connector assigns a fresh remote id. Anywhere else in the workspace that still points at the old id (FKs in sibling records) needs to be relinked.

The system handles this in three pieces:

1. **A sentinel in the PK field** marks "this record was reverted and needs a fresh id."
2. **A `RecreatedIdMap` table** records `(prior remote id → new remote id)` after each successful recreate.
3. **The backfill phase** rewrites stale FK literals via the remap, so children relink to the new parent id without the user touching them.

## The key data structures

### Recreate sentinel

When the CLI's `files revert-plan` revives a deleted record, it writes the pre-publish blob to the worktree with the PK rewritten:

```
old PK value:      42                                  (or "rec_xyz")
sentinel PK value: "scratch_pending_recreate_42"
```

Both the worktree file and the accepted-patch entry carry the sentinel. The server's `dispatchCreateBatch` recognizes the prefix, strips the sentinel before sending the payload to the connector (so the connector assigns a fresh id), and after the create lands, writes the `(prior → new)` row to `RecreatedIdMap`.

The CLI accepted-patch also gets `revert: true` set, which becomes `UploadPatchMeta.revert=true` on the server and then `PublishPlanOperation.isRecreate=true` on the plan operations.

### `RecreatedIdMap`

Per-`(workbookId, connectorAccountId)` table that records every recreate's id transition. Backfill consults it to rewrite stale FK literals.

```
workbookId | connectorAccountId | folder           | priorRemoteId | newRemoteId | settledAt
-----------+--------------------+------------------+---------------+-------------+----------
wkb_123    | coa_456            | public/projects  | 5             | 105         | …
wkb_123    | coa_456            | public/tasks     | 10            | 110         | …
```

Lookups chain-follow (5 → 105 → 205) so repeated recreate cycles always resolve to the latest id, with a cycle guard.

## Phase ordering — why backfill is correct by construction

Publish phases run in order:

```
asset-upload → edit → create → delete → backfill → rename-files
```

Pass4 of plan-build strips FK fields off CREATE/EDIT ops for revert paths and emits a separate BACKFILL op carrying the FK literals. Because **backfill always runs after every create lands**, the `RecreatedIdMap` is fully populated by the time backfill needs it — even when sibling reverts create records that reference each other.

## End-to-end flow (single-record revert)

```
USER:
  Delete project-5. Publish.   →  Server deletes id=5 in Postgres. main no longer has project-5.json.
  Revert that publish. Publish. →  Server creates a new project (id=105). main has project-5.json with id=105.

CLI revert-plan
  ─── for each affected path ───────────────────────────────────────────────
  reads pre-publish blob from `preMainCommitSha`:  {id: 5, name: "P", …}
  rewrites PK to sentinel:                          {id: "scratch_pending_recreate_5", name: "P", …}
  writes the rewritten blob to:
    • worktree file       (so the desktop UI shows the right shape)
    • accepted-patches.json with `revert: true`

CLI upload-patch
  posts each accepted entry (including `revert: true`) to the server.

ApplyPatchesService
  upserts UploadPatchMeta(workbook, account, filePath, revert=true) per path.
  applies the patch content to the dirty branch.

PublishPlanBuildService (plan-build)
  joins UploadPatchMeta — sets PublishPlanOperation.isRecreate=true for revert paths.
  pass4 (revert-only) nullifies FK fields on the CREATE op; diff goes to a BACKFILL op.

PublishPlanRunService (run-pipeline)
  ─── create phase ─────────────────────────────────────────────────────────
  dispatchCreateBatch:
    detects "scratch_pending_recreate_5" in payload
    strips it (id field removed) before calling connector.createRecords
    connector returns {id: 105, name: "P", …}
    main gets commit with id=105
    RecreatedIdMap row written:  (folder=public/projects, prior=5, new=105)

  ─── backfill phase (runs after all creates) ──────────────────────────────
  dispatchUpdateBatch (phase='backfill'):
    walks FK fields in resolved content
    looks up each literal in RecreatedIdMap.resolveLatest
    rewrites hits, PATCHes the connector with the new ids

  ─── after publish settles ────────────────────────────────────────────────
  UploadPatchMeta rows for this account are deleted (consumed).
  RecreatedIdMap persists for future revert-of-children to resolve against.
```

## The hard case — cyclic FK between two reverted records

This is the design's reason for being. Without the create→backfill split, the second record's FK would point at a parent whose new id is still pending.

```
Before: project id=5, task id=10 with projectId=5.

USER: delete both. Publish (delete-plan).
USER: revert the delete-plan. Publish the revert.

In the revert publish, plan-build pass4 emits:
  CREATE  public/projects/project-5.json   {id: sentinel_5, name: "P"}     ← no FK fields here
  CREATE  public/tasks/task-10.json        {id: sentinel_10, name: "T", projectId: null}  ← pass4 nullified
  BACKFILL public/tasks/task-10.json       changedFields: {projectId: 5}

CREATE phase (both run together):
  project created → id=105.  RecreatedIdMap(projects, 5 → 105).
  task created    → id=110.  RecreatedIdMap(tasks,    10 → 110).
  Neither create carries a stale FK literal → no constraint failure.

BACKFILL phase (runs after every create lands):
  task's backfill content has projectId=5.
  Lookup (projects, 5) → 105.  Rewrite.  PATCH task with projectId=105.

Final state on main: task with id=110 and projectId=105.  ✓
```

Same shape works for non-cyclic siblings (e.g. one parent, many children) and for nested chains.

## Storage map

```
                                                                       writes              reads
─────────────────────────────────────────────────────────────────────────────────────────────────────
.scratch/connections/<conn>/accepted-patches.json                      CLI revert-plan      CLI upload
                                                                                            CLI re-anchor

UploadPatchMeta (workbook, account, filePath, revert)                  ApplyPatchesService  PublishPlanBuildService
                                                                                            cleared post-publish

PublishPlanOperation.isRecreate                                        PublishPlanBuildService  (informational)

RecreatedIdMap (workbook, account, folder, priorRemoteId,              dispatchCreateBatch  dispatchUpdateBatch
                newRemoteId)                                           (after success)      (backfill phase)
                                                                                            persists across publishes
```

Cleanup paths (so neither table leaks):

- After a successful publish: `UploadPatchMeta` for that `(workbook, account)` is deleted (the flags were consumed).
- On workbook delete: both tables deleted for that workbook.
- On connector-account delete: both tables deleted for that `(workbook, account)`.

## Known limitations

- **Sentinel only fires when `pre_blob.is_some() && main_snapshot.is_none()`** — i.e., a true delete-revert. Re-reverting the same plan after the record is already alive on main writes the pre-publish id as a literal (no sentinel), which becomes a stale-id edit. The user shouldn't normally do this; if they do, the publish will surface a connector-side FK or PK error.
- **Backfill FK rewrite is unconditional** — every backfill consults the remap regardless of `isRecreate`. A user who deliberately wrote a literal id matching a remap entry would get it silently rewritten. The remap is treated as authoritative for FK resolution during backfill.
- **Suffix-match resolves FK target folders**. The FK schema's `linkedTableId` (e.g. `"authors"`) is matched against `DataFolder.path` by suffix (`/authors`). Ambiguous matches (two folders ending with the same suffix) are skipped with a warning rather than guessed.
- **Nested PKs** (Attio-shaped id triples like `id.record_id`) replace the entire `id` object with the sentinel string. The connector must accept a string id at sentinel-time; the round-trip is asserted by unit tests but not exercised against the live Attio connector.
