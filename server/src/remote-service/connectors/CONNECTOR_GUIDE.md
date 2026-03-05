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

The `ConnectorsService` (`connectors.service.ts`) owns a switch statement mapping each `Service` enum value to its connector class. It validates credentials, handles OAuth token refresh, and returns a ready-to-use connector instance.

### Pull Flow

1. **Pull job** (`worker/jobs/job-definitions/pull-linked-folder-files.job.ts`) creates a connector
2. Calls `connector.pullRecordFiles(tableSpec, callback, progress)`
3. Connector paginates through the remote API, calling `callback` with each batch of records
4. Callback converts records to git files, commits them to the main branch, and rebases the dirty branch
5. After all pages: files present in main but not pulled are deleted (removals)
6. Progress is checkpointed after each batch for resumability

### Publish Flow

1. **Publish job** (`worker/jobs/job-definitions/publish-data-folder.job.ts`) diffs the dirty branch against main
2. `DataFolderPublishingService.publishAll()` categorizes files into creates/updates/deletes
3. Files are batched per `connector.getBatchSize()` and sent to `createRecords`/`updateRecords`/`deleteRecords`
4. After publishes, a pull job syncs the remote state back to main

## 3. The Connector Abstract Class

**File:** `connector.ts`

```typescript
export abstract class Connector<
  T extends Service,
  TConnectorProgress extends JsonSafeObject = JsonSafeObject,
>
```

### Type Parameters

| Parameter            | Purpose                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `T extends Service`  | The `Service` enum value this connector handles (e.g., `Service.AIRTABLE`)                                                                      |
| `TConnectorProgress` | Connector-specific progress state for resumable pulls. Defaults to `JsonSafeObject`. Example: `{ nextCursor: string \| undefined }` for Notion. |

### Required Abstract Members

