---
created: 2026-04-15
status: proposed
area: scratch-desktop
---

# Schema-Driven Column Metadata for Grid and Detail Views

## Problem

Today the desktop app derives columns for `FolderDataGrid` and field rows for `RecordDetailView` by **flattening the JSON content** of every record file in a folder and taking the **union of dot-paths seen in the data**. The code lives in [scratch-desktop/src/main/local-files.ts](scratch-desktop/src/main/local-files.ts) (`readGridData`, `flattenObject`, `flattenSchemaPropertyKeys`, `orderColumnsBySchema`) and [scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:674-687](scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx#L674-L687).

This produces several problems:

1. **Column noise** — Any one-off nested shape in a single record adds a permanent column for the whole folder. Connectors that nest optional objects (e.g. attachments, lookup arrays) leak low-value columns into the grid.
2. **No metadata** — Columns are just strings, so the grid and detail view cannot show display labels, read-only indicators, required markers, or type-aware formatting. `FolderDataGrid` currently uses the raw dot-path string as the column header title.
3. **Schema is already available** — `getFolderMetadata` in [scratch-desktop/src/main/local-files.ts:145](scratch-desktop/src/main/local-files.ts#L145) already loads `schema.json` from `.scratch/connections/scratch/<relPath>/schema.json`. Connectors emit rich JSON Schema with `x-scratch-*` extensions ([server/src/remote-service/connectors/json-schema.ts](server/src/remote-service/connectors/json-schema.ts)) but the desktop app uses that schema only for property ordering.
4. **Object/array fields render as `[object Object]`** — `toDisplayString` hides the value entirely for non-scalars; the desired behavior is a stable JSON stringification so users can at least see and search the contents.

We want `schema.json` to be the **source of truth** for the column set, and every record to be projected through a **normalized row shape** that carries pre-computed display strings alongside raw values.

## Goals

1. Define a `ColumnDefinition` model extracted from `schema.json` with stable id, display name, data type, and UI attributes (`readOnly`, `required`, plus pass-through connector hints).
2. Build a `NormalizedRecordRow` model that projects a raw record JSON into values keyed by column id, with stringified display values for object/array columns.
3. Replace the data-union column derivation in `readGridData` (and the diff reader) with schema-driven columns.
4. Update `FolderDataGrid` and `RecordDetailView` to consume `ColumnDefinition` for headers, labels, and read-only editor behavior.
5. Introduce a Vitest setup in `scratch-desktop` and cover the new pure utilities with unit tests driven by fixture `schema.json` files from multiple connectors.

## Non-Goals

- Full JSON Schema validation (`enum`, `pattern`, numeric ranges, format-specific coercion).
- Changing the on-disk format of `schema.json` or modifying any server connector.
- Type-aware cell editors (date pickers, multi-select chips). First pass keeps editing as plain-text; read-only enforcement is the only new editing behavior.
- Visible handling of virtual fields (`x-scratch-virtual-fields`). Pass metadata through but do not surface in the grid yet.

## Current State

Relevant anchors for the implementation:

| File | Reference | Purpose |
|------|-----------|---------|
| [scratch-desktop/src/main/local-files.ts:145](scratch-desktop/src/main/local-files.ts#L145) | `getFolderMetadata` | Loads `schema.json` and returns `FolderMetadata`. |
| [scratch-desktop/src/main/local-files.ts:405](scratch-desktop/src/main/local-files.ts#L405) | `readGridData` | Reads JSON files and derives columns from the **data union**. |
| [scratch-desktop/src/main/local-files.ts:544](scratch-desktop/src/main/local-files.ts#L544) | `flattenSchemaPropertyKeys` | Walks schema `properties` recursively into `type === 'object'`. |
| [scratch-desktop/src/main/local-files.ts:583](scratch-desktop/src/main/local-files.ts#L583) | `flattenObject` | Flattens record JSON into dot-paths; treats arrays as leaves. |
| [scratch-desktop/src/renderer/src/types/local-files.ts:21](scratch-desktop/src/renderer/src/types/local-files.ts#L21) | `FolderMetadata.schema` | Typed as `Record<string, unknown>`. |
| [scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:674](scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx#L674) | Column construction | Column title is the raw dot-path string. |
| [scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx:435](scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx#L435) | `fieldRows` | Iterates `columnOrder` and flattens the record with `flattenObject`. |
| [server/src/remote-service/connectors/json-schema.ts](server/src/remote-service/connectors/json-schema.ts) | `x-scratch-*` constants | Authoritative list of schema extension keys. |

The schema file on disk is a **table wrapper** object:

```jsonc
{
  "id": { "wsId": "...", "remoteId": [...] },
  "slug": "...",
  "name": "Semiprecious Stones",
  "schema": { "$id": "...", "type": "object", "required": [...], "properties": { ... } },
  "idColumnRemoteId": "id",
  "titleColumnRemoteId": [...],
  "basePath": [...],
  "generatedAt": "..."
}
```

The inner `schema` object is the JSON Schema that describes each record file on disk.

## Proposed Design

### 1. New module: `scratch-desktop/src/shared/schema-columns/`

A new shared directory (importable from both main and renderer, pure TypeScript, zero Electron imports) containing:

```
scratch-desktop/src/shared/schema-columns/
├── index.ts                         # re-exports
├── types.ts                         # ColumnDefinition, NormalizedRecordRow, enums
├── x-scratch-keys.ts                # constants mirrored from server/json-schema.ts
├── build-column-definitions.ts      # buildColumnDefinitions(schemaJson) → ColumnDefinition[]
├── project-record.ts                # projectRecordToNormalizedRow(raw, columns) → NormalizedRecordRow
├── format-cell.ts                   # formatCellForGrid(value, column) → string
└── __tests__/
    ├── build-column-definitions.test.ts
    ├── project-record.test.ts
    ├── format-cell.test.ts
    └── fixtures/
        ├── airtable-semiprecious-stones.schema.json
        ├── airtable-minimal.schema.json
        ├── webflow-collection.schema.json       (if available)
        ├── notion-database.schema.json          (if available)
        ├── postgres-users.schema.json           (if available)
        └── minimal-scalar.schema.json
```

The module is framework-free so it can be imported by `main` (for `readGridData`) and `renderer` (for grid/detail view formatting) without circular deps.

### 2. `ColumnDefinition` type

```ts
export type ColumnDataType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'unknown';

export interface ColumnAttributes {
  readOnly: boolean;
  required: boolean;
  /** Passed through from `x-scratch-connector-data-type` (e.g. `multipleRecordLinks`). */
  connectorDataType?: string;
  /** Passed through from `x-scratch-remote-field-id`. */
  remoteFieldId?: string | string[];
  /** Passed through from `x-scratch-foreign-key`. */
  foreignKey?: { linkedTableId: string };
  /** True when the column value originates inside a nested object (e.g. `fields.Stone`). */
  nested: boolean;
}

export interface ColumnDefinition {
  /** Stable dot-path id, e.g. `fields.Stone`. Matches the id used by the old flatten path. */
  id: string;
  /** Human label used as grid header and detail-view label. */
  displayName: string;
  /** Optional long description for tooltip. */
  description?: string;
  /** Normalized internal type. */
  dataType: ColumnDataType;
  /** Schema `format` (e.g. `date-time`) passed through when present. */
  format?: string;
  attributes: ColumnAttributes;
}
```

### 3. Extraction rules — `buildColumnDefinitions`

Input: the **table-wrapper object** (the full `schema.json`), not just the inner JSON Schema. The function unwraps `wrapper.schema` internally; if that is missing it returns an empty array (caller decides how to surface).

**Traversal**

- Start at the inner JSON Schema (`wrapper.schema`). Walk `properties` in declaration order.
- If a property has `type === 'object'` **and** a nested `properties` object, recurse using the same rule as `flattenSchemaPropertyKeys` today. This keeps the Airtable-style `fields.<Name>` layout working without changing on-disk paths.
- Every other property becomes a **leaf column** — including arrays, objects without `properties`, and scalars.

**Display name** (first non-empty wins):

1. `property.title` (standard JSON Schema field when present).
2. `property.description`.
3. The last segment of the dot-path (e.g. `Stone` for `fields.Stone`).

**Data type mapping**

- `type: 'string'` → `'string'`.
- `type: 'number'` → `'number'`.
- `type: 'integer'` → `'integer'`.
- `type: 'boolean'` → `'boolean'`.
- `type: 'array'` → `'array'`.
- `type: 'object'` **without** `properties` (or with `additionalProperties` only) → `'object'`.
- Missing/unknown type → `'unknown'`.
- Union types (`type: ['string', 'null']`) → pick the first non-`null` type; fall back to `'unknown'`.

**Attributes**

- `readOnly` ← `property[READONLY_FLAG] === true`.
- `required` ← property name is in the parent schema's `required` array (looked up at each recursion level).
- `connectorDataType` ← `property[CONNECTOR_DATA_TYPE]` if it is a string.
- `remoteFieldId` ← `property[REMOTE_FIELD_ID]`.
- `foreignKey` ← `property[FOREIGN_KEY_OPTIONS]` if shaped `{ linkedTableId: string }`.
- `nested` ← `true` when the column id contains a `.`.
- `format` ← `property.format` if present (`date-time`, `uri`, etc.).

**Ordering** — Schema declaration order, preserving the parent-before-child recursion. The title column promotion currently done in `FolderDataGrid` stays in the renderer (it reorders the list but does not change the metadata).

**Defensive parsing** — Every field lookup is defensive (`typeof` guards, no `as any`). Unknown or malformed properties degrade to `ColumnDataType = 'unknown'` with the raw key as display name. No throws.

### 4. `NormalizedRecordRow` and `projectRecordToNormalizedRow`

```ts
export interface NormalizedRecordRow {
  __filename: string;
  /** Raw value indexed by column id — the original JSON value (may be object/array/null/undefined). */
  raw: Record<string, unknown>;
  /** Pre-formatted display string indexed by column id — always a string (possibly empty). */
  display: Record<string, string>;
}
```

`projectRecordToNormalizedRow(fileContent: Record<string, unknown>, columns: ColumnDefinition[], filename: string): NormalizedRecordRow`

1. For each column definition, resolve its dot-path against `fileContent` using a `getByPath` helper that walks plain objects and returns `undefined` when any segment is missing. It does **not** index into arrays (arrays are leaves).
2. Store the resolved raw value under `raw[column.id]`.
3. Compute `display[column.id] = formatCellForGrid(raw, column)`.

`formatCellForGrid(value, column)`:

- `undefined` / `null` → `''`.
- `column.dataType === 'boolean'` → `'true' | 'false'`.
- `column.dataType === 'string'` / `'number'` / `'integer'` → `String(value)` (no locale-specific formatting in this pass).
- `column.dataType === 'array'` / `'object'` / `'unknown'` when `value` is non-scalar → `JSON.stringify(value)` (compact, no pretty-print — grid rows should be single-line).
- Scalar value in a non-scalar column → still `String(value)` so the grid does not show `[object Object]` for malformed data.

### 5. Wire-up — main process

Update `readGridData` and `readDiffGridDataPage` to be schema-aware. Their signatures change so the caller always passes the loaded schema wrapper (main already has access via `readConnectionSchema`).

```ts
interface GridDataResult {
  rows: NormalizedRecordRow[];
  columns: ColumnDefinition[];
  total: number;
  offset: number;
  invalidJsonFiles: Array<{ filename: string; error: string }>;
}
```

The new `readGridData` flow:

1. Load schema via `readConnectionSchema` (same call as today).
2. `const columns = buildColumnDefinitions(schemaWrapper);` — **once per call**, reused for every row.
3. For each record file: parse JSON, `projectRecordToNormalizedRow(raw, columns, filename)`.
4. Sorting and filtering operate on `row.display[columnId]` (already precomputed strings).
5. Column filtering by request (`opts.columns`) narrows the returned `columns` array rather than recomputing from raw data. If a requested column id is not in the schema, it is dropped with a `console.debug`.
6. **Unmapped-path policy** — Keys present in record JSON but not in the schema are **ignored** for the grid. They remain available in the raw file and the detail view can optionally show them under "Unmapped fields" (see §7).

Error handling: if the schema is missing or empty, `readGridData` throws with the same error message `getFolderMetadata` uses today. This matches the existing contract — the grid already refuses to load without a schema.

### 6. IPC type changes

The IPC response shape changes from `columns: string[]` to `columns: ColumnDefinition[]`, and rows from flat dot-path records to `NormalizedRecordRow`. Both are JSON-serializable. The diff reader (`readDiffGridDataPage`) follows the same pattern — diff rows already carry `__changedFields`, `__unpublishedFields`, etc., which stay at the row level.

Preload signatures in [scratch-desktop/src/preload/index.ts](scratch-desktop/src/preload/index.ts) and renderer types in [scratch-desktop/src/renderer/src/types/local-files.ts](scratch-desktop/src/renderer/src/types/local-files.ts) are updated in the same PR.

`FolderMetadata.schema` gets a second field:

```ts
export interface FolderMetadata extends FolderEntry {
  schema: Record<string, unknown>;              // raw wrapper (kept for titleColumnRemoteId etc.)
  columnDefinitions: ColumnDefinition[];        // pre-computed by main process
}
```

Precomputing `columnDefinitions` in `getFolderMetadata` means the renderer does not need to re-parse the schema on its own.

### 7. Renderer changes

**FolderDataGrid** ([scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:674](scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx#L674)):

- `allColumnIds` is derived from `columnDefinitions` (plus the title-column promotion logic that already exists).
- The `columns` memo builds `GridColumn` entries from `ColumnDefinition`:
  - `title` ← `column.displayName`.
  - Width heuristic uses `displayName.length` instead of id length.
  - `hasMenu` unchanged.
  - `themeOverride` gets a subtle visual when `column.attributes.readOnly` (e.g. muted header foreground). Details go under UI polish, not this doc.
- Cell value reads come from `row.display[columnId]` — no more per-render `toDisplayString` on raw values.
- Edit commit paths stay the same, but they check `column.attributes.readOnly` before entering edit mode.

**RecordDetailView** ([scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx:435](scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx#L435)):

- `fieldRows` iterates `columnDefinitions` (not the flattened union) to drive both order and labels.
- `RecordFieldRow` gains a `column: ColumnDefinition` field (or at minimum `displayName`, `readOnly`, `dataType`). The component renders `column.displayName` as the left-hand label.
- Values come from `row.display[column.id]`; the existing diff/approve/undo logic continues to operate on the `__changedFields` / `__unpublishedFields` sets.
- **Unmapped fields** (keys in the raw JSON but not in the schema): grouped into an optional "Unmapped fields" section below the schema-driven rows. Gated behind a simple `<Details>` toggle; labeled with the raw dot-path; not editable in this pass. Keeps legacy/manual edits visible without polluting the grid.

### 8. Alignment with the schema-driven save plan

Whatever save path exists today — whether it eventually honors the plan in [2026-04-09-desktop-schema-driven-field-save.md](../2026-04-09-desktop-schema-driven-field-save/2026-04-09-desktop-schema-driven-field-save.md) or not — should continue to work because `NormalizedRecordRow.raw` preserves the original JSON values. The stringified display values are derived-only; they are never written back to disk. Tests in §10 cover this (round-tripping the raw JSON through `projectRecordToNormalizedRow` must not mutate it).

## Unit Tests and Fixtures

### Test runner setup

`scratch-desktop` has no `test` script today. Add **Vitest** (fits `electron-vite`, ESM-native, fast):

1. `yarn add --dev vitest @types/node` in `scratch-desktop/`.
2. Add `"test": "vitest run"` and `"test:watch": "vitest"` to [scratch-desktop/package.json](scratch-desktop/package.json).
3. Add `scratch-desktop/vitest.config.ts` scoped to `src/shared/**/*.test.ts` so no Electron bootstrap is needed.
4. Tests import from `src/shared/schema-columns` only — no `electron`, no `fs` beyond reading fixture files with Node `readFileSync`.

### Fixture directory

`scratch-desktop/src/shared/schema-columns/__tests__/fixtures/` holds hand-curated `schema.json` files. Each fixture is a full table-wrapper object (same shape as what the desktop app loads from disk), so tests exercise the real unwrap path.

**Seed fixtures** (committed immediately):

| File | Source | Purpose |
|------|--------|---------|
| `airtable-semiprecious-stones.schema.json` | Copied from `.local/prompts/example-airtable-schema.json` | Nested `fields` object, `x-scratch-readonly`, `x-scratch-foreign-key`, array-of-string fields. |
| `airtable-minimal.schema.json` | Hand-authored | Single `fields.Name` scalar; smallest happy path. |
| `minimal-scalar.schema.json` | Hand-authored | Flat schema with no nested object — non-Airtable-style connectors. |
| `object-without-properties.schema.json` | Hand-authored | Property with `type: 'object'` but no `properties` → must become a leaf column with `dataType: 'object'`. |
| `array-of-objects.schema.json` | Hand-authored | Property with `type: 'array'` containing objects → leaf column, `dataType: 'array'`. |
| `missing-schema.schema.json` | Hand-authored | Wrapper without inner `schema` → returns `[]`. |
| `malformed-union-type.schema.json` | Hand-authored | `type: ['string', 'null']` to cover nullable types. |
| `read-only-flags.schema.json` | Hand-authored | Multiple `x-scratch-readonly` cases including nested required arrays. |

**Follow-up fixtures** (added as connector sample schemas become available — docs should list a TODO but the first PR is not blocked on them):

- `webflow-collection.schema.json` (Webflow CMS)
- `notion-database.schema.json` (Notion title-property edge case)
- `postgres-users.schema.json` (flat scalar-only)

Fixtures are committed as real JSON files (not inline strings) so they double as documentation of the wrapper format.

### Test cases

**`build-column-definitions.test.ts`**

Using `airtable-semiprecious-stones.schema.json`:

- Produces exactly these ids in order: `id`, `fields.Stone`, `fields.Hardness`, `fields.Value`, `fields.Details`, `fields.Primary Minerals`, `fields.Read Only Autonumber`, `fields.Birth Stone`, `fields.Name (from Birth Stone)`, `fields.Lookup Column`, `createdTime`.
- `fields.Stone`: `dataType === 'string'`, `connectorDataType === 'singleLineText'`, `readOnly === false`, `nested === true`, `displayName === 'Stone'`.
- `fields.Read Only Autonumber`: `dataType === 'integer'`, `readOnly === true`, `connectorDataType === 'autoNumber'`.
- `fields.Birth Stone`: `dataType === 'array'`, `foreignKey.linkedTableId === 'tblDm2PThSGMpxyJx'`.
- `fields.Name (from Birth Stone)`: `dataType === 'array'`, `readOnly === true`.
- `createdTime`: `dataType === 'string'`, `format === 'date-time'`, `required === true` (from the top-level `required` array), `nested === false`.
- `id`: `required === true`, `dataType === 'string'`.

Edge cases:

- `missing-schema.schema.json` → returns `[]`.
- `object-without-properties.schema.json` → one column, `dataType === 'object'`, `nested === false`.
- `array-of-objects.schema.json` → one column, `dataType === 'array'`.
- `malformed-union-type.schema.json` → `dataType === 'string'` for `['string', 'null']`, `'unknown'` for `['null']`.
- `read-only-flags.schema.json` → nested `required` arrays mark child columns correctly without leaking `required: true` to siblings.

**`project-record.test.ts`**

- Given the Airtable fixture columns and a sample record (Airtable-shaped JSON with `{ id, fields: {...}, createdTime }`):
  - `row.raw['fields.Stone']` equals the original string.
  - `row.raw['fields.Primary Minerals']` is the original array (referential equality check → projection does not clone).
  - `row.display['fields.Primary Minerals']` equals `JSON.stringify(['Quartz', 'Feldspar'])`.
  - `row.display['fields.Stone']` equals the string value directly.
- Missing paths → `row.raw[id]` is `undefined`, `row.display[id]` is `''`.
- Unmapped keys in the raw record are ignored (not present in `raw` or `display`).
- Round-trip invariance: the input record object is not mutated after projection.

**`format-cell.test.ts`**

- `undefined` / `null` → `''`.
- Scalars → `String(value)`.
- Booleans → `'true' | 'false'`.
- Arrays / objects → compact `JSON.stringify`.
- Scalar value in an `array` column (malformed data) → falls through to `String(value)` and does not throw.
- Circular object → catches `JSON.stringify` failure and returns `'[unserializable]'`.

## Implementation Phases

1. **Pure utilities + Vitest** — Add the runner, fixtures, and the three pure modules (`build-column-definitions`, `project-record`, `format-cell`) with the test suite above. Fully testable with zero Electron code. First PR.
2. **Main process integration** — Wire `buildColumnDefinitions` / `projectRecordToNormalizedRow` into `readGridData`, `readDiffGridDataPage`, and `getFolderMetadata`. Update IPC types. Lint + `yarn build` in `scratch-desktop`. Second PR.
3. **Renderer integration** — Update `FolderDataGrid` column construction, cell reads, and edit gating; update `RecordDetailView` to render `displayName` labels and the unmapped-fields section. Third PR.
4. **Cleanup** — Delete `flattenObject` and `orderColumnsBySchema` from `local-files.ts` if no callers remain. Update [scratch-desktop/docs/ipc-api.md](../../../../scratch-desktop/docs/ipc-api.md) if it exists, or add a section on the new column metadata shape.

Phases 2 and 3 may land in a single PR if the diff stays reviewable.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Schema property lookup differs from runtime JSON shape (connectors drift). | `getByPath` tolerates missing segments; unmapped fields section surfaces data the schema does not describe. |
| IPC payload grows — `columns` goes from `string[]` to `ColumnDefinition[]`. | `ColumnDefinition` is small and sent once per grid load, not per row. Rows carry a `display` map of strings, which is comparable in size to the old flat row but pre-formatted so the renderer does less work per frame. |
| `JSON.stringify` on large objects in the display map inflates IPC payloads. | Display strings are computed only for columns returned to the grid; `opts.columns` narrowing applies before projection when the caller paginates with a column filter. |
| Schema extension keys change on the server side. | Mirror constants in `scratch-desktop/src/shared/schema-columns/x-scratch-keys.ts` and add a comment pointing back to [server/src/remote-service/connectors/json-schema.ts](server/src/remote-service/connectors/json-schema.ts). A cross-package shared-types entry is possible later but out of scope for this plan. |
| Existing persisted user preferences (column widths, visible column sets) are keyed by dot-path. | Column ids remain dot-paths. No migration needed. |

## Open Questions

1. Should the unmapped-fields section in `RecordDetailView` be editable? This plan says no for phase 1 — the save path is schema-aware and would reject unmapped writes anyway.
2. Do we want a `dataType: 'date'` bucket driven by `format: 'date-time'`? Deferred — the grid currently treats dates as strings and sorting works acceptably.
3. Should `buildColumnDefinitions` expose a second pass that honors `x-scratch-virtual-fields` and emits synthesized columns? Deferred to a follow-up plan; pass the metadata through untouched for now.

## References

- Sample Airtable wrapper: [.local/prompts/example-airtable-schema.json](.local/prompts/example-airtable-schema.json)
- `x-scratch-*` extension inventory: [server/src/remote-service/connectors/json-schema.ts](server/src/remote-service/connectors/json-schema.ts)
- Current column derivation: [scratch-desktop/src/main/local-files.ts:544-576](scratch-desktop/src/main/local-files.ts#L544-L576)
- Current grid column construction: [scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:674-687](scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx#L674-L687)
- Current detail-view field iteration: [scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx:435-490](scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx#L435-L490)
- Related save-path plan: [2026-04-09-desktop-schema-driven-field-save.md](../2026-04-09-desktop-schema-driven-field-save/2026-04-09-desktop-schema-driven-field-save.md)
