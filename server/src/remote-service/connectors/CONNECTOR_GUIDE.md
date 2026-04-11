# Connector Development Guide

A guide for building new connectors in Scratch (Spinner). Intended for internal team members and AI agents.

## 1. Core Philosophy

### Store Raw API Responses

Save exactly what the API returns — no transformation. The system stores records as JSON files in git, so preserving the original structure ensures round-trip fidelity and simplifies debugging.

**Exceptions:**

- **Strip pagination metadata** — cursors, `hasMore` flags, page counts. These are transport artifacts, not data.
- **Hydrate nested structures in-place** — when the API returns stub references (e.g., Notion block children, Shopify product variants), fetch the full objects and embed them directly in the record.

### Prefer Dynamic Discovery

Introspect schemas from API metadata endpoints rather than hardcoding field definitions. This means new fields added by the service appear automatically without connector code changes.

For example, Airtable's `fetchJsonTableSpec` reads the base schema API, and PostgreSQL's queries `information_schema.columns`. Only hardcode schemas when the API provides no introspection (e.g., WordPress post types).

## 2. Architecture Overview

### How Connectors Fit

```
ConnectorsService.getConnector()
  → instantiates Connector<T> with credentials
  → called by pull/publish worker jobs
  → records stored as JSON files in git
```

The `ConnectorsService` (`connectors.service.ts`) uses the connector registry to look up connector factories by service key. It validates credentials, handles OAuth token refresh, and returns a ready-to-use connector instance.

### Pull Flow

1. **Pull job** (`worker/jobs/job-definitions/pull-linked-folder-files.job.ts`) creates a connector
2. Calls `connector.pullRecordFiles(tableSpec, callback, connectorProgress, options)`
3. Connector paginates through the remote API, calling `callback` with each batch of records and a `connectorProgress` cursor
4. Callback converts records to git files, commits them to the main branch, and checkpoints progress (including `connectorProgress`) to Redis
5. After all pages: files present in main but not pulled are deleted (removals — skipped on resumed runs)
6. If the job stalls and restarts, completed folders are skipped and the active folder resumes from the last checkpointed `connectorProgress` cursor

### Publish Flow

1. **Publish job** (`worker/jobs/job-definitions/publish-data-folder.job.ts`) diffs the dirty branch against main
2. `DataFolderPublishingService.publishAll()` categorizes files into creates/updates/deletes
3. Files are batched per `connector.getBatchSize()` and sent to `createRecords`/`updateRecords`/`deleteRecords`
4. After publishes, a pull job syncs the remote state back to main

## 3. The Connector Abstract Class

**File:** `connector.ts`

```typescript
export abstract class Connector<
  T extends string = string,
  TConnectorProgress extends JsonSafeObject = JsonSafeObject,
>
```

### Type Parameters

| Parameter            | Purpose                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `T extends string`   | A service identifier string (e.g., `'AIRTABLE'`). The `Service` type is just `string` — convenience constants are in `service-constants.ts`.    |
| `TConnectorProgress` | Connector-specific progress state for resumable pulls. Defaults to `JsonSafeObject`. Example: `{ nextCursor: string \| undefined }` for Notion. |

### Required Abstract Members

