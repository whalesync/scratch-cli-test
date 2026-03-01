# Whalesync to Scratch Sync Migration

## Problem

Many Whalesync users want to migrate to Scratch. We need a way for them to convert their existing Whalesync syncs into Scratch syncs, with clear caveats about what translates and what doesn't.

## Goals

- User specifies a Whalesync sync (CoreBase) and gets a Scratch-compatible `SyncMapping` JSON
- Clear list of caveats where the Scratch sync isn't an exact replacement
- Clear list of prerequisites (e.g., "connect this Airtable base in Scratch first")

## Key Differences Between Whalesync and Scratch Syncs

| Aspect               | Whalesync                                                    | Scratch                                                                                                |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Direction**        | Bidirectional (`both`) or one-way (`left`/`right`)           | One-way only (source → destination)                                                                    |
| **Architecture**     | Two-sided (left ↔ right) with a core intermediary           | Source folder → destination folder                                                                     |
| **Sync model**       | Continuous, live sync between two external APIs              | Discrete runs, operates on files in git storage                                                        |
| **Delete behavior**  | `sync` (propagate) or `do_nothing`                           | No equivalent                                                                                          |
| **Filters**          | Rich condition groups (AND/OR, operators) on table mappings  | No equivalent                                                                                          |
| **Column direction** | Per-column direction control                                 | All columns go source → destination                                                                    |
| **Selective sync**   | Checkbox column gates which records sync                     | No equivalent                                                                                          |
| **Transforms**       | `syncToCoreTransforms` / `syncToExternalTransforms` (opaque) | Typed transformers (`string_to_number`, `source_fk_to_dest_fk`, `lookup_field`, rich text conversions) |

## Architecture

Two components, built independently:

### 1. Whalesync Export Endpoint (bottlenose)

A new endpoint in `api/bottlenose/` that exports a sync's full configuration as a clean, denormalized JSON document.

- **Endpoint**: `GET /rest/core-bases/:coreBaseId/export`
- **Auth**: API token (`Authorization: WS-API-Token <TOKEN>`)
- **Returns**: A `WhalesyncSyncExport` JSON — a self-contained document organized around what matters for migration (not Whalesync internals)

The export flattens Whalesync's internal model (CoreBase → CoreTable → CoreColumn → ColumnMapping → ExternalColumn) into a simpler structure organized by table pairs and column pairs, with all remote IDs included.

#### Export Shape

```typescript
type WhalesyncSyncExport = {
  version: 1;
  exportedAt: string; // ISO 8601

  sync: {
    id: string;
    name: string;
    syncState: string;
  };

  sources: {
    left: WhalesyncExportSource | null;
    right: WhalesyncExportSource | null;
  };

  tablePairs: WhalesyncExportTablePair[];
};

type WhalesyncExportSource = {
  connectorType: string; // e.g., 'airtable', 'webflow', 'notion'
  displayName: string;
  browserUrl: string | null;
  remoteBaseId: string; // Remote ID of the base/site/workspace

  tables: WhalesyncExportTable[];
};

type WhalesyncExportTable = {
  id: string; // Whalesync ExternalTable ID
  name: string;
  remoteId: string; // Remote ID of the table in the external service
  connectorType: string;
  supportsWrite: boolean;

  columns: WhalesyncExportColumn[];
};

type WhalesyncExportColumn = {
  id: string; // Whalesync ExternalColumn ID
  name: string;
  remoteId: string; // Remote ID of the column in the external service
  connectorType: string;
  dataType: string;
  typeMetadata: unknown;
};

type WhalesyncExportTablePair = {
  leftTableId: string; // References WhalesyncExportTable.id
  rightTableId: string;

  syncDirection: "left" | "right" | "both" | "invalid";
  leftDeleteBehavior: "sync" | "do_nothing";
  rightDeleteBehavior: "sync" | "do_nothing";

  /** Connector-specific table config (e.g., subtable selection) */
  leftSelectedConfigExtras: Record<string, unknown> | null;
  rightSelectedConfigExtras: Record<string, unknown> | null;

  /** Filter conditions, if any */
  filter: SyncFilterConditionGroup | null;

  columnPairs: WhalesyncExportColumnPair[];
};

type WhalesyncExportColumnPair = {
  leftColumnId: string; // References WhalesyncExportColumn.id
  rightColumnId: string;

  syncDirection: "left" | "right" | "both" | "invalid";
  initializeOnMergeWinner: "left" | "right" | "either";

  /** Transform arrays — currently unused/empty in practice */
  transforms: {
    leftToCoreTransforms: string[];
    leftToExternalTransforms: string[];
    rightToCoreTransforms: string[];
    rightToExternalTransforms: string[];
  };
};

type SyncFilterConditionGroup = {
  readonly type: "group";
  id: string;
  logicalOperator: "AND" | "OR";
  conditions: (SyncFilterCondition | SyncFilterConditionGroup)[];
};

type SyncFilterCondition = {
  readonly type: "condition";
  id: string;
  columnMappingId: string;
  operator: string;
  value: unknown;
};
```

