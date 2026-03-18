# Asset Publishing Workflow

How asset references in records are managed through the publishing pipeline.

## Background

Records in DataFolders can reference external file assets (images, PDFs, attachments) via connector-specific field types. Each connector annotates these fields with `x-scratch-asset-field` or marks entire tables as assets via `x-scratch-asset-table`.

When a user modifies asset references in the workspace, those changes must be processed through the publishing pipeline so that:

1. New assets are uploaded to the connector before the referencing record is published.
2. Record content is updated to use connector-native asset references.
3. Orphaned assets are cleaned up.

This process is analogous to foreign key resolution, where pseudo-references (`@/folder/file.json`) are resolved to remote record IDs at publish time.

## How Asset References Get Modified

Asset references in record files can change through three main pathways. Each pathway produces the same result — modified JSON on the dirty branch — but the entry point and user experience differ.

### 1. Sync

When a sync runs between two connected DataFolders, asset references from the source records are written into destination records. This can introduce new asset URLs that the destination connector doesn't recognize. For example, syncing an Airtable table with attachment fields into Webflow means Airtable-hosted URLs (which expire) end up in Webflow image fields that expect permanent CDN URLs.

Key considerations:

- The sync transformer must detect asset fields and either rehost the source asset or flag it for upload to the destination connector.
- Assets from the source may already exist in the destination's Asset table if they were previously synced — deduplication via `remoteAssetId` prevents re-uploading.
- Expiring source URLs (Airtable, Notion) must be rehosted before the sync writes them, since they may expire before the next publish.

### 2. CLI Record Modifications

Users can modify record files directly through the Scratch CLI (`scratch-cli`). This includes editing JSON files on disk and committing changes to the dirty branch. A user might:

- Replace an image URL in a record's asset field with a new URL.
- Add or remove entries from an array-type asset field (e.g., Airtable attachments).
- Clear an asset field entirely by setting it to `null`.
- Update metadata like `alt` text or filenames without changing the asset itself.

Key considerations:

