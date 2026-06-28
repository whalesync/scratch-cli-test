# Publish stringifies integer primary keys

**Status**: open, root cause confirmed
**Surfaced via**: publish-history "After Publish" view on the desktop (post-publish diff shows `"id": "102"` where the pre-publish state had `"id": 102`)
**Investigated**: 2026-05-29

## TL;DR

On the edit/backfill publish path, the publish service overwrites the primary-key field in each record's JSON content with the value of `FileIndex.recordId` / `PublishPlanOperation.remoteRecordId` — both Prisma `String` columns. For Postgres connectors with integer PKs, this clobbers the on-disk integer value with its string form. The post-publish commit is then tagged `main_plan_{planId}`, so every downstream consumer (publish-history diff, next pull, …) sees the stringified ID.

Creates are unaffected. Pulls are unaffected. The bug is concentrated on the **edit/backfill update batch** path.

## Root cause

`server/src/publish-plan/publish-plan-run.service.ts`, function `dispatchUpdateBatch`, **lines 717–728**:

```ts
let remoteId = entry.remoteRecordId;                       // String | null (Prisma column type)
if (!remoteId) {
  const { folderPath, filename } = parsePath(entry.filePath);
  remoteId = await this.fileIndexService.getRecordId(workbookId, folderPath, filename); // String
}

resolvedContent = {
  ...resolvedContent,
  [idField]: remoteId,                                     // ← overwrites integer 102 with "102"
} as ParsedContent;
```

Downstream:

- Line 761 formats with `formatJsonWithPrettier` (a thin wrapper over `JSON.stringify(data, null, 2)`).
- Lines 763–768 call `commitFilesToBranch` on `main` with the stringified content.
- Line 468 writes the `main_plan_{plan.id}` tag pointing at that commit.

## Why pull keeps the integer

The pull path goes through `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts:984` → `connector-file-utils.ts:49` (`buildGitFilesFromConnectorFiles`). It writes the connector's `parsedRecord` verbatim. The string `recordId` is only used as filename + `FileIndex.recordId` metadata (lines 50, 75) — it is never assigned back into the JSON content.

So the same `JSON.stringify` serializer produces integer-typed IDs on pull and string-typed IDs on publish-edit. The difference is the overwrite at `publish-plan-run.service.ts:725-728`, not the serializer.

## Why creates look fine

`dispatchCreateBatch` writes whatever the connector returns from `insertMany`. The Postgres connector's `RETURNING *` row carries the PK in its native type, so creates appear correct in the post-publish diff. The bug only manifests on records that take the **update / backfill** branch.

## Schema context

- `FileIndex.recordId` — `String` — `server/prisma/schema.prisma:469`
- `PublishPlanOperation.remoteRecordId` — `String` — `server/prisma/schema.prisma:550`
- `readRecordId` / `readRecordIdAsString` — `server/src/remote-service/connectors/types.ts:53-68`. `readRecordIdAsString` correctly normalizes any PK type (`number | string | bigint`) into a string for indexing, via `String(value)`. This is intentional and correct as an **index key**. The bug is that the same string is then written back into JSON content as if it were the canonical value.

## Reproducer

1. Pull a record from a Postgres connector whose PK column is `integer` (e.g. `posts.id`). The local file has `"id": 102`.
2. Edit any non-PK field locally (e.g. flip `authorId` to `null`).
3. Publish.
4. Open publish-history → that record → "After Publish" column. The id is now `"102"`.

## Fix directions

Listed in increasing scope / durability.

### A. Skip the overwrite when the content already has the field

Smallest fix. Inside `dispatchUpdateBatch`, only assign `resolvedContent[idField]` when it's currently missing/null. The disk file's PK is already correct in its native type — there's no reason to clobber it.

```ts
if (resolvedContent[idField] == null) {
  resolvedContent = { ...resolvedContent, [idField]: remoteId } as ParsedContent;
}
```

Risk: if a connector occasionally drops the PK from `resolvedContent` mid-flight, we now leave it absent. Audit `resolveContent` to be sure.

### B. Restore native type at write-back

