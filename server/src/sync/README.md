# Sync Module

This module enables syncing records between source and destination DataFolders within a workbook.

## Overview

The sync system copies data from a **source** DataFolder to a **destination** DataFolder, transforming fields according to column mappings. It supports:

- **Record matching**: Identifying which source records correspond to existing destination records
- **Field mapping**: Transforming source fields to destination schema
- **Schema validation**: Ensuring mapped fields have compatible types

## Data Model

### SyncMapping (`@spinner/shared-types`)

The core configuration for a sync, stored as JSON in the `Sync.mappings` column. See type definitions in [packages/shared-types/src/sync-mapping.ts](../../../packages/shared-types/src/sync-mapping.ts):

- `SyncMapping`: Top-level sync configuration with version and table mappings
- `TableMapping`: Maps a source DataFolder to a destination DataFolder with column mappings and optional record matching
- `ColumnMapping`: Direct field-to-field mapping with an optional `transformer` configuration

### Database Tables

| Table                  | Purpose                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Sync`                 | Stores sync configuration including name, mappings JSON, and `lastSyncTime`                                      |
| `SyncTablePair`        | Links source/destination DataFolder pairs for a sync                                                             |
| `SyncMatchKeys`        | Temporary table for matching records during sync execution                                                       |
| `SyncRemoteIdMapping`  | Persists source→destination record ID mappings                                                                   |
| `SyncForeignKeyRecord` | Caches referenced records for `lookup_field` transformers (keyed by `syncId`, `dataFolderId`, `foreignKeyValue`) |

## Sync Execution Flow

When `POST /workbooks/:workbookId/syncs/:syncId/run` is called:

### Phase 1: DATA

For each table mapping:

1. **Job Queued**: A background job is enqueued via BullMQ
2. **Clear Match Keys**: Previous match keys for this sync are deleted
3. **Fetch Records**: Files are read from both source and destination DataFolders
4. **Parse Records**: JSON files are parsed into `ConnectorRecord` objects
5. **Fill Caches**: Insert match column values into `SyncMatchKeys` for both sides, then create `SyncRemoteIdMapping` entries for all source records (with null destination for unmatched records) via a SQL LEFT JOIN
6. **Populate FK Record Cache**: For `lookup_field` transformers, fetch records from each referenced DataFolder and cache them in `SyncForeignKeyRecord`. Mappings are grouped by referenced folder to avoid duplicate fetches; all unique FK values across columns referencing the same folder are collected and stored once per `(dataFolderId, foreignKeyValue)` pair.
7. **Get Mappings**: Look up the source→destination ID mappings from `SyncRemoteIdMapping`
8. **Transform & Write**:
   - Column mappings are applied via `transformRecordAsync`, which supports optional transformers on each mapping (see [Transformers](#transformers) below). In this phase, `source_fk_to_dest_fk` passes through raw values while `lookup_field` resolves values from the FK record cache.
   - **New records**: A temporary ID is generated via `createScratchPendingPublishId()` and injected as the record's ID field. The filename is resolved using the destination schema's `slugColumnRemoteId` if available, falling back to the temp ID, and deduplicated against existing filenames. This temp ID allows subsequent syncs to match the record before it's published.
   - **Existing records**: Existing destination fields are merged with the transformed source fields (source takes precedence), preserving destination fields not covered by column mappings. Written to the existing file path.
   - Files are serialized as Prettier-formatted JSON.
9. **Commit**: All file changes are committed to the `DIRTY_BRANCH` via git

### Phase 2: FOREIGN_KEY_MAPPING

After all table mappings complete Phase 1, a second pass runs for any table mapping that has `source_fk_to_dest_fk` columns. This phase re-runs `syncTableMapping` with `phase = 'FOREIGN_KEY_MAPPING'`, which:

- Skips the FK record cache population (not needed)
- Runs `source_fk_to_dest_fk` transformers, which resolve source FK values to destination IDs via `SyncRemoteIdMapping`
- Skips `lookup_field` transformers (already resolved in Phase 1)

This two-phase approach is necessary because destination records must exist (created in Phase 1) before their IDs can be used to resolve foreign key references.

### Finalization

10. **Update lastSyncTime**: On success, the `Sync` record's `lastSyncTime` is updated

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

The `mappings` field uses the `SyncMapping` type directly — there is no conversion layer between the API payload and the stored format. Validation is performed using zod schemas in `sync-mapping.schema.ts`.

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

The `validateSchemaMapping()` function in [schema-validator.ts](schema-validator.ts) ensures mapped fields have compatible types:

- Traverses TypeBox JSON schemas using dot-notation paths
- Unwraps `Optional<T>` (union with null) to get base type
- Compares base types (string, number, boolean, object)
- Returns validation errors if types don't match

Validation always runs on create and update, but is skipped gracefully when either source or destination schema is absent (e.g., for scratch folders).

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

| File                                                                                    | Description                                                     |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [sync.service.ts](sync.service.ts)                                                      | Core sync logic                                                 |
| [sync.controller.ts](sync.controller.ts)                                                | REST API endpoints                                              |
| [schema-validator.ts](schema-validator.ts)                                              | Schema compatibility checking                                   |
| [sync-mapping.schema.ts](sync-mapping.schema.ts)                                        | Zod validation schemas for request bodies                       |
| [transformers/](transformers/)                                                          | Transformer registry, types, `LookupTools`, and implementations |
| [shared-types/.../sync-api.ts](../../../packages/shared-types/src/dto/sync/sync-api.ts) | API interface definitions                                       |
| [shared-types/.../sync-mapping.ts](../../../packages/shared-types/src/sync-mapping.ts)  | SyncMapping type definitions                                    |
