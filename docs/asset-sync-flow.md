# Asset Sync: Source to Destination

How an asset referenced by a source record ends up published in the destination connector.

## Steps

### 1. Pull — Extract & Index Source Assets

**When:** Pull job runs for the source DataFolder.

During pull, each fetched record is passed through the connector's `extractAssets()` method. This walks schema fields annotated with `x-scratch-asset-field` (or `x-scratch-asset-table` for standalone asset tables) and emits `AssetIndexEntry` objects containing the `remoteAssetId`, URL, filename, MIME type, dimensions, etc.

Entries are batch-upserted into the `Asset` table keyed by `(workbookId, dataFolderId, remoteAssetId)`. The `lastSeenAt` timestamp is updated on every pull so stale assets can be detected later.

**Key files:**

- `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts` (L391–418)
- `server/src/asset/asset-extractor.service.ts`
- `server/src/asset/asset-index.service.ts`

### 2. Rehost — Permanent Copy in GCS

**When:** User triggers "Pull Assets" (`POST /workbook/:id/pull-assets`).

Many connectors (Airtable, Notion) serve assets from expiring URLs. Rehosting downloads the file and uploads it to Google Cloud Storage under a stable key (`v1/{workbookId}/{service}/{hash(remoteAssetId)}/{filename}`), then writes the permanent `rehostedUrl` back to the Asset row.

Assets must be rehosted before they can be synced. If a source asset has no `rehostedUrl`, the sync transformer will fail with `ASSET_NOT_REHOSTED`.

**Key files:**

- `server/src/worker/jobs/job-definitions/rehost-assets.job.ts`
- `server/src/asset/asset-download.service.ts`
- `server/src/asset/object-storage.service.ts`

### 3. Sync — Map Source Asset to Destination Asset

**When:** Sync job transforms record fields from source to destination format.

The `SourceAssetToDestAsset` transformer runs in the `FOREIGN_KEY_MAPPING` phase. For each source asset remote ID in a field value it calls `getOrCreateDestinationAssetMapping()`, which:

1. Looks up the source `Asset` row by `(workbookId, sourceDataFolderId, service, remoteAssetId)`.
2. Verifies `rehostedUrl` is set (throws `ASSET_NOT_REHOSTED` otherwise).
3. Upserts a **destination** `Asset` row keyed by `(sourceAssetId, destinationDataFolderId)`. New rows get a temporary `PENDING_PUBLISH_*` remote ID and copy all metadata + `rehostedUrl` from the source.

The transformer writes an `@asset/{destinationAssetId}` pseudo-reference into the destination record content. If the destination asset already has a real remote ID (from a prior publish), the raw ID is used instead.

**Key files:**

- `server/src/sync/transformers/implementations/source-asset-to-dest-asset.transformer.ts`
- `server/src/sync/transformers/lookup-tools.ts`

### 4. Publish — Upload Assets to Destination Connector

**When:** Publish plan is built and executed.

#### 4a. Plan: Identify assets to upload

`findUnuploadedDestinationAssets()` queries for destination assets where `sourceAssetId IS NOT NULL`, `rehostedUrl IS NOT NULL`, and `uploadedAt IS NULL`. Each match becomes a publish plan operation in the `asset-upload` phase.

#### 4b. Execute: Upload to connector

For each `asset-upload` operation:

1. Download the file from `rehostedUrl`.
2. Call `connector.uploadFile(buffer, filename, mimeType)` → returns a `ConnectorAssetResult` with the connector-native `remoteAssetId` and URL.
3. Update the destination `Asset` row with the real `remoteAssetId`, `url`, and `uploadedAt`.

#### 4c. Resolve pseudo-references

During subsequent publish phases (edit, create), the `RefResolverService` replaces `@asset/{id}` pseudo-references in record content with the now-known real `remoteAssetId`. Unresolved refs are stripped by `RefCleanerService`.

**Key files:**

- `server/src/publish-plan/publish-plan-build.service.ts` (L334–356)
- `server/src/publish-plan/publish-plan-run.service.ts` (L191–213, L562–609)
- `server/src/publish-plan/ref-resolver.service.ts`
- `server/src/publish-plan/ref-cleaner.service.ts`

## Pipeline Diagram

```
Source Pull          Rehost            Sync Transform         Publish
──────────          ──────            ──────────────         ───────
                                                            4a. Plan upload ops
1. Extract assets   2. Download URL   3. Lookup source  ──► 4b. Upload to connector
   from records        Upload to GCS     Upsert dest        4c. Resolve @asset/ refs
   Index in DB         Save rehostedUrl  Write @asset/ ref     in record content
```

## Error Scenarios

| Error                | Cause                               | Resolution                                                    |
| -------------------- | ----------------------------------- | ------------------------------------------------------------- |
| `ASSET_NOT_FOUND`    | Source asset not in the Asset table | Re-pull the source DataFolder                                 |
| `ASSET_NOT_REHOSTED` | Source asset has no `rehostedUrl`   | Run "Pull Assets" on the source DataFolder                    |
| Upload failure       | Connector rejects the file          | Check connector-specific limits (size, format); retry publish |
