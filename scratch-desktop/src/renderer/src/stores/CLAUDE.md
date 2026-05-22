# Workspace UI Store

Zustand store for shared workspace UI state. Lives in `workspace-ui-store.ts`.

## What belongs in the store

- State read or written by **multiple components** (e.g. `selectedFolderPath` is read by the sidebar, grid, and header)
- State that would otherwise be **drilled through 2+ levels** of props
- **UI configuration** that persists across component mounts within a workspace session (sort, filters, column widths, page)

## What does NOT belong in the store

- **Server/fetched data** (diffData, schema, workspace, localPath) — keep in the component that loads it or use SWR
- **Transient interaction state** (hover position, popover bounds, resize drag, grid selection, editing cell) — keep as local `useState`
- **Modal open/close flags** — keep local to the component that owns the modal
- **Loading/error indicators** — keep local to the data-fetching component

## viewMode is derived, not stored

`viewMode` is computed from `selectedRecordFilename` and `focusedFieldName`:

```
focusedFieldName !== null  →  'field'
selectedRecordFilename !== null  →  'record'
otherwise  →  'grid'
```

Never store viewMode directly. Use the `useViewMode()` hook to read it. To change it, set the underlying fields via the compound actions.

## Compound actions for view transitions

Use these instead of setting individual fields:

| Action | Sets | Result |
|--------|------|--------|
| `showGrid()` | clears record + field | viewMode = 'grid' |
| `showRecord(filename)` | sets record, clears field | viewMode = 'record' |
| `showField(filename, fieldName)` | sets both | viewMode = 'field' |

The low-level setters (`setSelectedRecordFilename`, `setFocusedFieldName`) are available but don't guarantee consistent state across multiple fields. Prefer the compound actions when changing view mode.

## Folder change resets

`setSelectedFolderPath(path)` atomically resets all per-folder state (record selection, field focus, sort, filters, page, column widths, visible columns). Components that need to reset additional local state on folder change (e.g. grid selection, schema, cell popovers) should use a `useEffect` on `selectedFolderPath`.

## Store setters accept updater functions

All grid-configuration setters (`setSort`, `setActiveFilters`, `setPage`, `setVisibleColumnIds`, `setColumnWidths`) accept either a direct value or an updater function, matching the `useState` setter pattern:

```typescript
setActiveFilters([]);                                    // direct value
setActiveFilters((prev) => prev.filter((f) => ...));     // updater function
```

## Record selection is by filename, not index

The store tracks `selectedRecordFilename` (stable across sort/filter/page changes). Components that need a row index (e.g. for the grid or RecordDetailView's `selectedIndex` prop) derive it locally:

```typescript
const detailRowIndex = useMemo(() => {
  if (!selectedRecordFilename) return null;
  const idx = pagedRows.findIndex((r) => r.__filename === selectedRecordFilename);
  return idx >= 0 ? idx : null;
}, [selectedRecordFilename, pagedRows]);
```

## Adding new state

1. Add the field and setter to `WorkspaceUiState` interface
2. Add initial value and setter implementation in the `create()` call
3. If it should reset on folder change, add it to `setSelectedFolderPath` and `resetFolderState`
4. Prefer a direct selector (`useWorkspaceUiStore(s => s.myField)`) over destructuring the whole store
