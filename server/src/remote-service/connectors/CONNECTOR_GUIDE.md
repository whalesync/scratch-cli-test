# Connector Development Guide

A guide for building new connectors in Scratch (Spinner). Intended for internal team members and AI agents.

## 1. Core Philosophy

### The Connector Prime Directive: Store Raw API Responses

**We never reshape, rename, or normalize the data on the way in — a record's own structure stays exactly as the API returned it. If the raw shape is awkward to display or edit, adapt the view/schema layer to the data; never transform the data to fit the UI.** This is the **Connector Prime Directive**, and it overrides convenience every time. The system stores records as JSON files in git, so this is what gives us round-trip fidelity (what we publish back is the shape the service expects), keeps debugging honest (the file on disk is exactly what the API sent), and keeps git history meaningful.

**The only two exceptions — and this is the entire list:**

- **Strip transport wrappers** — pagination cursors, `hasMore` flags, page/total counts. These are the envelope around the data, not the data.
- **Hydrate stub references in place** — when the API returns a stub (e.g. Notion block children, Shopify product variants), fetch the full object and embed it exactly where the stub sat.

Both stay within the Directive because **neither alters a record's own structure**: one removes an outer envelope, the other deepens the tree where the API itself points — no key is renamed, no container kind is changed, nothing is re-ordered.

**Litmus test.** Before any transform on the way in, ask: _would the stored record still deserialize to exactly what the service's read endpoint returns for that record (minus transport wrappers, plus hydrated stubs)?_ If your change renames a key, alters nesting, coerces a type, reorders keys, or **swaps a container kind (array ↔ object)**, it fails the test and violates the Directive.

**A stored record that fails this test is a bug** — even if it round-trips cleanly on publish, and even if it already ships in a connector today. Any existing violation slipped in unintentionally; it is an open bug to fix, not a sanctioned exception and not precedent. Fix it; don't enshrine it.

> **These feel justified but are still violations — do not do them:**
>
> - **Reshaping an array into a keyed object so its elements become editable columns** — e.g. `custom_fields: [{ id, value }]` → `custom_fields: { cf_<id>: value }`. This is the most common trap, because Scratch's editable path engine treats arrays as leaves (`getByPath`/`setByPath` don't index into arrays, and schema auto-columns recurse only into objects), so per-element editing _seems_ impossible without it. **It is still a violation.** "It reverses cleanly on publish" does not save it — the Directive governs what sits on disk, not just what we ship back, and the on-disk record no longer matches the API. The correct fix is to make the **view/schema/path layer** address array elements, or to leave the array a non-editable leaf until it can — never to reshape the stored data. (**GoHighLevel** `customFields[]` and **Copper** `custom_fields[]` currently do this — that is a **known bug to fix, not a pattern to replicate.**)
> - **Renaming keys to friendlier names**, flattening nested objects, or splitting/combining fields for display. All of this belongs in the schema/view layer (column labels, `displayTransformer`, subfield paths, FK options), never in the stored record.
> - **Coercing types or normalizing values** — numbers-as-strings → numbers, trimming, case-folding, snapping dates. Store what the API sent; if a value is awkward, adapt the column type or add a display transform.

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

