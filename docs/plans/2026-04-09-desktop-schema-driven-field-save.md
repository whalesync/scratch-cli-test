# Desktop Schema-Driven Field Save Plan

**Date**: 2026-04-09
**Status**: Proposed

## Problem

The desktop app currently saves edited field values without consulting the folder schema.

Today, [acceptCellChange](/Users/ijd/repos/spinner/scratch-desktop/src/main/local-files.ts:1109) sends the UI string through [parseFieldValue](/Users/ijd/repos/spinner/scratch-desktop/src/main/local-files.ts:1271), which does `JSON.parse(trimmed)` and falls back to the original string.

That causes a few incorrect behaviors:

- `"123"` becomes JSON number `123` even when the schema says the field is a string.
- `"null"` becomes `null` even when the schema says the field is a string.
- JSON-looking text like `{"a":1}` becomes an object even when the schema says the field is a string.
- Surrounding whitespace is trimmed before parse, so the saved value is not always the exact input text.

The schema is already loaded in the desktop app through [getFolderMetadata](/Users/ijd/repos/spinner/scratch-desktop/src/main/local-files.ts:145), but inside `scratch-desktop` it is currently only used for `titleColumnRemoteId` in [FolderDataGrid.tsx](/Users/ijd/repos/spinner/scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:447).

## JSON Value Kinds

JSON has six value kinds:

1. string
2. number
3. boolean
4. null
5. object
6. array

One important detail: JSON does **not** have a separate `integer` runtime type. `integer` is a JSON Schema concept. At runtime, both `integer` and `number` are JSON numbers.

## Goals

- Save edited values according to the field schema, not according to `JSON.parse` heuristics.
- Preserve exact typed values for approve/undo flows.
- Keep the grid fast for folders with many records.
- Share one coercion path between grid editing and record-view editing.

## Non-Goals

- Full schema validation in this pass (`enum`, `minLength`, `pattern`, `minimum`, etc.).
- Schema-driven widget rendering in this pass.
- Coercing arbitrary user text into complex values with guessy behavior.

## Current State

### Schema Read Path

- Folder metadata reads `.scratch/connections/.../schema.json` in [readConnectionSchema](/Users/ijd/repos/spinner/scratch-desktop/src/main/local-files.ts:449).
- The renderer loads that metadata in [FolderDataGrid.tsx](/Users/ijd/repos/spinner/scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:366).
- The schema object appears to be a table-spec wrapper, because the desktop reads `titleColumnRemoteId` directly from the returned object. The actual JSON Schema for fields may therefore live under `schema`, not at the top level.

### Save Path

- Grid edit commits call [acceptCellChange](/Users/ijd/repos/spinner/scratch-desktop/src/renderer/src/pages/workspace/FolderDataGrid.tsx:499).
- Record-view edit commits call [acceptCellChange](/Users/ijd/repos/spinner/scratch-desktop/src/renderer/src/pages/workspace/RecordDetailView.tsx:258).
- The main process then parses the string blindly in [acceptCellChange](/Users/ijd/repos/spinner/scratch-desktop/src/main/local-files.ts:1109).

### Approve / Undo Path

- Undo is already type-safe because [undoApprovedCellChange](/Users/ijd/repos/spinner/scratch-desktop/src/main/local-files.ts:1141) reads the master value in the main process and writes that exact value back.
- Approve is not fully type-safe today because the UI often round-trips through display strings before saving.

## Proposed Design

### 1. Split "typed value" writes from "user text" writes

Introduce two main-process write paths:

- `acceptCellInputText(...)`
- `acceptCellValue(...)`

`acceptCellInputText(...)` is for direct user typing from the grid editor and record-view editor.

`acceptCellValue(...)` is for flows that already know the intended JSON value, such as:

- approve reviewed changes
- undo approved changes
- future typed controls like checkboxes or date pickers

This split avoids one parser trying to serve two very different jobs.

### 2. Resolve the field schema for a dot-path

Add a helper in `scratch-desktop/src/main/local-files.ts` that:

- loads the folder schema once
- unwraps the outer table-spec object if needed
- walks `properties` by the dot path used by the grid and record view
- unwraps simple unions like `anyOf` / `oneOf` when possible

Suggested helper shape:

```ts
type JsonRuntimeKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'unknown';

function resolveFieldRuntimeKind(
  folderSchema: Record<string, unknown> | null,
  fieldPath: string,
): JsonRuntimeKind | JsonRuntimeKind[];
```

Notes:

- If the schema says `integer`, treat it as `number`.
- If the schema is nullable, return a union such as `['string', 'null']`.
- If the schema cannot be resolved, return `unknown`.

### 3. Coerce user input from schema, not from `JSON.parse`

`acceptCellInputText(...)` should use schema-aware coercion rules.

Recommended initial coercion matrix:

| Schema kind | Input handling |
| --- | --- |
| `string` | Save the exact text as typed. No trim. |
| `number` / `integer` | Parse as a number. Reject invalid input. |
| `boolean` | Accept exact `true` or `false`. Reject anything else. |
| `null` | Accept exact `null`. Reject anything else. |
| `object` | Parse as JSON object text. Reject invalid JSON or non-object JSON. |
| `array` | Parse as JSON array text. Reject invalid JSON or non-array JSON. |
| `T \\| null` | Accept `null` or parse as `T`. |
| `unknown` | Save exact text as string. |

This gives the safe behavior we want:

- string field + input `123` => save `"123"`
- number field + input `123` => save `123`
- boolean field + input `true` => save `true`
- nullable field + input `null` => save `null`

### 4. Keep approve/undo typed

Approve and undo should not round-trip through display strings.

Instead:

- diff payloads should carry raw `working`, `dirty`, and `master` values
- UI actions should pass the raw value to `acceptCellValue(...)`
- the main process should write that exact value without parsing

Undo already mostly follows this pattern. Approve should be brought in line with it.

### 5. Reuse schema data without slowing down the grid

The grid should **not** fetch per-cell schema over IPC.

Instead:

- schema lookup should stay in the main process
- the renderer should keep sending `folderPath`, `workspacePath`, `filename`, `fieldName`, and input text
- the main process should load and cache the folder schema once per folder
- coercion should happen locally in the main process before patching the JSON files

This keeps the renderer simple and avoids an N+1 schema-fetch pattern.

## Recommended API Shape

### Main Process

Add:

```ts
export async function acceptCellInputText(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
  inputText: string,
): Promise<void>

export async function acceptCellValue(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
  value: unknown,
): Promise<void>
```

Keep the shared patch-and-commit logic behind a private helper:

```ts
async function applyCellValue(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
  value: unknown,
): Promise<void>
```

### Renderer

- Grid text editing => `acceptCellInputText(...)`
- Record-view text editing => `acceptCellInputText(...)`
- Approve => `acceptCellValue(...)`
- Undo => can keep the dedicated `undoApprovedCellChange(...)` or internally reuse `acceptCellValue(...)` with the master value

## Error Handling

When input cannot be coerced to the schema type, the save should fail instead of silently saving the wrong type.

Examples:

- number field + `abc` => reject
- boolean field + `yes` => reject
- object field + `{not json}` => reject
- null field + empty string => reject

The renderer should surface the error near the editor rather than mutating the data incorrectly.

## Implementation Steps

### Phase 1: Main-process schema helpers

1. Add a helper to unwrap the actual JSON Schema from the folder schema object.
2. Add a helper to resolve a field schema by dot path.
3. Add a helper to reduce a field schema to runtime save kinds.

### Phase 2: Typed save endpoints

1. Add `acceptCellInputText(...)`.
2. Add `acceptCellValue(...)`.
3. Move the existing file patching and dirty-branch commit flow behind a shared helper.
4. Delete or stop using `parseFieldValue(...)`.

### Phase 3: Renderer wiring

1. Switch grid edit commits to `acceptCellInputText(...)`.
2. Switch record-view edit commits to `acceptCellInputText(...)`.
3. Switch approve actions to use raw values with `acceptCellValue(...)`.
4. Keep undo typed.

### Phase 4: UX polish

1. Show type mismatch errors inline.
2. Add future schema-driven editors if needed:
   - checkbox for booleans
   - number input for numbers
   - JSON editor for object/array

## Testing Plan

Add tests for the main-process coercion helper covering:

- string field saves exact text
- string field preserves leading/trailing whitespace
- number field accepts `123`, `1.5`, `-2`
- integer field accepts `123` and rejects `1.5`
- boolean field accepts only `true` / `false`
- null field accepts only `null`
- nullable string accepts `null` and normal strings
- object field accepts valid object JSON and rejects arrays
- array field accepts valid array JSON and rejects objects
- unknown schema falls back to string
- approve preserves raw numbers, booleans, objects, arrays, and null exactly

## Open Decisions

### 1. What should happen for empty string on nullable fields?

Two reasonable choices:

- strict: empty string stays `""` for string fields and is invalid for `null`
- convenience: empty string maps to `null` for nullable fields

Recommendation: start strict to avoid surprising data loss.

### 2. Should object/array editing be enabled immediately?

Recommendation:

- yes in the backend coercion layer
- no special UI yet

That keeps the model correct without blocking future richer editors.

### 3. What if the schema is missing?

Recommendation: fall back to saving exact text as a string, because that is the least destructive behavior.

## Summary

The key shift is:

- do not infer value types from user text
- do infer value types from schema

That requires:

- resolving field schemas by path
- splitting text-entry saves from typed-value saves
- keeping approve/undo on exact raw values

Once this is in place, the desktop app can save strings, numbers, booleans, nulls, objects, and arrays correctly without guessy parsing.