| Member                                                    | Signature                                                                                                                                                                                                                                     | Purpose                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `service`                                                 | `abstract readonly service: T`                                                                                                                                                                                                                | The service identifier string                                                                                         |
| `displayName`                                             | `static readonly displayName: string`                                                                                                                                                                                                         | Human-readable name (e.g., `'Airtable'`)                                                                              |
| `metadata`                                                | `static readonly metadata: ConnectorMetadata`                                                                                                                                                                                                 | Connector metadata (display name, terminology, logo, visibility, OAuth labels). Use the `connectorMetadata()` helper. |
| `testConnection()`                                        | `abstract testConnection(): Promise<void>`                                                                                                                                                                                                    | Validate credentials. Throw on failure, resolve silently on success.                                                  |
| `listTables()`                                            | `abstract listTables(): Promise<TablePreview[]>`                                                                                                                                                                                              | Return all available tables/collections                                                                               |
| `fetchJsonTableSpec(id)`                                  | `abstract fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec>`                                                                                                                                                                       | Build the full JSON schema for a table                                                                                |
| `pullRecordFiles(tableSpec, callback, progress, options)` | `abstract pullRecordFiles(tableSpec: BaseJsonTableSpec, callback: (params: { files: ConnectorFile[]; connectorProgress?: TConnectorProgress }) => Promise<void>, progress: TConnectorProgress, options: ConnectorPullOptions): Promise<void>` | Stream all records via batched callbacks                                                                              |
| `pullRecordFilesByIds(tableSpec, ids, callback)`          | `abstract pullRecordFilesByIds(tableSpec: BaseJsonTableSpec, ids: string[], callback: (params: { files: ConnectorFile[] }) => Promise<void>): Promise<void>`                                                                                  | Fetch specific records by ID (bulk where supported, silently skip 404s)                                               |
| `getBatchSize(operation)`                                 | `abstract getBatchSize(operation: 'create' \| 'update' \| 'delete'): number`                                                                                                                                                                  | Max batch size per CRUD operation (must be > 0)                                                                       |
| `createRecords(tableSpec, files)`                         | `abstract createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]>`                                                                                                                                      | Create records, return files with remote IDs assigned                                                                 |
| `updateRecords(tableSpec, files, changedFields?)`         | `abstract updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[], changedFields?: (Record<string, unknown> \| undefined)[]): Promise<void>`                                                                                       | Update existing records (see [Partial Field Updates](#partial-field-updates-changedfields))                           |
| `deleteRecords(tableSpec, files)`                         | `abstract deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void>`                                                                                                                                                 | Delete records                                                                                                        |
| `getSuggestedRecordFileNames(records, tableSpec)`         | `abstract getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string \| undefined)[]`                                                                                                                       | Suggest human-friendly filenames for pulled records (without extension). Return `undefined` per record to use its ID. |
| `extractConnectorErrorDetails(error)`                     | `abstract extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails`                                                                                                                                                                | Translate service errors to user-friendly messages                                                                    |

### Optional Methods & Properties

| Member                                              | Purpose                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getNewFile(tableSpec)`                             | Return a default template for new records. Default: `{}`. Override to pre-populate fields (e.g., Webflow sets `isDraft: true`).                                                                                  |
| `validateFiles?(tableSpec, files)`                  | Optional pre-publish validation. Return validation results with `publishable` boolean and optional `errors`, or `undefined` if unsupported.                                                                      |
| `tableDiscoveryMode`                                | Getter returning `TableDiscoveryMode.LIST` (default) or `TableDiscoveryMode.SEARCH`. Use SEARCH for slow list APIs (e.g. Notion).                                                                                |
| `searchTables(searchTerm)`                          | Search tables by name. Required when `tableDiscoveryMode` is `SEARCH`. Returns `{ tables: TablePreview[]; hasMore: boolean }`.                                                                                   |
| `supportsFilters()`                                 | Whether the connector supports filter expressions for pulling records. Default: `false`.                                                                                                                         |
| `supportsFieldSelection()`                          | Whether the connector supports field/column selection when adding tables. Default: `false`.                                                                                                                      |
| `supportsFileUpload`                                | Property indicating whether the connector supports `uploadFile()`. Default: `false`.                                                                                                                             |
| `uploadFile(buffer, filename, mimeType, metadata?)` | Upload a file to the remote service and return asset metadata. Default: throws. Override alongside `supportsFileUpload = true`.                                                                                  |
| `extractAssets(input)`                              | Extract asset metadata from a record's content and schema. Default: `[]`. Override for connectors with asset fields. See [Asset Extraction](#asset-extraction).                                                  |
| `fallbackErrorDetails(error)`                       | Protected helper that returns a `ConnectorErrorDetails` including the actual error message. Use as the final fallback in `extractConnectorErrorDetails()` (see [Error Handling](#extractconnectorerrordetails)). |

### Key Types

```typescript
// An identifier with both a Scratch-internal ID and a remote API path
type EntityId = {
  wsId: string; // Human-readable, valid in postgres
  remoteId: string[]; // Path components in the remote service
};

// A table available for selection
type TablePreview = {
  id: EntityId;
  displayName: string;
  parentPath?: string; // Slash-separated grouping path (e.g. "My Base" or "Project/schema")
  disabled?: true; // Table cannot be selected
  disabledCreates?: true; // Creates not supported
  disabledReason?: string; // Human-readable explanation for disabled state
  metadata?: Record<string, unknown>; // Connector-specific metadata
};

// Full schema for a table
type BaseJsonTableSpec = {
  id: EntityId;
  slug: string;
  name: string;
  schema: TSchema; // TypeBox JSON Schema
  idColumnRemoteId: string; // Field used as record ID
  titleColumnRemoteId?: EntityId['remoteId'];
  mainContentColumnRemoteId?: EntityId['remoteId'];
  slugFieldPath?: string; // Lodash dot-path for filename slug (e.g. 'fieldData.slug')
  basePath?: string[]; // Root path grouping (e.g. site name, base name)
  generatedAt?: string; // ISO 8601 timestamp of schema generation
};

// A record — just a plain JSON object
type ConnectorFile = Record<string, unknown>;

// Standardized error output
type ConnectorErrorDetails = {
  userFriendlyMessage: string;
  description?: string;
  additionalContext?: Record<string, unknown>;
};
```

### AuthParser (Optional)

If the connector requires pre-processing of user-provided credentials (e.g., WordPress discovers the REST API endpoint from a site URL), implement an `AuthParser`:

```typescript
export abstract class AuthParser<T extends string = string> {
  abstract readonly service: T;
  abstract parseUserProvidedParams(params: { userProvidedParams: Record<string, string | undefined> }): Promise<{
    credentials: Record<string, string>;
    extras: Record<string, string>;
  }>;
}
```

Register it via `createAuthParser` in your `connectorRegistry.register()` call.

## 4. Implementing Each Method

### `testConnection()`

Make a lightweight API call to validate credentials. No side effects — don't create or modify anything.

```typescript
// Airtable: list bases (lightweight call)
async testConnection(): Promise<void> {
  await this.client.listBases();
}

// Notion: search with minimal results
async testConnection(): Promise<void> {
  await this.client.search({
    filter: { property: 'object', value: 'database' },
    page_size: 1,
  });
}

// PostgreSQL: run a simple query
async testConnection(): Promise<void> {
  await this.pool.query('SELECT 1');
}
```

### `listTables()`

Return `TablePreview[]` where each entry has an `EntityId`. The `wsId` should be human-readable and stable; `remoteId` is the path the connector needs to locate the table.

#### `parentPath` — Table Grouping

Set `parentPath` on each `TablePreview` to control how tables are grouped in the UI. The client splits on `/` to create a group/subgroup hierarchy. If `parentPath` is omitted, tables render as a flat list.

```typescript
// Airtable: group by base name
return tables.map((table) => ({
  id: { wsId: sanitizeForTableWsId(table.id), remoteId: [baseId, table.id] },
  displayName: table.name,
  parentPath: base.name, // → group header: "My Base"
}));

// Supabase: group by project and schema
return tables.map((t) => ({
  id: { wsId: sanitizeForTableWsId(...), remoteId: [projectRef, schema, tableName] },
  displayName: t.table_name,
  parentPath: `${projectName}/${t.table_schema}`, // → "My Project" > "public"
}));

// Shopify: flat list (no grouping)
return Object.entries(ENTITY_CONFIG).map(([entityType, config]) => ({
  id: { wsId: entityType, remoteId: [entityType] },
  displayName: config.displayName,
  // no parentPath → flat list
}));
```

#### `disabledReason` — Explaining Disabled Tables

When setting `disabled: true` or `disabledCreates: true`, also set `disabledReason` with a human-readable explanation. The client shows this as a tooltip.

```typescript
return {
  id: { ... },
  displayName: tableName,
  disabled: true,
  disabledReason: "This table doesn't have a unique value column (primary key).",
};
```

Use `sanitizeForTableWsId()` from `ids.ts` to ensure the `wsId` is safe for postgres and file paths.

### `fetchJsonTableSpec()`

Build a `BaseJsonTableSpec` with a TypeBox JSON Schema describing every field. Prefer dynamic discovery — fetch the schema from the API rather than hardcoding it.

Key considerations:

- Set `idColumnRemoteId` to the field that uniquely identifies records (e.g., `'id'`, `'recordId'`)
- Optionally set `titleColumnRemoteId` (display name), `mainContentColumnRemoteId` (markdown body), `slugFieldPath` (lodash dot-path for filename slug, e.g. `'fieldData.slug'`)
- Annotate fields with `x-scratch-*` extensions (see [Section 5](#5-json-schema-extensions))

### `pullRecordFiles()`

Stream records by calling the `callback` with batches. Three common pagination patterns:

#### Cursor-Based (Notion)

```typescript
async pullRecordFiles(
  tableSpec: BaseJsonTableSpec,
  callback: (params: { files: ConnectorFile[]; connectorProgress?: NotionDownloadProgress }) => Promise<void>,
  progress: NotionDownloadProgress,
  options: ConnectorPullOptions,
): Promise<void> {
  let cursor: string | undefined = progress.nextCursor;
  do {
    const response = await this.client.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    cursor = response.has_more ? response.next_cursor : undefined;

    const files = response.results.map((page) => this.pageToFile(page));
    await callback({ files, connectorProgress: { nextCursor: cursor } });
  } while (cursor);
}
```

#### Offset-Based (WordPress)

```typescript
async pullRecordFiles(
  tableSpec: BaseJsonTableSpec,
  callback: (params: { files: ConnectorFile[]; connectorProgress?: WordPressDownloadProgress }) => Promise<void>,
  progress: WordPressDownloadProgress,
  options: ConnectorPullOptions,
): Promise<void> {
  let offset = progress.nextOffset ?? 0;
  let hasMore = true;
  while (hasMore) {
    const records = await this.client.listRecords(tableId, { offset, limit: PAGE_SIZE });
    hasMore = records.length === PAGE_SIZE;
    offset += records.length;

    await callback({ files: records, connectorProgress: { nextOffset: offset } });
  }
}
```

#### Async Iterator (Stripe)

```typescript
async pullRecordFiles(
  tableSpec: BaseJsonTableSpec,
  callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
  progress: JsonSafeObject,
  options: ConnectorPullOptions,
): Promise<void> {
  const resumeAfter = (progress as { startingAfter?: string })?.startingAfter;

  for await (const entities of this.client.listEntities(entityType, 100, resumeAfter)) {
    const lastId = (entities[entities.length - 1] as Record<string, unknown>)?.id as string;
    await callback({
      files: entities as unknown as ConnectorFile[],
      connectorProgress: lastId ? { startingAfter: lastId } : {},
    });
  }
}
```

The async iterator pattern wraps pagination internally in the API client. The generator must accept an optional starting cursor so the connector can resume after a stall. The connector reads the cursor from `progress`, passes it to the generator, and writes the latest cursor to `connectorProgress` in each callback.

**Important:** All connectors must persist pagination state via `connectorProgress`. When a BullMQ job stalls and restarts, the saved `connectorProgress` is passed back to `pullRecordFiles` as the `progress` parameter. If your connector doesn't write `connectorProgress`, it will re-fetch from page 1 on every restart.

### Hydration

When the API returns lightweight list results but you need full detail, use the **light list + heavy hydrate** pattern:

```typescript
// Notion: list pages, then hydrate each with block children
const pages = await this.client.databases.query({ database_id: dbId });
for (const page of pages.results) {
  const blocks = await this.fetchBlockChildren(page.id); // recursive
  page.page_content = blocks; // embed in-place
}
```

```typescript
// Shopify: list products, then hydrate variants/images via GraphQL
for (const product of products) {
  product.variants = await this.client.getProductVariants(product.id);
  product.images = await this.client.getProductImages(product.id);
}
```

Hydrate before passing to the callback — the stored file should contain the complete record.

### `pullRecordFilesByIds()`

Fetch specific records by their IDs. Used for targeted re-pulls (e.g., after a publish). Use bulk API endpoints where available, falling back to individual fetches otherwise. Silently skip records that return 404 (already deleted).

```typescript
async pullRecordFilesByIds(
  tableSpec: BaseJsonTableSpec,
  ids: string[],
  callback: (params: { files: ConnectorFile[] }) => Promise<void>,
): Promise<void> {
  // Bulk fetch where possible, skip 404s
  const files: ConnectorFile[] = [];
  for (const id of ids) {
    try {
      const record = await this.client.getRecord(tableSpec.id.remoteId, id);
      files.push(this.recordToFile(record));
    } catch (error) {
      if (error.status === 404) continue;
      throw error;
    }
  }
  if (files.length > 0) {
    await callback({ files });
  }
}
```

### `getSuggestedRecordFileNames()`

Return human-friendly filenames for pulled records (without extension). The array must be parallel to `records` — return `undefined` for entries that should fall back to the record's ID. These suggestions are only used for initial file naming; once set, filenames don't change.

Use the `suggestFileNamesFromFieldPaths()` helper for connectors with simple record structures:

```typescript
import { suggestFileNamesFromFieldPaths } from '../connector';

getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
  return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, 'name', 'title');
}
```

The helper tries each lodash dot-path in order and returns the first non-empty string. Connectors with complex record structures (e.g., Notion rich text titles) should implement this method directly.

### `createRecords()` / `updateRecords()` / `deleteRecords()`

Implement batch CRUD operations. Key patterns:

> **Do NOT silently strip read-only fields.** Some existing connectors (Airtable, Notion, Shopify) filter out read-only fields before sending to the API. This is **incorrect behavior** that should be removed — if a user edits a read-only field, the API should return an error so the user understands what happened. Silently dropping edits and reporting success is confusing. New connectors should send the user's data as-is and let the API reject invalid writes.

> **Field-level diffs are now available.** `updateRecords` receives an optional `changedFields` parameter — a parallel array where each entry is a deep sparse object containing only the fields that changed, with properly transformed values. Connectors can use this directly as a partial payload. See [Partial Field Updates](#partial-field-updates-changedfields) in Section 7.

**Return files with assigned remote IDs from `createRecords()`:**

The returned `ConnectorFile[]` must include the remote ID assigned by the service, so Scratch can track the record going forward.

```typescript
// Moco: create each entity and return the API response (which includes the new ID)
async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
  const entityType = tableSpec.id.wsId as MocoEntityType;
  const results: ConnectorFile[] = [];

  for (const file of files) {
    const createData = this.transformToCreateRequest(entityType, file);
    const created = await this.client.createEntity(entityType, createData);
    results.push(created as unknown as ConnectorFile);
  }

  return results;
}
```

**Handle already-deleted records gracefully in `deleteRecords()`:**

```typescript
// Webflow: ignore 404s during delete
try {
  await this.client.collections.items.deleteItems(collectionId, { itemIds });
} catch (error) {
  if (error.statusCode !== 404) throw error;
}
```

### `getBatchSize()`

Return the maximum number of records per API call for each operation. Respect the service's rate limits and batch API constraints.

```typescript
// Airtable: 10 for all operations (API limit)
getBatchSize(): number { return 10; }

