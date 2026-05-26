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

## Design

### Core Shift

Each column mapping describes **one value rule for a destination field, under a specific condition**. A destination field may have multiple mappings — one per applicable bucket. The archive case becomes two mappings for the same destination column, each self-describing.

### What Changes

| Change                           | Purpose                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reshape `ColumnMapping.source`   | A mapping's value source becomes a discriminated union: either copy from a source column, or write a literal constant under a stated condition (`matched`/`unmatched`/`always`). |
| Add `unmatchedSourcePolicy`      | What to do with source records that have no destination match. (`create` is today's behavior.)                                                                                   |
| Add `unmatchedDestinationPolicy` | What to do with destination records that have no source match — subdivided by match-key state.                                                                                   |

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
  source: ColumnMappingSource;
}

export type ColumnMappingSource =
  | {
      // Copy from a source column. Implicitly applies only to matched records
      // (there is no source value to read for orphan destination records).
      columnId: string;
      transformer?: TransformerConfig;
      transformers?: TransformerConfig[];
    }
  | {
      // Write a literal constant. The `when` field selects which records this rule fires for.
      constant: JsonValue;
      when: "matched" | "unmatched" | "always";
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

After migration (see next section), existing syncs work identically.

### Schema Versioning and Migration

`SyncMapping` already carries a `version` field (currently `1`) specifically for shape migrations. We bump it to `2` and roll out in three phases, following the Whalesync backfill pattern (see `whalesync/api/bottlenose/src/backfill/`):

**Phase 1 — Deploy dual-version support.**

- Update `packages/shared-types/src/sync-mapping.ts` and `server/src/sync/sync-mapping.schema.ts` to define both v1 and v2 shapes.
- **Reader/validator accepts both versions.** When loading a `Sync.mappings` row, normalize v1 to v2 in memory before handing to the executor and other business logic. The writer always produces v2.
- After this deploy, all reads work whether the row is v1 or v2 on disk. New syncs and any saved edits are persisted as v2.

**Phase 2 — Run the backfill.**

- Add a backfill endpoint (e.g. `POST /backfill/sync-mapping-v2`) on a `BackfillController` in `server/src/`, guarded by the equivalent of `SecretKeyAuthGuard` so only ops can run it in prod.
- The endpoint accepts `n` (batch size) and `cursor` (last `Sync.id` from the previous response). It selects up to `n` `Sync` rows whose `mappings.version === 1` (ordered by id), transforms each to v2, writes back, and returns `{ processed, updated, lastId, isDone }` so the caller can sweep cursor-by-cursor.
- Idempotent — rows already at v2 are skipped without a write. Safe to re-run.
- **Local dev**: auto-run the backfill on server start, so dev environments stay current without manual intervention.
- **Production**: SRE calls the endpoint explicitly via the standard backfill sweep loop.

**Phase 3 — Drop v1 support (later, optional).**

Once all rows are verified at v2, remove the v1 normalization code and tighten the validator to v2-only. This is a separate cleanup deploy, no rush.

**The v1 → v2 transform itself:**

```
v1: { sourceColumnId: "Title", destinationColumnId: "name", transformer?: T, transformers?: T[] }
v2: { destinationColumnId: "name", source: { columnId: "Title", transformer?: T, transformers?: T[] } }
```

`tableMappings`, `recordMatching`, and unrelated fields pass through unchanged. Sets `version: 2` on the outer `SyncMapping`. The transform is purely shape-level — no semantic change — so it's safe to run any time after Phase 1 is deployed, independently of the executor / UI work.

### Worked Example: DEV-10008 (Webflow Archive)

```ts
{
  columnMappings: [
    { destinationColumnId: 'name', source: { columnId: 'Title' } },
    { destinationColumnId: 'post-body', source: { columnId: 'Body' } },
    // Two mappings for `archived`, each self-describing:
    { destinationColumnId: 'archived', source: { constant: false, when: 'matched' } },
    { destinationColumnId: 'archived', source: { constant: true, when: 'unmatched' } },
  ],
  unmatchedDestinationPolicy: {
    withMatchKey: 'apply',     // synced records that lost their source → archive
    withoutMatchKey: 'ignore', // hand-authored Webflow content → untouched
  },
}
```

Reading the config tells you exactly what the sync does in each case: matched records get `archived: false`, claimed orphans get `archived: true`, hand-authored content is left alone.

`when: 'always'` is also available for fields that should be written on every record the sync touches regardless of matched state — e.g., a `lastSyncRunId` constant.

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

The invariant is **for each (destination column, applicable bucket), at most one mapping fires**. Concretely:

- A `{ columnId }` source applies to matched records only (no source value exists for orphans).
- A `{ constant, when: 'matched' }` mapping conflicts with another `{ constant, when: 'matched' }` or any `{ columnId }` source for the same `destinationColumnId`.
- A `{ constant, when: 'unmatched' }` mapping conflicts with another `{ constant, when: 'unmatched' }` for the same `destinationColumnId`.
- A `{ constant, when: 'always' }` mapping conflicts with any other mapping for the same `destinationColumnId` (it covers every bucket).
- It is legal — and expected — for a single `destinationColumnId` to appear in multiple mappings as long as their (column, bucket) coverage doesn't overlap. The archive case is the canonical example.

Existing data is forward-compatible: today's `{ sourceColumnId, destinationColumnId, transformer? }` shape maps cleanly to a single `{ destinationColumnId, source: { columnId: sourceColumnId, transformer? } }` per destination column. No existing destination is covered by two mappings, so the validation rule holds.

All other existing validations (schema compatibility for copied fields, transformer option validation, etc.) still apply. Schema compatibility for constants is checked against the destination column's type.

### Matched Merge Rule

Today's rule: destination fields not covered by `columnMappings` are preserved.

Updated rule: destination fields not covered by any column mapping **for the bucket being processed** are preserved. For matched records, "covered" means any of `{ columnId }`, `{ when: 'matched' }`, or `{ when: 'always' }`. For visited orphan records, "covered" means `{ when: 'unmatched' }` or `{ when: 'always' }`. The match-key column is never touched by the orphan pass.

### Executor Changes

Two changes to `syncTableMapping`:

1. **Phase 1 (DATA), matched & new-record write paths**: walk each column mapping whose `source` applies to matched records — `{ columnId }`, `{ when: 'matched' }`, or `{ when: 'always' }`. For `{ columnId }`, run transformers and write the resulting value. For constants, write the literal value directly.

2. **New phase (post Phase 1, before FOREIGN_KEY_MAPPING) — destination orphan pass**:
   - Enumerate destination records whose match-key value is **not** in the current source set.
   - For each, classify as `withMatchKey` (match-key column populated) or `withoutMatchKey` (match-key column empty/null).
   - If the corresponding policy is `apply`, walk each column mapping whose `source` applies to unmatched records — `{ when: 'unmatched' }` or `{ when: 'always' }` — and write the constant to the destination record. Files are written to `DIRTY_BRANCH` like normal.
   - If the policy is `ignore`, skip.

Notes:

- The orphan pass is purely field writes. It does **not** invent a match-key value — there is no source record to point to. The match-key column stays as-is.
- The orphan pass uses the same `Sync.mappings` snapshot and `SyncRemoteIdMapping` data as Phase 1.
- If `unmatchedSourcePolicy` is `ignore`, the existing new-record creation in Phase 1 is skipped for source records with no destination match. Everything else in Phase 1 is unchanged.
- Column mappings with no orphan-applicable rule are no-ops during the orphan pass.

### Sync-Edit UI

Even though the data shape stores multi-rule destination columns as multiple mappings, the editor should group them by destination column in a single row:

- One row per destination column.
- Inputs per row: matched-side value source (a **Copy from source** picker + transformer, or a **Constant** value editor), optional orphan-side constant editor (a smaller secondary field on the same row).
- On save, the UI splits a multi-rule row into multiple `ColumnMapping` entries with the appropriate `when` values; on load, it groups them back. The persisted shape is normalized JSON; the UI affordance is purely a presentation grouping.

Two new pickers on the table mapping form:

- **Unmatched source policy** — Create (default) / Ignore.
- **Unmatched destination policy** — two toggles, clearly labeled for the with-match-key and without-match-key sub-buckets. Inline help should make clear that "without match key" typically means hand-authored content.

## Out of Scope for v1

- **Hard delete on unmatched-destination**: not exposing a `delete` option. Hard-deleting CMS records is a serious footgun and deserves its own loud feature with extra confirmations.
- **Publish review UI changes**: the existing diff UI already shows the `archived` field flipping. A future enhancement can call out the count of archive operations at the top of the review summary, but that's a follow-up.
- **Computed constants**: the `constant` field is literal JSON. No expressions (e.g., `now()`) in v1.
- **Additional `when` conditions** beyond `'matched' | 'unmatched' | 'always'`. The discriminated union leaves room for richer predicates later (e.g., `'source_field_equals'`) without restructuring.

## Follow-Ups

- **Publish review UI severity callout** ([DEV-10008](https://linear.app/whalesync/issue/DEV-10008) flags this explicitly). Surface a count like "N records will be archived" at the top of the publish review summary so users notice the destructive change without reading every diff. Cheap to add once the data model is in.
- **`delete` as a third unmatched-destination policy option**, with its own confirmation gating.
