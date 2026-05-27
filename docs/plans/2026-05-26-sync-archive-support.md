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

### Schema Versioning and Migration

`SyncMapping` carries a `version` field (currently `1`) specifically for shape migrations. We bump it to `2` and roll out in three phases:

**Phase 1 — Deploy dual-version support behind a writer feature flag.**

- Update `packages/shared-types/src/sync-mapping.ts` and `server/src/sync/sync-mapping.schema.ts` to define both v1 and v2 shapes.
- **All `Sync.mappings` reads go through a single choke point.** `SyncService.getSync()` / `SyncService.getMappings()` always return v2 (normalized in memory). The six existing direct-cast consumers route through it: `sync.service.ts:1188`, `sync-data-folders.job.ts`, `dev-tools.service.ts`, `workbook-repo.service.ts`, `whalesync-import.service.ts`, `cli-workbook.controller.ts`. An ESLint `no-restricted-syntax` rule on `server/eslint.config.mjs` bans `prisma.sync.find*` outside `sync.service.ts` so the choke point stays enforceable as new consumers land.
- **The writer is feature-flagged.** `WRITE_SYNC_MAPPING_V2=1` enables v2 writes; off by default. The flag is flipped to `1` in prod only after a 24-48h soak with `sync_mapping_normalize_error_total = 0`. Flag flip happens **after** a rolling deploy converges (do not flip mid-deploy). Flag is removed in Phase 3.
- After this deploy, all reads work whether the row is v1 or v2 on disk. With the flag on, new saves persist as v2.

**Phase 2 — Run the backfill via `code-migrations`.**

- Register a new descriptor in `server/src/code-migrations/code-migrations.controller.ts` — the in-repo backfill pattern that already wires `ScratchAuthGuard + hasAdminToolsPermission` and `AuditLogService`. Do not introduce a parallel `/backfill/...` controller.
- The descriptor accepts `n` (batch size) and `cursor` (last `Sync.id` from the previous response). It selects up to `n` `Sync` rows whose `mappings.version === 1` (ordered by id), transforms each to v2, and writes back via **compare-and-set on `updatedAt`**: `updateMany({ where: { id, updatedAt: previouslyRead }, data: ... })`. If the user PATCH-ed between the read and the write, the conditional update affects zero rows and the backfill picks the row up on the next sweep. Returns `{ processed, updated, lastId, isDone }` for cursor-based sweep.
- A kill-switch endpoint (`POST /code-migrations/sync-mapping-v2/stop`) sets a flag; in-flight batches finish, no new batches start. Used for the "stop the sweep" rollback path.
- Idempotent — rows already at v2 are skipped without a write. Safe to re-run.
- **Local dev**: gated by `SCRATCH_DEV_AUTO_MIGRATE_SYNC_MAPPING_V2=1`. Without the flag, server start logs a warning and skips. First-time devs opt in once after reading the warning.
- **Production**: ops invokes the descriptor explicitly via the standard `code-migrations` sweep loop.

**Phase 3 — Drop v1 support (separate cleanup, ~6 weeks after Phase 2 completes).**

Once all rows are verified at v2, remove the v1 normalization code, tighten the validator to v2-only, and delete the writer feature flag. A calendar-triggered ticket avoids the "deferred cleanup stays forever" failure mode.

**The v1 → v2 transform itself:**

```
v1: { sourceColumnId: "Title", destinationColumnId: "name", transformer?: T, transformers?: T[] }
v2: { destinationColumnId: "name", source: { kind: 'column', columnId: "Title", transformer?: T, transformers?: T[] } }
```

`tableMappings`, `recordMatching`, and unrelated fields pass through unchanged. Sets `version: 2` on the outer `SyncMapping`. `when` is not added by the transform — it defaults to `'matched'`, which matches v1 semantics exactly. The transform is purely shape-level; no semantic change.

`transformV1ToV2(mapping)` lives at `packages/shared-types/src/sync-mapping.ts` so both the read path (`SyncService.getSync()`) and the backfill descriptor import it from the same place.

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

`syncTableMapping` gains one new pass and absorbs three pure helpers extracted into `server/src/sync/sync-execution.ts`:

- **`transformV1ToV2(mapping)`** — pure shape transform. Imported by both `SyncService.getSync()` (read path) and the backfill descriptor (write path) from `packages/shared-types/src/sync-mapping.ts`.
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