// Webflow: 100 for all operations (bulk API)
getBatchSize(): number { return 100; }

// Notion: 1 for all operations (no batch API)
getBatchSize(): number { return 1; }

// Shopify: different per operation
getBatchSize(operation: 'create' | 'update' | 'delete'): number {
  return operation === 'delete' ? 1 : 10;
}
```

### `extractConnectorErrorDetails()`

Translate service-specific errors into `ConnectorErrorDetails` with a user-friendly message. Use `ErrorMessageTemplates` for consistency.

```typescript
extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
  // Use the shared Axios helper for HTTP-based APIs
  const common = extractCommonDetailsFromAxiosError(this, error);
  if (common) return common;

  // Handle service-specific error codes
  if (error instanceof APIResponseError) {
    switch (error.code) {
      case 'unauthorized':
        return { userFriendlyMessage: ErrorMessageTemplates.API_UNAUTHORIZED('Notion') };
      case 'rate_limited':
        return { userFriendlyMessage: ErrorMessageTemplates.API_QUOTA_EXCEEDED('Notion') };
    }
  }

  return this.fallbackErrorDetails(error);
}
```

Available templates in `error.ts`:

- `ErrorMessageTemplates.API_UNAUTHORIZED(serviceName)` — invalid credentials
- `ErrorMessageTemplates.API_QUOTA_EXCEEDED(serviceName)` — rate limited
- `ErrorMessageTemplates.API_TIMEOUT(serviceName)` — request timeout
- `ErrorMessageTemplates.RESPONSE_TOO_LARGE(serviceName)` — response too large
- `ErrorMessageTemplates.UNKNOWN_ERROR(serviceName)` — catch-all

For Axios-based connectors, `extractCommonDetailsFromAxiosError(connector, error)` handles 401/403, 408/504, and timeout errors automatically. Use `extractErrorMessageFromAxiosError(service, error)` to pull error messages from response bodies.

## 5. JSON Schema Extensions

Custom `x-scratch-*` properties annotate fields in the TypeBox schema. Defined in `json-schema.ts`:

### `x-scratch-readonly`

Mark fields that should not be sent on create/update (computed fields, system timestamps, etc.).

```typescript
import { READONLY_FLAG } from '../json-schema';