#### Implementation Notes (Bottlenose)

- Uses the existing `SyncCluster` Prisma include pattern in `cluster-types.ts` to fetch the full sync graph
- New controller + service in `src/rest/core-bases/` (or a new `src/rest/sync-export/` module)
- Auth via `APITokenAuthGuard` (existing strategy: `Authorization: WS-API-Token <TOKEN>`)
- The flattening from CoreTable/CoreColumn intermediary to direct ExternalTable/ExternalColumn pairs happens in the entity/serialization layer

### 2. Scratch Import Module (spinner/server)

A service in `spinner/server/src/sync/whalesync-import/` that converts the Whalesync export into a Scratch sync.

- Takes a `WhalesyncSyncExport` and a `workbookId`
- Resolves DataFolders by matching remote IDs (connectorService + tableId)
- Produces a `SaveSyncBody` + caveats + prerequisites

#### Conversion Logic

Bidirectional Whalesync syncs produce **two** Scratch syncs (one per direction). One-way syncs produce one.

```typescript
class WhalesyncImportService {
  async convertSync(
    workbookId: WorkbookId,
    whalesyncExport: WhalesyncSyncExport,
  ): Promise<{
    /** One sync for one-way, two syncs for bidirectional (left→right + right→left) */
    syncs: SaveSyncBody[];
    caveats: Caveat[];
    unmatchedFolders: UnmatchedFolder[];
  }>;
}
```

For bidirectional table pairs (`syncDirection: 'both'`), two Scratch syncs are created:

- **Left→Right sync**: includes column pairs with direction `'left'` or `'both'`
- **Right→Left sync**: includes column pairs with direction `'right'` or `'both'`

One-way table pairs (`'left'` or `'right'`) only appear in the corresponding sync. When multiple DataFolders match the same remote ID, the first match is used.

#### DataFolder Resolution

The bridge between the two systems is **remote IDs**:

```
Whalesync ExternalBase.remoteBaseId  →  Scratch DataFolder (by connectorService + tableId)
Whalesync ExternalTable.remoteId     →  Scratch DataFolder (by connectorService + tableId)
Whalesync ExternalColumn.remoteId    →  Scratch DataFolder schema field (by field remoteId in JSON schema)
```

Both systems store the same remote IDs from external services (e.g., Airtable base ID, table ID, field ID), making automatic matching possible.

#### Caveat Generation

The converter should flag:

| Caveat                                          | Severity | When                                                            |
| ----------------------------------------------- | -------- | --------------------------------------------------------------- |
| Bidirectional sync split into two one-way syncs | warning  | `syncDirection: 'both'` on any table pair                       |
| Delete behavior not supported                   | warning  | `leftDeleteBehavior` or `rightDeleteBehavior` is `'sync'`       |
| Filter conditions not migrated                  | warning  | Table pair has a non-null `filter`                              |
| Non-empty transforms found (cannot be mapped)   | warning  | Any transform array is non-empty (currently unused in practice) |
| Invalid sync direction on table or column pair  | warning  | `syncDirection: 'invalid'`                                      |
| Connector type not supported in Scratch         | error    | Whalesync connectorType has no Scratch Service equivalent       |
| Table was read-only in Whalesync too            | info     | `supportsWrite: false` — one-way isn't a limitation             |
| Continuous sync → discrete runs                 | info     | Always — fundamental difference                                 |
| First-run data behavior requires user attention | info     | Always — existing data may need matching field configuration    |

#### Unmatched Folder Output

When a Whalesync ExternalTable can't be matched to a Scratch DataFolder:

```typescript
interface UnmatchedFolder {
  whalesyncTableName: string;
  connectorType: string;
  remoteBaseId: string;
  remoteTableId: string;
  browserUrl?: string;
  message: string; // e.g., "Connect your Airtable base 'Marketing' and pull the 'Campaigns' table"
}
```

## Connector Type Mapping

| Whalesync `connectorType` | Scratch `Service` | Notes              |
| ------------------------- | ----------------- | ------------------ |
| `airtable`                | `AIRTABLE`        | Direct match       |
| `webflow`                 | `WEBFLOW`         | Direct match       |
| `notion`                  | `NOTION`          | Direct match       |
| `postgres`                | `POSTGRES`        | Direct match       |
| `supabase-oauth`          | `SUPABASE`        | Direct match       |
| `hubspot`                 | —                 | Not in Scratch yet |
| `salesforce`              | —                 | Not in Scratch yet |
| `stripe`                  | —                 | Not in Scratch yet |
| `wordpressorg`            | `WORDPRESS`       | Name difference    |
| `affinity`                | —                 | Not in Scratch yet |
| `memberstack`             | —                 | Not in Scratch yet |
| `iapp_apollo`             | —                 | Not in Scratch yet |
| `iapp_attio`              | —                 | Not in Scratch yet |
| `iapp_sheets`             | —                 | Not in Scratch yet |

## Build Order

1. **Whalesync export endpoint** — Build and test independently against real syncs. Validate the export shape has everything needed.
2. **WhalesyncSyncExport type definition** — Define the input type in `spinner/packages/shared-types/` or `spinner/server/src/sync/whalesync-import/`.
3. **Scratch conversion service** — Build the mapping logic with unit tests using fixture data from the export endpoint.
4. **Scratch API endpoint** — Scratch server calls bottlenose export endpoint directly (server-to-server). User provides Whalesync API token + core base ID. Endpoint returns converted syncs + caveats as a dry run; does not create the syncs automatically.
5. **(Future) UI** — Import flow in Scratch's client.

## Resolved Questions

- **Server-to-server vs. client-passes-JSON?** → Server-to-server. Scratch calls bottlenose directly with user's Whalesync API token.
- **Duplicate DataFolder matches?** → Use first match. Rare case, not worth complicating.
- **Bidirectional → one or two syncs?** → Two separate Scratch syncs (one per direction), with column pairs distributed by direction.
- **Transform mapping?** → Not needed. Whalesync transform arrays are unused legacy fields (always empty in practice). Flag a caveat if non-empty.

## References

- Whalesync SQL export: `spinner/docs/migration/extract-whalesync-sync.sql`
- Whalesync sync markdown generator: `whalesync/dusky/routes/sync-detail/table-mapping-editor/generateMappingsMarkdown.ts`
- Scratch AI context generator: `spinner/server/src/sync/sync.service.ts:generateAiContext()`
- Scratch sync mapping types: `spinner/packages/shared-types/src/sync-mapping.ts`
- Scratch sync API types: `spinner/packages/shared-types/src/dto/sync/sync-api.ts`
- Bottlenose cluster types (Prisma includes): `api/bottlenose/src/db/cluster-types.ts`
- Bottlenose API token auth: `api/bottlenose/src/auth/api-token.strategy.ts`
