/**
 * Local file access layer for Scratch Desktop.
 *
 * All filesystem I/O for workspace files lives here, in the main process.
 * The renderer accesses these functions via IPC handlers registered in index.ts.
 *
 * Target format: Rust CLI / .scratch workspace layout.
 */

import { execFile } from 'child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'path';

import { listUnpublishedChanges, listUnreviewedChanges } from './scratchmd';

// ── Types (duplicated from renderer types to avoid cross-process import issues) ──

interface WorkspaceConfig {
  apiUrl: string;
  workbookId: string;
  orgId: string;
  authToken?: string;
}

interface FolderEntry {
  name: string;
  path: string;
  fileCount: number;
  lastModified: number;
  totalSize: number;
}

interface FolderMetadata extends FolderEntry {
  schema: Record<string, unknown> | null;
}

interface ListFilesOptions {
  offset: number;
  limit: number;
  sortBy?: 'name' | 'modified' | 'size';
  sortOrder?: 'asc' | 'desc';
  filter?: {
    search?: string;
    extensions?: string[];
  };
}

interface ListFilesResult {
  files: FileEntry[];
  total: number;
  offset: number;
}

interface FileEntry {
  name: string;
  path: string;
  size: number;
  lastModified: number;
  extension: string;
  isJson: boolean;
}

type FileContent =
  | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
  | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
  | { type: 'error'; path: string; error: string };

// ── Constants ──

const SCRATCH_DIR = '.scratch';
const CONFIG_FILE = 'config.json';
const SCHEMAS_DIR = 'schemas';
const CONNECTIONS_DIR = 'connections/scratch';
const HIDDEN_PREFIX = '.';

/** Max binary file size (5 MB) to inline as base64 */
const MAX_INLINE_BINARY_SIZE = 5 * 1024 * 1024;

/** Max concurrency for batch file reads */
const BATCH_CONCURRENCY = 10;

/** Hard limit for grid data pagination values (offset and limit). */
const GRID_DATA_MAX_PAGINATION = 1000;

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
};

// ── Filename cache ──

interface CachedDirListing {
  names: string[];
  mtime: number;
}

const dirCache = new Map<string, CachedDirListing>();

interface ConnectionPaths {
  subPath: string;
  workingConnPath: string;
  reviewedDirtyConnPath: string;
}

type JsonFieldValue = { exists: true; value: unknown } | { exists: false };

// ── Public functions ──

export async function readWorkspaceConfig(workspacePath: string): Promise<WorkspaceConfig> {
  const configPath = join(workspacePath, SCRATCH_DIR, CONFIG_FILE);
  const content = await readFile(configPath, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    apiUrl: (parsed.api_url as string) ?? '',
    workbookId: (parsed.workbook_id as string) ?? '',
    orgId: (parsed.org_id as string) ?? '',
    authToken: (parsed.auth_token as string) ?? undefined,
  };
}

export async function listFolders(workspacePath: string): Promise<FolderEntry[]> {
  const folders: FolderEntry[] = [];
  await collectLeafFolders(workspacePath, workspacePath, folders);
  return folders;
}

/** Total record files across all data leaf folders (same definition as per-folder counts in listFolders). */
export async function countWorkspaceFiles(workspacePath: string): Promise<number> {
  const folders = await listFolders(workspacePath);
  return folders.reduce((sum, f) => sum + f.fileCount, 0);
}

export async function getFolderMetadata(folderPath: string, workspacePath: string): Promise<FolderMetadata> {
  const folderName = basename(folderPath);
  const meta = await computeFolderStats(folderPath);
  const relPath = relative(workspacePath, folderPath);
  const schema = await readConnectionSchema(workspacePath, relPath);
  if (!schema) {
    throw new Error(
      `Schema not found for folder "${folderName}" at ${join(SCRATCH_DIR, CONNECTIONS_DIR, relPath, 'schema.json')}`,
    );
  }

  return {
    name: folderName,
    path: folderPath,
    fileCount: meta.fileCount,
    lastModified: meta.lastModified,
    totalSize: meta.totalSize,
    schema,
  };
}

export async function listFiles(folderPath: string, opts: ListFilesOptions): Promise<ListFilesResult> {
  const allNames = await getCachedFileNames(folderPath);

  // Filter
  let filtered = allNames;
  if (opts.filter) {
    filtered = applyFilter(filtered, opts.filter);
  }

  const total = filtered.length;

  // Sort (default: name asc). For 'modified' and 'size' sorting, we need stat info
  // on all filtered files which is expensive — only do it if explicitly requested.
  if (opts.sortBy === 'modified' || opts.sortBy === 'size') {
    filtered = await sortByStatField(folderPath, filtered, opts.sortBy, opts.sortOrder ?? 'asc');
  } else {
    filtered = sortByName(filtered, opts.sortOrder ?? 'asc');
  }

  // Paginate
  const offset = Math.max(0, opts.offset);
  const limit = Math.max(1, opts.limit);
  const page = filtered.slice(offset, offset + limit);

  // Stat only the page
  const files = await Promise.all(page.map((name) => statFileEntry(folderPath, name)));

  return { files, total, offset };
}

const MAX_TEXT_FILE_RAW_BYTES = 2 * 1024 * 1024;

/**
 * Reads a UTF-8 file as plain text (no JSON parsing). Used to display invalid JSON contents.
 */