// In your schema builder:
const fieldSchema = Type.String();
fieldSchema[READONLY_FLAG] = true;
```

### `x-scratch-connector-data-type`

Preserve the native API field type for display and transformation purposes.

```typescript
import { CONNECTOR_DATA_TYPE } from '../json-schema';

fieldSchema[CONNECTOR_DATA_TYPE] = 'RichText'; // Webflow
fieldSchema[CONNECTOR_DATA_TYPE] = 'multipleAttachments'; // Airtable
```

### `x-scratch-foreign-key`

Define relationships between tables.

```typescript
import { FOREIGN_KEY_OPTIONS } from '../json-schema';

fieldSchema[FOREIGN_KEY_OPTIONS] = {
  linkedTableId: 'other_database_id',
};
```

### `x-scratch-suggested-transformer`

Hint that the system should auto-apply a transformation when this field is selected as a **source** in the sync editor.

```typescript
import { SUGGESTED_TRANSFORMER } from '../json-schema';

fieldSchema[SUGGESTED_TRANSFORMER] = { type: 'notion_to_html' };
```

### `x-scratch-suggested-in-transformer`

Hint that the system should auto-apply a transformation when this field is selected as a **destination** in the sync editor.

```typescript
import { SUGGESTED_IN_TRANSFORMER } from '../json-schema';