| Member                                            | Signature                                                                                                                                                                                                      | Purpose                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `service`                                         | `abstract readonly service: T`                                                                                                                                                                                 | The Service enum value                                                                      |
| `displayName`                                     | `static readonly displayName: string`                                                                                                                                                                          | Human-readable name (e.g., `'Airtable'`)                                                    |
| `testConnection()`                                | `abstract testConnection(): Promise<void>`                                                                                                                                                                     | Validate credentials. Throw on failure, resolve silently on success.                        |
| `listTables()`                                    | `abstract listTables(): Promise<TablePreview[]>`                                                                                                                                                               | Return all available tables/collections                                                     |
| `fetchJsonTableSpec(id)`                          | `abstract fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec>`                                                                                                                                        | Build the full JSON schema for a table                                                      |
| `pullRecordFiles(tableSpec, callback, progress)`  | `abstract pullRecordFiles(tableSpec: BaseJsonTableSpec, callback: (params: { files: ConnectorFile[]; connectorProgress?: TConnectorProgress }) => Promise<void>, progress: TConnectorProgress): Promise<void>` | Stream all records via batched callbacks                                                    |
| `getBatchSize(operation)`                         | `abstract getBatchSize(operation: 'create' \| 'update' \| 'delete'): number`                                                                                                                                   | Max batch size per CRUD operation (must be > 0)                                             |
| `createRecords(tableSpec, files)`                 | `abstract createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]>`                                                                                                       | Create records, return files with remote IDs assigned                                       |
| `updateRecords(tableSpec, files, changedKeys?)` | `abstract updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[], changedKeys?: (string[] \| undefined)[]): Promise<void>`                                                        | Update existing records (see [Partial Field Updates](#partial-field-updates-changedkeys)) |
| `deleteRecords(tableSpec, files)`                 | `abstract deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void>`                                                                                                                  | Delete records                                                                              |
| `extractConnectorErrorDetails(error)`             | `abstract extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails`                                                                                                                                 | Translate service errors to user-friendly messages                                          |

### Optional Methods

| Method                             | Purpose                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `getNewFile(tableSpec)`            | Return a default template for new records. Default: `{}`. Override to pre-populate fields (e.g., Webflow sets `isDraft: true`).             |
| `validateFiles?(tableSpec, files)` | Optional pre-publish validation. Return validation results with `publishable` boolean and optional `errors`, or `undefined` if unsupported. |

### Key Types

```typescript
// An identifier with both a Scratch-internal ID and a remote API path
type EntityId = {
  wsId: string; // Human-readable, valid in postgres
  remoteId: string[]; // Path components in the remote service
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
  slugColumnRemoteId?: string; // Dot-path for filename slug
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
export abstract class AuthParser<T extends Service> {
  abstract readonly service: T;
  abstract parseUserProvidedParams(params: { userProvidedParams: Record<string, string | undefined> }): Promise<{
    credentials: Record<string, string>;
    extras: Record<string, string>;
  }>;
}
```

Register it in `ConnectorsService.getAuthParser()`.

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

```typescript
// Airtable: bases contain tables — remoteId = [baseId, tableId]
return tables.map((table) => ({
  id: {
    wsId: sanitizeForTableWsId(table.id),
    remoteId: [baseId, table.id],
  },
  name: table.name,
}));

// Shopify: entity types are "tables" — remoteId = [entityType]
return Object.entries(ENTITY_CONFIG).map(([entityType, config]) => ({
  id: {
    wsId: entityType,
    remoteId: [entityType],
  },
  name: config.displayName,
}));
```

Use `sanitizeForTableWsId()` from `ids.ts` to ensure the `wsId` is safe for postgres and file paths.

### `fetchJsonTableSpec()`

Build a `BaseJsonTableSpec` with a TypeBox JSON Schema describing every field. Prefer dynamic discovery — fetch the schema from the API rather than hardcoding it.

Key considerations:

- Set `idColumnRemoteId` to the field that uniquely identifies records (e.g., `'id'`, `'recordId'`)
- Optionally set `titleColumnRemoteId` (display name), `mainContentColumnRemoteId` (markdown body), `slugColumnRemoteId` (filename slug)
- Annotate fields with `x-scratch-*` extensions (see [Section 5](#5-json-schema-extensions))

### `pullRecordFiles()`

Stream records by calling the `callback` with batches. Three common pagination patterns:

#### Cursor-Based (Notion)

```typescript
async pullRecordFiles(
  tableSpec: BaseJsonTableSpec,
  callback: (params: { files: ConnectorFile[]; connectorProgress?: NotionDownloadProgress }) => Promise<void>,
  progress: NotionDownloadProgress,
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

#### Async Iterator (Airtable)

```typescript
async pullRecordFiles(
  tableSpec: BaseJsonTableSpec,
  callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  progress: JsonSafeObject,
): Promise<void> {
  for await (const rawRecords of this.client.listRecords(baseId, tableId)) {
    const files = rawRecords.map((record) => this.recordToFile(record));
    await callback({ files });
  }
}
```

The async iterator pattern wraps pagination internally in the API client. Use this when building your own client or when the SDK provides generators. Note that connectorProgress is optional for async iterators since the iterator manages its own state (though resumability is limited).

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

### `createRecords()` / `updateRecords()` / `deleteRecords()`

Implement batch CRUD operations. Key patterns:

> **Do NOT silently strip read-only fields.** Some existing connectors (Airtable, Notion, Shopify) filter out read-only fields before sending to the API. This is **incorrect behavior** that should be removed — if a user edits a read-only field, the API should return an error so the user understands what happened. Silently dropping edits and reporting success is confusing. New connectors should send the user's data as-is and let the API reject invalid writes.

> **Field-level diffs are now available.** `updateRecords` receives an optional `changedKeys` parameter — a parallel array where each entry contains only the top-level key names that changed. Connectors can use this to build partial payloads from the corresponding file. See [Partial Field Updates](#partial-field-updates-changedkeys) in Section 7.

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

  return { userFriendlyMessage: ErrorMessageTemplates.UNKNOWN_ERROR('MyService') };
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

Hint that the system should auto-apply a transformation when displaying/editing this field.

```typescript
import { SUGGESTED_TRANSFORMER } from '../json-schema';

fieldSchema[SUGGESTED_TRANSFORMER] = { type: 'notion_to_html' };
```

## 6. Registration Checklist

When adding a new connector, touch all of these:

### Shared Types

- [ ] Add to `Service` enum in `packages/shared-types/src/enums/enums.ts`

### Server — Prisma

- [ ] Add to `Service` enum in `server/prisma/schema.prisma`
- [ ] Create and run a migration: `cd server && yarn run migrate`

### Server — Connector Registration

- [ ] Add connector class in `server/src/remote-service/connectors/library/<service-name>/`
- [ ] Add switch case in `ConnectorsService.getConnector()` (`connectors.service.ts`)
- [ ] Add case in `getServiceDisplayName()` (`display-names.ts`)
- [ ] Add credential fields to `DecryptedCredentials` interface if needed (`packages/shared-types/src/connector-account-types.ts`)
- [ ] Add `AuthParser` and register in `ConnectorsService.getAuthParser()` if auth pre-processing is needed

### Server — OAuth (if applicable)

- [ ] Create provider class implementing `OAuthProvider` in `server/src/oauth/providers/`
- [ ] Register provider in `OAuthModule` (`server/src/oauth/oauth.module.ts`)
- [ ] Add to `OAuthService` constructor providers map (`server/src/oauth/oauth.service.ts`)

### Client

- [ ] Add entry in `ServiceNamingConventions` (`client/src/service-naming-conventions.ts`) — includes display names, table/record terminology, logo
- [ ] Add to `OAuthService` type union if OAuth (`client/src/types/oauth.ts`)
- [ ] Add to `isValidOAuthService()` check if OAuth (`client/src/app/oauth/callback-step-2/page.tsx`)

## 7. Common Patterns

### Pagination Strategies

| Strategy           | When to Use                                                 | Example Connectors                   |
| ------------------ | ----------------------------------------------------------- | ------------------------------------ |
| **Cursor-based**   | API returns `next_cursor` / `has_more`                      | Notion                               |
| **Offset-based**   | API supports `offset` + `limit` params                      | WordPress, Webflow, PostgreSQL       |
| **Async iterator** | SDK provides generator or you build one wrapping pagination | Airtable, Shopify, Moco, Audienceful |

For resumability, pass `connectorProgress` in the callback. Cursor and offset patterns naturally support this. Async iterators do not easily support mid-stream resume.

### Error Handling

1. Use `extractCommonDetailsFromAxiosError()` for HTTP-based APIs — it handles common status codes
2. Handle service-specific error types (SDK errors, API error codes)
3. Always return `ErrorMessageTemplates.UNKNOWN_ERROR(displayName)` as a fallback
4. The `ConnectorInstantiationError` is thrown by `ConnectorsService` when credentials are missing/invalid — you don't need to handle this in the connector itself

### Credential Validation in `getConnector()`

When adding your switch case, validate required credentials and throw `ConnectorInstantiationError` if missing:

```typescript
case Service.MY_SERVICE: {
  const apiKey = decryptedCredentials?.apiKey;
  if (!apiKey) throw new ConnectorInstantiationError(Service.MY_SERVICE);
  return new MyServiceConnector(apiKey);
}
```

For OAuth services, get a valid access token first:

```typescript
case Service.MY_SERVICE: {
  const accessToken = decryptedCredentials?.apiKey
    ?? (connectorAccount ? await this.oauthService.getValidAccessToken(connectorAccount.id) : null);
  if (!accessToken) throw new ConnectorInstantiationError(Service.MY_SERVICE);
  return new MyServiceConnector(accessToken);
}
```

### EntityId Conventions

| Connector  | `wsId`                               | `remoteId`               |
| ---------- | ------------------------------------ | ------------------------ |
| Airtable   | `sanitizeForTableWsId(tableId)`      | `[baseId, tableId]`      |
| Webflow    | `sanitizeForTableWsId(collectionId)` | `[siteId, collectionId]` |
| Notion     | `sanitizeForTableWsId(databaseId)`   | `[databaseId]`           |
| Shopify    | `entityType` (e.g., `'products'`)    | `[entityType]`           |
| WordPress  | `tableId` (e.g., `'posts'`)          | `[tableId]`              |
| PostgreSQL | `sanitizeForTableWsId(tableName)`    | `['public', tableName]`  |

### Partial Field Updates (`changedKeys`)

`updateRecords` receives an optional third parameter: `changedKeys?: (string[] | undefined)[]`. This is a parallel array where `changedKeys[i]` contains the top-level key names that changed for `files[i]`.

**How it works:**

- When `changedKeys` is provided, connectors can build a partial payload by picking only the listed keys from `files[i]`
- When `changedKeys` is `undefined` (legacy plans, non-V2 publish paths), connectors fall back to sending full file content
- Each connector decides how to extract changed fields based on its data structure (e.g., Airtable uses `fields`, Webflow uses `fieldData`, Notion uses `properties`)
- `files` always contains the full resolved record content — the source of truth for both data values and git commits

**Removed keys are not tracked:** Keys present in the main branch but absent in the dirty branch are intentionally not included in `changedKeys`. Users should set fields to `null` or `""` to clear them, not delete JSON keys. Key removal typically indicates schema changes or reference cleaning.

**Example — opting in a connector:**

```typescript
async updateRecords(
  tableSpec: BaseJsonTableSpec,
  files: ConnectorFile[],
  changedKeys?: (string[] | undefined)[],
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const payload = changedKeys?.[i]
      ? Object.fromEntries(changedKeys[i].map((k) => [k, files[i][k]]))
      : files[i];
    await this.client.update(files[i].id, payload);
  }
}
```

### Read-Only Fields on Publish

> **Legacy behavior (do not replicate):** Several existing connectors silently strip read-only fields before sending data to the API. This masks user errors and should be removed. With `changedKeys` now available on `updateRecords`, connectors can send only the fields the user actually changed, avoiding API rejections from unchanged read-only fields without silently masking real edits.

### File Organization

Follow the established pattern for your connector directory:

```
server/src/remote-service/connectors/library/<service-name>/
├── <service-name>-connector.ts       # Connector implementation
├── <service-name>-json-schema.ts     # Schema builder (fetchJsonTableSpec helper)
├── <service-name>-api-client.ts      # API client wrapper (if needed)
├── <service-name>-auth-parser.ts     # AuthParser (if needed)
├── <service-name>-types.ts           # Service-specific types
└── __tests__/                        # Tests
```
