# Sync Archive Support: Unmatched-Record Policies

## Overview

Scratch syncs today operate only on the **intersection** of source and destination records — fields are copied from matched source records to matched destination records. This design adds first-class handling for the two **crescents** of the sync Venn diagram: records in source but not destination, and records in destination but not source.

The motivating use case is [DEV-10008](https://linear.app/whalesync/issue/DEV-10008): when a source Airtable record disappears, the corresponding Webflow record should be archived; when it returns, unarchived. The mechanism — column mappings whose value source can be a column copy or a literal constant, plus per-side policies on what to do with unmatched records — generalizes beyond archive.

## Motivation

From the ticket:

> Matthew wants to sync deletes. When an item is gone from Airtable, the corresponding record should be set to archive on Webflow.
>
> - For each existing item on the destination that isn't in the source, set the record to archive.
> - For items that do exist, we need to potentially unset the archive bit.

Two things follow from this:

1. **Archive-on-disappear and unarchive-on-return are coupled.** They share a single field; the value just flips based on whether the record currently has a source match.
2. **The behavior generalizes.** "Archive" is one preset of "force a destination field to a specific value." The same mechanism handles `status: stale`, locked status fields, etc.

## Today's Behavior

The Venn diagram has three buckets:

| Bucket                    | What "today" does                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Matched**               | Existing destination fields are merged with transformed source fields. Source-mapped fields win; unmapped destination fields are preserved. |
| **Unmatched source**      | New destination file is created with transformed source fields and the auto-injected match key. (No user choice — always create.)           |
| **Unmatched destination** | Not visited. The executor iterates source records; destination records with no source counterpart are completely ignored.                   |

Sync definitions live in `Sync.mappings` as JSON, validated by zod schemas (`server/src/sync/sync-mapping.schema.ts`) and shared between client/server via `packages/shared-types/src/sync-mapping.ts`.

**A note on what "absence from source" means.** This design treats "the record is not in the source folder this run" as the deletion signal. If a sync's source is a filtered view (e.g., a filtered Airtable view), records that fall out of the view appear identical to deletes to the executor. The help copy in the editor must make this implication explicit so users don't accidentally archive records that are merely filtered out for the moment.

## Design

### Core Shift

Each column mapping describes **one value rule for a destination field, under a specific bucket**. A destination field may have multiple mappings — one per applicable bucket. The archive case becomes two mappings for the same destination column, each self-describing. The bucket is named by a top-level `when` field on the mapping; the value source is a discriminated union (`column` for copies, `constant` for literals).

### What Changes

| Change                           | Purpose                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Reshape `ColumnMapping`          | Lift `when` to the top-level mapping (default `'matched'`). Make `source` a discriminated union `{ kind: 'column' } | { kind: 'constant' }`. Conflict rule collapses to "same `(destinationColumnId, when)` collides." |
| Add `unmatchedSourcePolicy`      | What to do with source records that have no destination match. (`create` is today's behavior.)                      |
| Add `unmatchedDestinationPolicy` | What to do with destination records that have no source match — subdivided by match-key state.                      |

### Type Sketch

```ts
// packages/shared-types/src/sync-mapping.ts

export interface TableMapping {
  sourceDataFolderId: DataFolderId;
  destinationDataFolderId: DataFolderId;
  columnMappings: ColumnMapping[];
  recordMatching?: { sourceColumnId: string; destinationColumnId: string };

  // NEW: what to do with source records that have no destination match.
  unmatchedSourcePolicy?: UnmatchedSourcePolicy;

  // NEW: what to do with destination records that have no source match.
  unmatchedDestinationPolicy?: UnmatchedDestinationPolicy;
}

export interface ColumnMapping {
  destinationColumnId: string;

  /**
   * Which bucket the mapping applies to. Defaults to 'matched'.
   * - 'matched'   — fires when the source record exists and is paired with this destination.
   * - 'unmatched' — fires when the destination has no source counterpart this run (orphan).
   * - 'always'    — fires for both buckets.
   *
   * Structural constraint enforced by zod refinement:
   *   `source.kind === 'column'` with `when` of 'unmatched' or 'always' is illegal —
   *   there is no source value to copy for an orphan record.
   */
  when?: "matched" | "unmatched" | "always";

  source: ColumnMappingSource;
}

export type ColumnMappingSource =
  | {
      kind: "column";
      // Copy from a source column.
      columnId: string;
      transformer?: TransformerConfig;
      transformers?: TransformerConfig[];
    }
  | {
      kind: "constant";
      // Write a literal value. For v1 the value must be a JSON primitive.
      // Arrays/objects come later once their per-element type checking
      // against the destination column lands.
      value: string | number | boolean | null;
    };

export type UnmatchedSourcePolicy =
  | { type: "create" } // DEFAULT — today's behavior
  | { type: "ignore" };

export interface UnmatchedDestinationPolicy {
  /** Records that claim to be synced — destination match-key field is populated. */
  withMatchKey: "ignore" | "apply";
  /** Records that were never managed by this sync — match-key field is empty/null. */
  withoutMatchKey: "ignore" | "apply";
}
```

### Defaults Preserve Today's Behavior

For the new optional fields, defaults match today's executor:

- `unmatchedSourcePolicy` defaults to `{ type: 'create' }`.
- `unmatchedDestinationPolicy` defaults to `{ withMatchKey: 'ignore', withoutMatchKey: 'ignore' }`.
- `ColumnMapping.when` defaults to `'matched'` — matches v1 semantics for any mapping that doesn't explicitly opt into orphan handling.

After migration (see next section), existing syncs work identically.

### Storage Model and Migration

V2 lives in a **new column** alongside v1, not on top of it. The existing `Sync.mappings` (`Json`, non-null) column is frozen as the v1 source of truth from the moment this change ships. A new `Sync.mappingsV2` (`Json?`, nullable) column holds the v2 shape. Reads prefer v2 when present; writes go to `mappingsV2` only and never touch `mappings`.

The dual-column model is the rollback story: if a v2 writer or backfill produces a corrupt v2 shape on some rows, ops sets `mappingsV2 = NULL` on those rows and the system falls back to the still-pristine v1 column. No destructive in-place transformation ever happens to `mappings`, so v1 is always a safe harbor.

**Prisma schema:**

```prisma
model Sync {
  // ...existing fields unchanged...

  // V1 shape. Frozen on disk from the moment mappingsV2 is first written.
  // Read via SyncService.getMappings() only — direct reads are blocked by ESLint.
  mappings   Json
  mappingsV2 Json? // SyncMappingV2 — @see packages/shared-types/src/sync-mapping.ts
}
```

Migration is a single `ALTER TABLE "Sync" ADD COLUMN "mappingsV2" JSONB;`. Nullable, no default, no data migration in the SQL itself — the explicit code-migrations sweep populates it in Phase 3.

**Single read choke point — `SyncService.getMappings()`.** Returns a **discriminated union** reflecting the on-disk shape, not a normalized v2:

```ts
// packages/shared-types/src/sync-mapping.ts
export interface SyncMappingV1 { version: 1; tableMappings: TableMappingV1[] }
export interface SyncMappingV2 { version: 2; tableMappings: TableMappingV2[] }
export type StoredSyncMapping = SyncMappingV1 | SyncMappingV2;

// server/src/sync/sync.service.ts
async getMappings(syncId: SyncId): Promise<StoredSyncMapping | null> {
  const row = await this.db.client.sync.findFirst({
    where: { id: syncId },
    select: { mappings: true, mappingsV2: true },
  });
  if (!row) return null;
  return row.mappingsV2 !== null
    ? syncMappingV2Schema.parse(row.mappingsV2)
    : syncMappingV1Schema.parse(row.mappings);
}

async getSync(syncId: SyncId): Promise<(Sync & { mappings: StoredSyncMapping }) | null> {
  // Full row with `mappings` shadowed by the resolved discriminated union;
  // `mappingsV2` is omitted from the return type so consumers can't reach
  // around the choke point.
}
```

Consumers narrow on `mapping.version`. Most consumers don't need to narrow — they read `tableMappings[].sourceDataFolderId`, `destinationDataFolderId`, or `recordMatching`, all of which have the same shape in v1 and v2. The executor is the one consumer that branches behavior on `version` (see §"Executor Changes").

An ESLint `no-restricted-syntax` rule on `server/eslint.config.mjs` blocks any `prisma.sync.find*` call that selects `mappings` or `mappingsV2` outside `sync.service.ts`. Forces every read to flow through `getMappings()`/`getSync()`.

**Write asymmetry.** Once this change ships:

- `createSync()` writes a sentinel empty v1 (`mappings: { version: 1, tableMappings: [] }`) plus the real shape to `mappingsV2`. Pre-update clients reading just `mappings` see an empty sync — fail-safe, not a corrupt half-state.
- `updateSync()` writes only to `mappingsV2`. The `mappings` column is frozen at whatever it was at the moment of first v2 save. Reverting `mappingsV2 → NULL` loses any edits made since the v2 transition. Acceptable: routine edits on prod syncs are rare today, and the rollback is the emergency hatch, not a daily-use path.
- The backfill descriptor populates `mappingsV2` from `mappings` on rows where `mappingsV2 IS NULL`. Non-destructive.

No writer feature flag is needed — because v2 writes target a separate column, there is no destructive overwrite to gate. The old plan's `WRITE_SYNC_MAPPING_V2` flag is removed.

**Rollout phases.**

**Phase 1 — Ship the column, the reader, and the writer in one deploy.** Add the `mappingsV2` Prisma column. Land `SyncService.getMappings()`, the v2 writer in `updateSync()`/`createSync()`, the ESLint rule, and all six direct-cast consumers routed through the choke point (`sync.service.ts:1188`, `sync-data-folders.job.ts`, `dev-tools.service.ts`, `workbook-repo.service.ts`, `whalesync-import.service.ts`, `cli-workbook.controller.ts`). From this point forward every sync save writes v2; existing rows (`mappingsV2 = NULL`) still read v1 from `mappings` until an edit or the backfill touches them.

**Phase 2 — Update all clients.** The desktop app has released versions in the wild. Before running the backfill, ensure every active client has been updated to the v2-aware reader. Monitor desktop version analytics; broadcast an update prompt for stragglers. **Risk being mitigated:** an old client editing a row with a populated `mappingsV2` would write only to `mappings`, and its edits would be silently shadowed by the v2 column. A server-side guard rejects v1-shape writes once `mappingsV2 IS NOT NULL` for that row (HTTP 409 → client prompt to update). The guard is enabled at the start of Phase 2 and stays on through Phase 4.

**Phase 3 — Run the backfill via `code-migrations`.** Register a new descriptor in `server/src/code-migrations/code-migrations.controller.ts` — the in-repo backfill pattern wires `ScratchAuthGuard + hasAdminToolsPermission` and `AuditLogService`. Do not introduce a parallel `/backfill/...` controller. The descriptor:

- Accepts `n` (batch size) and `cursor` (last `Sync.id` from the previous response).
- Selects up to `n` `Sync` rows where `mappingsV2 IS NULL` (ordered by id), parses `mappings` as v1, runs `transformV1ToV2()`.
- Writes back via **compare-and-set on `updatedAt` and `mappingsV2 IS NULL`**: `updateMany({ where: { id, updatedAt: previouslyRead, mappingsV2: null }, data: { mappingsV2: <v2> } })`. If a concurrent save populated `mappingsV2` between read and write, the conditional update affects zero rows; the row is left alone because it's already migrated.
- Returns `{ processed, updated, lastId, isDone }` for cursor-based sweep.
- Idempotent — rows already at v2 are skipped by the `WHERE mappingsV2 IS NULL` filter. Safe to re-run.
- A kill-switch endpoint (`POST /code-migrations/sync-mapping-v2/stop`) sets a flag; in-flight batches finish, no new batches start. Used for the "stop the sweep" rollback path.
- **Local dev**: gated by `SCRATCH_DEV_AUTO_MIGRATE_SYNC_MAPPING_V2=1`. Without the flag, server start logs a warning and skips. First-time devs opt in once after reading the warning.
- **Production**: ops invokes the descriptor explicitly via the standard `code-migrations` sweep loop.

**Phase 4 — Drop v1 (separate cleanup, ~6 weeks after Phase 3 completes).** Once `backfill_sync_mapping_v1_remaining = 0` has held for the soak window, run a migration that drops the `mappings` column and renames `mappingsV2 → mappings`. Delete the v1 type, the v1 zod schema, the v1 branch in the executor, the dual-column logic in `getMappings()`, and the Phase 2 server-side guard. A calendar-triggered ticket avoids the "deferred cleanup stays forever" failure mode.

**The v1 → v2 transform.**

```
v1: { sourceColumnId: "Title", destinationColumnId: "name", transformer?: T, transformers?: T[] }
v2: { destinationColumnId: "name", source: { kind: 'column', columnId: "Title", transformer?: T, transformers?: T[] } }
```

`tableMappings`, `recordMatching`, and unrelated fields pass through unchanged. Sets `version: 2` on the outer `SyncMappingV2`. `when` is not added by the transform — it defaults to `'matched'`, which matches v1 semantics exactly. Purely shape-level; no semantic change.

`transformV1ToV2(mapping)` lives at `packages/shared-types/src/sync-mapping.ts`. **It is NOT used by the read path** — `getMappings()` returns the on-disk shape via the discriminated union. It IS used by:

- The editor's "open v1 sync" flow — when the editor receives a v1 mapping, it transforms in memory for the UI; the next save persists as v2 to `mappingsV2`.
- The backfill descriptor — transforms v1 → v2 in batches and writes to `mappingsV2`.
- The executor's entry point — see §"Executor Changes" (transform-in-memory dispatch).

The transform raises typed errors on malformed input:

- `SyncMappingNormalizeError` — structural corruption (missing required fields, wrong types).
- `SyncMappingVersionError` — unknown `version` value.

A `SyncExceptionFilter` (extending NestJS `BaseExceptionFilter`) maps both to HTTP 500 with stable error codes (`SYNC_MAPPING_NORMALIZE_FAILED`, `SYNC_MAPPING_UNKNOWN_VERSION`). `ConstantTypeMismatchError` from save-time validation maps to HTTP 400 (`INVALID_CONSTANT_TYPE`). `BackfillTransformError` and `UnsupportedWhenError` are accumulated in result summaries, not thrown to HTTP.

### Worked Example: DEV-10008 (Webflow Archive)

```ts
{
  columnMappings: [
    { destinationColumnId: 'name',      source: { kind: 'column', columnId: 'Title' } },
    { destinationColumnId: 'post-body', source: { kind: 'column', columnId: 'Body'  } },
    // Two mappings for `archived`, each self-describing:
    { destinationColumnId: 'archived', when: 'matched',   source: { kind: 'constant', value: false } },
    { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true  } },
  ],
  unmatchedDestinationPolicy: {
    withMatchKey:    'apply',  // synced records that lost their source → archive
    withoutMatchKey: 'ignore', // hand-authored Webflow content → untouched
  },
}
```

Reading the config tells you exactly what the sync does in each case: matched records get `archived: false`, claimed orphans get `archived: true`, hand-authored content is left alone.

`when: 'always'` is also available for fields that should be written on every record the sync touches regardless of bucket — e.g., a `lastSyncRunId` constant on every visited record.

### Subdivision of the Destination Crescent

A Webflow collection often mixes synced records with hand-authored content. Both fall into "in destination, not in source" — but they have very different semantics:

- **With match key**: the destination's match-key field is populated, indicating the sync (or a previous sync) wrote a value there. The source counterpart has since disappeared. These are clear orphans of this sync.
- **Without match key**: the match-key field is empty/null. The record was never managed by this sync — hand-authored, imported through another channel, or pre-existed the sync.

Subdividing makes the choice explicit in config and lets users handle both real-world patterns:

| Use case                                       | `withMatchKey` | `withoutMatchKey` |
| ---------------------------------------------- | -------------- | ----------------- |
| Webflow with hand-authored content (DEV-10008) | `apply`        | `ignore`          |
| "Sync owns the entire collection"              | `apply`        | `apply`           |
| Default                                        | `ignore`       | `ignore`          |

### Validation Rules

The persisted shape's invariants — all enforced at save time, most as zod refinements:

- **One mapping per `(destinationColumnId, when)` pair.** Two mappings sharing the same column and the same `when` value collide. Save fails with a clear error citing the colliding entries. Two mappings sharing the same column but with different `when` values are legal and expected (the archive case is the canonical example).
- **`source.kind === 'column'` is only legal with `when: 'matched'` (or `when` omitted, which defaults to `'matched'`).** Structural — `when: 'unmatched'` or `when: 'always'` with a column source is illegal because there is no source value to copy for an orphan record.
- **`source.kind === 'constant'` cannot write to the `recordMatching.destinationColumnId`** regardless of `when`. The match-key column identifies the record; overwriting it from a constant rule would destroy the only identifier that classifies it as belonging to this sync. The only legitimate match-key write path is a `{ kind: 'column', columnId: <matchSrc> }` mapping during new-record creation in Pass 2.
- **`constant.value` types match the destination column type.** The schema validator checks `typeof value` against the dest column's type. For v1 the value union is `string | number | boolean | null`.
- Existing data is forward-compatible: today's `{ sourceColumnId, destinationColumnId, transformer? }` maps cleanly to `{ destinationColumnId, source: { kind: 'column', columnId: sourceColumnId, transformer? } }` with `when` defaulting to `'matched'`. No existing destination is covered by two mappings, so the new invariant holds for the entire installed base.

All existing validations (schema compatibility for column copies, transformer option validation, etc.) still apply.

### Matched Merge Rule

Today's rule: destination fields not covered by `columnMappings` are preserved.

Updated rule: destination fields not covered by any mapping **for the bucket being processed** are preserved.

- For matched records in Pass 2: "covered" means any mapping whose `when` is `'matched'` (or undefined → defaults to matched) or `'always'`.
- For orphan records visited by Pass 3: "covered" means `when: 'unmatched'` or `when: 'always'`.

The match-key column is never overwritten by a constant mapping — enforced at save time, defended at runtime by Pass 3 if a manually-edited DB row sneaks one through (omit + warn, never crash).

### Executor Changes

`syncTableMapping` operates internally on v2 only. At its entry point, if `getMappings()` returns a v1 mapping, the executor calls `transformV1ToV2(mapping)` in memory before running anything. Because a transformed v1 mapping has no `unmatchedDestinationPolicy` and every column mapping defaults to `when: 'matched'`, Pass 3 is a no-op for v1 syncs — they retain today's behavior exactly. This keeps the executor as a single codepath instead of duplicating v1/v2 branches.

The executor gains one new pass and absorbs three pure helpers extracted into `server/src/sync/sync-execution.ts`:

- **`transformV1ToV2(mapping)`** — pure shape transform. Imported from `packages/shared-types/src/sync-mapping.ts` by the executor (entry point), the editor (open-v1 flow), and the backfill descriptor.
- **`classifyOrphan(destRecord, sourceMatchKeySet, matchCol)`** — returns `'matched' | 'withMatchKey' | 'withoutMatchKey'`. Empty / null / whitespace-only match-key values classify as `withoutMatchKey`. Non-string, non-number match-key values classify as `withoutMatchKey`.
- **`applyColumnMappings(bucket, sourceFields | null, destFields, mappings, ...)`** — filters mappings to the bucket-applicable subset, dispatches `kind: 'column'` vs `kind: 'constant'`, returns merged fields. `transformer-pipeline.ts` stays bucket-agnostic; the executor pre-filters.

The flow inside `syncTableMapping`:

**Pass 1 — build caches (unchanged from today).** Walk source pages → fill `SyncMatchKeys` (source). Walk destination pages → fill `SyncMatchKeys` (dest) and build `destinationRecordsByPath`. `buildRecordMatchingMappings` joins to populate `SyncRemoteIdMapping`. `populateForeignKeyRecordCache` for `lookup_field` transformers.

**Pass 2 — source-driven write (modified).** Iterate source records. For each matched record call `applyColumnMappings({ bucket: 'matched' }, sourceFields, destFields, mappings)` and write to the existing destination file. For each unmatched-source record, create a new destination file via the existing `createScratchPendingPublishId` path (skipped if `unmatchedSourcePolicy.type === 'ignore'`). Pre-existing batch-write error handling (`sync.service.ts:1146-1165`) is unchanged. The `isEqual` no-op skip at line 1108-1112 is inherited.

**Pass 3 — destination-orphan write (NEW).** Gated by `unmatchedDestinationPolicy` having any `'apply'` value AND `recordMatching` being configured AND `onlySourceFilePath` NOT being set (the `syncOneRecord` path skips Pass 3 entirely — single-record-scope is incompatible with a dest-folder-wide enumeration). Pseudocode:

```
sourceMatchKeySet := SELECT matchId
                     FROM   "SyncMatchKeys"
                     WHERE  syncId = ? AND dataFolderId = <source>
                  → hydrate into Set<string> for O(1) classification

for each (path, record) in destinationRecordsByPath:
    destKey := record.fields[recordMatching.destinationColumnId]
    classify via classifyOrphan(destKey, sourceMatchKeySet, …):
        matched           → SKIP (handled by Pass 2)
        withMatchKey      → if policy.withMatchKey === 'apply':
                              applyColumnMappings({ bucket: 'unmatched' }, null, record.fields, mappings)
                              omit + warn if a rule attempts to write the match-key column
                              accumulate into filesToWrite (inherits isEqual no-op skip)
        withoutMatchKey   → same as withMatchKey, gated by policy.withoutMatchKey

commit batch via the same commitFilesToBranch error-handling pattern as Pass 2
```

**Defensive runtime behaviors:**

- If the match-key column is missing from the current destination schema, Pass 3 logs a warning and skips entirely. Never crashes.
- If a `{ kind: 'constant' }` mapping targeting the match-key column survives validation (e.g., manually-edited DB row), the executor omits the write and emits a warning. Never overwrites the match-key.

**Audit + observability:**

- One `AuditLogEntry` per sync run with summary counts: `{ archived, unarchived, withMatchKey, withoutMatchKey }`. No per-record entries. Wires through `AuditLogService` per `server/CLAUDE.md`.
- New metrics: `sync_orphan_with_key_count`, `sync_orphan_without_key_count`, `sync_archive_writes_total`, `backfill_sync_mapping_v1_remaining`, `backfill_sync_mapping_v2_transformed_total`, `sync_mapping_normalize_error_total`.
- A SHA over the normalized v2 mappings is persisted on each sync run record (`mappings_snapshot_hash`) so ops can correlate "what config was active when this archive happened" weeks later.
- `WSLogger.info` on every sync save logs the writer-flag value for postmortem traceability during the Phase 1 soak window.

**Pull-atomicity invariant.** Pull jobs throw on connector errors (`pull-files.job.ts:472` — `throw exceptionForConnectorError`) rather than committing partial state. Therefore "0 source records after a successful pull" really does mean "all source records deleted upstream," and mass archive in that case is the intended behavior, not a failure mode. No executor-level safeguard against empty source is needed.

### Sync-Edit UI

The persisted shape stores multi-rule destination columns as multiple `ColumnMapping` entries. The editor groups them by `destinationColumnId` and renders **stacked** — matched-side on top, orphan-side indented below. On save the editor splits a multi-rule row into multiple entries with the appropriate `when` values; on load it groups them back. Persisted shape is normalized JSON; grouping is a presentation layer.

**Locked layout (UI-R4):**

```
┌── dest col: archived ────────────────────────────────────────────┐
│  Matched    [ Constant ▾ ]  [ false        ]                    │
│    on orphan:   [ Constant ▾ ]  [ true      ]  [×]             │
└──────────────────────────────────────────────────────────────────┘

Multi-rule overflow (3+ rules same dest col):
┌── dest col: archived ────────────────────────────────────────────┐
│  Matched    [ Constant ▾ ]  [ false        ]                    │
│    on orphan (with-key):    [ Constant ▾ ]  [ true   ]  [×]    │
│    on orphan (without-key): [ Constant ▾ ]  [ stale  ]  [×]    │
└──────────────────────────────────────────────────────────────────┘
```

Implementation uses Mantine `<Stack>` with `sm` gap; orphan side indented via `padding-left: md`. Both rules stay visible at a glance — the matched/orphan coupling is the feature.

**Two new policy pickers**, placed in a **collapsed accordion at the bottom of the table-mapping form** labeled "Unmatched record handling — advanced" (`Text13Medium`). Defaults visible when expanded. Order inside the accordion: source policy first, destination policy second (matches the source-to-destination cognitive flow of the column mappings themselves).

- **Unmatched source policy** — Mantine `<SegmentedControl>` with options _"Create new destination records (default)"_ / _"Ignore — don't create new records."_
- **Unmatched destination policy** — two `<SegmentedControl>` pairs (`withMatchKey` first, `withoutMatchKey` second):
  - "Synced records that lost their source" — `Apply` / `Ignore` (default). Help copy in `Text12Regular var(--fg-secondary)`, italic: _"Records previously created by this sync whose source has been deleted. Typically: yes, archive them."_
  - "Hand-authored or pre-existing records" — `Apply` / `Ignore` (default). Help copy: _"Records that were never managed by this sync. Typically: don't touch."_

**Per-row affordances:**

- `[+ Add unmatched rule]` — `IconButtonGhost` + `PlusIcon` via `StyledLucideIcon` + adjacent `Text13Regular` label. **Hidden** (not disabled) when `unmatchedDestinationPolicy` is all-`ignore` for the table mapping. Reveals as soon as any policy becomes `apply`.
- `[×]` row remove — `IconButtonGhost` + `XIcon` via `StyledLucideIcon`. Right-aligned per row.

**Constant editor type-switches by destination column type:** `<TextInput>` for string, `<NumberInput>` for number, `<Switch>` for bool. Same dispatch as today's column-value editing.

**Destructive safeguard (`client/CLAUDE.md` mandates `ConfirmDialog` for destructive actions):** when a user toggles `withMatchKey` or `withoutMatchKey` from `ignore` to `apply` for the first time on a sync that has previously run, a `ConfirmDialog` (via `useConfirmDialog`) opens:

- Title: _"Enable orphan record handling?"_
- Body: _"Saving with this setting means the next sync run will apply archive rules to {count} destination records that have no source counterpart. You can review and reject these changes in publish review before they go live."_
- Confirm: "Enable" (`variant: 'primary'`); Cancel: "Keep ignore."
- One-time per setting flip per sync (lifetime). Count is computed at save time from the already-loaded `destinationRecordsByPath` — no new server endpoint needed.

**v1 JSON paste flow:** paste detects v1 shape via zod parse, runs `transformV1ToV2()` silently, saves as v2. Toast on success: _"Sync upgraded from v1 to v2 format."_ Malformed paste shows `Text12Regular var(--fg-error)` inline below the textarea with the zod error path.

**Conflict-matrix violations** render as a per-row red left-border (`border-left: 2px solid var(--fg-error)` — functional, not decorative) plus `Text12Regular var(--fg-error)` helper text below the offending row with the specific zod refinement message. Linked via `aria-describedby`.

**Responsive:** desktop-only (minimum 1024 × 600). No mobile/tablet layout — declared explicitly so the implementer doesn't waste time on responsive variants.

**Accessibility:** all new affordances inherit Mantine's default keyboard support (Tab focus, Enter/Space activate, arrow keys within `<SegmentedControl>`). Per-affordance aria-labels:

- Policy `<SegmentedControl>`: `aria-label="Source records with no destination match"` / `"Synced records that lost their source"` / `"Hand-authored or pre-existing records"`.
- `[+ Add unmatched rule]`: `aria-label="Add unmatched-side rule to column {destinationColumnId}"`.
- `[×]`: `aria-label="Remove mapping for column {destinationColumnId}"`.
- ConfirmDialog: title becomes `aria-labelledby`.

The implementer verifies `var(--fg-tertiary)` meets WCAG AA (4.5:1) on the form panel background; falls back to `var(--fg-secondary)` for the matched/orphan sub-labels if not.

## Out of Scope for v1

- **Hard delete on unmatched-destination**: not exposing a `delete` option. Hard-deleting CMS records is a serious footgun and deserves its own loud feature with extra confirmations.
- **Publish review UI changes**: the existing diff UI already shows the `archived` field flipping. A future enhancement can call out the count of archive operations at the top of the review summary, but that's a follow-up.
- **Computed constants**: the `constant` field is literal JSON. No expressions (e.g., `now()`) in v1.
- **Additional `when` conditions** beyond `'matched' | 'unmatched' | 'always'`. The discriminated union leaves room for richer predicates later (e.g., `'source_field_equals'`) without restructuring.

## Follow-Ups

- **Publish review UI severity callout** ([DEV-10008](https://linear.app/whalesync/issue/DEV-10008) flags this explicitly). Surface a count like "N records will be archived" at the top of the publish review summary so users notice the destructive change without reading every diff. Cheap to add once the data model is in.
- **`delete` as a third unmatched-destination policy option**, with its own confirmation gating.

## Review-Agreed Changes (from /plan-ceo-review on 2026-05-26)

This section is the audit trail for a HOLD-SCOPE CEO review. The plan body above has been updated to reflect each decision below; this section retains the rationale (why this option won) and pointers to artifacts. JSONL task breakdown lives at `~/.gstack/projects/whalesync-spinner/tasks-ceo-review-20260526-215819.jsonl`.

### Type shape revisions

- **D9 + D13 — Reshape `ColumnMapping`.** Lift `when` to the `ColumnMapping` itself (not inside `source`). Make `source` a discriminated union with an explicit `kind` field. Resulting shape:

  ```ts
  export interface ColumnMapping {
    destinationColumnId: string;
    /** Defaults to 'matched'. */
    when?: "matched" | "unmatched" | "always";
    source:
      | {
          kind: "column";
          columnId: string;
          transformer?: TransformerConfig;
          transformers?: TransformerConfig[];
        }
      | { kind: "constant"; value: JsonValue };
  }
  ```

  Zod uses `discriminatedUnion('kind', ...)` on `source`. A schema refinement makes `{ source.kind: 'column' } + when: 'unmatched' | 'always' }` structurally illegal (no source value exists for an orphan to copy). The conflict matrix collapses to "same `(destinationColumnId, when)` pair collides."

- **R2 — Tighten `constant.value` zod schema** for v1 to `z.union([z.string(), z.number(), z.boolean(), z.null()])`. Add arrays/objects later once their dest-column type checking is wired.

### Executor + read-path

- **D3 — Single read choke point.** Add `SyncService.getSync()` / `SyncService.getMappings()` that always return v2 (normalized in memory). Update all six existing direct-cast consumers to route through it: `sync.service.ts:1188`, `sync-data-folders.job.ts`, `dev-tools.service.ts`, `workbook-repo.service.ts`, `whalesync-import.service.ts`, `cli-workbook.controller.ts`.

- **D4 — In-memory orphan classification.** Pass 3 walks `destinationRecordsByPath` (already built in Pass 1 at `sync.service.ts:834`); for each record, computes the dest match-key value, classifies into `{ matched, withMatchKey, withoutMatchKey }` against the transformed source match-key Set. No new SQL query. Pass 3 is skipped entirely when `recordMatching` is unset OR `onlySourceFilePath` is set (the latter is the `syncOneRecord` path — see OV9).

- **D6 + Q8 — Pre-filter at executor; extract helper.** Introduce `applyColumnMappings(bucket, sourceFields | null, destFields, mappings, ...)` and have the executor filter `mappings` to the bucket-applicable subset before calling it. `transformer-pipeline.ts` stays bucket-agnostic.

- **D10 + OV8 — Save-time validation rejects writes to the match-key column** from any `{ source.kind: 'constant' }` mapping regardless of `when`. The only legitimate match-key write path is a `{ source.kind: 'column', columnId: <matchSrc> }` mapping during new-record creation in Pass 2.

- **D7 — Invariant: zero source records is an intended signal.** Pull-files.job.ts throws on connector errors (line 472 `throw exceptionForConnectorError`), so "0 source records after a successful pull" really does mean "all source records deleted." Document this explicitly in `server/src/sync/README.md` so future readers don't reinvent an executor-level safeguard. No executor-level threshold.

### Migration + rollout

- **D5 — Writer feature flag.** Phase 1 ships the v2 writer behind an env flag (off by default). Flip to v2 writes only after 24-48h of dual-version reader running clean. Flag flip must happen after a deploy converges (do not flip mid-rolling-deploy). Flag deleted in Phase 3.

- **R1 — Backfill uses the in-repo `code-migrations` pattern.** Register a new descriptor in `server/src/code-migrations/code-migrations.controller.ts` with the existing `ScratchAuthGuard + hasAdminToolsPermission` + `AuditLogService` wiring. The original plan body cited the sibling `whalesync/api/bottlenose` backfill pattern with `SecretKeyAuthGuard`; the in-repo `code-migrations` pattern is the right reference. Add a `code-migrations` kill-switch endpoint for the "stop the sweep" rollback path.

- **D8 — Backfill writes use compare-and-set on `updatedAt`.** Inside the transform-and-write transaction, `updateMany({ where: { id, updatedAt: previouslyRead }, data: ... })`. If the user PATCH-ed between read and write, the conditional update writes zero rows and the backfill picks up the row on the next sweep.

- **D14 + OV4 — Local-dev auto-run is gated** by `SCRATCH_DEV_AUTO_MIGRATE_SYNC_MAPPING_V2=1`. Without the flag, server start logs a warning and skips. First-time devs read the warning, opt in once.

### Observability

- **D11 — One AuditLog entry per sync run with summary counts**: `{ archived, unarchived, withMatchKey, withoutMatchKey }`. No per-record audit entries.

- **O2 — Metrics**: `sync_orphan_with_key_count`, `sync_orphan_without_key_count`, `sync_archive_writes_total`, `backfill_sync_mapping_v1_remaining`, `backfill_sync_mapping_v2_transformed_total`, `sync_mapping_normalize_error_total`.

- **O5 — Per-run mappings hash.** Persist a SHA over the normalized v2 mappings on the sync-run record so ops can correlate "what config was active when this archive happened."

### UI

- **UI-R1 — Policy pickers placement**: collapsed accordion at the bottom of the table-mapping form, labeled "Unmatched record handling — advanced." Defaults visible when expanded.

- **UI-R2 — Inline help copy** for the `withMatchKey` and `withoutMatchKey` toggles: name the real-world intuition ("Synced records that lost their source — typically: archive them" / "Hand-authored or pre-existing records — typically: don't touch").

- **UI-R3 — Per-row orphan affordance gating**: the "add orphan-side rule" affordance on a destination-column row only appears when `unmatchedDestinationPolicy` has any `apply` value.

- **I2 — Editor JSON paste**: v1 JSON paste auto-upgrades to v2 silently before save (matches the dual-version reader policy).

### Plan body recommendations

- **Validation conflict matrix** — replace the prose listing in §"Validation Rules" with an explicit table over `(destinationColumnId, when)` pairs.

- **`syncOneRecord` interaction (OV9)** — explicitly state in §"Executor Changes" that Pass 3 is a no-op when `onlySourceFilePath` is passed.

- **View-filtered pulls (OV3)** — add a paragraph in §"Today's Behavior" noting that if a source DataFolder is a filtered view (e.g., a filtered Airtable view), records falling out of the view are indistinguishable from real deletes by this design. Users should know.

### Cross-references

- Test plan (T1-T19) and decisions D1-D14 detailed in the review's transcript.
- Out-of-scope items unchanged.
- Follow-Ups extended: see `## Follow-Ups Added During Review` below.

## Follow-Ups Added During Review

- **Wire `AuditLogService` into all sync runs (separate ticket, P2).** Pre-existing gap surfaced during review; server CLAUDE.md mandates audit logs for record-file mutations, but sync currently uses only PostHog. The orphan-pass scope (D11) addresses this for archive writes only. File as separate Linear ticket.
- **Schedule Phase 3 v1-removal ticket for ~6 weeks after Phase 2 sweep completes.** Without a calendar trigger, deferred cleanup stays forever.
- **`dryRun: true` mode on `POST /syncs/:syncId/run` (P2).** Returns counts of what would archive / unarchive / create without writing. Real safety net before enabling archive policy on a CMS with existing data.

## Review-Agreed Changes (from /plan-eng-review on 2026-05-27)

Audit trail for the eng review. The plan body above incorporates every gating decision and inline recommendation from this review. This section retains the parallelization lanes, eng-specific task IDs (T19-T23), and the artifact pointers needed during implementation.

### Gating decisions (locked)

- **D1-eng — Enforce the `getSync()` choke point with ESLint.** Add a `no-restricted-syntax` rule to `server/eslint.config.mjs` banning `prisma.sync.find*` outside `server/src/sync/sync.service.ts`. Pattern parallels existing `client/` and `scratch-desktop/` configs. Override comment on the SyncService file. The rule keeps D3 enforceable as new consumers land.

- **D2-eng — Dedicated CI job for the v1-compat regression gate.** Place the T16 v1-compat specs in `server/test/integration/sync-mapping-v1-compat.spec.ts`. Add a `sync_v1_compat` CI job that runs only those specs. The job's green status is the explicit precondition for flipping `WRITE_SYNC_MAPPING_V2=1` in prod. Document this gate in the Phase 1 runbook.

### Code organization (inline)

- **Extract pure helpers to `server/src/sync/sync-execution.ts`** — `transformV1ToV2`, `classifyOrphan`, `applyColumnMappings`. Pure, no Nest deps, easy to unit-test. Keeps `sync.service.ts` under 2400 lines and stops the god-class trajectory without committing to a full `SyncExecutorService` extraction.

- **`transformV1ToV2` lives in `packages/shared-types/src/sync-mapping.ts`** — colocated with the v1 + v2 shape definitions. Imported by both `SyncService.getSync()` (read path) and the backfill descriptor (write path).

- **Source match-key Set for Pass 3 classification** — `SELECT matchId FROM "SyncMatchKeys" WHERE syncId=? AND dataFolderId=<source>` after Pass 1 completes. Uses the existing unique index. Hydrate into a JS `Set<string>` for O(1) lookups. ~5 LOC.

### Defensive runtime behaviors (added to the plan body)

- **Match-key column missing from current dest schema** — Pass 3 validates the match-key column exists in the destination schema before classifying. If missing, log a warning and skip Pass 3 entirely. Never crashes.

- **`{kind: 'constant'}` write to the match-key column at runtime** — even though D10 makes this a save-time validation reject, the executor is defensive: if such a mapping is encountered at runtime (e.g., from a manually-edited DB row), omit the write and emit a warning. Never overwrites the match-key.

- **Writer flag value logged on every sync save** — `WSLogger.info({ source: 'SyncService.updateSync', writerFlag: isV2WriteEnabled() })`. Operational traceability for postmortems during the Phase 1 soak window.

### Wiring & docs

- **Typed exception → HTTP mapping** — wire the 5 new exception classes through a `SyncExceptionFilter` extending `BaseExceptionFilter`. Map:
  - `SyncMappingNormalizeError` → 500 `{ error: 'SYNC_MAPPING_NORMALIZE_FAILED', syncId, detail }`
  - `SyncMappingVersionError` → 500 `{ error: 'SYNC_MAPPING_UNKNOWN_VERSION', syncId, version }`
  - `ConstantTypeMismatchError` → 400 (only thrown from save-time validation) `{ error: 'INVALID_CONSTANT_TYPE', destinationColumnId, expected, got }`
  - `BackfillTransformError` — not HTTP; accumulated in batch summary
  - `UnsupportedWhenError` — not HTTP; accumulated in warnings

- **Update `server/src/sync/README.md`** — add Pass 3 to the "Sync Execution Flow" section, refresh examples to v2 shape, embed the executor ASCII diagram. Stale README is worse than no README.

### Parallelization (build order)

Six lanes derived from the agreed plan:

| Lane                               | Steps                    | Depends on              |
| ---------------------------------- | ------------------------ | ----------------------- |
| **A** (shape + reader)             | T1, T2, T4, T13          | — (foundation)          |
| **B** (executor + helpers)         | T3, T6, T7, T8, T14, T21 | Lane A                  |
| **C** (backfill + flag)            | T5, T9, T10              | Lane A                  |
| **D** (client)                     | T11, T12                 | Lane A (types only)     |
| **E** (tests)                      | T15, T16, T20            | Whatever it tests       |
| **F** (docs + obs + lint + filter) | T17, T18, T19, T22, T23  | None — can land anytime |

Execution: Lane A first, sequentially. Then B + C + D in parallel (3 worktrees). E rolls alongside. F can land independently.

### Eng-review tasks

- **T19** — Add ESLint rule (D1-eng).
- **T20** — Wire `sync_v1_compat` CI job (D2-eng).
- **T21** — Extract `sync-execution.ts` (A1-eng inline).
- **T22** — `SyncExceptionFilter` wiring (Q3-eng inline).
- **T23** — Refresh `server/src/sync/README.md` (Q4-eng inline).

JSONL artifact: `~/.gstack/projects/whalesync-spinner/tasks-eng-review-20260527-081503.jsonl`.

Test plan artifact for `/qa`: `~/.gstack/projects/whalesync-spinner/cfonger-dev-10008-review-eng-review-test-plan-20260527-081109.md`.

## Review-Agreed Changes (from /plan-design-review on 2026-05-27)

Audit trail for the design review. The Sync-Edit UI section above incorporates every locked decision (D2-design ConfirmDialog, D3-design stacked layout, accordion placement, component mapping, copy, a11y patterns). This section retains the wireframe, the user-journey storyboard, the full component mapping table, and the task IDs (T24-T32) the implementer will check off.

### Gating decisions (locked)

- **D2-design — ConfirmDialog on first ignore→apply transition.** When a user toggles `withMatchKey` or `withoutMatchKey` from `ignore` to `apply` for the first time on a sync that has previously run, surface a `ConfirmDialog` via `useConfirmDialog` (per `client/CLAUDE.md`):
  - Title: `"Enable orphan record handling?"`
  - Body: `"Saving with this setting means the next sync run will apply archive rules to {count} destination records that have no source counterpart. You can review and reject these changes in publish review before they go live."`
  - Confirm: `"Enable"` (variant: `primary`); Cancel: `"Keep ignore"`
  - Count is computed at save time from the already-loaded `destinationRecordsByPath`. No new server endpoint needed.
  - One-time per setting flip per sync (lifetime). After confirm, no further dialogs.

- **D3-design — UI-R4: matched + orphan slot layout is STACKED.** Per dest-column row, matched-side renders on top; orphan-side renders indented below. Multi-rule overflow (3+ rules same dest col) extends the same stacked pattern. Implemented via Mantine `<Stack>` with `sm` gap; orphan-side indented via `padding-left: md`.

### Layout wireframe — locked

```
┌── dest col: archived ────────────────────────────────────────────┐
│  Matched    [ Constant ▾ ]  [ false        ]                    │
│    on orphan:   [ Constant ▾ ]  [ true      ]  [×]             │
└──────────────────────────────────────────────────────────────────┘

Multi-rule overflow:
┌── dest col: archived ────────────────────────────────────────────┐
│  Matched    [ Constant ▾ ]  [ false        ]                    │
│    on orphan (with-key):    [ Constant ▾ ]  [ true   ]  [×]    │
│    on orphan (without-key): [ Constant ▾ ]  [ stale  ]  [×]    │
└──────────────────────────────────────────────────────────────────┘
```

### Information architecture (inline)

- Inside the `Unmatched record handling — advanced` accordion: source policy first, destination policy second (matches the source-to-destination cognitive flow of the column mappings themselves).
- Inside the destination policy block: `withMatchKey` toggle first (synced records that lost their source — the common case), `withoutMatchKey` toggle second (hand-authored — the edge case).
- Per-row order: matched-side first (default case), orphan-side second (exception case).

### State coverage (inline — written into the plan)

Each affordance gets concrete user-visible copy:

- **`unmatchedSourcePolicy` picker** — defaults visible: `● Create new destination records (default)` / `○ Ignore — don't create new records`.
- **`unmatchedDestinationPolicy` toggles** — both default to `Ignore`. Inline help in `Text12Regular var(--fg-secondary)`:
  - `withMatchKey`: _"Records previously created by this sync whose source has been deleted. Typically: yes, archive them."_
  - `withoutMatchKey`: _"Records that were never managed by this sync (hand-authored or pre-existing). Typically: don't touch."_
- **Orphan-side affordance** — `[+ Add unmatched rule]` link (`IconButtonGhost` + `PlusIcon` + `Text13Regular` label). **Hidden** (not disabled) when `unmatchedDestinationPolicy` is all-ignore for the table mapping.
- **Conflict-matrix violation** — per-row red left-border (`border-left: 2px solid var(--fg-error)`) + `Text12Regular` helper text below the row with the specific zod refinement message. Linked to the row via `aria-describedby`.
- **v1 JSON paste** — auto-upgrades to v2 silently before save. Toast on success: `"Sync upgraded from v1 to v2 format"`. Malformed paste: inline `Text12Regular var(--fg-error)` below the textarea with the zod error path.
- **Save success** — existing toast: `"Sync saved"`. No change.

### User journey storyboard

14-step Webflow archive (DEV-10008) path documented in design review Pass 3. Safety chain: editor copy → D2-design ConfirmDialog → publish review diff → publish. Step 4-5 (toggle + ConfirmDialog) is the confidence-building moment.

### Component mapping (Pass 5)

| Affordance                    | UI_SYSTEM.md component                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| Accordion shell               | Mantine `<Accordion>`; label `Text13Medium`                             |
| Section labels in accordion   | `Text13Medium`                                                          |
| Policy toggles                | Mantine `<SegmentedControl>` with `Apply` / `Ignore` options            |
| Inline help copy              | `Text12Regular` with `var(--fg-secondary)`, italic                      |
| Per-row dest column label     | `Text13Medium`                                                          |
| Matched / orphan sub-labels   | `Text12Regular` with `var(--fg-tertiary)`                               |
| Source col vs Constant picker | Mantine `<Select>`                                                      |
| Constant editor               | Type-driven: `<TextInput>` / `<NumberInput>` / `<Switch>`               |
| `[+ Add unmatched rule]`      | `IconButtonGhost` + `PlusIcon` via `StyledLucideIcon` + `Text13Regular` |
| `[×]` remove                  | `IconButtonGhost` + `XIcon` via `StyledLucideIcon`                      |
| Conflict helper text          | `Text12Regular` with `var(--fg-error)`                                  |
| Conflict row accent           | `border-left: 2px solid var(--fg-error)` (functional, not decorative)   |
| ConfirmDialog                 | `ConfirmDialog` via `useConfirmDialog`                                  |
| Paste-success toast           | Existing project `notifications.show` pattern                           |

### Responsive + accessibility

- **Responsive: desktop-only.** SyncEditor minimum supported viewport: 1024 × 600. No mobile/tablet layout required. Declared explicitly so implementer doesn't waste time on responsive specs.
- **Keyboard:** all new affordances inherit Mantine's default keyboard support (Tab focus, Enter/Space activate, arrow keys within `<SegmentedControl>`).
- **Screen reader:** aria-labels per affordance specified in design review Pass 6 a11y table. Key labels:
  - `<SegmentedControl>` per policy: `aria-label="Source records with no destination match"` / `"Synced records that lost their source"` / `"Hand-authored or pre-existing records"`.
  - `[+ Add unmatched rule]`: `aria-label="Add unmatched-side rule to column {destinationColumnId}"`.
  - `[×]`: `aria-label="Remove mapping for column {destinationColumnId}"`.
  - ConfirmDialog: title becomes `aria-labelledby`.
- **Contrast:** implementer verifies `var(--fg-tertiary)` meets WCAG AA (4.5:1) on the form panel background; falls back to `var(--fg-secondary)` for matched/orphan sub-labels if not.

### Design-review tasks

- **T24** — Wire ConfirmDialog with orphan count (D2-design).
- **T25** — Implement stacked per-row layout (D3-design).
- **T26** — Lock UI copy for accordion + toggles.
- **T27** — Type-driven Constant editor.
- **T28** — Conflict-matrix violation rendering.
- **T29** — Orphan-side affordance with gating.
- **T30** — v1 JSON paste auto-upgrade flow.
- **T31** — Plan-body annotation: desktop-only declaration.
- **T32** — Multi-rule overflow visual.

JSONL artifact: `~/.gstack/projects/whalesync-spinner/tasks-design-review-20260527-083111.jsonl`.

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status       | Findings                                                                                             |
| ------------- | --------------------- | ------------------------------- | ---- | ------------ | ---------------------------------------------------------------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 1    | CLEAR (PLAN) | HOLD scope; 14 decisions locked (D1-D14); 0 unresolved; 0 critical gaps; 3 TODOs added               |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 0    | —            | —                                                                                                    |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN) | 6 issues found (1 lint, 1 CI gate, 3 inline arch, 1 inline code-qual); 0 critical gaps; 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 1    | CLEAR (PLAN) | score 6/10 → 9/10; 2 decisions locked (D2 ConfirmDialog, D3 stacked layout); 0 unresolved            |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —            | —                                                                                                    |

**OUTSIDE VOICE (Claude subagent):** 9 findings from CEO outside voice — 7 absorbed (OV2 → D13; OV4 → D14; OV3/OV5/OV8/OV9 absorbed inline; OV6 → TODO-3); OV1 overshot; OV7 closed by pull-atomicity invariant. Eng + design skipped second outside voices (incremental value low after CEO absorption).

**CROSS-MODEL:** subagent's "third destination scan" worry (OV1) was incorrect — `destinationRecordsByPath` lives for the full `syncTableMapping` invocation. All other tensions resolved.

**UNRESOLVED:** 0.

**VERDICT:** CEO + ENG + DESIGN CLEARED — ready to implement. Run `/ship` when the work is done.

## Review-Agreed Changes (from implementation discussion on 2026-05-27)

Audit trail for a redesign of the migration model during pre-implementation discussion. The plan body above has been updated to reflect each decision below; this section retains the rationale (what changed, why this design wins, and which earlier decisions it supersedes).

### What changed

The original plan migrated `Sync.mappings` in place — same column, two possible shapes (v1 or v2 on disk), with `SyncService.getMappings()` auto-normalizing to v2 on read and a `WRITE_SYNC_MAPPING_V2` feature flag gating destructive v2 writes. The redesign splits v2 into a **separate `mappingsV2 Json?` column**, leaving the v1 column frozen and pristine from the moment v2 ships.

The trigger was the rollback story. With the in-place model, a buggy v2 transform destructively overwrites v1 data and there is no safe-harbor row state to fall back to. With the dual-column model, the rollback is `UPDATE Sync SET mappingsV2 = NULL` — the v1 column is still authoritative, untouched.

### Locked decisions

- **D1-storage — Dual-column storage.** Add `mappingsV2 Json?` to `Sync`. The existing `mappings` column is frozen as v1 source of truth from the moment v2 ships. Writes go to `mappingsV2` only; reads prefer `mappingsV2` if non-null. Supersedes the in-place "bump `mappings.version` to 2" model.

- **D2-storage — `SyncService.getMappings()` returns a discriminated union.** Returns `StoredSyncMapping = SyncMappingV1 | SyncMappingV2` reflecting the on-disk shape. Consumers narrow on `mapping.version`. Supersedes the original D3 wording in the CEO review (which said the read path always returns v2 normalized in memory).

- **D3-storage — Executor transforms v1 → v2 in memory at its entry point.** `syncTableMapping` operates internally on v2 only. v1 mappings get `transformV1ToV2()` applied at the top of the executor, then run through the unified v2 codepath. Because transformed v1 has no orphan policies and all column mappings default to `when: 'matched'`, Pass 3 is a no-op for v1 syncs — preserving today's behavior with zero duplicated executor code.

- **D4-storage — Sentinel empty-v1 on create.** `createSync()` writes `mappings: { version: 1, tableMappings: [] }` plus the real shape to `mappingsV2`. Pre-update clients reading only `mappings` see an empty sync — fail-safe rather than corrupt half-state. Supersedes the question of "can `mappings` be nullable" — it stays non-nullable; the sentinel handles new-sync creation.

- **D5-storage — No writer feature flag.** With v2 writes going to a separate column, there's no destructive overwrite to gate. Supersedes the original D5 (CEO review) `WRITE_SYNC_MAPPING_V2` flag and removes the associated 24-48h soak-then-flip ceremony.

- **D6-storage — Server-side rejection of v1-shape writes once `mappingsV2 IS NOT NULL`.** Closes the "old client writes v1, new system reads v2" silent-shadow gap. Returns HTTP 409 → old client prompts user to update. Enabled at the start of Phase 2 and stays on through Phase 4.

- **D7-storage — Reordered rollout phases.** Four phases now:
  - **Phase 1:** ship column + reader + writer in one deploy.
  - **Phase 2:** update all clients (desktop especially); enable v1-write rejection guard.
  - **Phase 3:** run the backfill (compare-and-set on `(id, updatedAt, mappingsV2 IS NULL)`).
  - **Phase 4:** drop the `mappings` column, rename `mappingsV2 → mappings`, delete v1 code.

  Supersedes the original 3-phase rollout. The new Phase 2 (client updates before backfill) is explicit because the desktop app has released versions in the wild and the backfill's correctness depends on no concurrent v1 writers.

### Eng-review decisions that still hold

- **D1-eng (ESLint choke point)** — still applies, with a tightened selector: block `prisma.sync.find*` outside `sync.service.ts` when the query selects `mappings` or `mappingsV2`.
- **A1-eng (extract `sync-execution.ts`)** — unchanged. `transformV1ToV2`, `classifyOrphan`, `applyColumnMappings` still pure helpers in that module.
- **`transformV1ToV2` colocation** — still in `packages/shared-types/src/sync-mapping.ts`. Now imported by three call sites: executor entry, editor open-v1 flow, backfill descriptor. NOT used by the read path.
- **Typed exception → HTTP mapping** — unchanged.

### Implications for the Eng-review parallelization lanes

The build order from the prior eng review (Lane A → B/C/D in parallel) still works, but the contents of each lane shift slightly:

- **Lane A (shape + reader)** — now also includes the Prisma migration for `mappingsV2`, the dual-column `getMappings()`, and the executor's v1-transform-at-entry. Sentinel-empty-v1 logic in `createSync()`.
- **Lane C (backfill + flag)** — drops the writer feature-flag work entirely. Adds the v1-write rejection guard (Phase 2 gate) and the `mappingsV2 IS NULL` filter on the backfill descriptor.
- **Lane B / D / E / F** — unchanged.

### Out of scope for this redesign

- Whether `mappings` is ever populated after first v2 save. **No** — frozen at last v1 state forever (or until Phase 4 drops the column).
- Whether old clients can read or display v2 syncs. **No** — they read `mappings` only, which is the frozen v1 snapshot. They see stale data, which is acceptable because (a) the v1-write-rejection guard prevents them from making it worse, and (b) Phase 2 minimizes the population of old clients before backfill.

## Implementation Conventions

Notes that apply across every session implementing this plan.

### Code-comment terminology

Plan-internal jargon (Lane A/B/C/D/E/F, phase numbers, task IDs like T4/T13/T19) is only meaningful while reading this doc. It rots fast in code comments: anyone who hits the comment cold has no idea what "Lane B" refers to, and once the rollout is complete, the references are actively misleading.

Two acceptable patterns in source code:

1. **Reword without the jargon.** Describe the concrete future change ("when the executor adopts v2, replace this narrow with `transformV1ToV2(sync.mappings)`"), the static reason ("frozen as v1 source of truth from the moment `mappingsV2` is first written"), or the call site involved — anything a cold reader can follow.
2. **Pair the jargon (or the cleanup intent) with `TODO(DEV-10008)`.** The ticket reference is greppable, durable past the rollout, and survives terminology churn. Use this when the cleanup is the _point_ of the comment — e.g., temporary narrows that throw on v2, or back-compat aliases that get deleted once the v1 column is dropped.

Avoid: bare references to "Phase 4", "Lane C", "T19", or similar — they only make sense if the reader has this doc open. Note that pre-existing `Phase N` references inside `sync.service.ts` and `sync-data-folders.job.ts` refer to the executor's FK-resolution phases (`DATA` vs `FOREIGN_KEY_MAPPING`); that's real domain terminology, not plan jargon.

The same applies to the audit-trail prefixes in this doc itself (`D1-eng`, `OV4`, `UI-R3`, etc.). Those live here and in the review JSONL artifacts; they should never appear in shipped code comments.

## Implementation Progress

### Completed

- **T1 (Lane A) — Reshape shared-types** (`packages/shared-types/src/sync-mapping.ts`)
  - V1 types renamed to `SyncMappingV1` / `TableMappingV1` / `ColumnMappingV1`. Back-compat aliases (`SyncMapping`, `TableMapping`, `ColumnMapping`) kept so the 11 downstream consumers compile untouched; aliases are removed in the Phase 4 cleanup.
  - V2 types added: `SyncMappingV2`, `TableMappingV2`, `ColumnMappingV2`, `ColumnMappingSource` (discriminated `kind: 'column' | 'constant'`), `ColumnMappingWhen`, `UnmatchedSourcePolicy`, `UnmatchedDestinationPolicy`.
  - `StoredSyncMapping = SyncMappingV1 | SyncMappingV2` — the discriminated union the T4 choke point will return.
  - `transformV1ToV2()` pure transform with defensive validation. Imports planned from the executor entry, the editor's open-v1 flow, and the backfill descriptor; not used by the read path.
  - Typed errors `SyncMappingNormalizeError` (with `detail`) and `SyncMappingVersionError` (with `receivedVersion`), matching the field shape `SyncExceptionFilter` (T22) will read.
  - Verified: `yarn build` clean across all 14 packages; `yarn lint` clean across all 5 packages.

- **T2 (Lane A) — Zod schemas** (`server/src/sync/sync-mapping.schema.ts`)
  - Renamed v1 schemas: `columnMappingV1Schema`, `tableMappingV1Schema`, `syncMappingV1Schema`. Back-compat alias `syncMappingSchema = syncMappingV1Schema` kept for `sync.service.ts` + `debug-openrouter.ts`.
  - V2 schemas added: `columnMappingV2SourceSchema` (`z.discriminatedUnion('kind', [...])` over `column` / `constant`), `columnMappingV2Schema`, `unmatchedSourcePolicySchema` (discriminated on `type`), `unmatchedDestinationPolicySchema`, `tableMappingV2Schema`, exported `syncMappingV2Schema`. Constant value union is `z.union([z.string(), z.number(), z.boolean(), z.null()])` — JSON primitives only for v1-of-v2.
  - Refinements wired via `.superRefine` for precise issue paths:
    - **(a)** Column source `superRefine` on `columnMappingV2Schema` — `source.kind === 'column'` with `when ∈ {'unmatched', 'always'}` raises a custom issue at `path: ['when']`. Also folds in transformer-vs-transformers exclusivity (mirrors the v1 refinement, scoped to the column source variant).
    - **(b)** Table-level `superRefine` — emits a custom issue at `path: ['columnMappings', idx, 'source']` if any `{ source.kind: 'constant' }` mapping targets `recordMatching.destinationColumnId`, regardless of `when`.
    - **(d)** Table-level `superRefine` — emits a custom issue at `path: ['columnMappings', idx]` on duplicate `(destinationColumnId, when ?? 'matched')` pairs, naming the colliding earlier index.
  - Refinement **(c)** — at the bare-schema level, `constant.value` is enforced as a JSON primitive. The destination-column-type compatibility check (`ConstantTypeMismatchError`) needs DataFolder schema info and lives in the service layer; comment in the schema flags this for whoever wires it (T6 / save-time validation).
  - `previewRecordBodySchema` and `validateMappingBodySchema` re-pointed at `columnMappingV1Schema` (these endpoints still operate on the v1 shape until their consumers migrate).
  - Verified: root `yarn build` and `yarn lint` clean. Server lint already runs with `--max-warnings=0`, so strict lint is covered by the root command.

- **T13 (Lane A) — Prisma `mappingsV2 Json?` column**
  - Added `mappingsV2 Json?` to `Sync` in `server/prisma/schema.prisma`, alongside the existing `mappings Json`. Comments document the freeze semantics (`mappings` becomes frozen-v1 once `mappingsV2` is first written) and the Phase 4 drop-rename.
  - Migration: `server/prisma/migrations/20260528140713_add_sync_mappings_v2/migration.sql` — single `ALTER TABLE "Sync" ADD COLUMN "mappingsV2" JSONB;`. Nullable, no default, no data migration in SQL — the explicit Phase 3 backfill descriptor populates it.
  - `yarn prisma generate` run; client types updated. Existing rows: `mappingsV2 = NULL` → `parseStoredMappings` falls back to v1 `mappings`. No behavioral change until a v2 write lands (Lane C).

- **T4 (Lane A) — Single read choke point** (`server/src/sync/sync-mapping.schema.ts`, `server/src/sync/sync.service.ts`)
  - Added pure helper `parseStoredMappings(row)` in `sync-mapping.schema.ts`. Generic over the row shape so includes (e.g., `syncTablePairs`) flow through. Prefers `mappingsV2` when non-null, falls back to v1 `mappings`. Returns the row with `mappings` typed as `StoredSyncMapping` and `mappingsV2` stripped so consumers cannot reach around the choke point. Branded-ID cast at the parse boundary matches the codebase's existing zod-vs-shared-types convention.
  - Added `SyncService.getSync(syncId): Promise<SyncWithMappings | null>`, `getMappings(syncId): Promise<StoredSyncMapping | null>`, and `getSyncForExecution(syncId)` (deep include for the worker job). Exported type `SyncWithMappings = Omit<Sync, 'mappings' | 'mappingsV2'> & { mappings: StoredSyncMapping }`.
  - Routed three internal casts in `sync.service.ts` through `parseStoredMappings`/`getSync`: `exportSyncs` map (was line 430), `syncOneRecord` (was line 1188), `validateSyncMappingTypes` (was line 1978). Each adds a `mappings.version !== 1` defensive narrow that throws today — v2 is never produced yet (Lane C writer not shipped). Lane B replaces these throws with `transformV1ToV2` at the executor entry.
  - Routed three external consumers: `worker/jobs/job-definitions/sync-data-folders.job.ts` (now calls `syncService.getSyncForExecution`), `workbook/workbook-repo.service.ts` (uses `parseStoredMappings` directly — `WorkbookRepoService` cannot import `SyncService` because the dep is already one-way the other direction; ESLint rule explicitly disabled at the `findMany` with justification), `cli/cli-sync.controller.ts` GET endpoint (now uses `syncService.findOneForWorkbook`, preserves the `assertReadableWorkbook` permission check the prior code did directly).
  - **Consumer list correction (vs plan body §"Phase 1"):** the plan listed `dev-tools.service.ts`, `whalesync-import.service.ts`, `cli-workbook.controller.ts` as direct-cast consumers. Audit found they are not: `dev-tools.service.ts`'s `remapSyncMappings` takes `unknown` from an internal caller and never touches Prisma; `whalesync-import.service.ts` reads `sync.mappings` from a **Whalesync export JSON payload**, not from a `Sync` row; `cli-workbook.controller.ts` delegates to `WorkbookRepoService.pushSyncs`. The actual direct-cast set is the five inventoried above plus three internal-to-sync.service sites.

- **T19 (Lane F, landed with T4) — ESLint choke-point enforcement** (`server/eslint.config.mjs`)
  - Added `no-restricted-syntax` blocking `<chain>.sync.find{First,Unique,Many,UniqueOrThrow,FirstOrThrow}` via selector `CallExpression[callee.object.property.name='sync'][callee.property.name=/^find.../]`. Catches `prisma.sync.find*`, `db.client.sync.find*`, `tx.sync.find*` patterns uniformly.
  - Rule disabled for `src/sync/sync.service.ts` (the choke point itself), `**/__tests__/**`, and `**/*.spec.ts` (mocks).
  - Per-call `// eslint-disable-next-line no-restricted-syntax -- <reason>` added to four existence-only callers that demonstrably do not read mappings: `schedule/schedule.service.ts:entityExists` and `:validateEntityId` (id-only existence via `syncTablePairs.some.sourceDataFolder.workbookId`), `cli/cli-sync.controller.ts:runSync` (existence + posthog metadata), `sync/sync.controller.ts:runSync` (same), `workbook/workbook.service.ts:delete` (id-only enumeration for cascade-delete). The disable comments document the exception cases and surface them for future review.

- **Verified:** root `yarn build` clean across 14 packages; root `yarn lint` clean (server runs `--max-warnings=0`); `yarn jest src/sync/__tests__/sync.service.spec.ts src/sync/__tests__/sync.controller.spec.ts src/workbook/__tests__/workbook.service.spec.ts src/schedule` → 91 tests pass. Integration tests not run (require local DB).

### Next up

Lane A complete. Lane B / C / D / E / F now unblocked and can land in parallel.

- **Lane B (executor + helpers)** — T3 (executor entry-point `transformV1ToV2` dispatch), T6 (`applyColumnMappings` extraction), T7 (Pass 3 orphan-driven write), T8 (`classifyOrphan` helper), T14 (Pass 3 audit + metrics), T21 (extract `sync-execution.ts`). With T4's `SyncWithMappings` in place, the executor entry can narrow `sync.mappings.version` and call `transformV1ToV2` for v2 rows; the three `version !== 1 → throw` narrows added in T4 become the natural replacement sites.
- **Lane C (backfill + writer)** — T5 (sentinel-v1 + v2-writer in `createSync`/`updateSync`), T9 (Phase 3 backfill descriptor in `code-migrations.controller.ts` with compare-and-set on `(id, updatedAt, mappingsV2 IS NULL)`), T10 (Phase 2 server-side guard rejecting v1-shape writes once `mappingsV2 IS NOT NULL`).
- **Lane D (client)** — T11 (sync-edit UI: stacked layout, accordion, policy pickers, ConfirmDialog), T12 (v1 JSON paste auto-upgrade flow).
- **Lane E (tests)** — T15, T16 (v1-compat regression specs in `server/test/integration/sync-mapping-v1-compat.spec.ts`), T20 (CI `sync_v1_compat` job).
- **Lane F (remaining)** — T17 (`server/src/sync/README.md` Pass 3 + v2 examples), T18 (Posthog/CustomMetrics counters), T22 (`SyncExceptionFilter`), T23 (README refresh follow-up).

### Lane status

- **Lane A** (T1, T2, T4, T13) — **complete**. T19 (Lane F) landed early with T4.
- **Lanes B / C / D / E** — unblocked; can land in parallel.
- **Lane F** — partially landed (T19 done with T4); T17, T18, T22, T23 remain.