fieldSchema[SUGGESTED_IN_TRANSFORMER] = { type: 'html_to_notion' };
```

### `x-scratch-remote-field-id`

Store the remote field ID from the external service (e.g., Airtable `fldXXX`, Webflow hex hash, Notion property ID).

```typescript
import { REMOTE_FIELD_ID } from '../json-schema';

fieldSchema[REMOTE_FIELD_ID] = 'fld12345abc';
```

### `x-scratch-virtual-fields`

Define human-readable shortcuts for complex nested fields. Each virtual field provides a display label and a pre-configured transformer.

```typescript
import { VIRTUAL_FIELDS } from '../json-schema';
import { VirtualFieldDef } from '../json-schema';

fieldSchema[VIRTUAL_FIELDS] = [
  {
    displayLabel: 'Title (plain text)',
    type: 'string',
    suggestedTransformer: { type: 'notion_title_to_plain_text' },
  },
] satisfies VirtualFieldDef[];
```

### `x-scratch-asset-field`

Mark a field as containing file/media assets that should be indexed. Used by the asset extraction system.

```typescript
import { ASSET_FIELD, AssetFieldOptions } from '../json-schema';

fieldSchema[ASSET_FIELD] = {
  idPath: 'id', // JSONPath to stable ID within each item (null = use URL hash)
  urlExpires: true, // Whether the asset URL expires (e.g. Airtable ~2hr)
} satisfies AssetFieldOptions;
```

### `x-scratch-asset-table`

Mark a table whose records ARE assets (e.g., WordPress media, Webflow Assets). Unlike `x-scratch-asset-field`, this annotates the entire table spec rather than individual fields.

```typescript
import { ASSET_TABLE, AssetTableOptions } from '../json-schema';

tableSpec[ASSET_TABLE] = {
  urlPath: 'source_url',
  filenamePath: 'title.rendered',
  mimeTypePath: 'mime_type',
  sizePath: 'media_details.filesize',
  widthPath: 'media_details.width',
  heightPath: 'media_details.height',
  altTextPath: 'alt_text',
  urlExpires: false,
} satisfies AssetTableOptions;
```

## 6. Registration Checklist

When adding a new connector, touch all of these:

### Server — Service Constant

- [ ] Add to `Service` const in `server/src/remote-service/connectors/service-constants.ts` (convenience constant — the `Service` type is just `string` in `@spinner/shared-types`, so no migration or shared-types change is needed)

### Server — Connector Registration

- [ ] Add connector class in `server/src/remote-service/connectors/library/<service-name>/`
- [ ] Add `static readonly metadata` using `connectorMetadata()` — this defines display name, terminology, logo, visibility, auth methods, credential fields, and OAuth labels (see example below)
- [ ] Register via `connectorRegistry.register()` at the bottom of your connector file (see example below)
- [ ] Add credential fields to `DecryptedCredentials` interface if needed (`packages/shared-types/src/connector-account-types.ts`)
- [ ] Add `AuthParser` and register via `createAuthParser` in your registration if auth pre-processing is needed
- [ ] Add barrel import in `server/src/remote-service/connectors/library/index.ts`

### Connector Logo

- [ ] Find or create an SVG logo for the service (e.g., from [Simple Icons](https://simpleicons.org/))
- [ ] Upload to the static assets GCS bucket: `gcloud storage cp <logo>.svg gs://spv1eu-production-static/connector-icons/<service-name>.svg --content-type="image/svg+xml"`
- [ ] Reference in connector metadata as `logo: 'https://static.scratch.md/connector-icons/<service-name>.svg'`
- [ ] Verify the logo is accessible at the URL

### Server — OAuth (if applicable)

