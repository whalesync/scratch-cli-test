# Asset System

How Scratch detects, indexes, re-hosts, syncs, and publishes file assets (images, PDFs, attachments) referenced by records in external services.

## Overview

Records in DataFolders can reference external file assets via connector-specific field types — Airtable attachments, Webflow images, Notion file properties, etc. The asset system provides:

1. **Detection** — Connectors declare which fields contain assets via schema annotations. During pull, assets are extracted from record content.
2. **Indexing** — Extracted assets are stored in the `Asset` database table, creating a queryable inventory per workbook.
3. **Re-hosting** — Assets are downloaded from their original URLs and uploaded to GCS for permanent hosting. This is critical for connectors with expiring URLs (Airtable, Notion).
4. **Syncing** — When syncing records between connectors, asset references are mapped from source to destination via the `SourceAssetToDestAsset` transformer.
5. **Publishing** — New or modified asset references are resolved and uploaded to the destination connector before records are published.

## Data Model

### Asset Table

The `Asset` model (`server/prisma/schema.prisma`) is the central record for every detected asset.

| Field              | Type      | Description                                                                                 |
| ------------------ | --------- | ------------------------------------------------------------------------------------------- |
| `id`               | String    | Primary key (cuid)                                                                          |
| `workbookId`       | String    | FK to Workbook (cascade delete)                                                             |
| `dataFolderId`     | String?   | FK to DataFolder (set null on delete)                                                       |
| `service`          | String    | Connector type: AIRTABLE, NOTION, WEBFLOW, etc.                                             |
| `remoteAssetId`    | String    | Stable ID from the connector (e.g. Airtable attachment `id`, URL hash)                      |
| `url`              | String?   | Current URL from the connector (may be expired)                                             |
| `filename`         | String?   | Original filename                                                                           |
| `mimeType`         | String?   | MIME type                                                                                   |
| `size`             | BigInt?   | File size in bytes                                                                          |
| `width` / `height` | Int?      | Image dimensions in pixels                                                                  |
| `altText`          | String?   | Alt text                                                                                    |
| `mediaType`        | String?   | Classification: `image`, `video`, `audio`, `document`, `file`, `external_video`, `model_3d` |
| `urlExpiresAt`     | DateTime? | When the URL expires (null = permanent)                                                     |
| `lastSeenAt`       | DateTime? | Updated each pull — assets not seen are stale/deleted upstream                              |
| `rehostedUrl`      | String?   | Permanent GCS URL after re-hosting                                                          |
| `rehostedAt`       | DateTime? | When re-hosting completed                                                                   |
| `uploadedAt`       | DateTime? | When uploaded to a destination connector (sync flow)                                        |
| `sourceAssetId`    | String?   | FK to source Asset (for assets created during sync)                                         |

**Unique constraints:**

- `(workbookId, dataFolderId, remoteAssetId)` — one row per asset per folder
- `(sourceAssetId, dataFolderId)` — one destination asset per source asset per folder

**Indexes:** `(workbookId, service)`, `(dataFolderId)`, `(urlExpiresAt)`, `(workbookId, lastSeenAt)`, `(sourceAssetId)`

### DataFolder.isAssetTable

Some connectors model assets as first-class records rather than embedded fields. For these, the DataFolder itself is flagged with `isAssetTable: true`. Examples: Webflow `__assets__` table, WordPress media library.

## Schema Annotations

Connectors declare asset fields in their JSON schemas using two annotations defined in `/packages/shared-types/src/connector/json-schema.ts`.

### `x-scratch-asset-field` (field-level)

Marks an individual field that contains one or more asset references (e.g. an Airtable `multipleAttachments` array, a Webflow `Image` field).

```typescript
interface AssetFieldOptions {
  idPath: string | null; // JSONPath to stable ID within each item (null = use URL hash)
  urlExpires: boolean; // Whether the asset URL expires
}
```

The annotation can appear on the field itself, on its `items` schema (for arrays), or inside `anyOf`/`oneOf` variants.

### `x-scratch-asset-table` (table-level)

Marks a table whose records ARE assets. The options specify dot-notation paths to extract metadata from each record.

```typescript
interface AssetTableOptions {
  urlPath: string; // Path to the asset URL
  filenamePath: string | null;
  mimeTypePath: string | null;
  sizePath: string | null;
  widthPath: string | null;
  heightPath: string | null;
  altTextPath: string | null;
  urlExpires: boolean;
}
```

## Detection & Extraction

### Connector Interface

The base `Connector` class (`server/src/remote-service/connectors/connector.ts`) defines:

```typescript
extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[]
```

The default implementation returns an empty array. Connectors that contain assets override this method.