| Member                                                    | Signature                                                                                                                                                                                                                                  | Purpose                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `service`                                                 | `abstract readonly service: T`                                                                                                                                                                                                             | The service identifier string                                                                                         |
| `displayName`                                             | `static readonly displayName: string`                                                                                                                                                                                                      | Human-readable name (e.g., `'Airtable'`)                                                                              |
| `metadata`                                                | `static readonly metadata: ConnectorMetadata`                                                                                                                                                                                              | Connector metadata (display name, terminology, logo, visibility, OAuth labels). Use the `connectorMetadata()` helper. |
| `testConnection()`                                        | `abstract testConnection(): Promise<void>`                                                                                                                                                                                                 | Validate credentials. Throw on failure, resolve silently on success.                                                  |
| `listTables()`                                            | `abstract listTables(): Promise<TablePreview[]>`                                                                                                                                                                                           | Return all available tables/collections                                                                               |
| `fetchJsonTableSpec(id)`                                  | `abstract fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec>`                                                                                                                                                                    | Build the full JSON schema for a table                                                                                |
| `pullRecordFiles(tableSpec, callback, progress, options)` | `abstract pullRecordFiles(tableSpec: BaseJsonTableSpec, callback: (params: { files: ConnectorFile[]; connectorProgress?: TConnectorProgress }) => Promise<void>, progress: TConnectorProgress, options: DataFolderOptions): Promise<void>` | Stream all records via batched callbacks                                                                              |
| `pullRecordFilesByIds(tableSpec, ids, callback)`          | `abstract pullRecordFilesByIds(tableSpec: BaseJsonTableSpec, ids: string[], callback: (params: { files: ConnectorFile[] }) => Promise<void>): Promise<void>`                                                                               | Fetch specific records by ID (bulk where supported, silently skip 404s)                                               |
| `getBatchSize(operation)`                                 | `abstract getBatchSize(operation: 'create' \| 'update' \| 'delete'): number`                                                                                                                                                               | Max batch size per CRUD operation (must be > 0)                                                                       |
| `createRecords(tableSpec, files)`                         | `abstract createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]>`                                                                                                                                   | Create records, return files with remote IDs assigned                                                                 |
| `updateRecords(tableSpec, files, changedFields?)`         | `abstract updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[], changedFields?: (Record<string, unknown> \| undefined)[]): Promise<void>`                                                                                    | Update existing records (see [Partial Field Updates](#partial-field-updates-changedfields))                           |
| `deleteRecords(tableSpec, files)`                         | `abstract deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void>`                                                                                                                                              | Delete records                                                                                                        |
| `getSuggestedRecordFileNames(records, tableSpec)`         | `abstract getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string \| undefined)[]`                                                                                                                    | Suggest human-friendly filenames for pulled records (without extension). Return `undefined` per record to use its ID. |
| `extractConnectorErrorDetails(error)`                     | `abstract extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails`                                                                                                                                                             | Translate service errors to user-friendly messages                                                                    |

### Optional Methods & Properties

| Member                                              | Purpose                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getNewFile(tableSpec)`                             | Return a default template for new records. Default: `{}`. Override to pre-populate fields (e.g., Webflow sets `isDraft: true`).                                                                                  |
| `validateFiles?(tableSpec, files)`                  | Optional pre-publish validation. Return validation results with `publishable` boolean and optional `errors`, or `undefined` if unsupported.                                                                      |
| `tableDiscoveryMode`                                | Getter returning `TableDiscoveryMode.LIST` (default) or `TableDiscoveryMode.SEARCH`. Use SEARCH for slow list APIs (e.g. Notion).                                                                                |
| `searchTables(searchTerm)`                          | Search tables by name. Required when `tableDiscoveryMode` is `SEARCH`. Returns `{ tables: TablePreview[]; hasMore: boolean }`.                                                                                   |
| `getApiQuota()`                                     | Return `{ quota }` with raw API data, `{ dashboardUrl }` with a link to the service's usage page, or `null` (default) if unsupported. See [API Quota](#api-quota).                                               |
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
  // All four path-shaped fields are branded DotPath (lodash dot-path strings),
  // constructed via dotPath(...). See "The DotPath convention" below.
  idPath: DotPath; // Dot-path to the record's remote id (e.g. dotPath('id') or dotPath('id.record_id'))
  titlePath?: DotPath; // Dot-path to the title/header field (e.g. dotPath('fields.Name'))
  mainContentPath?: DotPath; // Dot-path to the markdown body field
  slugPath?: DotPath; // Dot-path for the filename slug (e.g. dotPath('fieldData.slug'))
  basePath?: string[]; // Root path grouping (e.g. site name, base name)
  remoteWebUrl?: string; // Deep link to the table in the SERVICE's web UI (e.g. https://airtable.com/{baseId}/{tableId}); omit if not constructible
  generatedAt?: string; // ISO 8601 timestamp of schema generation
  // NOTE: the default column layout is NOT part of the spec. It is produced separately
  // by `Connector.buildDefaultView(spec)` — a pure spec → view stage (see Section 8).
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

- **The `DotPath` convention.** The four "path into a record" fields — `idPath`, `titlePath`, `mainContentPath`, `slugPath` — are all the branded type `DotPath`: a single lodash dot-path **string** constructed via the `dotPath(...)` constructor (`connectors/types.ts`). A nested path is one dotted string, never a segment array: `dotPath('id.record_id')`, `dotPath('fields.Name')`. Read them back with `lodash.get` / `lodash.toPath`, never bracket access. (DEV-10092 unified these — the old names `idColumnRemoteId` / `titleColumnRemoteId` / `mainContentColumnRemoteId` / `slugFieldPath`, and the old segment-array shape for title/mainContent, are accepted on read for `schema.json` files committed before the rename, via a compat shim in `ScratchGitService.readSchemaFromGit`; emit only the new names.)
- Set `idPath` to the dot-path that locates the record's remote id — e.g. `dotPath('id')` for flat ids, `dotPath('id.record_id')` when the API returns an id object (Attio). Helpers `readRecordId`, `readRecordIdAsString`, `writeRecordId`, `clearRecordId`, and `recordWithId` (in `connectors/types.ts`) are the canonical accessors — use them instead of raw lodash so future readers see the intent at every call site.
- Optionally set `titlePath` (display name, e.g. `dotPath('fields.Name')`), `mainContentPath` (markdown body), `slugPath` (filename slug, e.g. `dotPath('fieldData.slug')`).
- Set `remoteWebUrl` to a deep link to this table in the **service's own web UI** (a URL on _their_ site, not a Scratch URL) when the service exposes a stable, constructible link — e.g. Airtable `https://airtable.com/{baseId}/{tableId}`, Notion `https://www.notion.so/{databaseId-without-dashes}`, Stripe `https://dashboard.stripe.com/{entity}`. It is stamped onto `DataFolder.remoteWebUrl` at folder-create time and refreshed on every pull, and the client uses it to offer an "open in {service}" link. **Omit it rather than emit a guessed or broken URL** — a wrong link is worse than none. The link need not be composable from the remote id alone: Supabase's table editor addresses a relation by its Postgres `pg_class` OID, so that connector resolves the OID from the catalog inside `fetchJsonTableSpec` and omits the link when it can't (see its [STATE.md](library/supabase/STATE.md) → Gotchas).
- Set `remoteContainer` to the container this table lives in — the Airtable base, Google Sheets spreadsheet, Supabase project+schema, or Notion parent page — as `{ id, name, remoteWebUrl }`. It names the same place a create destination does, resolved for a table that already exists, so a client can show "this table lives in X" and link there. Stamped onto `DataFolder` and refreshed on every pull, so a container renamed on the service follows without a migration. Build it from what `fetchJsonTableSpec` already has (the remote id usually carries the container id), and match the `CreateDestination.id` form so the two are comparable. `remoteWebUrl: null` is fine — a container with a name but no constructible link still renders. **Omit the whole object rather than invent a container**: Notion skips it because its create destination is the parent *page*, whose id and title aren't in the data-source object, and naming the database instead would be a different thing wearing the container's name.
- Annotate fields with `x-scratch-*` extensions (see [Section 5](#5-json-schema-extensions))

### Create destinations (only for connectors that create tables)

A **create destination** is the container a new table is created inside — an Airtable base, a Supabase project+schema, a Notion parent page, a Google Sheets spreadsheet. Live Export's picker is built on three optional methods, all returning the shared `CreateDestination`:

| Method | When to implement |
| --- | --- |
| `listCreateDestinations()` | Always, if the connector creates tables. |
| `searchCreateDestinations(term)` | Only when the list can exceed the result cap and the service can search server-side (Notion). Otherwise the REST layer filters the full list in-process. |
| `lookupCreateDestination(id)` | Only when a saved selection can sit beyond the cap. Return `null` **only** for a definitively inaccessible id (deleted / reauthorized elsewhere); throw on transport failures, so an outage is never mistaken for a stale selection. Otherwise the REST layer scans the list. |

Every `CreateDestination` carries `created`. Set it `false` for a destination that **does not exist yet** and will be provisioned on first create — Google Sheets' "new spreadsheet" is the only one today. This is what lets a UI render "will be created" without knowing your sentinel id; a frontend must never branch on a service.

- Implement `buildCreateDestinationRemoteWebUrl(destinationId)` when the service has a stable, constructible link to the **container** — e.g. Airtable `https://airtable.com/{baseId}`. The REST layer calls it for every destination it returns from all three methods and stamps `CreateDestination.remoteWebUrl`, so you write the URL once instead of at each `{ id, name }` construction site. It must be **synchronous, pure, and network-free** (the picker calls it across a whole list), and must not throw. Same rule as `remoteWebUrl`: **omit rather than guess.** Return `undefined` for a destination that doesn't exist yet, a self-hosted deployment with no web UI, or an id that fails to parse — and note a destination id can be text the user *pasted*, so parse it rather than interpolating it raw. A service with no container-level URL at all should leave the method undefined rather than invent one; consumers fall back to a representative child table's link.
- If your connector **provisions** the parent rather than being handed an existing one, return the parent you actually used as `CreateTableResult.remoteParentId`. Callers pin it, so a retry adds tables to the same container instead of provisioning a second one.

### `pullRecordFiles()`

Stream records by calling the `callback` with batches. Three common pagination patterns:

#### Cursor-Based (Notion)

```typescript
async pullRecordFiles(
  tableSpec: BaseJsonTableSpec,
  callback: (params: { files: ConnectorFile[]; connectorProgress?: NotionDownloadProgress }) => Promise<void>,
  progress: NotionDownloadProgress,
  options: DataFolderOptions,
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
  options: DataFolderOptions,
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
  options: DataFolderOptions,
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

### Incremental Pulls

A full pull re-fetches every record every run. An **incremental pull** fetches only records changed since the previous run, which the job decides between by mode:

- `options.pullMode === 'full'` (or absent) — full scan; ignore `options.since` / `options.cursor`; return `{}`.
- `options.pullMode === 'incremental'` — fetch only records modified since `options.since`; return `{ newWatermark }` (or `{ newCursor }` for token-based APIs). Only invoked when `supportsIncrementalPull(options, tableSpec)` returned `true`.

The job demotes an incremental run to a full scan whenever `supportsIncrementalPull` is `false` or there is no prior watermark (bootstrap), so a connector never has to special-case the first run.

#### The contract (all incremental connectors)

1. **`ConnectorMetadata.incrementalPull: true`** — a _static, per-connector_ flag set in `connectorMetadata({ ... })`. The web client reads it to gate the incremental menu items and the incremental schedule row. It says only "this connector type can do incremental"; the _runtime_ `supportsIncrementalPull(options, tableSpec)` still decides per folder.
2. **`resolveModifiedAtField(options, tableSpec)`** — a private helper with a fixed two-layer precedence:
   1. explicit `options.modifiedAtField` (trimmed) if the user set one in advanced settings;
   2. else auto-detect: the first schema field annotated with `X_SCRATCH_LAST_MODIFIED_FIELD` (`x-scratch-last-modified-field`), found via `findLastModifiedFieldName(tableSpec)`.

   Connectors over an API with no last-modified convention (SQL) skip layer 2 — there is nothing to annotate, so resolution is the explicit setting only.

   `findLastModifiedFieldName` understands the three record-schema shapes connectors use (first match wins), so a connector's `resolveModifiedAtField`/auto-detect path and the client's annotation walk stay identical regardless of shape:
   1. **Airtable-nested** — `{ properties: { fields: { properties: { <name> } } } }` (the original Airtable record shape).
   2. **Flat top-level** — `{ properties: { <name> } }` — one static schema per entity type (WordPress, **Linear**, **Moco**, Shopify, Intercom). Note Intercom gates incremental on the _table_, not on this helper — the annotation is only for the UI picker.
   3. **HubSpot-nested** — `{ properties: { properties: { properties: { <name> } } } }`, where CRM properties live under a nested `properties` object.

3. **`supportsIncrementalPull`** — usually `return this.resolveModifiedAtField(...) !== undefined`. Connectors with a guaranteed system field (e.g. Notion's `last_edited_time`) return `true` unconditionally.
4. **`advancedSettings`** — expose `modifiedAtField` as a `field-select` setting so users can override/declare the column, unless the field is fixed and not user-selectable.
5. **Watermark-before-first-call rule** — capture `newWatermark = new Date()` _before the first API call_, not after the last. Anything modified mid-pull is then re-pulled next run rather than skipped; idempotent commits absorb the duplicates.
6. **Clock-skew margin** — the watermark is captured on the worker; the record's modified-at is written by the remote. Subtract a small per-connector margin from `since` so a record modified just before `pullStartedAt` on a skewed clock isn't missed. The margin is `0` only when the remote filter is inclusive and uses a server-side timestamp.

#### Modified-since archetypes

Pick the one matching the remote API:

- **Server-side predicate** (preferred — Airtable formula, SQL `WHERE`, Notion filter): the remote filters; you page through only changed records. Combine with any user `options.filter` (AND them). Lowest cost.
- **Client-side filter during pagination** (Webflow — no `modified_since` param): page through everything and drop records older than the cutoff before the callback. You cannot early-terminate unless the API guarantees modified-time sort order, so the win is skipping git writes for unchanged records, not API quota.
- **Opaque cursor / change feed**: persist `newCursor` instead of `newWatermark` and resume from it. None implemented yet.

##### Per-connector techniques

Each connector builds its predicate in its own `*-incremental.ts` helper (a clock-skew constant + a filter/param builder). **Reuse the module _shape_, not one shared helper** — the predicate syntaxes (Airtable formula, SQL `WHERE`, Notion JSON, Linear GraphQL filter, REST query params, Intercom Search clause) have nothing in common. Each summary below links to that connector's helper + connector for the full code.

- **Airtable** (annotation-gated + user override) — auto-detects the last-modified field via `X_SCRATCH_LAST_MODIFIED_FIELD` (or an explicit `modifiedAtField`), builds a server-side `filterByFormula` predicate, and AND-combines it with any user `options.filter`. 60s clock-skew. → [airtable-incremental.ts](library/airtable/airtable-incremental.ts), [airtable-connector.ts](library/airtable/airtable-connector.ts)
- **Postgres / Supabase** (user-declared field) — SQL has no last-modified convention, so incremental is gated entirely on the user setting `modifiedAtField` (no annotation, no auto-detect). `KnexPGClient.selectAll` appends a **parameterized** `WHERE ref(col) > since` (never string-interpolated), and `assertModifiedAtColumnExists` rejects a typo up front. 60s clock-skew. → [pg-incremental.ts](library/pg-common/pg-incremental.ts), [postgres-connector.ts](library/postgres/postgres-connector.ts), [supabase-connector.ts](library/supabase/supabase-connector.ts)
- **Notion** (fixed system field) — every page has `last_edited_time`, so support is unconditional; `databases.query` filters with **inclusive** `on_or_after`, so the clock-skew is `0`. A user filter that is itself a top-level compound would exceed Notion's one-level nesting limit, so that run demotes to a full scan. → [notion-incremental.ts](library/notion/notion-incremental.ts), [notion-connector.ts](library/notion/notion-connector.ts)
- **Linear** (fixed system field) — every entity has `updatedAt`; support is unconditional. GraphQL `filter: { updatedAt: { gt } }` with a per-entity `FILTER_TYPE_MAP` (`issues → IssueFilter`, …); `gt` is **exclusive** → 60s clock-skew. → [linear-incremental.ts](library/linear/linear-incremental.ts), [linear-connector.ts](library/linear/linear-connector.ts)
- **WordPress** (annotation-gated by collection) — REST `?modified_after=` on post/media collections (taxonomy has no `modified`, so it demotes to full). The watermark must be rendered in the **site's timezone** (resolved from the memoized REST-index lookup), not UTC, or the offset silently drops records; the 60s skew then only covers residual drift. → [wordpress-incremental.ts](library/wordpress/wordpress-incremental.ts), [wordpress-connector.ts](library/wordpress/wordpress-connector.ts)
- **Intercom** (capability-gated by table) — Conversations only, via `POST /conversations/search` (articles/collections demote to full). Timestamps are **Unix seconds** and `>` is exclusive → 60s clock-skew; the search sorts `updated_at` ascending so a record touched mid-pagination lands at the tail (a possible duplicate, never a miss). → [intercom-incremental.ts](library/intercom/intercom-incremental.ts), [intercom-connector.ts](library/intercom/intercom-connector.ts)
- **Moco** (fixed system field) — every entity has `updated_at`; support is unconditional. REST `?updated_after=` in **ISO-8601 UTC at seconds precision** (`YYYY-MM-DDTHH:mm:ssZ` — Moco 400s on the fractional seconds `toISOString()` emits; no timezone conversion, unlike WordPress) threaded through each list endpoint; `>` is exclusive → 60s clock-skew. Deletions are reconciled by the periodic `FULL_PULL`. → [moco-incremental.ts](library/moco/moco-incremental.ts), [moco-connector.ts](library/moco/moco-connector.ts)
- **HubSpot** (annotation-gated + user override) — the standard list endpoint can't filter by modified date, so incremental **switches endpoints** to the CRM **Search API** (`POST /crm/v3/objects/{type}/search`) with a `<field> GTE <epoch-ms>` filter sorted **ascending** by that field. The modified-date property name is object-type-dependent (`hs_lastmodifieddate` for most objects, `lastmodifieddate` for contacts, custom objects vary), so it's auto-detected via `X_SCRATCH_LAST_MODIFIED_FIELD` or an explicit `modifiedAtField`; a custom object the annotation misses reports `NEEDS_CONFIGURATION`. `GTE` is inclusive but the watermark is client-side → 60s clock-skew. **Two documented limitations, both reconciled by the periodic `FULL_PULL`**: (1) Search returns `properties` but **not** `associations`, so incremental pulls don't refresh association data; (2) a single Search result set is capped at **10,000 records** (bootstrap is always full, and the watermark advances by what returned so the next run continues). → [hubspot-incremental.ts](library/hubspot/hubspot-incremental.ts), [hubspot-connector.ts](library/hubspot/hubspot-connector.ts)

(None of these needed the **client-side-filter** archetype — it stays documented-but-unimplemented; the deferred Webflow design remains its future template.)

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
  return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'name', 'title');
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

### API Quota

Override `getApiQuota()` to let users view their current API quota / rate-limit state from the sidebar's "View API Quota" dialog. Return one of three shapes:

- `{ quota: JsonSafeObject }` — raw quota data from the API. The client renders it as pretty-printed JSON.
- `{ dashboardUrl: string }` — no API-level quota endpoint, but a link to the service's usage dashboard where the user can check manually.
- `null` (default) — no quota concept at all. The dialog shows a generic "unsupported" message.

```typescript
// Affinity: return raw /rate-limit response (per-minute + monthly buckets)
async getApiQuota(): Promise<{ quota: JsonSafeObject }> {
  const quota = await this.client.getQuota();
  return { quota: quota as unknown as JsonSafeObject };
}

// Airtable: no API quota endpoint, but link to the workspace billing page
async getApiQuota(): Promise<{ dashboardUrl: string }> {
  const bases = await this.client.listBases();
  const metadata = await this.client.getBaseMetadata(bases.bases[0].id);
  return { dashboardUrl: `https://airtable.com/${metadata.workspaceId}/workspace/billing` };
}

// YouTube: static Google Cloud Console URL
async getApiQuota(): Promise<{ dashboardUrl: string }> {
  return { dashboardUrl: 'https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas' };
}

// HubSpot: extract daily quota from response headers on a lightweight call
async getApiQuota(): Promise<{ quota: JsonSafeObject }> {
  const quota = await this.client.getApiQuota(); // reads x-hubspot-ratelimit-daily-* headers
  return { quota: quota as unknown as JsonSafeObject };
}
```

The server exposes this via `GET /workbooks/:workbookId/connections/:id/quota`, which returns `{ supported: true, quota }`, `{ supported: false, dashboardUrl }`, or `{ supported: false }`. No caching — the endpoint fetches fresh on every request since quota values are time-sensitive.

## 5. JSON Schema Extensions

Custom `x-scratch-*` properties annotate fields in the TypeBox schema. Defined in `json-schema.ts`:

### `x-scratch-readonly`

Mark fields that should not be sent on create/update (computed fields, system timestamps, etc.).

```typescript
import { READONLY_FLAG } from '@spinner/shared-types';

// In your schema builder:
const fieldSchema = Type.String();
fieldSchema[READONLY_FLAG] = true;
```

### `x-scratch-write-once`

Mark fields the service accepts **on create but rejects (or ignores) on update** — i.e. set-on-create-only fields (e.g. Attio task `content`, a list entry's `parent_record_id`/`parent_object`, Copper set-on-create FKs). This is the create-only counterpart to `x-scratch-readonly`: the field is **writable while the record is new (not yet published) and read-only once it exists remotely**.

```typescript
import { X_SCRATCH_WRITE_ONCE } from '@spinner/shared-types';

const fieldSchema = Type.String();
fieldSchema[X_SCRATCH_WRITE_ONCE] = true;
```

Effects across the stack (all derived from this one flag): the desktop grid/detail view compute editability as `readonly || (writeOnce && !recordIsNew)` (new-vs-existing from the row's diff status); the default-view builder copies the flag onto the `TableViewCol`; and the scratch-git `enforce_schema` validator warns when a write-once field changes on an **existing** record (silent on new records). Do **not** also mark a write-once field `x-scratch-readonly` — that would block setting it on create.

### `x-scratch-connector-data-type`

Preserve the native API field type for display and transformation purposes.

```typescript
import { CONNECTOR_DATA_TYPE } from '@spinner/shared-types';

fieldSchema[CONNECTOR_DATA_TYPE] = 'RichText'; // Webflow
fieldSchema[CONNECTOR_DATA_TYPE] = 'multipleAttachments'; // Airtable
```

### `x-scratch-max-length`

Preserve the maximum length of a string field as enforced by the external service (e.g. PostgreSQL `VARCHAR(n)` / `CHAR(n)`). The value is the maximum number of characters allowed.

```typescript
import { MAX_LENGTH } from '@spinner/shared-types';

fieldSchema[MAX_LENGTH] = 11; // VARCHAR(11)
```

### `x-scratch-foreign-key`

Define relationships between tables.

```typescript
import { FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';

fieldSchema[FOREIGN_KEY_OPTIONS] = {
  linkedTableId: 'other_database_id',
};
```

**Annotate the id LEAF, not the envelope.** The resolver reads the value at the annotated path and
expects the referenced record's id (or a list of them). If the service wraps the reference —
Notion's `relation: [{ id }]`, Attio's `[{ target_record_id }]` — annotate the inner id and let the
column's view codec / `displayTransformer` extract it. Annotating the wrapper makes the resolver
read the wrapper.

**When the value is NOT the target's remote id, say so with `targetKeyPath`.** Some services name a
reference's target by another field: Framer's Server API reads a reference back as the target
item's **slug**, and a Postgres foreign key may be declared onto a non-primary-key unique column.
Store the value verbatim (Prime Directive) and declare how it names its target:

```typescript
fieldSchema[FOREIGN_KEY_OPTIONS] = {
  linkedTableId: 'other_collection_id',
  targetKeyPath: 'slug', // dot path IN THE TARGET RECORD that this value matches
};
```

The sync's FK phase then indexes the referenced folder by that path before resolving. Contract:

- **Absent ⇒ the value is the target's remote id** (the value at the target spec's `idPath`). That
  is the default and what most connectors want — omit it.
- **The path must be unique across the target's records.** Two targets sharing a value is a data
  error: the reference fails with the collision named, rather than linking one of them at random.
- **Exact match, and no fallback.** No case folding or trimming, and a declared key never falls
  back to id matching — so resolution stays predictable.
- This is about the value's *semantics*, not its *shape*. A wrapped id is the leaf-annotation case
  above; do not use `targetKeyPath` for it.

### `x-scratch-suggested-transformer`

Hint that the system should auto-apply a transformation when this field is selected as a **source** in the sync editor.

```typescript
import { SUGGESTED_TRANSFORMER } from '@spinner/shared-types';

fieldSchema[SUGGESTED_TRANSFORMER] = { type: 'notion_to_html' };
```

### `x-scratch-suggested-in-transformer`

Hint that the system should auto-apply a transformation when this field is selected as a **destination** in the sync editor.

```typescript
import { SUGGESTED_IN_TRANSFORMER } from '@spinner/shared-types';

fieldSchema[SUGGESTED_IN_TRANSFORMER] = { type: 'html_to_notion' };
```

### `x-scratch-remote-field-id`

Store the remote field ID from the external service (e.g., Airtable `fldXXX`, Webflow hex hash, Notion property ID).

```typescript
import { REMOTE_FIELD_ID } from '@spinner/shared-types';

fieldSchema[REMOTE_FIELD_ID] = 'fld12345abc';
```

### `x-scratch-virtual-fields`

Define human-readable shortcuts for complex nested fields. Each virtual field provides a display label and a pre-configured transformer.

```typescript
import { VIRTUAL_FIELDS } from '@spinner/shared-types';
import { VirtualFieldDef } from '@spinner/shared-types';

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
import { ASSET_FIELD, AssetFieldOptions } from '@spinner/shared-types';

fieldSchema[ASSET_FIELD] = {
  idPath: 'id', // JSONPath to stable ID within each item (null = use URL hash)
  urlExpires: true, // Whether the asset URL expires (e.g. Airtable ~2hr)
} satisfies AssetFieldOptions;
```

### `x-scratch-asset-table`

Mark a table whose records ARE assets (e.g., WordPress media, Webflow Assets). Unlike `x-scratch-asset-field`, this annotates the entire table spec rather than individual fields.

```typescript
import { ASSET_TABLE, AssetTableOptions } from '@spinner/shared-types';

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

### `x-scratch-agent-instructions`

A plain-text hint an LLM agent (Claude, Gemini, etc.) will read when working with this field or object in the workspace. The string is propagated unchanged into the on-disk `schema.json` that agents consult before editing records; no UI surface consumes it.

Reach for this annotation **sparingly** — only when a connector quirk would otherwise mislead an agent. Good fits include an enum where only a subset of values matter, a soft relationship between two fields that JSON Schema can't express, or a parent/child convention that isn't obvious from the structure. Do not duplicate `description` (which is for everyone, including humans in the UI); do not use it for end-user docs or validation rules. If you're not sure whether to add one, don't — absence is the common case.

```typescript
import { X_SCRATCH_AGENT_INSTRUCTIONS } from '@spinner/shared-types';

const authorSchema = Type.Object(
  {
    /* ...fields... */
  },
  {
    [X_SCRATCH_AGENT_INSTRUCTIONS]:
      'Author `type` is one of "user", "admin", or "bot". "user" and "admin" represent ' +
      'human participants and are almost always what matters; "bot" entries come from ' +
      'automated flows and are usually safe to skip when summarizing a conversation.',
  },
);
```

Place the annotation at the _object_ level when the hint spans multiple fields, and at the _field_ level when scoped to a single value.

### Reading annotations back: escape JSON Pointer segments

Connectors typically look up these annotations at publish time by building a JSON Pointer and calling `ValuePointer.Get` / `ValuePointer.Has` from `@sinclair/typebox/value` — e.g. `isReadonlyField`, `isForeignKey`, `getForeignKeyOptions`.

**Any field name interpolated into a pointer path must be RFC 6901-escaped.** Per [RFC 6901 §3](https://datatracker.ietf.org/doc/html/rfc6901#section-3), `~` must be encoded as `~0` and `/` as `~1` (in that order — encode `~` first). Without this, a field whose name contains `/` or `~` (e.g. Airtable's `Date/heure de création`) walks the wrong sub-tree, `Get` returns `undefined`, the readonly/foreign-key check silently returns `false`, and the field leaks through into the write payload.

Use the shared helper for every interpolated segment:

```typescript
import { escapePointerToken } from '../../utils/json-pointer';

export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `/properties/${escapePointerToken(field)}/${X_SCRATCH_READONLY}`) === true;
}
```

If the field name is a dot-notation path through nested objects (e.g. YouTube's `snippet.channelId`), escape each segment independently before joining with `/properties/`.

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

### Live-API Integration Tests (Recommended for Connectors That Write)

Smoke tests + fakes catch shape regressions in our own code, but they only test what the fake models — and a fake is just our guess at the real API. Live-API integration tests catch the bugs the fake can't: write-shape mismatches, undocumented required fields, asymmetries between read and write payloads, and silent server-side coercion (the kind that lets a wrong write succeed but store the wrong value — see commit `d0bdbc9` for an example where the WordPress connector was sending `rendered` instead of `raw` and the API silently accepted it).

These tests live in `server/test/integration/<service>-connector.spec.ts`, use a separate Jest config (`server/test/integration/jest-integration.json`), and read credentials from `server/.env.integration`. They are **gated on the credential being present** (`describeIfKey = API_KEY ? describe : describe.skip`) so CI stays green when the key isn't configured.

- [ ] Add `<SERVICE>_API_KEY` (or equivalent) to `.env.integration`
- [ ] Create `server/test/integration/<service>-connector.spec.ts`
- [ ] Run with `cd server && yarn test:integration -- <service>-connector`

**Test coverage targets**

For connectors that write, the integration spec should round-trip every expected object × every CRUD action — and every test record should carry one value of each writable field type, so the field-type coverage falls out of the same handful of tests instead of multiplying combinatorially.

- [ ] **Object × CRUD**: one test per (object, action) — e.g. `companies × {create, read, update, delete}`. Each test creates a hermetic scratch record, exercises the action, then deletes it on teardown.
- [ ] **Field-type coverage**: each test record sets one value of each universal field type the connector exposes (text, number, checkbox, select, date, currency, etc.). Object-specific types (e.g. a status pipeline only on deals, a personal-name only on people) are tested via the system built-ins where they naturally live.
- [ ] **Round-trip assertions**: write a value → read it back → assert the read deserializes to the same value. Many APIs accept terse write shapes (`{ option: "Lead" }`) and return expanded read shapes (`{ option: { id, title: "Lead", ... } }`); a per-type matcher that strips metadata and normalizes references is what makes the assertion meaningful.
- [ ] **Custom fields, separately** (services that have them — CRMs especially): custom fields are a distinct surface that system-field tests don't cover (see [Custom Fields](#custom-fields-crms-and-similar)). Round-trip create + edit + publish-back of a custom field across object types **and** field types, provisioning a throwaway custom field in the bootstrap script if the account has none. Pipedrive's spec creates a temporary custom field on `persons` and asserts an edited value is live after publish — the exact DEV-10353 scenario.
- [ ] **List / sub-resource CRUD** (where applicable): exercise list-entry or sub-resource writes separately if they go through different endpoints.

The unit of testing is _object × action_, not _object × action × field type_ — the field-type dimension is absorbed into each test record. This keeps the test count linear (~3 objects × 4 actions = 12 tests) instead of combinatorial (3 × 4 × ~15 types = 180 tests).

**Bootstrap script**

Live-API tests need real workspace state — sample records, custom attributes covering every field type, lists or sub-resources. Provision that state with an **idempotent bootstrap script** at `server/scripts/bootstrap-<service>-test-data.ts`.

- [ ] Reads credentials from `.env.integration`
- [ ] Every step checks for existing state first and only creates what's missing — re-running is safe and a no-op when the workspace is already bootstrapped
- [ ] Names everything with a clear `Spinner Test ` / `spinner_test_` prefix so leftovers from failed test runs are easy to find and bulk-delete in the upstream UI
- [ ] Documents how to clean up (UI delete, or curl invocation) in a header comment

The bootstrap script doubles as living reference for the connector's write semantics — it exercises every required-attribute, every option-creation subresource, every shape gotcha the connector also has to handle. The right discoveries to encode here: required attributes you have to satisfy on creation, sub-resources that look declarative but actually require sequential calls (e.g. `select` options usually have to be added after the attribute exists, even if the attribute-creation payload accepts an `options` array), and any read-shape vs. write-shape asymmetries.

See `server/test/integration/attio-connector.spec.ts` and `server/scripts/bootstrap-attio-test-data.ts` for a complete reference implementation.

### Connector Metadata Example

The `connectorMetadata()` helper (from `@spinner/shared-types`) merges your overrides with sensible defaults (`table: 'table'`, `record: 'record'`, `base: null`, `bases: null`, `visible: true`, `pushOperationName: 'Publish'`, `pullOperationName: 'Download'`, `defaultAuthMethod: 'oauth'`). You must provide `displayName` and `logo`.

**`credentialFields`** declares the form fields the client renders for each auth method. It is a `Partial<Record<AuthMethod, ConnectorSettingDefinition[]>>` — keys are auth methods (`'oauth'`, `'user_provided_params'`, `'oauth_custom'`), values are arrays of `ConnectorSettingDefinition`. Field types: `'string'` (text input), `'password'` (masked input), `'boolean'` (checkbox), `'string-list'` (repeatable text rows with add/remove controls; `required` means ≥1 non-empty row, each row optionally validated against `itemPattern`/`itemPatternDescription`, and the rows are newline-joined into one string on the wire — see Google Sheets' spreadsheet-URLs field). A `string-list` field may also declare `extrasKey`: its rows then persist VERBATIM as a `string[]` under `ConnectorAccount.extras[extrasKey]`, which makes the field editable after connect — the edit-connection modal prefills the rows from extras and rewrites them on save, all generically (derive whatever you need from the rows server-side at read time).

**`supportedAuthMethods`** and **`defaultAuthMethod`** on the metadata control which auth options the client shows. Note that `supportedAuthMethods` also appears in the `connectorRegistry.register()` call.

**`setupGuide`** (optional) adds a prominent link above the credential fields in the connection modal. Use it when the auth flow requires the user to perform setup steps in an external system (e.g., creating a custom app, generating API keys). It takes `{ label: string; url: string }` — the URL can be an absolute path within Scratch (e.g., `/shopify-custom-app`) or an external link.

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
    setupGuide: { label: 'Setup Guide', url: '/my-service-setup' }, // optional — link shown above credential fields
    credentialFields: {
      user_provided_params: [
        // `label` is required and names the credential (e.g. "API Key", "Access
        // Token"). Set `placeholder` ONLY when the value has a distinctive,
        // recognizable shape — a prefix or format the user can match against
        // what they already hold (e.g. `pat-na1-...`, `postgres://user:password@host`).
        // Do NOT use the placeholder to repeat an instruction like "Enter API Key";
        // if the token is shapeless (a bare UUID or random string), omit it.
        { key: 'apiKey', type: 'password', label: 'API Key', required: true },
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

### Rate Limiting

Rate limiting has two halves and a connector needs **both**. Declaring `rateLimiterSpec` only gets you the first.

1. **Proactive** — `rateLimiterSpec` on the registration feeds a Redis token bucket shared by every request for that connector account; `RateLimiter.waitForQuota()` waits for room before each call.
2. **Reactive** — wrap every API call in `RateLimiter.withRetry(fn, opts)`, falling back to the standalone `withRetry` when no limiter is available (no spec, or Redis down). Proactive quota alone is never sufficient: the bucket counts only what *this* connection spends, while the service counts everything hitting the same account — a concurrent publish, a second Scratch connection, the customer's other integrations. A 429 can and does arrive with our own bucket half full, and with no retry a single one fails the folder and the whole routine step.

```typescript
export const MY_SERVICE_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => parseRetryAfterHeader(error), // omit entirely if the service sends none
  defaultCooldownS: 5, // how long to freeze the shared bucket when there is no Retry-After
};

private async requestWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  return this.rateLimiter
    ? this.rateLimiter.withRetry(fn, MY_SERVICE_RETRY_OPTS)
    : standaloneWithRetry(fn, MY_SERVICE_RETRY_OPTS);
}
```

Modelling the spec (`attio-api-client.ts` and `quickbooks-api-client.ts` are worked examples):

- **Prefer a per-second window.** `RateLimiterRedis` is a *fixed* window, so `{ points: 450, duration: 60 }` lets the whole minute's budget be spent at the end of one window and again at the start of the next — 900 requests in ~2s, all nominally in quota. `{ points: 7, duration: 1 }` holds the same ceiling with no burst.
- **State `maxConcurrency` when the service documents one.** A cap on *simultaneous* requests (QuickBooks: 10 per realmId) is a separate constraint from the per-window quota and is throttled on its own. Parallel folder pulls respect it; without it, fan-out falls out of `ceil(points / duration)`, which is only a heuristic.
- **Size `defaultCooldownS` and the retry ladder against the service's window.** A per-minute quota needs a cooldown and enough retries to outlast a full window reset; a per-second one does not.

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

> **Default behavior:** New connectors should use `changedFields` for updates and only fall back to the full file as a last resort (when `changedFields[i]` is `undefined`). Sending the full record on every update causes spurious writes, masks bugs in unrelated fields, and risks API rejections on unchanged read-only fields.

`updateRecords` receives an optional third parameter: `changedFields?: (Record<string, unknown> | undefined)[]`. This is a parallel array where `changedFields[i]` is a deep sparse object containing only the fields that changed for `files[i]`, with properly transformed values (FK resolution, transformers, etc. already applied).

**How it works:**

- When `changedFields` is provided, connectors **should** use it directly as a partial payload — it contains only the changed paths with correct values
- When `changedFields` is `undefined` (legacy plans, non-V2 publish paths), connectors fall back to sending the full file content as a last resort
- The sparse object preserves nested structure: e.g., `{ properties: { email: "new@ex.com" } }` for a HubSpot record where only `email` changed within `properties`
- `files` always contains the full resolved record content — the source of truth for git commits and any fields not in `changedFields`

**Removed keys are not tracked:** Keys present in the main branch but absent in the dirty branch are intentionally not included in `changedFields`. Users should set fields to `null` or `""` to clear them, not delete JSON keys. Key removal typically indicates schema changes or reference cleaning.

**Canonical pattern:**

```typescript
async updateRecords(
  tableSpec: BaseJsonTableSpec,
  files: ConnectorFile[],
  changedFields?: (Record<string, unknown> | undefined)[],
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    // Prefer the sparse partial; only fall back to the full record when
    // `changedFields` isn't available (legacy publish paths).
    const payload = changedFields?.[i] ?? files[i];
    await this.client.update(files[i].id, payload);
  }
}
```

### Read-Only Fields on Publish

> **Legacy behavior (do not replicate):** Several existing connectors silently strip read-only fields before sending data to the API. This masks user errors and should be removed. With `changedFields` now available on `updateRecords`, connectors can send only the fields the user actually changed, avoiding API rejections from unchanged read-only fields without silently masking real edits.

### Custom Fields (CRMs and similar)

> **Treat custom fields as their own surface, and test them separately.** Services with user-defined custom fields — CRMs especially (Pipedrive, Moco, HubSpot, Attio, Copper, …) — almost always handle them differently from built-in system fields. A connector whose system-field CRUD round-trips cleanly can still **silently drop or corrupt every custom-field write** (this is exactly what happened in DEV-10353, where the Pipedrive connector shipped an empty PATCH body for custom-field edits while system-field edits worked). System-field tests do not cover custom fields. Write dedicated ones.

Why custom fields behave differently:

- **They live in a dedicated container, not at the top level — and the container varies by service, and sometimes by API version within one service.** Pipedrive v2 nests them under a `custom_fields` object; Pipedrive v1 (leads) carries them as flat top-level keys; Moco puts them under `custom_properties`. The publish diff mirrors whatever shape the record uses on disk, so the write path has to carry that container through — not skip it as an unknown key.
- **Keys are opaque, not the human field label.** Pipedrive references each custom field by a randomly generated 40-character hash (discovered via a per-entity Fields endpoint); Moco uses the user's own property names. Don't hardcode them, and don't assume a key is a system field just because it isn't a recognizable name.
- **Discovery varies.** Some services expose a Fields/metadata endpoint so you can discover each custom field and its type (Pipedrive's `*Fields`); others give you no introspection at all, so the schema is an open map — Moco models `custom_properties` as `Type.Record(Type.String(), Type.Unknown())`. With no metadata you can't type-check or validate up front; the value rides through as-is.
- **Per-type value encoding, and read ≠ write.** Each custom field has a type, and structured types (monetary, address, date-range, multi-select) often serialize differently than scalars — and sometimes differently on read vs. write. A partial diff into a structured value can clobber the sibling subfields, and clearing semantics can be type-specific (Pipedrive's multi-select `set` clears with `null`; sending `[]` is a validation error). These are the asymmetries the [live-API tests](#live-api-integration-tests-recommended-for-connectors-that-write) exist to catch.

What to do:

- **Default to pushing the stored shape through verbatim.** Because we [store the raw API response](#the-connector-prime-directive-store-raw-api-responses) and most services' read and write shapes match, the on-disk record (and the `changedFields` diff derived from it) is usually already in the exact shape the write API wants — including the custom-field container. Prefer that over re-separating system vs. custom fields and rebuilding the body; the rebuild is where wrappers get dropped. (The Pipedrive connector was simplified to do exactly this — see `library/pipedrive/pipedrive-api-client.ts`.)
- **Verify the read==write assumption per service**, since the asymmetries above are real. Where a structured type's write shape differs from its read shape, adapt at the write boundary, not by reshaping stored data.
- **Test custom fields explicitly** — their own create + edit + publish-back round-trips, across object types **and** field types, asserting the value is actually live in the service after publish (not just that the request returned 200). See the testing call-out below.

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
├── <service-name>-default-view.ts    # Default view builder (see Section 8)
├── conversion/                       # Field type conversion utilities (if needed)
└── __tests__/                        # Tests
```

## 8. Default Views

Every connector should override `buildDefaultView(spec)` on its `Connector` class. The default view controls which columns appear in the grid, their order, display names, type hints, and visibility when the user first opens a table. Without one, the client falls back to an auto-generated view that shows every field alphabetically with no type hints — not a good first impression. Return `undefined` for a table that has no curated view (the base method's default), and no `views/default.json` is written for it.

> **Default-view generation is a pure `spec → view` stage.** `buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined` receives **only the spec** (its JSON schema — including `x-scratch-*` annotations — plus the wrapper metadata: `id`, `slug`, `titlePath`, `idPath`, `slugPath`, …). It **must not read raw API input**; the compiler enforces this, since the raw payload simply isn't in scope. Schema-gen (`fetchJsonTableSpec`) therefore **does not** build or attach the view — it only produces the spec. This realizes the project's `api → schema → view` pipeline: the schema _describes_ the data; the view _editorializes_ it. Because the view is a function of the spec alone, a checked-in `views/default.json` can always be regenerated from the schema and can never silently drift from the generator.
>
> - **Editorial choices are CODE in the builder, keyed off the entity type** (`spec.id` / `spec.slug`) — never passed-in config, and never a schema annotation invented just for view-building. Which fields lead, which get grouped under a banner, which stay hidden, and which entity variant a table is are all decided in code from the spec's identity.
> - **If the view genuinely needs a value the schema doesn't already carry, add an `x-scratch-*` annotation in the schema stage** — a _faithful fact about the field the service reports_ (e.g. Zoho's `x-scratch-custom-field` for standard-vs-custom provenance, Airtable's lookup result type), never a display opinion pushed into the schema (that would violate the Connector Prime Directive). The builder then reads that annotation back. Do this only when the fact is real data, not editorial.

### Types

See the types in `/packages/shared-types/src/connector/table-view.ts`. Comments there explain how and when to use them.

### Overview

Override `buildDefaultView(spec)` on your connector class to return a `TableView` built purely from the spec. The write sites (create-folder, pull, refresh-schema) call it — after re-applying any user id/name field overrides onto `spec.idPath`/`spec.titlePath` — and write the result to `views/default.json` in the workbook's git repo on every pull. Put the builder logic in a dedicated file (`<service-name>-default-view.ts`) that takes the spec (or its schema) and add tests in `__tests__/<service-name>-default-view.spec.ts`.

### Design Principles

**0. Make the table immediately recognizable.** The user should open this up and say "AHA! That's my data!". Ensure the first screen of ~5 columns contains real user-meaningful data and not only IDs, dates, and metadata that will be hard to relate to. Focus on columns that a user of this service will interact with frequently and identify each record in the user's mind.

**1. Schema-driven, not hardcoded.** Read the TypeBox schema produced by your `fetchJsonTableSpec()` to discover fields dynamically. This way new fields added by the service appear automatically. Only use hardcoded lists for _ordering_ and _visibility_ preferences, not for defining which columns exist.

**2. Title column first.** The field identified by `titlePath` in the table spec should always be the first visible column. This is the field users recognize each record by (e.g. `name`, `email`, `title`). If the connector already has per-entity `titleFieldPath` or similar config, use it to find and prioritize that column.

**3. Priority ordering.** Define a priority list of important fields that should appear first (after the title column). Fields not in the list go after, sorted in the order they appear from the server, or worst-case, alphabetically. This gives users a sensible default column order.

**4. Hide less important fields.** System fields, timestamps, internal IDs, and metadata should be hidden by default. The user can always show them via the column picker. It's better to start clean and let users add columns than to overwhelm them with 40 columns.

**5. Map types from schema annotations.** Use `x-scratch-connector-data-type` annotations on the schema to determine the correct `TablePropertyType`. Fall back to JSON Schema `format` hints when the annotation is missing.

**6. Use subfields for compound objects.** Some fields contains multiple representations of a single value. For example, WordPress text appears as `{ raw, rendered }`, or Shopify numbers appear as `{ count, precision }`. We want the user to see these as a single column, which is populated with the user-facing "real" data. This is done with subfields. Create a subfield for each primitive field in the object, and set the `selectedSubfield` to default to the friendliest, most meaningful, most useful, hopefully-not-readonly subfield.

**7. Use banner groups sparingly.** Groups add visual structure but also complexity. Use them when a service has a clear logical grouping that users expect (e.g. address fields, SEO metadata). Don't group for the sake of grouping — a flat column list is often clearer.

**8. Mark readonly (and write-once) fields.** Read the `x-scratch-readonly` annotation from the schema and propagate it to the column — this prevents users from trying to edit computed fields. Do the same for `x-scratch-write-once` (copy it onto the `TableViewCol`): the frontend renders a write-once column as editable on a brand-new record and read-only once the record exists. Drive both from the schema annotation rather than a hardcoded field list, so there is one source of truth.

**9. Format display names.** Convert field IDs to human-readable names: `featured_media` → `Featured Media`, `fieldData.slug` → `Slug`.

### Handling Nested / Expanded Fields

Some connectors have nested structures that should be expanded into top-level columns. For example, WordPress has an `acf` (Advanced Custom Fields) object whose sub-properties each become their own column with a dotted path. When deciding what should be a top-level field, imagine if a user of this service will think of it as a standalone field (ex: fieldData.<fieldName> or acf.post_name), vs if they will think of it as a property of a different field (ex. feature_image.width). When there are a lot of standalone fields that still 'belong' together, consider putting them in a Banner Group.

### Testing

Write unit tests that build a realistic schema and verify the view output.

### Reference Implementation

See `library/wordpress/wordpress-default-view.ts` and its tests in `library/wordpress/__tests__/wordpress-default-view.spec.ts` for a complete example covering priority ordering, hidden fields, subfields, type mapping, and nested field expansion.

## 9. Migrating Existing Data When a Connector's Layout Changes

Sometimes a connector change is not backward-compatible with data already pulled into existing workbooks — most commonly a **folder-layout change** (e.g. re-parenting collections under a `/<Site>/Collections/` grouping, DEV-9698). New workbooks pick up the new layout automatically, but existing ones need a one-time **migration** that moves their folders and rewrites every path that points at them. Do this with the established playbook below rather than inventing a one-off — it is idempotent, crash-safe, and never races live pipeline activity. Reference implementation: the `webflow-folder-restructure` migration in `server/src/code-migrations/`.

### Step 1 — Version-pin the layout (no mixed-layout window)

Bump the connector's `ConnectorRegistration.version` (`connector-registry.ts`). The current code version is snapshotted onto `ConnectorAccount.version` at account creation (DEV-10302). The connector emits the **old** layout for accounts pinned to the old version and the **new** layout for the new version (drive this off a `BaseJsonTableSpec.structureVersion` the builders read — never an `if (service === X)` branch in `DataFolderService`). The migration flips an account's `version` to the new value only **after** all its folders have moved, so a connection is always atomically all-old or all-new, never mixed. Keep the old-vs-new path derivation in **one shared helper** used by both the connector and the migration, so the path a fresh pull writes can never drift from the path the migration moves a folder to.

### Step 2 — Write the migration in the `code-migrations` framework

Register it in `server/src/code-migrations/` (admin-gated `POST /code-migrations/run`, with `dryRun` + `qty`/`ids` batching + audit logging; model on an existing migration). Make it:

- **Idempotent** — gate each unit of work on a per-folder version column (`DataFolder.version`); a folder already at the new version is skipped. Re-running converges.
- **Crash-safe** — order writes so the idempotency key only advances in the **same atomic transaction** as the path rewrite. A crash between the git move and the DB commit leaves the key un-advanced; a re-run recomputes the same target, finds the git move already done (the move route is a no-op when the source is gone), and finishes the commit.
- **`dryRun`-able** — return the would-be moves without touching git or the DB, so you can canary against real data read-only before running for real (you can even replicate the dryRun read-path against a read-only DB replica).
- **Account-atomic** — process a whole connector account in one pass (don't split an account across `qty` batches), so move-ordering constraints hold and the version flip is reached.

### Step 3 — Quiesce each connection for the duration of its migration

A folder move must not race a live edit or an in-flight job, or a write lands at the old path and is orphaned. Wrap **each connection's** migration in a quiesce/release pair (the reusable `ConnectionQuiesceService` + `MigrationLockService`):

```
acquire (quiesceConnection):
  1. set ConnectorAccount.migrationLockedAt = now   → gates live edits + new job enqueues (409 "blocked_migrating")
  2. disable + MARK the connection's schedules        (persist prior state via a marker column)
  3. cancel every non-terminal PublishPlan            (so a resumed publish can't commit to old paths)
  4. cancel + DRAIN in-flight jobs                    (wait for the BullMQ `active` set to clear, not just DB status)
  → migrate the account's folders, then flip ConnectorAccount.version  (while still locked)
release (unquiesceConnection, in a `finally`):
  5. restore the schedules this migration disabled    (marker-driven → crash-safe)
  6. clear migrationLockedAt
  7. emit a workbook event so open clients refresh the relocated tree
```

Key invariants:

- **The lock is the single gate.** `MigrationLockService.assertConnectionNotMigrating(connectorAccountId)` is called from the live-edit write paths (web file CRUD, CLI `/upload-patch/commit`); `assertEnqueueAllowedForJob(jobData)` is called from the one job-enqueue chokepoint (`BullEnqueuerService.createAndEnqueue`). The enqueue gate has a fast-path no-op when nothing is locked, so it is essentially free in normal operation.
- **Flip the version BEFORE releasing.** If you restore schedules / unlock before flipping, a restored schedule could fire an old-layout pull that re-creates the folders you just moved.
- **Draining means waiting for the worker to actually stop.** Setting a job's DB status to `canceled` does not stop a worker mid-batch; poll the live `active` set until the connection has none. A connection whose jobs won't drain within the timeout is **released and skipped** (retried on a later run) rather than migrated unsafely.
- **Crash-repair is marker-driven.** Persist "this migration disabled this schedule" as a column marker (not just in memory), so a re-run after a crash re-enables exactly the schedules the migration disabled and leaves user-disabled ones alone. The connection lock is strict-by-design (no auto-expiry); a re-run (or a manual clear) releases a lock a hard crash left set.

### Step 4 — Local checkouts (desktop / CLI)

Path-changing moves invalidate stale local clones. The server already rejects uploads to an unknown path (`validateRecordPath`), so a stale binary fails loudly rather than silently — surface an actionable "re-clone" message, and salvage un-uploaded local work before any forced re-clone.