- [ ] Create provider class implementing `OAuthProvider` in `server/src/oauth/providers/`
- [ ] Register provider in `OAuthModule` (`server/src/oauth/oauth.module.ts`)
- [ ] Add to `OAuthService` constructor providers map (`server/src/oauth/oauth.service.ts`)

### Fake API (Recommended for HTTP-Based Connectors)

Most connectors communicate with external services over HTTP. Adding a fake API enables local development and automated testing without hitting real APIs.

- [ ] Create a fake API server in `test-api-fakes/<service-name>/` following the established pattern:

```
test-api-fakes/<service-name>/
├── src/
│   ├── index.ts              # Express app with error simulation + auth middleware
│   ├── store.ts              # In-memory Map-based data store with reset/seed/CRUD
│   ├── middleware/
│   │   └── auth.ts           # Validate auth headers (skip /test/ routes)
│   └── routes/
│       ├── test-admin.ts     # /test/health, /test/reset, /test/setup, /test/dump,
│       │                     #   /test/simulate-rate-limit, /test/simulate-error
│       └── <api-routes>.ts   # Routes mirroring the real API's HTTP contract
├── package.json
├── tsconfig.json
└── Dockerfile
```

Key patterns:

- The **store** uses `Map`-based in-memory storage with `reset()`, `add*()`, `list*()`, and CRUD methods
- **Error simulation middleware** runs before auth — checks an error queue and rate-limit counter, returning queued errors/429s before real routes handle the request. Skips `/test/` routes.
- **Test admin routes** (`/test/*`) are unauthenticated and provide: health checks, state reset, data seeding, state dump, error/rate-limit simulation
- **API routes** replicate the real service's HTTP contract (same paths, methods, request/response shapes, pagination)
- Pick the next available port (check `server/localdev/docker-compose.yml` for current allocations)

After creating the fake:

- [ ] Add service to `server/localdev/docker-compose.yml` (for local dev)
- [ ] Add URL override to `start-dev-v2-fakes.sh`: startup/shutdown commands, health check port, seed data, `API_URL_OVERRIDES` mapping, and status display
- [ ] Verify the fake builds: `cd test-api-fakes/<service-name> && yarn install && yarn build`

The URL override system (`server/src/remote-service/connectors/api-url-overrides.ts`) rewrites connector HTTP requests via an Axios interceptor — connectors don't need any code changes to use fakes. Set `API_URL_OVERRIDES=https://real-api.com=http://localhost:<port>` and the interceptor handles the rest.

### Smoke Tests (Recommended When a Fake API Exists)

If you've added a fake API, wire it into the smoke test infrastructure so your connector is exercised in CI.

- [ ] Add service to `smoke-tests/docker-compose.smoke-test.yml`:
  - Add a `fake-<service-name>` service with a health check
  - Add its URL override to the server's `API_URL_OVERRIDES` env var
  - Add `FAKE_<SERVICE>_URL` env var to the `test-runner` service
  - Add the fake to `depends_on` for both `server` and `test-runner`
- [ ] Create a connector fixture in `smoke-tests/helpers/connector-fixtures/<service-name>.fixture.ts` implementing the `ConnectorFixture` interface:
  - `createAdminClient()` — return a `FakeAdminClient` pointed at the fake's URL
  - `createConnectionCredentials()` — return credentials the server will use
  - `seed()` — reset the fake, seed test data via `/test/setup`, return `SeedResult`
  - `dumpRecords()` — fetch current state via `/test/dump` for assertions
- [ ] Add your fixture to the `fixtures` array in relevant smoke test specs (e.g., `pull/pull-basic.spec.ts`, `publish/publish-happy-path.spec.ts`) to include your connector in the parameterized test matrix

See `smoke-tests/helpers/connector-fixtures/airtable.fixture.ts` for a complete reference implementation.

### Connector Metadata Example

The `connectorMetadata()` helper (from `@spinner/shared-types`) merges your overrides with sensible defaults (`table: 'table'`, `record: 'record'`, `base: null`, `bases: null`, `visible: true`, `pushOperationName: 'Publish'`, `pullOperationName: 'Download'`, `defaultAuthMethod: 'oauth'`). You must provide `displayName` and `logo`.

**`credentialFields`** declares the form fields the client renders for each auth method. It is a `Partial<Record<AuthMethod, ConnectorSettingDefinition[]>>` — keys are auth methods (`'oauth'`, `'user_provided_params'`, `'oauth_custom'`), values are arrays of `ConnectorSettingDefinition`. Field types: `'string'` (text input), `'password'` (masked input), `'boolean'` (checkbox).

**`supportedAuthMethods`** and **`defaultAuthMethod`** on the metadata control which auth options the client shows. Note that `supportedAuthMethods` also appears in the `connectorRegistry.register()` call.

```typescript
import { connectorMetadata } from '@spinner/shared-types';
import { connectorRegistry } from '../../connector-registry';

export class MyConnector extends Connector {
  readonly service = 'MY_SERVICE';
  static readonly displayName = 'My Service';
  static readonly metadata = connectorMetadata({
    displayName: 'My Service',
    table: 'collection',
    tables: 'collections',
    record: 'item',
    records: 'items',
    logo: 'https://static.scratch.md/connector-icons/my-service.svg',
    oauth: { label: 'OAuth' }, // omit if no OAuth support
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'API Key', placeholder: 'Enter API Key', required: true },
      ],
    },
  });
  // ...
}

// Self-register at import time (bottom of file)
connectorRegistry.register({
  service: 'MY_SERVICE',
  metadata: MyConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['oauth', 'user_provided_params'],
  rateLimiterSpec: { points: 5, duration: 1 }, // optional — rate limit to 5 requests/second
  async createConnector(ctx) {
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount?.id ?? 'default');
    const apiKey = ctx.decryptedCredentials?.apiKey;
    if (!apiKey) throw new Error('Missing API key');
    return new MyConnector(apiKey, { rateLimiter });
  },
});
```