export async function readFileTextRaw(filePath: string): Promise<{ text: string } | { error: string }> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_TEXT_FILE_RAW_BYTES) {
      return {
        error: `File is too large to display (${fileStat.size} bytes; max ${MAX_TEXT_FILE_RAW_BYTES})`,
      };
    }
    const text = await readFile(filePath, 'utf-8');
    return { text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

/**
 * Writes UTF-8 text to a file (used by the invalid-JSON editor). Creates parent directories if needed.
 */
export async function writeFileTextRaw(filePath: string, contents: string): Promise<{ ok: true } | { error: string }> {
  try {
    const byteLength = Buffer.byteLength(contents, 'utf8');
    if (byteLength > MAX_TEXT_FILE_RAW_BYTES) {
      return {
        error: `File content is too large (${byteLength} bytes; max ${MAX_TEXT_FILE_RAW_BYTES})`,
      };
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

export async function readFileContent(filePath: string): Promise<FileContent> {
  try {
    const fileStat = await stat(filePath);
    const ext = extname(filePath).toLowerCase();

    if (ext === '.json') {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      return { type: 'json', path: filePath, data, size: fileStat.size };
    }

    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const result: FileContent = { type: 'binary', path: filePath, mimeType, size: fileStat.size };

    if (fileStat.size <= MAX_INLINE_BINARY_SIZE) {
      const buffer = await readFile(filePath);
      result.base64 = buffer.toString('base64');
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: 'error', path: filePath, error: message };
  }
}

export async function readBatch(filePaths: string[], opts?: { maxSize?: number }): Promise<FileContent[]> {
  const results: FileContent[] = [];

  // Process in batches to limit concurrency
  for (let i = 0; i < filePaths.length; i += BATCH_CONCURRENCY) {
    const batch = filePaths.slice(i, i + BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        if (opts?.maxSize) {
          try {
            const fileStat = await stat(filePath);
            if (fileStat.size > opts.maxSize) {
              return {
                type: 'binary' as const,
                path: filePath,
                mimeType: MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
                size: fileStat.size,
              };
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { type: 'error' as const, path: filePath, error: message };
          }
        }
        return readFileContent(filePath);
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

// ── Grid data ──

export type FilterStatus = 'unreviewed' | 'unpublished' | 'published';
export type GridVersion = 'working' | 'dirty' | 'main';
export type RowStatus =
  | 'added'
  | 'modified'
  | 'unpublished'
  | 'deleted'
  | 'deletedUnpublished'
  | 'unchanged'
  | 'invalidJson';
export type DiffGridFilterKind = 'unreviewed' | 'unpublished';

export type DiffGridFilter =
  | { scope: 'global'; kind: DiffGridFilterKind }
  | { scope: 'column'; kind: DiffGridFilterKind; columnId: string; columnTitle: string }
  | { scope: 'text'; columnId: string; columnTitle: string; value: string };

export interface DiffRow extends Record<string, unknown> {
  __rowStatus: RowStatus;
  /** Fields where working != dirty (unreviewed changes). */
  __changedFields: string[];
  /** Dirty-branch values for unreviewed fields (the "from" side when w != d). */
  __fromFields: Record<string, unknown>;
  /** Fields where working == dirty but dirty != master (reviewed but not yet published). */
  __unpublishedFields: string[];
  /** Master-branch values for unpublished fields (the "from" side when d != m). */
  __masterFields: Record<string, unknown>;
  __filename: string;
  /** Set when __rowStatus is invalidJson (which branch failed is encoded in the string). */
  __parseError?: string;
}

export interface InvalidJsonFileEntry {
  filename: string;
  error: string;
  workingFilePath: string;
  reviewedFilePath: string;
  publishedFilePath: string;
}

export interface DiffGridResult {
  rows: DiffRow[];
  columns: string[];
  total: number;
  summary: DiffGridSummary;
  filterCounts: {
    unreviewed: number;
    unpublished: number;
  };
  invalidJsonFiles: InvalidJsonFileEntry[];
}

export interface DiffRecordResult {
  row: DiffRow;
  columns: string[];
  workingData: Record<string, unknown> | null;
  dirtyData: Record<string, unknown> | null;
  masterData: Record<string, unknown> | null;
  displayData: Record<string, unknown> | null;
}

export interface FolderStatuses {
  unreviewedFilenames: string[];
  unpublishedFilenames: string[];
}

interface ReadGridDataOptions {
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filter?: Record<string, unknown>;
  columns?: string[];
  filterStatus?: FilterStatus;
  workspacePath?: string;
}

interface ReadDiffGridDataOptions {
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filters?: DiffGridFilter[];
}

interface GridDataResult {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  total: number;
  offset: number;
  /** `.json` files that could not be parsed as a top-level object (separate from `rows`). */
  invalidJsonFiles: Array<{ filename: string; error: string }>;
}

/**
 * Reads JSON files from a folder and returns their contents as flat records
 * suitable for Glide Data Grid. Each JSON file becomes one row. Top-level
 * keys become columns. Only JSON files are included; non-JSON files are skipped.
 *
 * The `columns` array in the result is the union of all keys found across the
 * returned rows, in insertion order (first file's keys first, then any new keys
 * from subsequent files). If `opts.columns` is provided, only those columns are
 * returned and the column order matches the requested list.
 *
 * Files that are not valid JSON objects are omitted from `rows` and listed in
 * `invalidJsonFiles` (filename + parse error).
 */
export async function readGridData(folderPath: string, opts: ReadGridDataOptions): Promise<GridDataResult> {
  console.debug('readGridData', folderPath, opts);

  if (opts.offset !== undefined && opts.offset > GRID_DATA_MAX_PAGINATION) {
    throw new Error(
      `readGridData offset (${opts.offset}) exceeds the hardcoded maximum of ${GRID_DATA_MAX_PAGINATION}. `,
    );
  }
  if (opts.limit !== undefined && opts.limit > GRID_DATA_MAX_PAGINATION) {
    throw new Error(
      `readGridData limit (${opts.limit}) exceeds the hardcoded maximum of ${GRID_DATA_MAX_PAGINATION}. `,
    );
  }

  let allNames = await getCachedFileNames(folderPath);

  // Only include JSON files
  allNames = allNames.filter((name) => extname(name).toLowerCase() === '.json');

  // Apply status filter
  if (opts.filterStatus) {
    if (!opts.workspacePath) {
      throw new Error(`readGridData filterStatus '${opts.filterStatus}' requires workspacePath to be set.`);
    }
    const allowed = await resolveFilterStatus(opts.filterStatus, folderPath, opts.workspacePath, allNames);
    allNames = allNames.filter((name) => allowed.has(name));
  }

  // Read, parse, and flatten all matching files
  const columnSet = new Set<string>();
  let allRows: Array<Record<string, unknown>> = [];
  const invalidJsonFiles: Array<{ filename: string; error: string }> = [];

  for (let i = 0; i < allNames.length; i += BATCH_CONCURRENCY) {
    const batch = allNames.slice(i, i + BATCH_CONCURRENCY);
    const batchRows = await Promise.all(
      batch.map(async (name) => {
        try {
          const content = await readFile(join(folderPath, name), 'utf-8');
          const parsed = parseTopLevelJsonObject(content);
          if (!parsed.ok) {
            invalidJsonFiles.push({ filename: name, error: parsed.error });
            return null;
          }
          const flat = flattenObject(parsed.raw);
          flat.__filename = name;
          return flat;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          invalidJsonFiles.push({ filename: name, error: message });
          return null;
        }
      }),
    );

    for (const row of batchRows) {
      if (row === null) {
        continue;
      }
      for (const key of Object.keys(row)) {
        if (!key.startsWith('__')) columnSet.add(key);
      }
      allRows.push(row);
    }
  }

  // Remove internal metadata from visible columns
  columnSet.delete('__filename');

  // Filter rows by column values
  if (opts.filter) {
    const filterEntries = Object.entries(opts.filter);
    allRows = allRows.filter((row) => filterEntries.every(([col, expected]) => col in row && row[col] === expected));
  }

  const total = allRows.length;

  // Sort by column value
  if (opts.sortBy) {
    const sortKey = opts.sortBy;
    const order = opts.sortOrder ?? 'asc';
    allRows = sortRowsByColumn(allRows, sortKey, order);
  }

  // Paginate
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? GRID_DATA_MAX_PAGINATION);
  let rows = allRows.slice(offset, offset + limit);

  let columns = Array.from(columnSet);

  // If specific columns requested, filter and reorder
  if (opts.columns && opts.columns.length > 0) {
    columns = opts.columns.filter((c) => columnSet.has(c));
    rows = rows.map((row) => {
      const filtered: Record<string, unknown> = { __filename: row['__filename'] };
      for (const col of columns) {
        if (col in row) {
          filtered[col] = row[col];
        }
      }
      return filtered;
    });
  }

  return { rows, columns, total, offset, invalidJsonFiles };
}

/**
 * Reads the schema for a data folder from its connection-relative path.
 * Schema lives at: <workspace>/.scratch/connections/scratch/<relPath>/schema.json
 */
async function readConnectionSchema(workspacePath: string, relPath: string): Promise<Record<string, unknown> | null> {
  try {
    const schemaPath = join(workspacePath, SCRATCH_DIR, CONNECTIONS_DIR, relPath, 'schema.json');
    const content = await readFile(schemaPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readSchema(workspacePath: string, folderName: string): Promise<Record<string, unknown> | null> {
  try {
    const schemaPath = join(workspacePath, SCRATCH_DIR, SCHEMAS_DIR, `${folderName}.json`);
    const content = await readFile(schemaPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Internal helpers ──

/**
 * Extracts flattened dot-separated property keys from a JSON Schema in declaration order.
 * Recurses into nested `object` type schemas so that e.g. `{ properties: { id: …, fields: { properties: { Name: … } } } }`
 * yields `['id', 'fields.Name']`.
 */
function flattenSchemaPropertyKeys(schema: Record<string, unknown>, prefix = ''): string[] {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props || typeof props !== 'object') return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    const nested = value?.properties as Record<string, unknown> | undefined;
    if (nested && typeof nested === 'object' && value?.type === 'object') {
      keys.push(...flattenSchemaPropertyKeys(value, flatKey));
    } else {
      keys.push(flatKey);
    }
  }
  return keys;
}

/**
 * Orders columns according to schema property declaration order.
 * Columns present in the schema come first (in schema order), followed by any
 * remaining columns sorted alphabetically.
 */
function orderColumnsBySchema(columnSet: Set<string>, schema: Record<string, unknown> | null): string[] {
  if (!schema) return Array.from(columnSet).sort((a, b) => a.localeCompare(b));
  const schemaKeys = flattenSchemaPropertyKeys(schema);
  const ordered: string[] = [];
  for (const key of schemaKeys) {
    if (columnSet.has(key)) ordered.push(key);
  }
  const remaining = Array.from(columnSet)
    .filter((k) => !ordered.includes(k))
    .sort((a, b) => a.localeCompare(b));
  return [...ordered, ...remaining];
}

/**
 * Flattens a nested object into dot-separated keys.
 * `{ id: "a", fields: { field1: "b" } }` → `{ id: "a", "fields.field1": "b" }`
 * Arrays and non-plain-object values are kept as leaf values (not recursed into).
 */
function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, flatKey));
    } else {
      result[flatKey] = value;
    }
  }
  return result;
}

function parseTopLevelJsonObject(
  content: string,
): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, raw: parsed as Record<string, unknown> };
    }
    return { ok: false, error: 'JSON must be a top-level object' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type JsonFileSnapshot =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; flat: Record<string, unknown>; raw: Record<string, unknown> };

function sortRowsByColumn(
  rows: Array<Record<string, unknown>>,
  column: string,
  order: 'asc' | 'desc',
): Array<Record<string, unknown>> {
  return [...rows].sort((a, b) => {
    const va = a[column];
    const vb = b[column];

    // Missing values sort last regardless of order
    if (va === undefined && vb === undefined) return 0;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;

    let cmp: number;
    if (typeof va === 'number' && typeof vb === 'number') {
      cmp = va - vb;
    } else {
      const sa = typeof va === 'string' ? va : JSON.stringify(va);
      const sb = typeof vb === 'string' ? vb : JSON.stringify(vb);
      cmp = sa.localeCompare(sb, undefined, { sensitivity: 'base', numeric: true });
    }

    return order === 'desc' ? -cmp : cmp;
  });
}

async function computeFolderStats(
  folderPath: string,
): Promise<{ fileCount: number; lastModified: number; totalSize: number }> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  let fileCount = 0;
  let lastModified = 0;
  let totalSize = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(HIDDEN_PREFIX)) continue;

    fileCount++;
    try {
      const fileStat = await stat(join(folderPath, entry.name));
      totalSize += fileStat.size;
      const mtime = fileStat.mtimeMs;
      if (mtime > lastModified) lastModified = mtime;
    } catch {
      // Skip files we can't stat
    }
  }

  return { fileCount, lastModified, totalSize };
}

async function getCachedFileNames(folderPath: string): Promise<string[]> {
  const folderStat = await stat(folderPath);
  const folderMtime = folderStat.mtimeMs;

  const cached = dirCache.get(folderPath);
  if (cached && cached.mtime === folderMtime) {
    return cached.names;
  }

  const entries = await readdir(folderPath, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && !e.name.startsWith(HIDDEN_PREFIX)).map((e) => e.name);

  dirCache.set(folderPath, { names, mtime: folderMtime });
  return names;
}

function applyFilter(names: string[], filter: { search?: string; extensions?: string[] }): string[] {
  let result = names;

  if (filter.search) {
    const needle = filter.search.toLowerCase();
    result = result.filter((name) => name.toLowerCase().includes(needle));
  }

  if (filter.extensions && filter.extensions.length > 0) {
    const exts = new Set(filter.extensions.map((e) => e.toLowerCase()));
    result = result.filter((name) => exts.has(extname(name).toLowerCase()));
  }

  return result;
}

function sortByName(names: string[], order: 'asc' | 'desc'): string[] {
  const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return order === 'desc' ? sorted.reverse() : sorted;
}

async function sortByStatField(
  folderPath: string,
  names: string[],
  field: 'modified' | 'size',
  order: 'asc' | 'desc',
): Promise<string[]> {
  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        const fileStat = await stat(join(folderPath, name));
        return { name, value: field === 'modified' ? fileStat.mtimeMs : fileStat.size };
      } catch {
        return { name, value: 0 };
      }
    }),
  );

  stats.sort((a, b) => (order === 'asc' ? a.value - b.value : b.value - a.value));
  return stats.map((s) => s.name);
}

