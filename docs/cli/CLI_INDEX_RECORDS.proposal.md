# Analysis: Introducing DuckDB for Scratch Desktop Indexing & Pagination

## Current State Analysis

Currently, the Scratch Desktop app paginates and processes data in memory. In `src/main/local-files.ts` (specifically `readGridData`), the application:
1. Uses `readdir` to find all JSON files.
2. Applies initial filters (e.g., branch status).
3. Reads and parses *all* matching JSON files into memory (`JSON.parse` inside `BATCH_CONCURRENCY` batches).
4. Applies user-defined filters and sorts the in-memory array.
5. Slices the array for pagination (`offset`, `limit`).

**Issues with this approach:**
- **Memory Overhead:** As the dataset grows, loading all files into Node.js memory will cause severe UI lagging and eventually OOM (Out of Memory) crashes.
- **Performance:** Parsing thousands of JSON files on every grid interaction (sort/filter) is highly CPU-intensive and slow.

There is an existing SQLite index managed by the Rust CLI (`scratch-git-2/src/shared/index.rs`), but it primarily indexes metadata (`folder`, `filename`, `remote_id`) and foreign key references. It does not index arbitrary column values, which are necessary for the desktop app's column-based filtering and sorting.

## DuckDB vs SQLite Recommendation

**Recommendation: Use DuckDB.**

While you already have an SQLite setup for metadata, DuckDB is vastly superior for this specific use-case (querying many JSON files). 

**Why DuckDB?**
1. **Native JSON querying:** DuckDB has a `read_json_auto()` function that can directly query a directory of JSON files using SQL.
   Example: `SELECT * FROM read_json_auto('my_folder/*.json') WHERE Status = 'Draft' ORDER BY Name LIMIT 10 OFFSET 0;`
2. **No manual schema mapping required:** DuckDB can infer the schema from the JSON files dynamically.
3. **Columnar execution:** DuckDB is highly optimized for analytical queries (filtering/sorting on specific columns) over JSON and Parquet.
4. **Performance:** DuckDB can evaluate filters and sorts directly from disk much faster than Node.js can parse them into memory, sometimes without even needing a persisted index if the file count is reasonable.

If you choose to use **SQLite instead**, you would need to implement an expensive step that parses every JSON file and dynamically stores its columns in a SQLite table or uses SQLite's JSON1 extension (which still requires reading the full text into the DB).

## Handling File System Changes

A critical challenge is keeping the index/cache up-to-date when files are edited. 
Edits can originate from:
1. **The Desktop App:** Easy to handle. The app can emit an update event after saving.
2. **The CLI (`scratchmd`):** Can be handled by having the CLI update the index, or notify the app via IPC/sockets.
3. **The File System (e.g., VS Code, Finder):** Requires active monitoring.

### Strategy for File System Detection

To detect external file system changes, you should implement a **File Watcher Strategy** in the Desktop App's Main Process.

1. **Use `chokidar`:** Standard Node.js `fs.watch` is notoriously buggy across different operating systems (especially macOS/Windows nuances). Introduce the `chokidar` library to watch the active workspace directories.
   ```typescript
   import chokidar from 'chokidar';

   const watcher = chokidar.watch('workspace_path/**/*.json', {
     ignored: /(^|[\/\\])\../, // ignore dotfiles
     persistent: true,
     awaitWriteFinish: {
       stabilityThreshold: 500, // wait for write to finish
       pollInterval: 100
     }
   });

   watcher
     .on('add', path => handleFileChange('add', path))
     .on('change', path => handleFileChange('change', path))
     .on('unlink', path => handleFileChange('delete', path));
   ```

2. **Debouncing & Re-indexing:** 
   File system events can be noisy (e.g., saving a file might trigger 3 `change` events). The watcher should debounce events.
   - When using DuckDB `read_json_auto`, the "index" is effectively the live file system. However, if you choose to persist the data into a DuckDB file/table for maximum performance on huge datasets, the watcher event should trigger a `DELETE FROM cache WHERE filename = ?` and an `INSERT` of the new JSON row.

3. **CLI Integration:**
   If the CLI modifies thousands of files (e.g., `files download`), the file watcher might get overwhelmed. The CLI should write a `.scratch_lock` file before mass-operations and delete it after. The desktop app watcher can pause index updates while the lock file exists, and do a full re-index once it's removed.

## Action Plan

1. **Install DuckDB:** Add `duckdb` (or `duckdb-async`) to `scratch-desktop`.
2. **Refactor `readGridData`:** Replace the `readdir` and `JSON.parse` loop with a DuckDB query targeting the folder's JSON files using `read_json_auto`.
3. **Implement `chokidar` watcher:** Start a watcher in `main/index.ts` or `main/local-files.ts` when a workspace is loaded, to notify the frontend to invalidate the grid cache when files change externally.
4. **Evaluate Performance:** For small-medium folders, live querying JSON files with DuckDB is fast enough. If folders exceed 100,000+ files, use DuckDB to materialize a temporary in-memory table upon workspace load, and keep it updated via `chokidar`.
