# Partial Field Updates for Publishing

**Date:** 2026-03-03
**Status:** Approved

## Problem

When a user edits a file in Scratch (e.g., changes only the `slug` of a Webflow record), the publish flow sends **all fields** to the connector API. This can overwrite fields that were changed directly in the remote service since the last pull.

## Goal

Only send the fields that actually changed to the connector, preventing unintended overwrites of concurrent remote edits. This is primarily a **correctness** improvement.

## Prior Art: Mackerel

Mackerel solved this in its publish pipeline (`publish-pipeline/phases.ts`):

1. Reads both the dirty (user-edited) and parent (main) versions of each file
2. Compares fields using `JSON.stringify()` for deep equality
3. Sends only changed fields to the connector, with the full record available for context
4. Deleted fields are explicitly set to `null`

Spinner adopts the same core idea with adaptations for its architecture.

## Design

### 1. Deep Diff Utility

A new pure function that recursively compares two JSON objects and returns only changed paths.

**Location:** `server/src/publish-plan/diff-utils.ts`

```typescript
function computeChangedFields(
  mainContent: Record<string, unknown>,
  dirtyContent: Record<string, unknown>,
): Record<string, unknown>;
```

**Algorithm:**

- Iterate over all keys in `dirtyContent`
- For each key, compare `JSON.stringify(dirtyContent[key])` vs `JSON.stringify(mainContent[key])`
- If different, include the value in the result
- For nested objects (both sides are plain objects), recurse and only include the nested diff
- If a nested diff is empty (no changes within), exclude the key entirely

**Important behavior — removed keys are NOT tracked:**
Keys present in `mainContent` but absent in `dirtyContent` are intentionally skipped. This means removing a key from a file does not propagate as a `null` to the connector. Rationale: users clear fields by setting values to `null` or `""`, not by deleting JSON keys. Key removal typically indicates schema changes or reference cleaning, not user intent to clear a field.

To clear a field value, users should set it to `null` or `""` in the file. The diff will naturally capture this as a value change.

**Examples:**

```
main:   { id: "abc", fields: { Name: "Old", Notes: "Same", Slug: "old-slug" } }
dirty:  { id: "abc", fields: { Name: "Old", Notes: "Same", Slug: "new-slug" } }
result: { fields: { Slug: "new-slug" } }
```

```
main:   { id: "abc", fields: { Name: "Hello" } }
dirty:  { id: "abc", fields: { Name: "Hello" } }
result: {}  (empty — no changes, skip connector call)
```

### 2. Database Schema Change

Add a new column to `PublishPlanOperation`:

```prisma
changedFields Json?  // Only the fields that changed (edit/backfill phases only)
```

This column is `null` for create, delete, and rename-files phases.

### 3. Build Phase Changes

**File:** `server/src/publish-plan/publish-plan-build.service.ts`

In the edit phase loop (processing modified files):

1. Already reads dirty branch content (existing behavior)
2. **New:** Also read the main branch version of each file in the same batch
3. **New:** Call `computeChangedFields(mainContent, dirtyContent)` to produce the diff
4. **New:** Store the diff in the `changedFields` column
5. Existing `content` column continues to hold the full dirty content (unchanged)

For ref-cleared files (not user-modified, but references to deleted records were stripped):

- The diff captures only the cleared reference fields
- The connector only updates those fields, not the entire record

For backfill-phase operations:

- Also compute `changedFields` between the pre-pseudo-ref and post-pseudo-ref versions
- This ensures backfill only sends the resolved reference fields

### 4. Run Phase Changes

**File:** `server/src/publish-plan/publish-plan-run.service.ts`

In `dispatchUpdateBatch`:

1. Read `changedFields` from each `PublishPlanOperation` row
2. If `changedFields` is an empty object `{}`, skip the connector call for that entry (no-op)
3. Pass `changedFields` as a parallel array to `connector.updateRecords()`

### 5. Connector Interface Change

**File:** `server/src/remote-service/connectors/connector.ts`

```typescript
// Before:
abstract updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void>;

// After:
abstract updateRecords(
  tableSpec: BaseJsonTableSpec,
  files: ConnectorFile[],
  changedFields?: Record<string, unknown>[],
): Promise<void>;
```

- `files`: Full file content (unchanged from today)
- `changedFields`: Optional parallel array where `changedFields[i]` corresponds to `files[i]`
- If `changedFields` is provided, connectors should prefer it for the API payload
- If `changedFields` is undefined, connectors fall back to full content (backward compatible)
- `ConnectorFile` type remains `Record<string, unknown>` — no changes

Each connector implementation decides how to use `changedFields`. Connectors are updated one at a time to use the partial fields.

### 6. UI Changes

In the publish plan UI, the "View JSON" display for edit operations shows `changedFields` instead of `content`. This gives users a clear view of exactly what will be sent to the remote service.

### 7. Edge Cases

| Case                                  | Behavior                                            |
| ------------------------------------- | --------------------------------------------------- |
| No main version exists                | `changedFields` = full content (defensive fallback) |
| Ref-cleared files (not user-modified) | Diff captures only cleared reference fields         |
| All fields changed                    | `changedFields` equals full content                 |
| No fields changed (identical)         | `changedFields` = `{}`, skip connector call         |
| Backfill phase                        | Diff between pre/post pseudo-ref resolution         |
| Create/delete/rename phases           | `changedFields` is `null` (not applicable)          |

### 8. Files Changed

| File                                                      | Change                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `server/prisma/schema.prisma`                             | Add `changedFields Json?` column to `PublishPlanOperation` |
| `server/prisma/migrations/...`                            | New migration                                              |
| `server/src/publish-plan/diff-utils.ts`                   | New file: `computeChangedFields()` function                |
| `server/src/publish-plan/publish-plan-build.service.ts`   | Read main version, compute diff, store `changedFields`     |
| `server/src/publish-plan/publish-plan-run.service.ts`     | Pass `changedFields` to connector, skip no-op edits        |
| `server/src/remote-service/connectors/connector.ts`       | Add `changedFields?` parameter to `updateRecords`          |
| `server/src/remote-service/connectors/library/*/`         | Update each connector to use `changedFields`               |
| `server/src/remote-service/connectors/CONNECTOR_GUIDE.md` | Document `changedFields` parameter                         |
| `server/src/publish-plan/README.md` (if exists)           | Document removed-key behavior                              |
| Client "View JSON" component                              | Show `changedFields` for edit operations                   |