/**
 * Recursively walks the directory tree from `dir`, collecting leaf folders
 * (directories that contain no subdirectories) into `out`. The `name` for
 * each entry is the relative path from `root` so the UI can display the
 * full folder path (e.g. "AIRTABLE - Airtable/Blog Posts - Rob/Tags").
 */
async function collectLeafFolders(root: string, dir: string, out: FolderEntry[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory() && e.name !== SCRATCH_DIR && !e.name.startsWith(HIDDEN_PREFIX));

  if (subdirs.length === 0) {
    // Leaf folder — only add if it's not the root itself
    if (dir !== root) {
      const meta = await computeFolderStats(dir);
      const relativePath = dir.slice(root.length + 1); // strip root + separator
      out.push({
        name: relativePath,
        path: dir,
        fileCount: meta.fileCount,
        lastModified: meta.lastModified,
        totalSize: meta.totalSize,
      });
    }
    return;
  }

  for (const sub of subdirs) {
    await collectLeafFolders(root, join(dir, sub.name), out);
  }
}

async function resolveFilterStatus(
  filterStatus: FilterStatus,
  folderPath: string,
  workspacePath: string,
  jsonNames: string[],
): Promise<Set<string>> {
  if (filterStatus === 'unreviewed') {
    const entries = await listUnreviewedChanges(workspacePath);
    // CLI returns paths like /subfolder/file.json with connectionName.
    // folderPath is absolute: workspacePath/connectionName/subfolder
    const names = new Set<string>();
    for (const entry of entries) {
      const absolutePath = join(workspacePath, entry.connectionName, entry.path.replace(/^\//, ''));
      if (absolutePath.startsWith(folderPath + '/') || absolutePath.startsWith(folderPath + '\\')) {
        names.add(absolutePath.slice(folderPath.length + 1));
      }
    }
    return names;
  }

  // unpublished / published both need the dirty-vs-master comparison via CLI
  const entries = await listUnpublishedChanges(workspacePath);
  const unpublishedNames = new Set<string>();
  for (const entry of entries) {
    const absolutePath = join(workspacePath, entry.connectionName, entry.path.replace(/^\//, ''));
    if (absolutePath.startsWith(folderPath + '/') || absolutePath.startsWith(folderPath + '\\')) {
      unpublishedNames.add(absolutePath.slice(folderPath.length + 1));
    }
  }

  if (filterStatus === 'unpublished') {
    return unpublishedNames;
  }

  // published = all JSON files NOT in the unpublished set
  const published = new Set<string>();
  for (const name of jsonNames) {
    if (!unpublishedNames.has(name)) {
      published.add(name);
    }
  }
  return published;
}

// ── Versioned / diff grid data ──

function getVersionFolderPath(folderPath: string, workspacePath: string, version: GridVersion): string {
  if (version === 'working') return folderPath;
  const rel = relative(workspacePath, folderPath);
  const parts = rel.split(sep);
  const connName = parts[0];
  const subPath = parts.slice(1).join(sep);
  const prefix =
    version === 'dirty' ? join('.scratch', 'connections', 'dirty') : join('.scratch', 'connections', 'master');
  return subPath ? join(workspacePath, prefix, connName, subPath) : join(workspacePath, prefix, connName);
}

function getConnectionPaths(folderPath: string, workspacePath: string): ConnectionPaths {
  const rel = relative(workspacePath, folderPath);
  const parts = rel.split(sep).filter(Boolean);
  const connName = parts[0];
  if (!connName || connName.startsWith('.')) {
    throw new Error(`Folder path ${folderPath} is not inside a workspace connection.`);
  }
  const subPath = parts.slice(1).join(sep);
  return {
    subPath,
    workingConnPath: join(workspacePath, connName),
    reviewedDirtyConnPath: join(workspacePath, '.scratch', 'connections', 'dirty', connName),
  };
}

function toGitPath(path: string): string {
  return path.split(sep).join('/');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function commitReviewedDirtyFile(folderPath: string, workspacePath: string, filename: string): Promise<void> {
  const { subPath, workingConnPath, reviewedDirtyConnPath } = getConnectionPaths(folderPath, workspacePath);
  const reviewedDirtyGitPath = join(reviewedDirtyConnPath, '.git');
  const workingGitPath = join(workingConnPath, '.git');

  if (!(await pathExists(reviewedDirtyGitPath))) {
    console.debug('[acceptCellChange] reviewed dirty checkout is not a git worktree; skipping dirty ref update');
    return;
  }

  const repoRelativePath = toGitPath(subPath ? join(subPath, filename) : filename);
  await runGit(reviewedDirtyConnPath, ['add', '--', repoRelativePath]);

  const { stdout: status } = await runGit(reviewedDirtyConnPath, ['status', '--porcelain', '--', repoRelativePath]);
  if (status.trim() === '') {
    console.debug('[acceptCellChange] dirty ref already matches approved value');
    return;
  }

  await runGit(reviewedDirtyConnPath, [
    '-c',
    'user.name=Scratch',
    '-c',
    'user.email=scratch@example.com',
    'commit',
    '-m',
    `Accept local cell change: ${repoRelativePath}`,
    '--',
    repoRelativePath,
  ]);

  const { stdout } = await runGit(reviewedDirtyConnPath, ['rev-parse', 'HEAD']);
  const newDirtyHash = stdout.trim();
  if (newDirtyHash && (await pathExists(workingGitPath))) {
    await runGit(workingConnPath, ['reset', '--mixed', newDirtyHash]);
  }
}

async function readJsonFileSnapshot(filePath: string): Promise<JsonFileSnapshot> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) return { kind: 'missing' };
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = parseTopLevelJsonObject(content);
  if (!parsed.ok) {
    return { kind: 'invalid', error: parsed.error };
  }
  return { kind: 'ok', flat: flattenObject(parsed.raw), raw: parsed.raw };
}

async function readFolderSnapshots(folderPath: string): Promise<Map<string, JsonFileSnapshot>> {
  const result = new Map<string, JsonFileSnapshot>();
  let names: string[];
  try {
    names = (await getCachedFileNames(folderPath)).filter((n) => extname(n).toLowerCase() === '.json');
  } catch {
    return result;
  }
  for (let i = 0; i < names.length; i += BATCH_CONCURRENCY) {
    const batch = names.slice(i, i + BATCH_CONCURRENCY);
    await Promise.all(
      batch.map(async (name) => {
        const snap = await readJsonFileSnapshot(join(folderPath, name));
        result.set(name, snap);
      }),
    );
  }
  return result;
}

export async function readFolderStatuses(folderPath: string, workspacePath: string): Promise<FolderStatuses> {
  const allNames = (await getCachedFileNames(folderPath)).filter((n) => extname(n).toLowerCase() === '.json');
  const [unreviewed, unpublished] = await Promise.all([
    resolveFilterStatus('unreviewed', folderPath, workspacePath, allNames),
    resolveFilterStatus('unpublished', folderPath, workspacePath, allNames),
  ]);
  return {
    unreviewedFilenames: Array.from(unreviewed),
    unpublishedFilenames: Array.from(unpublished),
  };
}

export interface DiffGridSummary {
  total: number;
  added: number;
  modified: number;
  unpublished: number;
  deleted: number;
  invalidJson: number;
}

function makeDiffRow(
  base: Record<string, unknown>,
  status: RowStatus,
  changedFields: string[],
  fromFields: Record<string, unknown>,
  unpublishedFields: string[],
  masterFields: Record<string, unknown>,
  filename: string,
  parseError?: string,
): DiffRow {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) row[k] = v;
  row['__rowStatus'] = status;
  row['__changedFields'] = changedFields;
  row['__fromFields'] = fromFields;
  row['__unpublishedFields'] = unpublishedFields;
  row['__masterFields'] = masterFields;
  row['__filename'] = filename;
  if (parseError !== undefined) {
    row['__parseError'] = parseError;
  }
  return row as DiffRow;
}

function compareFlattenedRecordVersions(
  workingRow: Record<string, unknown> | undefined,
  dirtyRow: Record<string, unknown> | undefined,
  masterRow: Record<string, unknown> | undefined,
  filename: string,
): { row: DiffRow; columns: string[] } | null {
  const columnSet = new Set<string>();

  if (workingRow && !dirtyRow) {
    for (const k of Object.keys(workingRow)) columnSet.add(k);
    return { row: makeDiffRow(workingRow, 'added', [], {}, [], {}, filename), columns: Array.from(columnSet) };
  }

  if (!workingRow && dirtyRow) {
    for (const k of Object.keys(dirtyRow)) columnSet.add(k);
    return { row: makeDiffRow(dirtyRow, 'deleted', [], dirtyRow, [], {}, filename), columns: Array.from(columnSet) };
  }

  if (!workingRow && !dirtyRow && masterRow) {
    for (const k of Object.keys(masterRow)) columnSet.add(k);
    return {
      row: makeDiffRow(masterRow, 'deletedUnpublished', [], {}, [], masterRow, filename),
      columns: Array.from(columnSet),
    };
  }

  if (workingRow && dirtyRow) {
    const comparableMasterRow = masterRow ?? {};
    const allKeysArr: string[] = Array.from(
      new Set<string>(Object.keys(workingRow).concat(Object.keys(dirtyRow)).concat(Object.keys(comparableMasterRow))),
    );

    const changedFields: string[] = [];
    const fromFields: Record<string, unknown> = {};
    const unpublishedFields: string[] = [];
    const masterFields: Record<string, unknown> = {};

    for (const k of allKeysArr) {
      columnSet.add(k);
      const wStr = JSON.stringify(workingRow[k] as object);
      const dStr = JSON.stringify(dirtyRow[k] as object);
      const mStr = JSON.stringify(comparableMasterRow[k] as object);

      if (wStr !== dStr) {
        changedFields.push(k);
        fromFields[k] = dirtyRow[k];
      } else if (dStr !== mStr) {
        unpublishedFields.push(k);
        masterFields[k] = comparableMasterRow[k];
      }
    }

    const status: RowStatus =
      changedFields.length > 0 ? 'modified' : unpublishedFields.length > 0 ? 'unpublished' : 'unchanged';

    return {
      row: makeDiffRow(workingRow, status, changedFields, fromFields, unpublishedFields, masterFields, filename),
      columns: Array.from(columnSet),
    };
  }

  return null;
}

function compareRecordSnapshots(
  w: JsonFileSnapshot,
  d: JsonFileSnapshot,
  m: JsonFileSnapshot,
  filename: string,
): { row: DiffRow; columns: string[] } | null {
  if (w.kind === 'invalid' || d.kind === 'invalid' || m.kind === 'invalid') {
    const parseParts: string[] = [];
    if (w.kind === 'invalid') parseParts.push(`working: ${w.error}`);
    if (d.kind === 'invalid') parseParts.push(`reviewed: ${d.error}`);
    if (m.kind === 'invalid') parseParts.push(`published: ${m.error}`);
    const parseError = parseParts.join('; ');
    const base: Record<string, unknown> =
      w.kind === 'ok' ? w.flat : d.kind === 'ok' ? d.flat : m.kind === 'ok' ? m.flat : {};
    const columnSet = new Set<string>();
    for (const k of Object.keys(base)) {
      columnSet.add(k);
    }
    return {
      row: makeDiffRow(base, 'invalidJson', [], {}, [], {}, filename, parseError),
      columns: Array.from(columnSet),
    };
  }

  const wRow = w.kind === 'ok' ? w.flat : undefined;
  const dRow = d.kind === 'ok' ? d.flat : undefined;
  const mRow = m.kind === 'ok' ? m.flat : undefined;
  return compareFlattenedRecordVersions(wRow, dRow, mRow, filename);
}

function pickDisplayRecordData(
  workingData: Record<string, unknown> | null,
  dirtyData: Record<string, unknown> | null,
  masterData: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return workingData ?? dirtyData ?? masterData;
}

/**
 * Compares working tree against dirty and master branches, returning a unified row list.
 *
 * Row status priority:
 * - added:       file in working only (unreviewed new file)
 * - deleted:     file in dirty only, not in working (unreviewed deletion)
 * - modified:    w != d for at least one field (unreviewed changes; d vs m is ignored)
 * - unpublished: w == d but d != m for at least one field (reviewed, not yet published)
 * - unchanged:   w == d == m for all fields
 * - invalidJson: at least one branch file is not valid top-level JSON object (see __parseError)
 *
 * For modified rows, __changedFields lists fields where w != d, and __fromFields holds the
 * dirty-branch values (the "from" side for the unreviewed diff display).
 *
 * For unpublished rows, __unpublishedFields lists fields where d != m (and w == d), and
 * __masterFields holds the master-branch values (the "from" side for the unpublished diff display).
 */
function buildInvalidJsonFileEntries(
  folderPath: string,
  workspacePath: string,
  rows: DiffRow[],
): InvalidJsonFileEntry[] {
  const reviewedDir = getVersionFolderPath(folderPath, workspacePath, 'dirty');
  const publishedDir = getVersionFolderPath(folderPath, workspacePath, 'main');
  return rows
    .filter((r) => r.__rowStatus === 'invalidJson')
    .map((r) => ({
      filename: r.__filename,
      error: typeof r.__parseError === 'string' ? r.__parseError : 'Invalid JSON',
      workingFilePath: join(folderPath, r.__filename),
      reviewedFilePath: join(reviewedDir, r.__filename),
      publishedFilePath: join(publishedDir, r.__filename),
    }));
}

export async function readDiffGridData(folderPath: string, workspacePath: string): Promise<DiffGridResult> {
  return readDiffGridDataPage(folderPath, workspacePath, {});
}

export async function readDiffGridDataPage(
  folderPath: string,
  workspacePath: string,
  opts: ReadDiffGridDataOptions,
): Promise<DiffGridResult> {
  const workingPath = folderPath;
  const dirtyPath = getVersionFolderPath(folderPath, workspacePath, 'dirty');
  const masterPath = getVersionFolderPath(folderPath, workspacePath, 'main');

  const relPath = relative(workspacePath, folderPath);
  const [workingFiles, dirtyFiles, masterFiles, schema] = await Promise.all([
    readFolderSnapshots(workingPath),
    readFolderSnapshots(dirtyPath),
    readFolderSnapshots(masterPath),
    readConnectionSchema(workspacePath, relPath),
  ]);

  const missingSnapshot: JsonFileSnapshot = { kind: 'missing' };

  // Include master-only files so approved deletions (dirty removed, master still has it) remain visible.
  const allNamesArr: string[] = Array.from(
    new Set<string>(
      Array.from(workingFiles.keys()).concat(Array.from(dirtyFiles.keys())).concat(Array.from(masterFiles.keys())),
    ),
  );
  const columnSet = new Set<string>();
  const rows: DiffRow[] = [];

  for (const name of allNamesArr) {
    const compared = compareRecordSnapshots(
      workingFiles.get(name) ?? missingSnapshot,
      dirtyFiles.get(name) ?? missingSnapshot,
      masterFiles.get(name) ?? missingSnapshot,
      name,
    );
    if (!compared) {
      continue;
    }
    for (const column of compared.columns) columnSet.add(column);
    rows.push(compared.row);
  }

  const summary: DiffGridSummary = {
    total: rows.length,
    added: rows.filter((r) => r.__rowStatus === 'added').length,
    modified: rows.filter((r) => r.__rowStatus === 'modified').length,
    unpublished: rows.filter((r) => r.__rowStatus === 'unpublished').length,
    deleted: rows.filter((r) => r.__rowStatus === 'deleted' || r.__rowStatus === 'deletedUnpublished').length,
    invalidJson: rows.filter((r) => r.__rowStatus === 'invalidJson').length,
  };

  const filterCounts = {
    unreviewed: rows.filter((row) => rowHasUnreviewedChanges(row)).length,
    unpublished: rows.filter((row) => rowHasUnpublishedChanges(row)).length,
  };
  const invalidJsonFiles = buildInvalidJsonFileEntries(workingPath, workspacePath, rows);
  const filteredRows = applyDiffGridFilters(rows, opts.filters ?? []);
  const sortedRows = sortDiffRows(filteredRows, opts.sortBy, opts.sortOrder);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? GRID_DATA_MAX_PAGINATION);
  const pagedRows = sortedRows.slice(offset, offset + limit);

  return {
    rows: pagedRows,
    columns: orderColumnsBySchema(columnSet, (schema?.schema as Record<string, unknown>) ?? null),
    total: filteredRows.length,
    summary,
    filterCounts,
    invalidJsonFiles,
  };
}

function rowHasUnreviewedChanges(row: DiffRow): boolean {
  return (
    row.__rowStatus === 'added' ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'invalidJson' ||
    row.__changedFields.length > 0
  );
}

function rowHasUnpublishedChanges(row: DiffRow): boolean {
  return row.__rowStatus === 'deletedUnpublished' || row.__unpublishedFields.length > 0;
}

function filterMatchesDiffRow(row: DiffRow, filter: DiffGridFilter): boolean {
  if (filter.scope === 'global') {
    return filter.kind === 'unreviewed' ? rowHasUnreviewedChanges(row) : rowHasUnpublishedChanges(row);
  }

  if (filter.scope === 'text') {
    const query = filter.value.trim().toLocaleLowerCase();
    if (query.length === 0) {
      return true;
    }

    const rawValue = row[filter.columnId];
    const textValue =
      rawValue == null
        ? ''
        : typeof rawValue === 'string'
          ? rawValue
          : typeof rawValue === 'number' || typeof rawValue === 'boolean'
            ? String(rawValue)
            : JSON.stringify(rawValue);

    return textValue.toLocaleLowerCase().includes(query);
  }

  return filter.kind === 'unreviewed'
    ? row.__changedFields.includes(filter.columnId)
    : row.__unpublishedFields.includes(filter.columnId);
}

function applyDiffGridFilters(rows: DiffRow[], filters: DiffGridFilter[]): DiffRow[] {
  if (filters.length === 0) {
    return rows;
  }

  return rows.filter((row) => filters.every((filter) => filterMatchesDiffRow(row, filter)));
}

function compareSortableValues(aVal: unknown, bVal: unknown, sortOrder: 'asc' | 'desc'): number {
  const direction = sortOrder === 'asc' ? 1 : -1;

  if (aVal == null && bVal == null) return 0;
  if (aVal == null) return direction;
  if (bVal == null) return -direction;
  if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * direction;

  const aText = typeof aVal === 'string' ? aVal : JSON.stringify(aVal);
  const bText = typeof bVal === 'string' ? bVal : JSON.stringify(bVal);
  return aText.localeCompare(bText, undefined, { sensitivity: 'base', numeric: true }) * direction;
}

function compareFilename(a: DiffRow, b: DiffRow): number {
  return a.__filename.localeCompare(b.__filename, undefined, { sensitivity: 'base', numeric: true });
}

function sortDiffRows(rows: DiffRow[], sortBy?: string, sortOrder?: 'asc' | 'desc'): DiffRow[] {
  return [...rows].sort((a, b) => {
    let primary = 0;
    if (sortBy && sortOrder) {
      primary = compareSortableValues(a[sortBy], b[sortBy], sortOrder);
    }

    if (primary !== 0) {
      return primary;
    }

    return compareFilename(a, b);
  });
}

export async function readDiffRecordData(
  folderPath: string,
  workspacePath: string,
  filename: string,
): Promise<DiffRecordResult | null> {
  const workingFile = join(folderPath, filename);
  const dirtyFile = join(getVersionFolderPath(folderPath, workspacePath, 'dirty'), filename);
  const masterFile = join(getVersionFolderPath(folderPath, workspacePath, 'main'), filename);

  const [w, d, m] = await Promise.all([
    readJsonFileSnapshot(workingFile),
    readJsonFileSnapshot(dirtyFile),
    readJsonFileSnapshot(masterFile),
  ]);

  const compared = compareRecordSnapshots(w, d, m, filename);
  if (!compared) {
    return null;
  }

  const workingData = w.kind === 'ok' ? w.raw : null;
  const dirtyData = d.kind === 'ok' ? d.raw : null;
  const masterData = m.kind === 'ok' ? m.raw : null;

  return {
    row: compared.row,
    columns: compared.columns,
    workingData,
    dirtyData,
    masterData,
    displayData: pickDisplayRecordData(workingData, dirtyData, masterData),
  };
}

/**
 * Applies a single field value to both the working copy and dirty branch file.
 * The value string is parsed as JSON if possible (restoring numbers, booleans, etc.),
 * otherwise kept as a plain string. Dot-separated fieldName paths address nested fields.
 */
export async function acceptCellChange(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
  value: string,
): Promise<{ value: unknown }> {
  const parsed = parseFieldValue(value);

  const workingFile = join(folderPath, filename);
  const dirtyPath = getVersionFolderPath(folderPath, workspacePath, 'dirty');
  const dirtyFile = join(dirtyPath, filename);

  console.debug('[acceptCellChange] working:', workingFile);
  console.debug('[acceptCellChange] dirty:  ', dirtyFile);
  console.debug('[acceptCellChange] field:', fieldName, '→', JSON.stringify(parsed));

  await patchJsonField(workingFile, fieldName, parsed);
  console.debug('[acceptCellChange] working file patched');

  await patchJsonField(dirtyFile, fieldName, parsed);
  console.debug('[acceptCellChange] dirty file patched');

  await commitReviewedDirtyFile(folderPath, workspacePath, filename);
  console.debug('[acceptCellChange] dirty ref updated');

  return { value: parsed };
}

/**
 * Reverts a reviewed-but-unpublished cell back to the master value in both
 * editable copies. This intentionally reads master in the main process so
 * nullable, numeric, object, and missing values are preserved exactly.
 */
export async function undoApprovedCellChange(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
): Promise<void> {
  const workingFile = join(folderPath, filename);
  const dirtyPath = getVersionFolderPath(folderPath, workspacePath, 'dirty');
  const dirtyFile = join(dirtyPath, filename);
  const masterPath = getVersionFolderPath(folderPath, workspacePath, 'main');
  const masterFile = join(masterPath, filename);
  const masterValue = await readJsonField(masterFile, fieldName);

  console.debug('[undoApprovedCellChange] working:', workingFile);
  console.debug('[undoApprovedCellChange] dirty:  ', dirtyFile);
  console.debug('[undoApprovedCellChange] master: ', masterFile);
  console.debug(
    '[undoApprovedCellChange] field:',
    fieldName,
    '→',
    masterValue.exists ? JSON.stringify(masterValue.value) : '<missing>',
  );

  await applyJsonField(workingFile, fieldName, masterValue);
  console.debug('[undoApprovedCellChange] working file patched');

  await applyJsonField(dirtyFile, fieldName, masterValue);
  console.debug('[undoApprovedCellChange] dirty file patched');

  await commitReviewedDirtyFile(folderPath, workspacePath, filename);
  console.debug('[undoApprovedCellChange] dirty ref updated');
}

async function patchJsonField(filePath: string, fieldName: string, value: unknown): Promise<void> {
  const obj = (await readJsonObject(filePath)) ?? {};
  setNestedValue(obj, fieldName, value);
  await writeJsonObject(filePath, obj);
}

async function applyJsonField(filePath: string, fieldName: string, value: JsonFieldValue): Promise<void> {
  if (value.exists) {
    await patchJsonField(filePath, fieldName, value.value);
    return;
  }
  await removeJsonField(filePath, fieldName);
}

async function readJsonField(filePath: string, fieldName: string): Promise<JsonFieldValue> {
  const obj = await readJsonObject(filePath);
  if (!obj) return { exists: false };
  return getNestedValue(obj, fieldName);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`JSON file ${filePath} does not contain an object`);
  } catch (err) {
    if (isFileNotFoundError(err)) return null;
    throw err;
  }
}