**Connectors with asset extraction:**

| Connector | Strategy                                                 | Details                                                                                                           |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Airtable  | `extractFromAnnotatedSchema`                             | `multipleAttachments` fields; uses `id` as stable asset ID; URLs expire (~2hr)                                    |
| Notion    | Custom + `extractFromAnnotatedSchema`                    | `cover`, `icon` as top-level properties; `files` array properties; content block images/videos/audio; URLs expire |
| Webflow   | `extractStandaloneEntity` + `extractFromAnnotatedSchema` | `__assets__` table (standalone); Image/File/MultiImage fields; permanent URLs                                     |
| WordPress | `extractStandaloneEntity`                                | Media library table (standalone); permanent URLs                                                                  |
| Wix Blog  | Custom                                                   | `heroImage` and `richContent.nodes` IMAGE blocks; permanent URLs                                                  |

### Extraction Helpers

`server/src/remote-service/connectors/asset-extraction-helpers.ts` provides shared logic:

- **`extractStandaloneEntity(input)`** — Phase 0: For `x-scratch-asset-table` tables where the record itself is the asset. Uses `recordRemoteId` as the asset ID, falls back to URL hash.

- **`extractFromAnnotatedSchema(input, options)`** — Phase 1: Walks schema properties looking for `x-scratch-asset-field` annotations. Handles both array and scalar field values. Connectors provide callbacks for service-specific behavior:
  - `extractUrl(item)` — pull the URL from the item's shape
  - `resolveFieldValue(content, fieldName, schema)` — handle connector-specific field wrapping (e.g. Notion's property objects)
  - `extractMimeType(item)` — optional custom MIME extraction
  - `inferMediaType(item, fieldPath)` — optional custom media type inference
  - `inferExpiryDate(item)` — optional custom expiry date
  - `generateAssetId(url)` — optional custom ID generation

- **`hashUrl(url)`** — SHA-256 hash of the full URL (first 32 hex chars). Used as `remoteAssetId` for permanent URLs without a native ID.

- **`hashUrlPath(url)`** — SHA-256 hash of just the pathname (strips query params). Used for expiring URLs where query params contain tokens.

- **`inferMediaType(item, fieldPath)`** — Infers `MediaType` from MIME type, filename extension, or field name (e.g. `cover` → `image`).

- **`defaultResolveFieldValue(content, fieldName, schema)`** — Resolves field values through `fields`/`fieldData`/`properties` wrapper objects.

### AssetExtractorService

`server/src/asset/asset-extractor.service.ts` orchestrates extraction. It delegates to the connector's `extractAssets()`, then wraps results with workbook/folder context (`AssetIndexEntry`) and deduplicates by `remoteAssetId`.

## Indexing

### How Assets Are Indexed During Pull

During the pull job (`server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts`), each fetched record is passed through the asset extractor:

```
For each pulled record:
  1. Parse record content as JSON
  2. Call assetExtractorService.extractAssets(connector, { recordContent, schema, workbookId, service, dataFolderId })
  3. Collect all AssetIndexEntry results
  4. Batch upsert via assetIndexService.upsertBatch(entries)
```

### AssetIndexService

`server/src/asset/asset-index.service.ts` manages the `Asset` table:

- **`upsertBatch(entries)`** — Bulk insert/update in chunks of 500 per transaction. Uses the `(workbookId, dataFolderId, remoteAssetId)` unique constraint. On conflict, updates all metadata fields and sets `lastSeenAt` to now. Filters out entries without a `dataFolderId`.

- **`findStaleEntries(workbookId, dataFolderId, before, limit)`** — Finds assets with `lastSeenAt` before the given timestamp (or null). These assets were not seen in the most recent pull and may have been deleted upstream.

- **`removeBatch(ids)`** — Deletes specific asset records by ID.

- **`getAssetsForDataFolder(workbookId, dataFolderId)`** — Returns all assets in a folder.

- **`findUnuploadedDestinationAssets(workbookId, dataFolderIds)`** — Finds sync-created assets (`sourceAssetId != null`) that are rehosted but not yet uploaded to the destination connector (`uploadedAt == null`).

- **`deleteForWorkbook(workbookId)`** — Cleanup on workbook deletion.

## Re-hosting

Re-hosting downloads assets from their original (possibly expiring) URLs and uploads them to Google Cloud Storage for permanent access. This is essential for Airtable (~2hr URL expiry) and Notion (expiring signed URLs).

### Trigger

`POST /workbook/:id/pull-assets` with `{ dataFolderId }` enqueues a `rehost-assets` job.

### Rehost Job

`server/src/worker/jobs/job-definitions/rehost-assets.job.ts`:

1. Queries for assets in the folder with `rehostedUrl == null` and `url != null`.
2. Processes in batches of 5 with controlled concurrency.
3. Reports progress via checkpoints: total, succeeded, failed, failure details.
4. Sends a workbook event on completion.

### AssetDownloadService

`server/src/asset/asset-download.service.ts`:

- **`downloadAndRehost(asset)`** — Never throws; returns `RehostResult` with success/error info.
  1. Validates the URL.
  2. Resolves a safe filename (priority: `asset.filename` → URL path basename → `remoteAssetId` + guessed extension).
  3. Computes GCS key: `v1/{workbookId}/{service}/{sha256(remoteAssetId)}/{filename}`
  4. Downloads via axios (max 100 MB, 120s timeout).
  5. Uploads to GCS via `ObjectStorageService`.
  6. Updates the asset record: sets `rehostedUrl`, `rehostedAt`, clears `urlExpiresAt`.

- **`downloadAndRehostBatch(assets, options?)`** — Processes multiple assets with configurable concurrency (default 5). Logs summary counts.

### ObjectStorageService

`server/src/asset/object-storage.service.ts`:

- Uses Google Cloud Storage. Configured via `GCS_ASSET_BUCKET` and `GCS_PROJECT_ID` env vars.
- **`saveObject({ key, buffer, contentType, contentHash })`** — Uploads with cache headers: `public, max-age=31536000, immutable`. Returns public URL: `https://storage.googleapis.com/{bucket}/{key}`.
- **`objectExists(key)`** — Checks if an object already exists (for deduplication).
- If `GCS_ASSET_BUCKET` is not configured, logs a warning and disables rehosting.

## Syncing Assets Between Connectors

When a sync runs between two DataFolders, asset references in source records must be mapped to equivalent destination assets. This is handled by the `SourceAssetToDestAsset` transformer.

### SourceAssetToDestAsset Transformer

`server/src/sync/transformers/implementations/source-asset-to-dest-asset.transformer.ts`

Runs in the `FOREIGN_KEY_MAPPING` phase. Transforms source asset remote IDs into destination asset references.

**Options:**

- `sourceDataFolderId` — DataFolder ID for source asset lookup
- `destinationDataFolderId` — DataFolder ID for created destination assets
- `onUnresolved` — `'fail'` (default) stops the sync; `'ignore'` skips with a warning
- `outputType` — `'array'` (default) preserves arrays; `'single'` unwraps to first element

**Behavior:**

1. Normalizes input to an array of source asset remote IDs.
2. For each ID, calls `lookupTools.getOrCreateDestinationAssetMapping()`.
3. New or pending-publish destination assets get an `@asset/{assetId}` pseudo-reference. Existing assets use their raw `destinationAssetRemoteId`.
4. Compares resolved values against existing destination values — skips if unchanged.
5. Handles `ASSET_NOT_FOUND` and `ASSET_NOT_REHOSTED` errors with user-friendly messages.

### getOrCreateDestinationAssetMapping

`server/src/sync/transformers/lookup-tools.ts`

The core asset sync mechanism:

1. **Find source asset** by `(workbookId, dataFolderId, service, remoteAssetId)`.
2. **Verify rehosted** — source must have `rehostedUrl` set. Throws `ASSET_NOT_REHOSTED` if not.
3. **Upsert destination asset** using `(sourceAssetId, dataFolderId)` unique constraint:
   - If new: creates with a `PENDING_PUBLISH_*` temporary `remoteAssetId`, copies metadata and `rehostedUrl` from source.
   - If existing: no-op update (returns existing record).
4. Returns `{ destinationAssetId, destinationAssetRemoteId, isNew }`.

### Asset Pseudo-References

Similar to FK pseudo-refs (`@/folder/file.json`), asset pseudo-references use the format:

```
@asset/<assetId>
```

These are written into destination record content during sync and resolved to connector-native references at publish time.

## Publishing Assets

See `docs/asset-publishing-workflow-concept.md` for the original design. The pipeline is now implemented.

### How Asset References Get Modified

Asset references in record files change through three pathways:

1. **Sync** — Source asset IDs are transformed to destination `@asset/` pseudo-refs by the `SourceAssetToDestAsset` transformer.
2. **CLI** — Users edit record JSON directly on the dirty branch (no built-in asset upload flow yet).
3. **Scratch UI** — Drag-and-drop, asset browser, or metadata editing in the web app.

### Publish Pipeline

```
asset-upload → edit → create → delete → backfill → rename-files
```

#### Phase 0: asset-upload

The `asset-upload` phase runs first (only when the destination connector has `supportsFileUpload = true`):

1. `findUnuploadedDestinationAssets()` finds destination assets with `sourceAssetId != null`, `rehostedUrl != null`, `uploadedAt == null`. Each becomes an `asset-upload` plan operation.
2. For each operation, download the file from `rehostedUrl`.
3. Call `connector.uploadFile(buffer, filename, mimeType, metadata)` → `ConnectorAssetResult` with the connector-native `remoteAssetId` and URL.
4. Update the destination `Asset` row with the real `remoteAssetId`, `url`, and `uploadedAt`.

Asset uploads are processed one at a time (batch size 1) to respect connector rate limits.

#### Pseudo-reference resolution

During the edit/create phases, the `RefResolverService` replaces `@asset/{id}` pseudo-references in record content with the now-known real `remoteAssetId` from the Asset table. Any `@asset/` references that could not be resolved (e.g. upload failed) are stripped by `RefCleanerService`.

### Connector Upload Interface

```typescript
// Base Connector class
supportsFileUpload = false;

uploadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  metadata?: Record<string, unknown>,
): Promise<ConnectorAssetResult>;
```

### Connector-Specific Asset Formats

| Connector | Field Types                   | URL Expiry | Upload Support |
| --------- | ----------------------------- | ---------- | -------------- |
| Airtable  | `multipleAttachments` (array) | Yes (~2hr) | No             |
| Webflow   | Image, File, MultiImage       | No         | Yes            |
| Webflow   | `__assets__` table            | No         | Yes            |
| Notion    | files (array), cover, icon    | Yes        | No             |
| WordPress | media table                   | No         | Yes            |
| Wix Blog  | heroImage, richContent blocks | No         | No             |
| Shopify   | Files, ProductMedia           | No         | No (read-only) |

### Notion Content Blocks

Notion pages store assets in two locations:

- **Property-level** — `files`, `cover`, `icon` fields; handled by standard schema annotations.
- **Content blocks** — Images, videos, etc. embedded in `page_content`. Currently extracted during pull but not publishable (`page_content` is marked `x-scratch-readonly`). See `docs/asset-publishing-workflow-concept.md` for the proposed approach.

## API Endpoints

| Method | Path                                                     | Description                                                                            |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST` | `/workbook/:id/pull-assets`                              | Enqueue a rehost job for a data folder. Body: `{ dataFolderId }`. Returns `{ jobId }`. |
| `GET`  | `/publish-plan/assets-index?workbookId=X&dataFolderId=Y` | List all indexed assets for a workbook, optionally filtered by data folder.            |

## Client UI

### AssetIndexModal

`client/src/app/workbook/[id]/components/modals/AssetIndexModal.tsx`

A modal that displays all extracted assets for a data folder. Shows:

- Filename, MIME type, size, dimensions
- Original URL with expiry status (red badge if expired)
- Rehosted URL (teal badge if available)
- Last seen timestamp

## Key Files

| Component             | Path                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Prisma model          | `server/prisma/schema.prisma` (Asset model)                                              |
| Types                 | `server/src/asset/asset.types.ts`                                                        |
| Schema annotations    | `packages/shared-types/src/connector/json-schema.ts`                                     |
| Extraction helpers    | `server/src/remote-service/connectors/asset-extraction-helpers.ts`                       |
| Connector base        | `server/src/remote-service/connectors/connector.ts`                                      |
| Extractor service     | `server/src/asset/asset-extractor.service.ts`                                            |
| Index service         | `server/src/asset/asset-index.service.ts`                                                |
| Download service      | `server/src/asset/asset-download.service.ts`                                             |
| Object storage        | `server/src/asset/object-storage.service.ts`                                             |
| Rehost job            | `server/src/worker/jobs/job-definitions/rehost-assets.job.ts`                            |
| Pull job (extraction) | `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts`                 |
| Sync transformer      | `server/src/sync/transformers/implementations/source-asset-to-dest-asset.transformer.ts` |
| Sync lookup tools     | `server/src/sync/transformers/lookup-tools.ts`                                           |
| Ref resolver          | `server/src/publish-plan/ref-resolver.service.ts`                                        |
| Ref cleaner           | `server/src/publish-plan/ref-cleaner.service.ts`                                         |
| API (rehost)          | `server/src/workbook/workbook.controller.ts`                                             |
| API (index)           | `server/src/publish-plan/publish-plan.controller.ts`                                     |
| Client modal          | `client/src/app/workbook/[id]/components/modals/AssetIndexModal.tsx`                     |
| Publishing design     | `docs/asset-publishing-workflow-concept.md`                                              |