The metadata is served at `GET /connectors/metadata` and consumed by the client automatically — no client-side file changes are needed when adding a new connector. The connection modals dynamically render credential fields from `credentialFields`.

## 7. Common Patterns

### Pagination Strategies

| Strategy           | When to Use                                                 | Example Connectors                   |
| ------------------ | ----------------------------------------------------------- | ------------------------------------ |
| **Cursor-based**   | API returns `next_cursor` / `has_more`                      | Notion                               |
| **Offset-based**   | API supports `offset` + `limit` params                      | WordPress, Webflow, PostgreSQL       |
| **Page-based**     | API supports `page` + `per_page` params                     | Intercom                             |
| **Async iterator** | SDK provides generator or you build one wrapping pagination | Airtable, Shopify, Moco, Audienceful |

For resumability, pass `connectorProgress` in the callback. Cursor and offset patterns naturally support this. Async iterators do not easily support mid-stream resume.

### Error Handling

1. Use `extractCommonDetailsFromAxiosError()` for HTTP-based APIs — it handles common status codes
2. Handle service-specific error types (SDK errors, API error codes)
3. Always call `this.fallbackErrorDetails(error)` as the final fallback — it includes the actual error message and service name
4. The `ConnectorInstantiationError` is thrown by `ConnectorsService` when credentials are missing/invalid — you don't need to handle this in the connector itself

### `ConnectorFactoryContext`

The `createConnector` factory receives a context object with:

```typescript
interface ConnectorFactoryContext {
  connectorAccount: { id: string; authType: string; extras: Record<string, unknown> | null } | null;
  decryptedCredentials: DecryptedCredentials | null;
  userId?: string;
  getOAuthAccessToken: (connectorAccountId: string) => Promise<string>;
  createRateLimiter: (connectorAccountId: string) => RateLimiter | undefined;
}
```

### Credential Validation in `createConnector()`

Validate required credentials in the `createConnector` factory function of your registration and throw if missing:

```typescript
connectorRegistry.register({
  service: 'MY_SERVICE',
  // ...
  async createConnector(ctx) {
    const apiKey = ctx.decryptedCredentials?.apiKey;
    if (!apiKey) throw new Error('Missing API key for My Service');
    return new MyServiceConnector(apiKey);
  },
});
```

For OAuth services, get a valid access token first:

```typescript
async createConnector(ctx) {
  const accessToken = ctx.decryptedCredentials?.apiKey
    ?? (ctx.connectorAccount ? await ctx.getOAuthAccessToken(ctx.connectorAccount.id) : null);
  if (!accessToken) throw new Error('Missing access token for My Service');
  return new MyServiceConnector(accessToken);
},
```

### EntityId Conventions

#### Fixed vs. user-defined tables

Connectors fall into two camps based on what their source system models:

- **Fixed-table connectors** expose a known set of resource types defined by the source API itself — `contacts`, `companies`, `deals` for HubSpot; `products`, `orders` for Shopify; `posts`, `pages` for WordPress. The user can't create new types of records, only new instances of the existing types. For these, **use a hardcoded string in `remoteId[0]`** that names the resource type. The string is what the connector uses internally to dispatch to the right API endpoint, and it's stable across deploys.

- **User-defined-table connectors** expose tables/databases/collections that the user creates inside the source system — Airtable bases, Notion databases, Postgres tables, Webflow collections. The set of tables is determined at runtime, and the natural identifier is whatever id the source system assigns. For these, **use the source system's id (sanitized for the `wsId` slot, raw for `remoteId`)**.

- **Hybrid connectors** have both. Affinity is the canonical example: it has three fixed tenant-wide resource types (`/v2/persons`, `/v2/companies`, `/v2/opportunities`) _and_ user-created lists with numeric ids. The dispatch handles both by checking for the fixed strings first, then falling through to the numeric parser:

  ```typescript
  function parseAffinityTableId(id: EntityId): AffinityTableKind {
    const raw = id.remoteId[0];
    switch (raw) {
      case 'persons':
        return { kind: 'tenant-persons' };
      case 'companies':
        return { kind: 'tenant-companies' };
      case 'opportunities':
        return { kind: 'tenant-opportunities' };
    }
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) throw new ConnectorError(`Invalid table id: ${raw}`);
    return { kind: 'list', listId: parsed };
  }
  ```

  This pattern is safe as long as the source system's user-defined ids can never collide with the fixed strings. For Affinity that's guaranteed because list ids are always numeric.

**Why `remoteId` and not `metadata`?** The `remoteId` is the canonical, persisted identifier — once the user creates a DataFolder for a table, `remoteId` is what gets stored in the database and replayed back to the connector on every subsequent `pullRecordFiles` / `fetchJsonTableSpec` / `pullRecordFilesByIds` call. Picker `metadata` is informational and isn't reliably plumbed through. Dispatch logic _must_ live in `remoteId` to survive a round-trip through the database.