async function writeJsonObject(filePath: string, obj: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(obj, null, 2));
}

async function removeJsonField(filePath: string, fieldName: string): Promise<void> {
  const obj = await readJsonObject(filePath);
  if (!obj) return;
  deleteNestedValue(obj, fieldName);
  await writeJsonObject(filePath, obj);
}

function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1];
  current[lastPart] = value;
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): JsonFieldValue {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current)) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function deleteNestedValue(obj: Record<string, unknown>, dotPath: string): boolean {
  const parts = dotPath.split('.');
  return deleteNestedValueAt(obj, parts, 0);
}

function deleteNestedValueAt(current: Record<string, unknown>, parts: string[], index: number): boolean {
  const part = parts[index];
  if (index === parts.length - 1) {
    delete current[part];
  } else {
    const child = current[part];
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      const childIsEmpty = deleteNestedValueAt(child as Record<string, unknown>, parts, index + 1);
      if (childIsEmpty) {
        delete current[part];
      }
    }
  }
  return Object.keys(current).length === 0;
}

function isFileNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

function parseFieldValue(str: string): unknown {
  const trimmed = str.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return str;
  }
}

async function statFileEntry(folderPath: string, name: string): Promise<FileEntry> {
  const filePath = join(folderPath, name);
  const ext = extname(name).toLowerCase();

  try {
    const fileStat = await stat(filePath);
    return {
      name,
      path: filePath,
      size: fileStat.size,
      lastModified: fileStat.mtimeMs,
      extension: ext,
      isJson: ext === '.json',
    };
  } catch {
    return {
      name,
      path: filePath,
      size: 0,
      lastModified: 0,
      extension: ext,
      isJson: ext === '.json',
    };
  }
}
