# Plan: Server-Driven Transformer Definitions

**Created:** 2026-04-15

## Context

Transformers in Scratch are data transformations applied to fields during sync. Currently, adding a new transformer requires changes in **two places**: a server-side implementation file and a 1200-line client-side modal (`TransformerConfigModal.tsx`) with hard-coded switch statements for each transformer's UI.

The goal is to make transformer UI definitions server-driven so that adding a new transformer is a **single server-side change**. The client fetches transformer metadata (field descriptors, defaults, labels) from the server and renders forms generically. No data migration — stored `TransformerConfig` objects are unchanged.

## Approach

### 1. Define `TransformerFieldDescriptor` and `TransformerMetadata` types

**New file: `packages/shared-types/src/transformer-metadata.ts`**

```typescript
export type TransformerFieldWidget =
  | "select"
  | "checkbox"
  | "text"
  | "folder_picker"
  | "json_editor"
  | "transformer_config";

export interface TransformerFieldDescriptor {
  key: string; // Options object key (e.g. 'targetType')
  widget: TransformerFieldWidget;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean; // Must be non-empty for config to be "complete"
  defaultValue?: unknown;

  // Select-specific
  selectOptions?: { value: string; label: string }[];

  // FolderPicker-specific
  assetFoldersOnly?: boolean;

  // Conditional visibility
  visibleWhen?: { field: string; value: unknown };
}

export interface TransformerMetadata {
  type: string;
  label: string;
  devOnly?: boolean;
  fields: TransformerFieldDescriptor[]; // Empty array = no options
  defaultOptions: Record<string, unknown>; // Computed from field defaults
}
```

Also export from `packages/shared-types/src/index.ts`.

### 2. Add `optionsSchema` to `FieldTransformer` interface

**Modify: `server/src/sync/transformers/transformer.types.ts`**

Add optional `optionsSchema?: TransformerFieldDescriptor[]` to the `FieldTransformer` interface.

### 3. Add `optionsSchema` to all 24 transformer implementations

**Modify: all files in `server/src/sync/transformers/implementations/`**

Each transformer declares its UI fields. Examples:

- **No-options** (Trim, Slugify, etc.): `optionsSchema: []`
- **Simple selects** (AutoConvert): `[{ key: 'targetType', widget: 'select', selectOptions: [...], defaultValue: 'string' }]`
- **Conditional fields** (EnsureType): `fallbackValue` field with `visibleWhen: { field: 'onFailure', value: 'other' }`
- **Folder pickers** (SourceFkToDestFk): `{ key: 'referencedDataFolderId', widget: 'folder_picker', required: true }`
- **JSON editors** (WrapObject): `{ key: 'template', widget: 'json_editor', defaultValue: {} }`

### 4. Add metadata generation to the registry

**Modify: `server/src/sync/transformers/transformer-registry.ts`**

Add `getAllTransformerMetadata()` that iterates `TRANSFORMER_TYPES`, looks up each transformer's `optionsSchema`, and builds `TransformerMetadata[]` with computed `defaultOptions`.

### 5. Add server endpoint

**Modify: `server/src/sync/transformers/transformer.controller.ts`**

Add `@Get('metadata')` that calls `getAllTransformerMetadata()` and returns the result. (Behind existing auth guard on the controller.)

### 6. Add client API + SWR hook

**New files:**

- `client/src/lib/api/transformer-metadata.ts` — axios call to `GET /sync/transformers/metadata`
- `client/src/hooks/use-transformer-metadata.ts` — SWR wrapper with `revalidateOnFocus: false`

**Modify: `client/src/lib/api/keys.ts`** — add `transformerMetadata.all()` SWR key.

### 7. Build generic form renderer

**New file: `client/src/app/workbook/[id]/components/MainPane/TransformerStepFormGeneric.tsx`**

A component that receives `TransformerMetadata` and renders fields in a loop:

| Widget               | Mantine Component                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `select`             | `<Select>` with `field.selectOptions`                                                         |
| `checkbox`           | `<Checkbox>`                                                                                  |
| `text`               | `<TextInput>` with `field.placeholder`                                                        |
| `folder_picker`      | `<Select>` with `allFolders` data + `renderFolderOption` + optional `assetFoldersOnly` filter |
| `json_editor`        | `<CodeMirror>` with JSON language                                                             |
| `transformer_config` | `<CodeMirror>` JSON editor (same as current MapArray)                                         |

Conditional visibility: skip rendering field if `visibleWhen` condition not met.

### 8. Replace hard-coded forms in TransformerConfigModal

**Modify: `client/src/app/workbook/[id]/components/MainPane/TransformerConfigModal.tsx`**

- Replace `TransformerStepForm` with the generic renderer
- Replace `defaultConfigForType()` switch with metadata-driven version: `{ type, options: meta.defaultOptions }`
- Replace `isTransformerConfigComplete()` switch with metadata-driven version: check all `required` fields are non-empty
- Replace `transformerSelectData` (from `TRANSFORMER_TYPES`) with data from the metadata endpoint
- Keep all pipeline visualization, type trace, and validation code as-is

## Files Summary

**New files (4):**

- `packages/shared-types/src/transformer-metadata.ts`
- `client/src/lib/api/transformer-metadata.ts`
- `client/src/hooks/use-transformer-metadata.ts`
- `client/src/app/workbook/[id]/components/MainPane/TransformerStepFormGeneric.tsx`

**Modified files:**

- `packages/shared-types/src/index.ts` — add export
- `server/src/sync/transformers/transformer.types.ts` — add `optionsSchema` to interface
- `server/src/sync/transformers/transformer-registry.ts` — add `getAllTransformerMetadata()`
- `server/src/sync/transformers/transformer.controller.ts` — add `GET metadata` endpoint
- `server/src/sync/transformers/implementations/*.transformer.ts` — all 24 files
- `client/src/lib/api/keys.ts` — add SWR key
- `client/src/app/workbook/[id]/components/MainPane/TransformerConfigModal.tsx` — swap to generic renderer

## Edge Cases

- **MapArray's `elementTransformer`**: Recursive transformer-in-transformer. Keep as JSON editor (matches current UX). `widget: 'transformer_config'` renders identically to `json_editor` for now.
- **Folder picker data** is passed as a prop from the parent, not from server metadata. `folder_picker` widget tells the renderer to use that data source.
- **`ConnectorIcon` in folder pickers** is handled internally by the generic renderer when it sees `folder_picker`.
- **Type safety**: Stored `TransformerConfig` union is unchanged. The generic renderer works with `Record<string, unknown>` internally but saves via the existing `onSave` callback.

## Verification

1. `yarn build` — confirms shared-types, server, and client all compile
2. `yarn lint` from root + `yarn lint-strict` in server/
3. `yarn test` — existing transformer tests pass (no runtime behavior changed)
4. Manual: open a sync's transformer config modal, verify each transformer type renders the same fields as before
5. Manual: verify type trace/validation still works
6. Manual: add a step, edit options, remove a step — same behavior as before