#### Per-connector reference

| Connector  | Style           | `wsId`                               | `remoteId`               |
| ---------- | --------------- | ------------------------------------ | ------------------------ |
| Airtable   | User-defined    | `sanitizeForTableWsId(tableId)`      | `[baseId, tableId]`      |
| Webflow    | User-defined    | `sanitizeForTableWsId(collectionId)` | `[siteId, collectionId]` |
| Notion     | User-defined    | `sanitizeForTableWsId(databaseId)`   | `[databaseId]`           |
| PostgreSQL | User-defined    | `sanitizeForTableWsId(tableName)`    | `['public', tableName]`  |
| HubSpot    | Fixed (+custom) | `objectType` (e.g., `'contacts'`)    | `[objectType]`           |
| Brevo      | Fixed           | `tableType` (e.g., `'contacts'`)     | `[tableType]`            |
| Shopify    | Fixed           | `entityType` (e.g., `'products'`)    | `[entityType]`           |
| WordPress  | Fixed           | `tableId` (e.g., `'posts'`)          | `[tableId]`              |
| Intercom   | Fixed           | `tableType` (e.g., `'articles'`)     | `[tableType]`            |

HubSpot is "fixed + custom" because standard CRM object types use the fixed-string convention (`'contacts'`, `'companies'`, …) while custom objects use HubSpot's own `fullyQualifiedName` (e.g., `'p12345_MyObject'`) — both still strings in `remoteId[0]`, just sourced differently.

### Partial Field Updates (`changedFields`)

`updateRecords` receives an optional third parameter: `changedFields?: (Record<string, unknown> | undefined)[]`. This is a parallel array where `changedFields[i]` is a deep sparse object containing only the fields that changed for `files[i]`, with properly transformed values (FK resolution, transformers, etc. already applied).

**How it works:**

- When `changedFields` is provided, connectors can use it directly as a partial payload — it contains only the changed paths with correct values
- When `changedFields` is `undefined` (legacy plans, non-V2 publish paths), connectors fall back to sending full file content
- The sparse object preserves nested structure: e.g., `{ properties: { email: "new@ex.com" } }` for a HubSpot record where only `email` changed within `properties`
- `files` always contains the full resolved record content — the source of truth for git commits and any fields not in `changedFields`

**Removed keys are not tracked:** Keys present in the main branch but absent in the dirty branch are intentionally not included in `changedFields`. Users should set fields to `null` or `""` to clear them, not delete JSON keys. Key removal typically indicates schema changes or reference cleaning.

**Example — opting in a connector:**

```typescript
async updateRecords(
  tableSpec: BaseJsonTableSpec,
  files: ConnectorFile[],
  changedFields?: (Record<string, unknown> | undefined)[],
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const payload = changedFields?.[i] ?? files[i];
    await this.client.update(files[i].id, payload);
  }
}
```

### Read-Only Fields on Publish

> **Legacy behavior (do not replicate):** Several existing connectors silently strip read-only fields before sending data to the API. This masks user errors and should be removed. With `changedFields` now available on `updateRecords`, connectors can send only the fields the user actually changed, avoiding API rejections from unchanged read-only fields without silently masking real edits.

### Asset Extraction

Connectors that store file/media assets can participate in the asset indexing system by:

1. **Annotating schema fields** with `x-scratch-asset-field` or `x-scratch-asset-table` (see [Section 5](#5-json-schema-extensions))
2. **Overriding `extractAssets()`** to extract asset metadata from record content

The `asset-extraction-helpers.ts` module provides shared utilities:

| Helper                         | Purpose                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `extractFromAnnotatedSchema()` | Schema-driven extraction — walks the schema looking for `x-scratch-asset-field` annotations |
| `extractStandaloneEntity()`    | For asset tables (entire record IS an asset) — reads `x-scratch-asset-table` options        |
| `hashUrl(url)`                 | SHA-256 hash of the full URL (for permanent URLs)                                           |
| `hashUrlPath(url)`             | SHA-256 hash of URL path only (for expiring URLs with rotating query params)                |
| `stripQueryParams(url)`        | Remove query params from a URL                                                              |
| `inferMediaType(url)`          | Determine media type (image/video/audio/document/file) from URL extension                   |
| `inferMediaTypeFromMime(mime)` | Determine media type from MIME type string                                                  |

```typescript
// Simple case: use schema-driven extraction (works for most connectors)
extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
  return extractFromAnnotatedSchema(input);
}

// Asset table: the record itself IS an asset (e.g. WordPress media)
extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
  const result = extractStandaloneEntity(input);
  return result ? [result] : [];
}
```

For connectors that support file uploads, also override `uploadFile()` and set `supportsFileUpload = true`.

### File Organization

Follow the established pattern for your connector directory:

```
server/src/remote-service/connectors/library/<service-name>/
├── <service-name>-connector.ts       # Connector implementation
├── <service-name>-json-schema.ts     # Schema builder (fetchJsonTableSpec helper)
├── <service-name>-api-client.ts      # API client wrapper (if needed)
├── <service-name>-auth-parser.ts     # AuthParser (if needed)
├── <service-name>-types.ts           # Service-specific types
├── conversion/                       # Field type conversion utilities (if needed)
└── __tests__/                        # Tests
```
