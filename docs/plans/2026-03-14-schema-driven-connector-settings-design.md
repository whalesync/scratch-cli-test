# Schema-Driven Connector Settings

**Date**: 2026-03-14
**Status**: Approved

## Problem

The client has hard-coded connector-specific logic (`isNotion`, `isAirtable`, `FILTER_SUPPORTED_SERVICES`, `FIELD_SELECTION_SERVICES`) to render advanced folder settings. Adding a new connector setting requires changes in both client and server. Connector settings should be driven by server metadata so the client renders them generically.

## Design

### Shared Type: `ConnectorSettingDefinition`

Defined in `packages/shared-types`:

```ts
export interface ConnectorSettingDefinition {
  key: string; // storage key in DataFolder.options (e.g. 'excludePageContent')
  type: "boolean" | "number" | "string";
  label: string; // human-readable label
  description?: string; // help text
  placeholder?: string; // for string/number inputs
  min?: number; // for number type
  max?: number; // for number type
}
```

### Server: Connector Base Class

Add `static readonly advancedSettings: ConnectorSettingDefinition[] = []` to the `Connector` base class, following the existing `static readonly displayName` pattern. Each connector overrides as needed.

Add `supportsFieldSelection(): boolean` to the base class (default `false`), with Supabase overriding to `true`.

### Server: `listTables` Response

Extend the `listTables` return type:

```ts
{
  tables: TablePreview[];
  discoveryMode: TableDiscoveryMode;
  supportsFilters: boolean;                       // NEW
  supportsFieldSelection: boolean;                // NEW
  advancedSettings: ConnectorSettingDefinition[];  // NEW
}
```

Add a static lookup function (like `getServiceDisplayName`) to map `Service` enum → connector metadata without instantiating the connector.

### Client: Generic Rendering

Both `AdvancedFolderSettingsModal` and `ChooseTablesModal` render settings generically from the schema:

- `type: 'boolean'` → `<Checkbox>`
- `type: 'number'` → `<NumberInput>` (with min/max)
- `type: 'string'` → `<TextInput>`

Remove all hard-coded connector checks: `isNotion`, `isAirtable`, `FILTER_SUPPORTED_SERVICES`, `FIELD_SELECTION_SERVICES`.

Settings values stored per-table in `DataFolder.options` as `Record<string, unknown>` — unchanged from today.

## Decisions

- **`filter` stays separate**: It's a first-class field on `DataFolder` with its own UI treatment. `supportsFilters` becomes a server-driven boolean instead of a client hard-coded set.
- **Static per-service**: Settings schema is the same for all tables in a service. If a connector later needs per-table variation, the design can be extended.
- **Per-table values**: Each table gets its own values for the settings (stored in `DataFolder.options`), but the schema is shared across all tables in a service.

## Scope

### In Scope

- `ConnectorSettingDefinition` type in shared-types
- `advancedSettings` static property on Connector base class
- Notion and Airtable connector setting declarations
- `supportsFilters` and `supportsFieldSelection` in listTables response
- Generic rendering in `AdvancedFolderSettingsModal`
- Generic rendering in `ChooseTablesModal`
- Remove `FILTER_SUPPORTED_SERVICES` and `FIELD_SELECTION_SERVICES` from client

### Out of Scope (YAGNI)

- `select` type for enum-style options
- Per-table setting schema variation
- Separate metadata endpoint
