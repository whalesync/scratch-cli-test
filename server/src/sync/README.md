# Sync Module

This module enables syncing records between source and destination DataFolders within a workbook.

## Overview

The sync system copies data from a **source** DataFolder to a **destination** DataFolder, transforming fields according to column mappings. It supports:

- **Record matching**: Identifying which source records correspond to existing destination records
- **Field mapping**: Transforming source fields to destination schema
- **Schema validation**: Ensuring mapped fields have compatible types

## Data Model

### Sync mappings (`@spinner/shared-types`)

The core configuration for a sync is a JSON document. Two on-disk shapes exist; see [packages/shared-types/src/sync-mapping.ts](../../../packages/shared-types/src/sync-mapping.ts).

**V1 (legacy, frozen):**

- `SyncMappingV1`: top-level config with `version: 1` and table mappings.
- `TableMappingV1`: maps a source DataFolder to a destination DataFolder with column mappings and optional record matching.
- `ColumnMappingV1`: direct field-to-field mapping (`sourceColumnId` → `destinationColumnId`) with optional `transformer` / `transformers`.

**V2 (unmatched-aware):**

- `SyncMappingV2`: `version: 2` plus table mappings.
- `TableMappingV2`: adds two optional policies — `unmatchedSourcePolicy` and `unmatchedDestinationPolicy` — describing what to do with records that have no counterpart on the other side (see [Unmatched-record policies](#unmatched-record-policies)).
- `ColumnMappingV2`: lifts `when` (`'matched' | 'unmatched' | 'always'`, default `'matched'`) to the mapping and makes the value a discriminated `source`:
  - `{ kind: 'column', columnId, transformer?, transformers? }` — copy from a source column.
  - `{ kind: 'constant', value }` — write a literal JSON primitive (e.g. `archived: true`).

`transformV1ToV2()` (in shared-types) is the pure shape transform. A transformed v1 mapping has no unmatched policies and every column defaults to `when: 'matched'`, so it behaves exactly like v1.

### Storage: dual-column + single read choke point

V2 lives in a **new column** alongside v1, not on top of it:

- `Sync.mappings` (`Json`, non-null) — the v1 source of truth. **Frozen** from the moment `mappingsV2` is first written for a row.
- `Sync.mappingsV2` (`Json?`, nullable) — the v2 shape. Writes target this column only; `mappings` is never mutated after first v2 write. The rollback story is `UPDATE Sync SET mappingsV2 = NULL` — v1 is always a safe harbor.

All reads flow through **`SyncService.getSync()` / `getMappings()`**, which return a `StoredSyncMapping` discriminated union (`SyncMappingV1 | SyncMappingV2`) reflecting the on-disk shape — preferring `mappingsV2` when non-null, falling back to v1 `mappings`. Consumers narrow on `mapping.version`. An ESLint `no-restricted-syntax` rule blocks direct `prisma.sync.find*` calls outside `sync.service.ts` so the choke point can't be bypassed.

> The executor and the editor transform v1 → v2 in memory at their entry points; the read path itself never normalizes. See [Sync Execution Flow](#sync-execution-flow).

### Database Tables

| Table                  | Purpose                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Sync`                 | Sync configuration: name, `mappings` (frozen v1) + `mappingsV2` (nullable v2), and `lastSyncTime`                |
| `SyncTablePair`        | Links source/destination DataFolder pairs for a sync                                                             |
| `SyncMatchKeys`        | Temporary table for matching records during sync execution                                                       |
| `SyncRemoteIdMapping`  | Persists source→destination record ID mappings                                                                   |
| `SyncForeignKeyRecord` | Caches referenced records for `lookup_field` transformers (keyed by `syncId`, `dataFolderId`, `foreignKeyValue`) |

## Record matching

A sync that updates existing destination records (rather than only creating new ones) needs to know **which destination record corresponds to which source record**. That correspondence is configured per table mapping as `recordMatching: { sourceColumnId, destinationColumnId }` — the **record matching field** (a.k.a. match key). Two records match when their match-field values are equal.

### Canonical match keys (direction-independent)

The comparison can only compare **primitives** (string/number), but a connector may store a field's value as a non-primitive envelope. The canonical example is a Notion `rich_text` field, whose value is `{ type: 'rich_text', rich_text: [{ text: { content: '…' }, … }] }`, not a bare string.

So each side's match value is first reduced to a **canonical match key** by `deriveCanonicalMatchKey` (`record-matching.ts`). The rule is applied **independently to each side**, using the field's _own_ connector-declared extraction transformer — **never the sync's copy transformers**:

1. **Primitive** (string/number) → use it directly (`String(v).trim()`).
2. **Non-primitive with an extraction transformer** → apply the field's `x-scratch-suggested-transformer` (the "unpack" hint, e.g. a Notion `rich_text` array → plain text), then require a primitive.
3. **Neither** → the field can't serve as a match key for that record (warn + skip).

This is deliberately **direction-independent**. Earlier the source value was run through the column-mapping _copy_ transformers (which reshape a value _into_ the other side's shape) while the destination was compared raw — so matching only worked one way. By reducing each side through its own extraction transformer instead, a plain Postgres string and a Notion `rich_text` envelope wrapping the same string both reduce to the same key, and matching works in **both** directions.

> Why not the copy transformers? They are intentionally direction-specific (Notion→Postgres unpacks; Postgres→Notion packs the string _into_ an object, which can't be a key). Matching needs the opposite: a stable canonical primitive per field, regardless of copy direction.

### Where it runs (three call sites, one reducer)

All three derive keys through the same `deriveCanonicalMatchKey`, so they always agree:

- **Source keys** — `insertSourceMatchKeys` → `SyncMatchKeys` (source rows).
- **Destination keys** — `insertDestinationMatchKeys` → `SyncMatchKeys` (dest rows).
- **The join** — `buildRecordMatchingMappings` self-joins `SyncMatchKeys` on `matchId`, producing the real source↔destination correspondence in `SyncRemoteIdMapping`.
- **Pass 3 classification** — `classifyDestinationRecord` takes a record's already-derived canonical key and checks membership in the source key set.

### Compatibility in the editor

The sync editor disables a candidate match field whose value is non-primitive with no extraction transformer, using the shared `getMatchFieldCompatibility(FieldTransformHints)` helper in `@spinner/shared-types` (the static, schema-only mirror of the runtime reducer). It is a _necessary_ check, not _sufficient_ — a field may declare an extraction transformer whose runtime output is still non-primitive, which the executor catches and skips at sync time.

## Sync Execution Flow

When `POST /workbooks/:workbookId/syncs/:syncId/run` is called a background job is enqueued (BullMQ). The job calls `syncTableMapping(tableMapping, phase)` once per **phase**:

- **`DATA`** — the main pass. Builds caches, writes matched/created records, and (v2 only) writes unmatched-destination records.
- **`FOREIGN_KEY_MAPPING`** — a second pass that resolves `source_fk_to_dest_fk` columns now that destination records exist.

`syncTableMapping` operates on the **v2 shape internally**. At its entry point it transforms a v1 mapping in memory (`transformV1ToV2`). Because a transformed v1 mapping has no `unmatchedDestinationPolicy` and every column defaults to `when: 'matched'`, Pass 3 below is a no-op for v1 syncs — they behave exactly as before.

```
syncTableMapping(tableMapping, phase)
│
├─ entry: mappings.version === 1 → transformV1ToV2()   (executor is v2-only internally)
│
├─ Pass 1 — build caches              [DATA phase only]
│    walk source pages → SyncMatchKeys (source)
│    walk dest pages   → SyncMatchKeys (dest) + destinationRecordsByPath
│    LEFT JOIN         → SyncRemoteIdMapping (source→dest, null dest for unmatched)
│    populateForeignKeyRecordCache    (for lookup_field transformers)
│
├─ Pass 2 — source-driven write
│    for each source record:
│      matched          → applyColumnMappings(bucket='matched') → merge into existing dest file
│      unmatched-source → create new dest file       (skipped if unmatchedSourcePolicy = 'ignore')
│
├─ Pass 3 — unmatched-destination write   [DATA phase only; gated, see below]
│    sourceMatchKeySet ← SELECT matchId FROM SyncMatchKeys WHERE dataFolderId = <source>
│    for each (path, record) in destinationRecordsByPath:
│      key ← deriveCanonicalMatchKey(record, destMatchCol)   (same reducer as Pass 1)
│      classifyDestinationRecord(key, sourceMatchKeySet):
│        matched                  → skip (Pass 2 handled it)
│        unmatchedWithMatchKey    → if policy.withMatchKey === 'apply':
│                                     applyColumnMappings(bucket='unmatched', sourceFields=null)
│        unmatchedWithoutMatchKey → if policy.withoutMatchKey === 'apply': (same)
│
└─ commit Pass 2 + Pass 3 file changes to DIRTY_BRANCH (single batch, Prettier-formatted JSON)
```

### Pass 1: build caches

Files are read and parsed from both source and destination DataFolders into `ConnectorRecord` objects. Match-column values are reduced to **canonical match keys** (see [Record matching](#record-matching)) and inserted into `SyncMatchKeys` for both sides; a SQL LEFT JOIN then creates `SyncRemoteIdMapping` entries for all source records (null destination for unmatched). For `lookup_field` transformers, records from each referenced DataFolder are fetched and cached in `SyncForeignKeyRecord` (grouped by referenced folder so each `(dataFolderId, foreignKeyValue)` pair is stored once). The destination records are also retained in an in-memory `destinationRecordsByPath` map for the lifetime of the call — Pass 3 reuses it with no extra query.

### Pass 2: source-driven write

Iterate source records:

- **Matched record** → `applyColumnMappings({ bucket: 'matched', ... })` merges the transformed source fields into the existing destination file (source-mapped fields win; destination fields not covered by a matched/`always` mapping are preserved).
- **Unmatched-source record** → a new destination file is created: a temporary ID is generated via `createScratchPendingPublishId()` and injected, the filename is resolved from the destination schema's `slugColumnRemoteId` (falling back to the temp ID, deduplicated), and the match key is auto-injected. Skipped entirely when `unmatchedSourcePolicy.type === 'ignore'`.

In the `DATA` phase `source_fk_to_dest_fk` passes through raw values while `lookup_field` resolves from the FK cache (see [Transformers](#transformers)).

### Pass 3: unmatched-destination write (v2)

Pass 3 visits the **destination crescent** — records in the destination that have no source counterpart this run. It runs only when **all** of the following hold:

- `phase === 'DATA'`
- `onlySourceFilePath` is **not** set (the `syncOneRecord` single-record path skips Pass 3 — it can't enumerate the whole destination folder),
- `recordMatching` is configured,
- `unmatchedDestinationPolicy` has at least one `'apply'` value, **and**
- the match-key column exists in the current destination schema (if missing, log a warning and skip — never crash).

For each destination record, `classifyDestinationRecord(record, sourceMatchKeySet, matchCol)` returns one of:

- **`matched`** — its match key is in the source set → skipped (Pass 2 already wrote it).
- **`unmatchedWithMatchKey`** — match-key field populated but no source counterpart → typically a record this sync previously wrote whose source was deleted. Acted on when `policy.withMatchKey === 'apply'`.
- **`unmatchedWithoutMatchKey`** — no canonical match key (empty/null/whitespace, or a non-primitive value with no extraction transformer; see [Record matching](#record-matching)) → hand-authored or pre-existing content this sync never managed. Acted on when `policy.withoutMatchKey === 'apply'`.

When acted on, `applyColumnMappings({ bucket: 'unmatched', sourceFields: null, ... })` applies the `when: 'unmatched'` / `when: 'always'` rules (the archive case writes `archived: true`). The `isEqual` no-op skip is inherited, so unchanged records produce no write. Pass 3 file changes are appended to the same batch as Pass 2 and committed together.

**Defensive runtime behaviors:** if a `{ kind: 'constant' }` mapping somehow targets the match-key column (save-time validation already rejects this — see [Validation](#schema-validation)), the executor omits that write and warns rather than destroying the record's identifier.

### Phase 2: FOREIGN_KEY_MAPPING

After all table mappings complete the `DATA` phase, a second pass runs for any table mapping with `source_fk_to_dest_fk` columns. This re-runs `syncTableMapping` with `phase = 'FOREIGN_KEY_MAPPING'`, which:

- Skips Pass 1 FK-cache population and Pass 3 (both `DATA`-only),
- Runs `source_fk_to_dest_fk` transformers, resolving source FK values to destination IDs via `SyncRemoteIdMapping`,
- Skips `lookup_field` transformers (already resolved in the `DATA` phase).

This two-phase approach is necessary because destination records must exist (created in the `DATA` phase) before their IDs can be used to resolve foreign key references.

### Finalization

On success, the `Sync` record's `lastSyncTime` is updated. The worker emits a PostHog `sync_completed` event and, when Pass 3 acted on any unmatched-destination record, a single `AuditLog` entry with summary counts (`archived` / `unarchived` / `withMatchKey` / `withoutMatchKey`) and a SHA of the active v2 mappings, so a later reviewer can correlate an archive to the exact config that produced it.

### Pure executor helpers

The pass logic above leans on three pure, Nest-free helpers in [sync-execution.ts](sync-execution.ts) (easy to unit-test, no DB):

- `transformV1ToV2(mapping)` — re-exported from shared-types; applied at the executor entry.
- `classifyDestinationRecord(canonicalMatchKey, sourceMatchKeySet)` — the three-way bucket classifier above (takes the record's already-derived canonical key; `null` → `unmatchedWithoutMatchKey`).
- `applyColumnMappings({ bucket, sourceFields, baseFields, mappings, ... })` — filters mappings to the bucket-applicable subset (`when` ∈ `{bucket, 'always'}`), dispatches `kind: 'column'` (via `transformRecordAsync`) vs `kind: 'constant'` (literal write), and returns the merged fields.

## Unmatched-record policies

A sync's Venn diagram has three buckets. V1 only ever touched the **matched** intersection and created records for the **unmatched-source** crescent. V2 adds first-class handling for both crescents:

| Bucket                | Controlled by                                                                         |
| --------------------- | ------------------------------------------------------------------------------------- |
| Matched               | `columnMappings` with `when: 'matched'` (or omitted) / `'always'`                     |
| Unmatched source      | `unmatchedSourcePolicy` (`{ type: 'create' }` default, or `{ type: 'ignore' }`)       |
| Unmatched destination | `unmatchedDestinationPolicy` + `columnMappings` with `when: 'unmatched'` / `'always'` |

`unmatchedDestinationPolicy` subdivides the destination crescent by match-key state — `withMatchKey` and `withoutMatchKey`, each `'ignore'` (default) or `'apply'`. This separates "synced records whose source was deleted" from "hand-authored content this sync never owned." Defaults (`create` + `ignore`/`ignore`) reproduce v1 behavior exactly.

### Worked example: archive on disappear (DEV-10008)

When a source Airtable record disappears, archive the corresponding Webflow record; when it returns, unarchive it. A single destination column carries two self-describing rules:

```json
{
  "version": 2,
  "tableMappings": [
    {
      "sourceDataFolderId": "datafolder_airtable_posts",
      "destinationDataFolderId": "datafolder_webflow_posts",
      "columnMappings": [
        { "destinationColumnId": "name", "source": { "kind": "column", "columnId": "Title" } },
        { "destinationColumnId": "post-body", "source": { "kind": "column", "columnId": "Body" } },
        { "destinationColumnId": "archived", "when": "matched", "source": { "kind": "constant", "value": false } },
        { "destinationColumnId": "archived", "when": "unmatched", "source": { "kind": "constant", "value": true } }
      ],
      "recordMatching": { "sourceColumnId": "id", "destinationColumnId": "airtable_id" },
      "unmatchedDestinationPolicy": { "withMatchKey": "apply", "withoutMatchKey": "ignore" }
    }
  ]
}
```

Reading the config tells you exactly what happens: matched records get `archived: false`; destination records whose source disappeared (and which carry the `airtable_id` match key) get `archived: true` in Pass 3; hand-authored Webflow content with no `airtable_id` is left untouched.

`when: 'always'` is also available for fields written on every record the sync touches regardless of bucket.

### Validation invariants (v2)

Enforced at save time — most as zod refinements in `sync-mapping.schema.ts`, the type check in the service layer:

- One mapping per `(destinationColumnId, when)` pair (two rules sharing a column with the same `when` collide; different `when` values are legal — that's the archive case).
- `source.kind === 'column'` is only legal with `when: 'matched'` (or omitted) — there's no source value to copy for an unmatched destination record.
- A `{ kind: 'constant' }` mapping may not target the `recordMatching.destinationColumnId` — overwriting the match key would destroy the identifier that classifies the record.
- A `{ kind: 'constant' }` value's type must match its destination column type (gated by `validateMappings`); a mismatch throws `ConstantTypeMismatchError` → HTTP 400 `INVALID_CONSTANT_TYPE` (see [Schema Validation](#schema-validation)).

## API Endpoints

| Method   | Path                                            | Description                                |
| -------- | ----------------------------------------------- | ------------------------------------------ |
| `POST`   | `/workbooks/:workbookId/syncs`                  | Create a new sync                          |
| `PATCH`  | `/workbooks/:workbookId/syncs/:syncId`          | Update sync configuration                  |
| `GET`    | `/workbooks/:workbookId/syncs`                  | List all syncs for a workbook              |
| `POST`   | `/workbooks/:workbookId/syncs/:syncId/run`      | Execute the sync                           |
| `DELETE` | `/workbooks/:workbookId/syncs/:syncId`          | Delete a sync                              |
| `POST`   | `/workbooks/:workbookId/syncs/validate-mapping` | Validate field mapping between two schemas |

### Create/Update Sync

The API accepts a `SaveSyncBody` interface (defined in `@spinner/shared-types`):

```json
{
  "displayName": "My Sync",
  "mappings": {
    "version": 1,
    "tableMappings": [
      {
        "sourceDataFolderId": "dfd_source",
        "destinationDataFolderId": "dfd_dest",
        "columnMappings": [
          { "sourceColumnId": "title", "destinationColumnId": "name" },
          {
            "sourceColumnId": "price",
            "destinationColumnId": "amount",
            "transformer": { "type": "string_to_number", "options": { "stripCurrency": true } }
          }
        ],
        "recordMatching": {
          "sourceColumnId": "id",
          "destinationColumnId": "source_id"
        }
      }
    ]
  }
}
```

The `mappings` field accepts **either** a v1 or a v2 `StoredSyncMapping` (`saveSyncBodySchema` validates both via a discriminated union on `version`). Existing v1 clients (the scratchmd CLI, whalesync import, pre-update web client) keep working; the v2-aware editor sends v2 directly. Both shapes are normalized to v2 in memory and persisted:

- `createSync` writes a sentinel-empty v1 (`{ version: 1, tableMappings: [] }`) to the frozen `mappings` column and the real v2 shape to `mappingsV2`.
- `updateSync` writes only `mappingsV2`; `mappings` is left untouched. If a row already has `mappingsV2` populated and a stale v1-only client tries to overwrite it, the save is rejected with **HTTP 409 `SYNC_MAPPING_V1_WRITE_REJECTED`** (prompting the client to update) — otherwise the v1 write would be silently shadowed by the authoritative v2 column.

Validation runs through zod schemas in `sync-mapping.schema.ts` plus the service-layer type checks described under [Schema Validation](#schema-validation).

## Examples

### Example 1: Simple field mapping (no transformers)

Sync blog posts from Airtable to a Webflow CMS collection, renaming fields to match the destination schema.

**API Request** — `POST /workbooks/:workbookId/syncs`

```json
{
  "displayName": "Airtable Posts → Webflow",
  "mappings": {
    "version": 1,
    "tableMappings": [
      {
        "sourceDataFolderId": "datafolder_airtable_posts",
        "destinationDataFolderId": "datafolder_webflow_posts",
        "columnMappings": [
          { "sourceColumnId": "Title", "destinationColumnId": "name" },
          { "sourceColumnId": "Body", "destinationColumnId": "post-body" },
          { "sourceColumnId": "Author Name", "destinationColumnId": "author" },
          { "sourceColumnId": "Published", "destinationColumnId": "is-published" }
        ],
        "recordMatching": {
          "sourceColumnId": "id",
          "destinationColumnId": "airtable_id"
        }
      }
    ]
  }
}
```

**What happens at sync time:**

- Source record `{ "id": "rec_001", "Title": "Hello World", "Body": "...", "Author Name": "Jane", "Published": true }` becomes destination record `{ "airtable_id": "rec_001", "name": "Hello World", "post-body": "...", "author": "Jane", "is-published": true }`.
- `airtable_id` is auto-injected via record matching even though it's not in `columnMappings`.
- On subsequent runs, records with matching `id` ↔ `airtable_id` values are updated in place rather than duplicated.

### Example 2: Transformers and foreign key resolution

Sync products and their categories from Notion to a CMS. Products reference categories via a foreign key, and prices are stored as strings in Notion but need to be numbers in the destination.

**API Request** — `POST /workbooks/:workbookId/syncs`

```json
{
  "displayName": "Notion Products → CMS",
  "mappings": {
    "version": 1,
    "tableMappings": [
      {
        "sourceDataFolderId": "datafolder_notion_categories",
        "destinationDataFolderId": "datafolder_cms_categories",
        "columnMappings": [
          { "sourceColumnId": "Name", "destinationColumnId": "name" },
          { "sourceColumnId": "Description", "destinationColumnId": "description" }
        ],
        "recordMatching": {
          "sourceColumnId": "id",
          "destinationColumnId": "notion_id"
        }
      },
      {
        "sourceDataFolderId": "datafolder_notion_products",
        "destinationDataFolderId": "datafolder_cms_products",
        "columnMappings": [
          { "sourceColumnId": "Name", "destinationColumnId": "title" },
          {
            "sourceColumnId": "Price",
            "destinationColumnId": "price",
            "transformer": { "type": "string_to_number", "options": { "stripCurrency": true } }
          },
          {
            "sourceColumnId": "Category ID",
            "destinationColumnId": "category_id",
            "transformer": {
              "type": "source_fk_to_dest_fk",
              "options": { "referencedDataFolderId": "datafolder_notion_categories" }
            }
          },
          {
            "sourceColumnId": "Category ID",
            "destinationColumnId": "category_name",
            "transformer": {
              "type": "lookup_field",
              "options": {
                "referencedDataFolderId": "datafolder_notion_categories",
                "referencedFieldPath": "Name"
              }
            }
          }
        ],
        "recordMatching": {
          "sourceColumnId": "id",
          "destinationColumnId": "notion_id"
        }
      }
    ]
  }
}
```

> **Note:** Since `columnMappings` is an array, the same source field can appear multiple times — e.g., `Category ID` is mapped to both `category_id` (via `source_fk_to_dest_fk`) and `category_name` (via `lookup_field`).

**What happens at sync time:**

1. **Phase 1 (DATA)**: Categories are synced first. Then products are synced — `Price: "$29.99"` is transformed to `price: 29.99`. The `source_fk_to_dest_fk` transformer passes through the raw value in this phase (destination records may not exist yet).
2. **Phase 2 (FOREIGN_KEY_MAPPING)**: Products are re-processed — `source_fk_to_dest_fk` now resolves `Category ID: "cat_001"` (Notion ID) to `category_id: "cms_cat_001"` (the destination ID) via `SyncRemoteIdMapping`.

### Example 3: Multi-table sync without record matching

Copy data into a fresh destination (no matching needed — all records are created new each run).

```json
{
  "displayName": "Import Event Speakers",
  "mappings": {
    "version": 1,
    "tableMappings": [
      {
        "sourceDataFolderId": "datafolder_speakers_csv",
        "destinationDataFolderId": "datafolder_website_speakers",
        "columnMappings": [
          { "sourceColumnId": "full_name", "destinationColumnId": "name" },
          { "sourceColumnId": "bio_text", "destinationColumnId": "biography" },
          { "sourceColumnId": "headshot_url", "destinationColumnId": "photo" }
        ]
      }
    ]
  }
}
```

Without `recordMatching`, every source record creates a new destination record on each run. This is useful for one-time imports or sources where records don't have stable IDs.

## Schema Validation

When `validateMappings` is set on the save body, `createSync` / `updateSync` run two schema-aware checks (both skipped gracefully when a folder's schema is absent — e.g. scratch folders). Both live in [schema-validator.ts](schema-validator.ts):

- **`validateSchemaMapping()`** — for column-source mappings, traverses the TypeBox JSON schemas by dot-notation path, unwraps `Optional<T>` / nullable unions to the base type, and reports any source→destination type mismatch. (v2 column mappings are projected down to the v1 shape first; constants and unmatched-side rules have no source column to check and are dropped from this pass.)
- **`findConstantTypeMismatches()`** — for `{ kind: 'constant' }` mappings, compares the literal's type against the destination column's type. `null` constants are always allowed; a numeric constant is accepted by both `number` and `integer` columns; columns with no resolvable type (`Type.Any()`) are skipped. The first mismatch throws `ConstantTypeMismatchError`.

### Typed sync-mapping errors → HTTP

Errors raised while normalizing or validating mappings are mapped to stable, machine-readable HTTP responses by `SyncExceptionFilter` ([../exception-filters/sync.exception-filter.ts](../exception-filters/sync.exception-filter.ts), registered globally in `main.ts`):

| Error (thrown from)                                | HTTP | Response `error` code           |
| -------------------------------------------------- | ---- | ------------------------------- |
| `SyncMappingNormalizeError` (`transformV1ToV2`)    | 500  | `SYNC_MAPPING_NORMALIZE_FAILED` |
| `SyncMappingVersionError` (`transformV1ToV2`)      | 500  | `SYNC_MAPPING_UNKNOWN_VERSION`  |
| `ConstantTypeMismatchError` (save-time validation) | 400  | `INVALID_CONSTANT_TYPE`         |

The 500 responses include `syncId` (read from the route param when present) so ops can correlate a corrupt-mapping failure to a specific sync.

## Record Matching

Records are matched between source and destination using the `recordMatching` configuration:

1. Source records: Match key = value of `sourceColumnId` field
2. Destination records: Match key = value of `destinationColumnId` field
3. Records with the same match key are considered the same record

Common pattern: Source uses `id` column, destination stores the source ID in a dedicated column.

### Auto-injection of Match Key

When creating **new** destination records, the sync automatically injects the source's match key value into the destination's match key field. This ensures subsequent syncs can match the record by content.

Example: If `recordMatching` is configured as:

```typescript
recordMatching: {
  sourceColumnId: 'id',
  destinationColumnId: 'source_id'
}
```

And a source record has `{ id: 'rec_001', name: 'John' }`, the new destination record will automatically include `source_id: 'rec_001'` even if it's not in the column mappings.

**Behavior notes:**

- If column mappings already populate the match key field, auto-injection is skipped (user config wins)
- If the source record is missing the match key field, the record fails with an error

## Transformers

Column mappings can include an optional `transformer` configuration that processes source values before writing them to the destination. Transformers are registered in [transformers/](transformers/) and looked up via `getTransformer()`.

Each `ColumnMapping` can specify a `transformer` with:

- `type`: The transformer type identifier
- `options`: An optional key-value bag of transformer-specific configuration

During sync, `transformRecordAsync` applies each mapping's transformer within a `TransformContext` that provides:

- The full source record and field path
- The raw source value
- `LookupTools` for FK resolution
- The current `SyncPhase` (`DATA` or `FOREIGN_KEY_MAPPING`)

If a transformer fails, the record is skipped and an error is added to the sync result.

### Adding a New Transformer

Adding a transformer is a single server-side change. Create a new file in `transformers/implementations/` that:

1. Implements the `FieldTransformer` interface (`type`, `transform`, optional `paramType`/`returnType`)
2. Declares an `optionsSchema` array describing the UI fields for its options
3. Calls `registerTransformer()` at the bottom of the file
4. Is imported in `transformers/index.ts`

The client renders transformer option forms generically from the `optionsSchema` metadata served by `GET /sync/transformers/metadata`. See [TRANSFORMER_TYPE_SYSTEM.md](transformers/TRANSFORMER_TYPE_SYSTEM.md) for details on the type system.

### Available Transformers

The full list of transformer types, labels, and options is defined in `@spinner/shared-types` (`TRANSFORMER_TYPES` array) and served at runtime via `GET /sync/transformers/metadata`. Key transformers:

| Type                         | Phase                 | Description                                                         |
| ---------------------------- | --------------------- | ------------------------------------------------------------------- |
| `source_fk_to_dest_fk`       | `FOREIGN_KEY_MAPPING` | Resolves source FK IDs to destination IDs via `SyncRemoteIdMapping` |
| `source_asset_to_dest_asset` | `FOREIGN_KEY_MAPPING` | Resolves source asset remote IDs to destination asset remote IDs    |
| `lookup_field`               | `DATA`                | Looks up a field value from a record referenced by a foreign key    |
| `auto_convert`               | `DATA`                | Generic type conversion (string, number, integer, boolean, array)   |
| `jsonpath`                   | `DATA`                | Extracts values using RFC 9535 JSONPath expressions                 |
| `map_array`                  | `DATA`                | Applies a nested transformer to each element of an array            |
| `wrap_object`                | `DATA`                | Wraps a value into a template object (`"$value"` placeholder)       |
| `ensure_type`                | `DATA`                | Validates runtime type with configurable fallback behavior          |
| `replace_regex`              | `DATA`                | Pattern-based text replacement with capture groups                  |

See `transformers/implementations/` for the complete set of 24 transformers.

## Key Files

| File                                                                                           | Description                                                                                  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [sync.service.ts](sync.service.ts)                                                             | Core sync logic; read choke point (`getSync`/`getMappings`), save path                       |
| [sync-execution.ts](sync-execution.ts)                                                         | Pure executor helpers: `transformV1ToV2`, `classifyDestinationRecord`, `applyColumnMappings` |
| [sync.controller.ts](sync.controller.ts)                                                       | REST API endpoints                                                                           |
| [schema-validator.ts](schema-validator.ts)                                                     | Source→dest type compatibility + constant-value type checking                                |
| [sync-mapping.schema.ts](sync-mapping.schema.ts)                                               | Zod validation schemas (v1 + v2) for request bodies                                          |
| [../exception-filters/sync.exception-filter.ts](../exception-filters/sync.exception-filter.ts) | Maps typed sync-mapping errors to stable HTTP responses                                      |
| [transformers/](transformers/)                                                                 | Transformer registry, types, `LookupTools`, and implementations                              |
| [shared-types/.../sync-api.ts](../../../packages/shared-types/src/dto/sync/sync-api.ts)        | API interface definitions                                                                    |
| [shared-types/.../sync-mapping.ts](../../../packages/shared-types/src/sync-mapping.ts)         | v1 + v2 sync-mapping types, `transformV1ToV2`, typed errors                                  |
