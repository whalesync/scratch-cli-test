# Table Search: Notion + Client Modal + CLI

## Context

The infrastructure for table discovery modes (LIST vs SEARCH) was added in a previous PR. All connectors default to LIST mode. Now we need to:

1. Switch Notion to SEARCH mode (its `listTables()` is slow since it fetches all databases)
2. Update the client's ChooseTablesModal to support search-based table discovery
3. Update the CLI's `linked add` and `linked available` commands to support search

## Changes

### 1. Notion Connector — Switch to SEARCH mode

**File:** `server/src/remote-service/connectors/library/notion/notion-connector.ts`

- Import `TableDiscoveryMode` from `@spinner/shared-types`
- Override `get tableDiscoveryMode()` → return `TableDiscoveryMode.SEARCH`
- Change `listTables()` to return `[]` immediately (fast, tells client to use search)
- Add `searchTables(searchTerm)` implementation:
  - Call `this.client.search({ query: searchTerm, filter: { property: 'object', value: 'database' } })` (no page_size cap — just one page, whatever Notion returns)
  - Filter to `DatabaseObjectResponse`, map through `schemaParser.parseDatabaseTablePreview()`
  - Return `{ tables, hasMore: response.has_more }`
  - Don't sort — Notion's relevance ordering is more useful for search

### 2. Client ChooseTablesModal — Dual-mode UI

**File:** `client/src/app/workbook/[id]/components/shared/ChooseTablesModal.tsx`

Add search mode alongside existing list mode:

- **New imports:** `useDebouncedValue` from `@mantine/hooks`, `TextInput` from `@mantine/core`, `SearchIcon` from `lucide-react`, `TableDiscoveryMode` from `@spinner/shared-types`, `TableSearchResult` from types
- **New state:** `searchTerm` + `debouncedSearchTerm` (300ms debounce via `useDebouncedValue`)
- **New SWR hook:** Fetch search results when in SEARCH mode and debounced term is non-empty. Use `keepPreviousData: true` to avoid flicker.
- **Reset** `searchTerm` when modal opens
- **Compute displayed content:**
  - `linkedTablePreviews`: Build `TablePreview[]` from `linkedFolders` (name + tableId) — these always show so user can unlink
  - `searchResultTables`: Filter `searchData.tables` to exclude already-linked (by tableId key)
- **Update `handleSave`:** Build `tablesToAdd` from combined `linkedTablePreviews + searchResultTables` instead of only `availableTables`
- **Conditional JSX rendering:**
  - LIST mode: Current behavior unchanged
  - SEARCH mode layout:
    1. "Linked tables" section — linked tables as checkboxes (always visible, pre-checked)
    2. Search `TextInput` with `SearchIcon`, autofocused
    3. Search results as checkboxes (excluding already-linked), in a `ScrollArea.Autosize`
    4. `hasMore` message: "Showing first N results. Refine your search for more specific results."
    5. Empty states: "Type to search for Notion databases" (no search yet), "No databases found" (no results)
- **Description text:** Mode-aware ("Search for databases..." vs "Pick the tables...")

### 3. CLI API Client — Add search support

**File:** `scratch-cli/internal/api/client_linked.go`

- Add `DiscoveryMode string` field to `TableList` struct
- Add `TableSearchResult` struct: `Tables []TablePreview`, `HasMore bool`
- Change `ListConnectionTables` return type from `([]TablePreview, error)` to `(*TableList, error)` — return full struct so caller gets `DiscoveryMode`
- Add `SearchConnectionTables(workbookID, connectionID, searchTerm)` method using `doRequestWithQuery` with `url.Values{"searchTerm": {searchTerm}}`
- Add `"net/url"` to imports

### 4. CLI Commands — Branch on discovery mode

**File:** `scratch-cli/internal/cmd/linked.go`

**`runLinkedAvailable`** (lines ~344-368):

- Update to use `*api.TableList` return from `ListConnectionTables`
- If `discoveryMode == "SEARCH"`: print message telling user to use `linked add` for interactive search
- Otherwise: existing behavior (print table list)

**`runLinkedAdd`** interactive mode (lines ~510-533):

- Step 2: Call `ListConnectionTables` → get `*api.TableList`
- Branch on `tableList.DiscoveryMode`:
  - **SEARCH:** Prompt for search term (`survey.Input`), call `SearchConnectionTables`, show `hasMore` message if applicable, use results as `tables`
  - **LIST:** Use `tableList.Tables` as before
- Step 3 onward: Unchanged (multi-select from `tables`, name prompt, create)

## Files Modified

| #   | File                                                                      | Description                                       |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | `server/src/remote-service/connectors/library/notion/notion-connector.ts` | SEARCH mode + `searchTables()`                    |
| 2   | `client/src/app/workbook/[id]/components/shared/ChooseTablesModal.tsx`    | Dual-mode UI                                      |
| 3   | `scratch-cli/internal/api/client_linked.go`                               | Types + `SearchConnectionTables`                  |
| 4   | `scratch-cli/internal/cmd/linked.go`                                      | Branch on discovery mode in `available` and `add` |

## Verification

1. `cd server && nvm use && yarn run build && yarn run lint-strict && yarn run format`
2. `cd client && nvm use && yarn run build && yarn run lint`
3. `cd scratch-cli && go build ./... && gofmt -w .`
4. `cd server && nvm use && yarn run test`