Coerce `remoteId` back from string before assignment, using either the connector schema's PK type or a fallback heuristic (`/^-?\d+$/` → `parseInt`; bigint heuristic for huge values). Keeps the assignment unconditional but undoes the indexing coercion.

Risk: heuristic is fragile (zero-padded IDs, ID columns that genuinely store digit-strings).

### C. Store a type discriminator alongside `recordId`

Add `recordIdType: 'int' | 'string' | 'bigint'` (or `recordIdJson: Json`) to `FileIndex` and `PublishPlanOperation`. Reconstruct the native value before the assignment at line 725.

Risk: migration + writes to two columns in every code path that touches `recordId`. Most correct, most invasive.

Recommendation: ship **A** as a hotfix; track **C** as a follow-up only if **A** turns out to leave gaps.

## Affected refs / downstream consumers

- The git tag `main_plan_{planId}` carries the stringified blob — so the publish-history diff is the primary surface.
- A subsequent pull will overwrite the stringified value with whatever the connector returns next (back to integer), so the corruption is **transient in main** — it only persists until the next pull touches that file.
- Workspaces that publish-then-don't-pull keep the stringified value indefinitely. Desktop users on a stale workspace will see it on their next sync.

## Key files

- `server/src/publish-plan/publish-plan-run.service.ts` — `dispatchUpdateBatch` lines 690-776; `main_plan` tag at line 468.
- `server/src/publish-plan/file-index.service.ts:101-107` — `getRecordId`.
- `server/prisma/schema.prisma:465-475` — `FileIndex`; `:538-551` — `PublishPlanOperation`.
- `server/src/remote-service/connectors/types.ts:53-68` — `readRecordId` / `readRecordIdAsString`.
- `server/src/worker/jobs/job-definitions/connector-file-utils.ts:45-76` — pull-side writer that preserves types (reference path; not buggy).
- `server/src/utils/json-formatter.ts` — `formatJsonWithPrettier` (plain `JSON.stringify`, not a culprit).

## Related publish-update bugs surfaced during this investigation

Both should be fixed alongside the PK clobber; the option-A hotfix doesn't
address either.

### 1. Connectors receive the full record, not just the changed fields

`dispatchUpdateBatch` builds `changedFieldsArray` (line 706) and computes
a deep-shaped subset of the resolved content via `pickByShape` (line
738). It then passes BOTH to the connector:

```ts
await connector.updateRecords(tableSpec, contents, changedFieldsArray);
```

The plumbing for "only send the changed fields to the remote service" is
in place, but it's the connector's choice which argument to use — and at
least the Postgres connector still uses `contents` (the full record). On
edits this means we send back every field of the record, not just what
the user changed:

- Risk of overwriting an out-of-band change made directly in Postgres
  between pull and publish (we'd silently revert it).
- Larger payloads than necessary on every edit.

**Fix direction**: audit each connector's `updateRecords`; switch to
using `changedFieldsArray` for the actual remote write. `contents` can
stay as a fallback for connectors that don't yet support partial updates,
but the path that does should be the default.

### 2. Post-update commit uses our assumed value, not the connector's response

After `connector.updateRecords(...)` returns (line 747), the return
value is **discarded**. Lines 751-768 then build `gitFiles` from
`resolvedContent` — the payload we *sent* to the connector, not what the
connector actually persisted — and commit that to `main`. This means any
remote-side rewriting is lost from `main_plan_{planId}`:

- Postgres `BEFORE UPDATE` triggers that normalize values (`trim()`,
  `LOWER()`, currency rounding, etc.).
- Server-side timestamps (`updated_at = now()` triggers).
- Computed/generated columns.
- Type coercions on the DB side (numeric precision, etc.).

The next full pull eventually reconciles, but until then the publish-
history "After Publish" view shows our optimistic guess, not the
canonical state — which is misleading for diagnostics and breaks
"Rollback to current" comparisons.

**Fix direction**: change `updateRecords` to return the persisted rows
(connectors that can do `RETURNING *` / read-back already have the data;
others can fetch after the write). Merge those values into
`resolvedContent` before the `commitFilesToBranch` call. Same applies to
`dispatchCreateBatch` — though create batches already use the connector
response for the assigned PK, they don't necessarily fold in the rest of
the rewritten columns.