- The CLI has no built-in asset upload flow today — users would paste in raw URLs that may not be valid connector references.
- A CLI command like `scratch asset upload <file>` could handle uploading to rehosting storage and returning an `@asset/` pseudo-reference for the user to place in the record.
- Validation at publish time must catch invalid asset references (URLs the connector can't resolve) and surface clear errors.

### 3. Scratch UI Asset Management

The Scratch web UI can provide purpose-built tools for managing assets on records. This is the most controlled pathway and offers the best opportunity for a seamless experience:

- **Drag-and-drop / file picker** — User attaches a file to a record's asset field. The UI uploads the file to rehosting storage (GCS), creates an Asset record with a `PENDING_PUBLISH_*` ID, and writes an `@asset/PENDING_PUBLISH_xxx` pseudo-reference into the record on the dirty branch.
- **Asset browser** — User selects an existing asset from the workbook's asset library (previously pulled or uploaded assets). The UI writes the selected asset's reference into the record.
- **Remove / reorder** — User removes an asset from a field or reorders items in a multi-asset field. The UI updates the record JSON on the dirty branch.
- **Metadata editing** — User edits `alt` text, filenames, or other metadata directly in the asset field UI without replacing the underlying file.

Key considerations:

- Eager upload (on attach) vs lazy upload (at publish) affects whether orphan assets accumulate when users abandon changes.
- The UI should show asset thumbnails and status (pending upload, uploaded, expired URL) so users understand what will happen at publish time.
- For asset-table connectors (WordPress media, Webflow `__assets__`), the UI could present the asset table as a dedicated library view rather than just inline field editing.

## Asset Mutation Types

| #   | Mutation                   | Example                                           | Requires Upload? |
| --- | -------------------------- | ------------------------------------------------- | ---------------- |
| 1   | Replace asset URL          | Swap an image for a different one                 | Yes              |
| 2   | Add asset to array field   | Add attachment to Airtable `multipleAttachments`  | Yes              |
| 3   | Remove asset from field    | Delete one image from a Webflow multi-image field | No               |
| 4   | Clear entire field         | Set an image field to `null`                      | No               |
| 5   | Modify asset metadata only | Change `alt` text on a Webflow image, rename file | No               |

For **asset-table** connectors (WordPress media, Webflow `__assets__`), records themselves ARE assets, so record create/edit/delete maps directly to asset CRUD.

## FK Resolution Parallel

| FK Resolution                                      | Asset Resolution                                           |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Pseudo-ref `@/folder/file.json` → remote record ID | Local/new asset reference → remote asset ID + URL          |
| Target record must exist before referencing record | Asset must be uploaded before referencing record publishes |
| `RefResolverService` resolves batch                | New `AssetResolverService` resolves batch                  |
| `FileIndex` maps filenames → remote IDs            | `Asset` table maps `remoteAssetId` → URLs                  |

## Proposed Publishing Phase Order

```
Current:     edit → create → delete → backfill → rename-files

Proposed:    upload-assets → edit → create → delete → backfill → rename-files
             ↑ NEW PHASE
```

The `upload-assets` phase runs first so that all new assets have connector-native IDs/URLs before any record creates or edits reference them.

## Detailed Flow

### 1. Diff Detection (`PublishPlanBuildService`)

When building the publish plan, for each changed record:

- Walk the schema for `x-scratch-asset-field` annotations (reuse `AssetExtractorService.extractAssets` logic).
- Compare dirty vs main branch asset references.
- Classify each asset change:
  - **New asset** — URL not in Asset table for this workbook+service, or references a local/rehosted URL.
  - **Removed asset** — reference present in main but absent in dirty.
  - **Unchanged asset** — same `remoteAssetId` in both versions.
  - **Metadata-only change** — same asset URL, different `alt`/`filename`.

New assets produce `PublishPlanOperation` entries with phase `upload-asset`.

### 2. Upload-Assets Phase (runs first)

```
For each new/replaced asset reference:
  1. Resolve source → buffer (download from rehostedUrl or original URL)
  2. Call connector.uploadFile(buffer, filename, mimeType, metadata)
  3. Receive ConnectorAssetResult { remoteId, url, ... }
  4. Upsert into Asset table with new remoteAssetId + url
  5. Build resolution map: localAssetRef → { remoteAssetId, connectorUrl }
```

### 3. Asset Reference Resolution (in edit/create phases)

An asset resolution step runs alongside `resolveBatchPseudoRefs`:

```typescript
// In processBatch for edit/create phases:
const contentWithResolvedFKs = await refResolver.resolveBatchPseudoRefs(...);
const contentWithResolvedAssets = await assetResolver.resolveAssetRefs(
  contentWithResolvedFKs,
  schema,     // to find x-scratch-asset-field paths
  assetMap,   // from upload phase: oldRef → newConnectorRef
);
```

The resolver walks `x-scratch-asset-field` paths and replaces local/placeholder references with the connector-native format:

- **Airtable**: `[{ url: "https://uploaded-url", filename: "photo.jpg" }]`
- **Webflow**: `{ url: "https://webflow-cdn/...", alt: "..." }`
- **Notion**: `{ type: "external", external: { url: "https://..." } }`

### 4. Orphan Asset Cleanup (post-publish)

After records that removed asset references are published:

```
For each removed asset reference:
  1. Check if any other record still references this asset
  2. If orphaned:
     a. For asset-table connectors: optionally delete remote asset
     b. Mark Asset record as stale or delete from Asset table
     c. Clean up rehosted GCS object if exists
```

This runs as a background job rather than blocking the publish.

## Asset Pseudo-Reference Format

Similar to FK pseudo-refs (`@/folder/file.json`), asset pseudo-references use:

```
@asset/<remoteAssetId>
```

When a user attaches a new file in the workspace UI:

1. File uploads to rehosting storage (GCS) immediately.
2. An Asset record is created with a `PENDING_PUBLISH_*` style `remoteAssetId`.
3. The record's asset field stores `@asset/PENDING_PUBLISH_xxx`.
4. At publish time, the upload-assets phase replaces this with the real connector reference.

## Connector Interface

The `uploadFile` method already exists as optional on the base `Connector`:

```typescript
uploadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  metadata?: Record<string, unknown>,
): Promise<ConnectorAssetResult>;
```

Each connector implements this for asset publishing. Connectors that don't support file upload (e.g., read-only Shopify) skip the upload phase and only allow metadata edits.

## Notion Page Content Blocks

Notion pages store assets in two distinct locations, each requiring different handling:

1. **Property-level assets** — `files`, `cover`, `icon` fields in `properties`. These are schema-annotated with `x-scratch-asset-field` and follow the standard asset resolution flow described above.

2. **Content block assets** — Images, videos, audio, files, and PDFs embedded in `page_content` (the block tree that forms the page body). These are **not** covered by schema-level asset annotations.

### Current State

- During **pull**, the `AssetExtractorService` walks `page_content` blocks in Phase 2 (content block extraction), identifying media blocks by type (`image`, `video`, `audio`, `file`, `pdf`) and extracting their URLs into the Asset table.
- During **publish**, `page_content` is marked `x-scratch-readonly: true` in the Notion schema. The `createRecords` and `updateRecords` methods only send `properties` to the Notion API — they do not touch page content. An `updatePageContent` method exists on the Notion connector (it diffs existing blocks against new blocks and executes operations), but it is **not wired into the publishing pipeline**.
- This means content block asset changes are currently not publishable.

### Challenges

Content block assets differ from property-level assets in several ways that affect the publishing workflow:

**No schema path.** Property-level assets have a known JSON path (e.g., `properties.Hero Image`) annotated with `x-scratch-asset-field`. Content block assets are at arbitrary positions in a variable-depth block tree. The asset resolver cannot use schema paths to locate them — it must walk the full `page_content` tree.

**Notion-hosted vs external URLs.** Each content block has a `type` field — either `file` (Notion-hosted, expiring URL) or `external` (permanent external URL). When a user replaces a block's image:

- If the new asset is uploaded to Notion via the API, Notion returns a `file`-type block with a hosted URL.
- If the user provides an external URL, it becomes an `external`-type block.
- The asset resolver needs to know which type to produce based on how the asset was sourced.

**Block identity and diffing.** The existing `updatePageContent` uses `createNotionBlockDiff` to compute add/remove/update operations on the block tree. Asset resolution must happen **before** this diff runs, so the new block tree contains resolved connector URLs rather than pseudo-references. The sequence would be:

```
1. Resolve asset pseudo-refs in page_content blocks
2. Diff resolved content against existing remote blocks
3. Execute block operations (append, update, delete)
```

**Nested blocks.** Notion blocks can nest recursively (e.g., a toggle containing an image). The asset walker must handle arbitrary depth, matching the pull-side extraction in `extractFromNotionBlock`.

### Proposed Approach

To support content block asset publishing for Notion:

1. **Extend asset extraction to produce block-level paths.** When extracting assets from `page_content`, record the block index path (e.g., `page_content[3]` or `page_content[2].children[1]`) alongside the `remoteAssetId`. This enables targeted resolution without re-walking the entire tree.

2. **Add a content block asset resolution step.** Before calling `updatePageContent`, walk `page_content` and resolve any `@asset/` pseudo-references in media blocks. Replace the block's URL with the connector-native URL from the Asset table or the upload-assets phase result.

3. **Wire `updatePageContent` into the publish pipeline.** The edit/create phases in `PublishPlanRunService` need to detect when `page_content` has changed and call `updatePageContent` after the property-level update completes. This requires removing the `x-scratch-readonly` flag from `page_content` (or treating it as writable specifically for asset resolution).

4. **Handle the Notion file upload API.** Notion's API does not support uploading files directly into blocks — external URLs are the only option for user-provided assets. This means:
   - New assets must be rehosted to a permanent URL (GCS) first.
   - The content block is written as `{ type: "external", external: { url: "<rehosted-url>" } }`.
   - Notion-hosted assets (pulled from Notion originally) retain their `file` type and URL — they don't need re-uploading to Notion.

### Wix Blog Rich Content

A similar pattern applies to Wix Blog's `richContent.nodes` array. IMAGE nodes contain `imageData.src` which is a Wix CDN URL. The same walk-and-resolve approach works, with the resolver replacing pseudo-references in image nodes before the record is published.

## Connector-Specific Asset Formats

| Connector | Field Types                   | URL Expiry | Upload Support |
| --------- | ----------------------------- | ---------- | -------------- |
| Airtable  | `multipleAttachments` (array) | Yes (2-4h) | Yes            |
| Webflow   | Image, File, MultiImage       | No         | Yes            |
| Webflow   | `__assets__` table            | No         | Yes            |
| Notion    | files (array), cover, icon    | Yes        | Yes            |
| WordPress | media table                   | No         | Yes            |
| Wix Blog  | heroImage, richContent blocks | No         | TBD            |
| Shopify   | Files, ProductMedia           | No         | No (read-only) |

## Open Design Decisions

1. **Eager vs lazy upload** — Upload assets when the user attaches them in the UI (eager) vs only at publish time (lazy). Eager gives faster feedback but creates orphans if changes are abandoned.

2. **Asset deduplication** — If the same file is attached to two records, upload once or twice? The unique constraint `(workbookId, service, remoteAssetId)` supports dedup.

3. **Asset-table connectors** — For WordPress media / Webflow assets, should new assets be created as records in the asset DataFolder, or handled separately? The `isAssetTable` flag already distinguishes these.

4. **Orphan cleanup strategy** — Aggressive (delete immediately after last reference removed) vs conservative (mark stale, clean up in background). Conservative is safer.

5. **Schema annotation extension** — Whether a new annotation like `x-scratch-asset-upload-target` is needed to specify which connector endpoint handles uploads, or if the existing `uploadFile` on the connector is sufficient.
