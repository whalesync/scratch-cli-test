/**
 * Local file access layer for Scratch Desktop.
 *
 * All filesystem I/O for workspace files lives here, in the main process.
 * The renderer accesses these functions via IPC handlers registered in index.ts.
 *
 * Target format: Rust CLI / .scratch workspace layout.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'path';
import { parse } from 'yaml';

import type { TableView } from '@spinner/shared-types';
import { formatRecordJson } from '@spinner/shared-types/format';
import {
  coerceCellInputTextAgainstExistingValueOrSchema,
  resolveSchemaLeafHint,
  type SchemaLeafHint,
} from '../shared/cell-value-coercion';
import type { ColumnDefinition, NormalizedRecordRow } from '../shared/schema-columns';
import { buildColumnDefinitions, createFallbackTableView, tableViewColumnPaths } from '../shared/schema-columns';
import {
  acceptCellField,
  discardCellField,
  listFolderFilenames,
  readFolderBlobsFiltered,
  rejectCellField,
} from './native/scratchmd-native';
import {
  listUnpublishedChanges,
  listUnreviewedChanges,
  readRecords,
  type ReadRecordsFilterOp,
  type ValidationError,
} from './scratchmd';

// ── Types (duplicated from renderer types to avoid cross-process import issues) ──

interface WorkspaceConfig {
  apiUrl: string;
  workbookId: string;
  orgId: string;
  authToken?: string;
  connections: WorkspaceConnection[];
}

interface WorkspaceConnection {
  id: string;
  displayName: string;
  service: string;
  dirName: string;
}

interface WorkspaceMarker {
  workbook?: Record<string, unknown>;
  connections?: Array<Record<string, unknown>>;
}

interface FolderEntry {
  name: string;
  path: string;
  fileCount: number;
}

interface FolderMetadata extends FolderEntry {
  schema: Record<string, unknown> | null;
  columnDefinitions: ColumnDefinition[];
  view: TableView | null;
  availableViewNames: string[];
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
const MARKER_FILE = '.scratchmd';
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

// ── Public functions ──

export async function readWorkspaceConfig(workspacePath: string): Promise<WorkspaceConfig> {
  const marker = await readWorkspaceMarker(workspacePath);
  const workbook = marker?.workbook ?? null;

  return {
    apiUrl: getString(workbook?.serverUrl) ?? '',
    workbookId: getString(workbook?.id) ?? '',
    orgId: getString(workbook?.orgId) ?? '',
    authToken: undefined,
    connections: parseWorkspaceConnections(marker),
  };
}

async function readWorkspaceMarker(workspacePath: string): Promise<WorkspaceMarker | null> {
  try {
    const markerPath = join(workspacePath, SCRATCH_DIR, MARKER_FILE);
    const content = await readFile(markerPath, 'utf-8');
    return parse(content) as WorkspaceMarker | null;
  } catch {
    return null;
  }
}

function parseWorkspaceConnections(marker: WorkspaceMarker | null): WorkspaceConnection[] {
  return (marker?.connections ?? [])
    .map((connection) => ({
      id: getString(connection.id) ?? '',
      displayName: getString(connection.displayName) ?? '',
      service: getString(connection.service) ?? '',
      dirName: getString(connection.dirName) ?? '',
    }))
    .filter((connection) => connection.id && connection.dirName);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export async function listFolders(workspacePath: string): Promise<FolderEntry[]> {
  const folders: FolderEntry[] = [];
  await collectLeafFolders(workspacePath, workspacePath, folders);
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return folders;
}

/** Total record files across all data leaf folders (same definition as per-folder counts in listFolders). */
export async function countWorkspaceFiles(workspacePath: string): Promise<number> {
  const folders = await listFolders(workspacePath);
  return folders.reduce((sum, f) => sum + f.fileCount, 0);
}

export async function getFolderMetadata(folderPath: string, workspacePath: string): Promise<FolderMetadata> {
  const folderName = basename(folderPath);
  const relPath = relative(workspacePath, folderPath);

  // The schema/view reads and the record-file count are independent I/O, so run
  // them concurrently. fileCount is derived from a single readdir (no per-file
  // stat), matching how the sidebar's collectLeafFolders counts files.
  const [schema, diskView, availableViewNames, fileCount] = await Promise.all([
    readConnectionSchema(workspacePath, relPath),
    readConnectionView(workspacePath, relPath),
    listConnectionViewNames(workspacePath, relPath),
    countRecordFilesInFolder(folderPath),
  ]);
  if (!schema) {
    throw new Error(
      `Schema not found for folder "${folderName}" at ${join(SCRATCH_DIR, CONNECTIONS_DIR, relPath, 'schema.json')}`,
    );
  }

  return {
    name: folderName,
    path: folderPath,
    fileCount,
    schema,
    columnDefinitions: buildColumnDefinitions(schema),
    view: diskView ?? createFallbackTableView(schema),
    availableViewNames,
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
export type RowStatus =
  | 'added'
  | 'addedUnpublished'
  | 'modified'
  | 'unpublished'
  | 'deleted'
  | 'deletedUnpublished'
  | 'unchanged'
  | 'invalidJson';
export type DiffGridFilterKind = 'unreviewed' | 'unpublished' | 'has-problems';

export type DiffGridFilter =
  | { scope: 'global'; kind: DiffGridFilterKind }
  | { scope: 'column'; kind: DiffGridFilterKind; columnId: string; columnTitle: string }
  | { scope: 'text'; columnId: string; columnTitle: string; value: string };

export interface DiffRow extends Record<string, unknown> {
  __rowStatus: RowStatus;
  /** Fields where working differs from the approved version (unreviewed changes). */
  __changedFields: string[];
  /** Approved values for unreviewed fields (the "from" side when working != approved). */
  __fromFields: Record<string, unknown>;
  /** Fields where working == approved but approved != published (reviewed but not yet published). */
  __unpublishedFields: string[];
  /** Published (refs/heads/main) values for unpublished fields. */
  __masterFields: Record<string, unknown>;
  __filename: string;
  /** Set when __rowStatus is invalidJson (which side failed is encoded in the string). */
  __parseError?: string;
  /** The full nested (non-flattened) record from the working tree, used by the renderer. */
  __raw: Record<string, unknown>;
}

export interface InvalidJsonFileEntry {
  filename: string;
  error: string;
  /**
   * Path to the file on disk in the user worktree. The "approved" and
   * "published" versions live as git blobs in the bare repo and can't be
   * opened as files — slice F retired the per-worktree on-disk mirrors.
   */
  workingFilePath: string;
}

export interface DiffGridResult {
  rows: DiffRow[];
  columns: ColumnDefinition[];
  total: number;
  summary: DiffGridSummary;
  filterCounts: {
    unreviewed: number;
    unpublished: number;
    errors: number;
  };
  focusColumnIds: {
    unreviewed: string[];
    unpublished: string[];
    errors: string[];
  };
  invalidJsonFiles: InvalidJsonFileEntry[];
  /** Number of records on the current page whose validation was stale before this call (0 when validate=false). */
  staleCount: number;
  /** Per-record validation errors keyed by filename. Empty when validate=false. */
  validationByCell: Record<string, ValidationError[]>;
  /** Total records across the whole table with has_errors=1. */
  totalErrorCount: number;
  /** Total records across the whole table with stale validation. 0 when validate=false. */
  totalProblemsStaleCount: number;
}

export interface DiffRecordResult {
  row: DiffRow;
  columns: ColumnDefinition[];
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
  validate?: boolean;
}

interface GridDataResult {
  rows: NormalizedRecordRow[];
  columns: ColumnDefinition[];
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

  // Load schema and derive column definitions
  if (!opts.workspacePath) {
    throw new Error('readGridData requires workspacePath to load the schema.');
  }
  const relPath = relative(opts.workspacePath, folderPath);
  const schemaWrapper = await readConnectionSchema(opts.workspacePath, relPath);
  if (!schemaWrapper) {
    const folderName = basename(folderPath);
    throw new Error(
      `Schema not found for folder "${folderName}" at ${join(SCRATCH_DIR, CONNECTIONS_DIR, relPath, 'schema.json')}`,
    );
  }
  let columns = buildColumnDefinitions(schemaWrapper);
  const columnIdSet = new Set(columns.map((c) => c.id));

  let allNames = await getCachedFileNames(folderPath);

  // Only include JSON files
  allNames = allNames.filter((name) => extname(name).toLowerCase() === '.json');

  // Apply status filter
  if (opts.filterStatus) {
    const allowed = await resolveFilterStatus(opts.filterStatus, folderPath, opts.workspacePath, allNames);
    allNames = allNames.filter((name) => allowed.has(name));
  }

  // Read, parse, and project all matching files through schema-driven columns
  let allRows: NormalizedRecordRow[] = [];
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
          return { __filename: name, __raw: parsed.raw } satisfies NormalizedRecordRow;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          invalidJsonFiles.push({ filename: name, error: message });
          return null;
        }
      }),
    );

    for (const row of batchRows) {
      if (row !== null) allRows.push(row);
    }
  }

  // Filter rows by column values (match against raw values)
  if (opts.filter) {
    const filterEntries = Object.entries(opts.filter);
    allRows = allRows.filter((row) =>
      filterEntries.every(([col, expected]) => col in row.__raw && row.__raw[col] === expected),
    );
  }

  const total = allRows.length;

  // Sort by column value
  if (opts.sortBy) {
    allRows = sortNormalizedRows(allRows, opts.sortBy, opts.sortOrder ?? 'asc');
  }

  // Paginate
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? GRID_DATA_MAX_PAGINATION);
  const rows = allRows.slice(offset, offset + limit);

  // If specific columns requested, narrow the returned column list
  if (opts.columns && opts.columns.length > 0) {
    const requested = new Set(opts.columns);
    columns = columns.filter((c) => requested.has(c.id) && columnIdSet.has(c.id));
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

export async function readConnectionViewByName(
  folderPath: string,
  workspacePath: string,
  viewName: string,
): Promise<TableView | null> {
  const relPath = relative(workspacePath, folderPath);
  return readConnectionView(workspacePath, relPath, viewName);
}

async function readConnectionView(
  workspacePath: string,
  relPath: string,
  viewName: string = 'default',
): Promise<TableView | null> {
  try {
    const viewPath = join(workspacePath, SCRATCH_DIR, CONNECTIONS_DIR, relPath, 'views', `${viewName}.json`);
    const content = await readFile(viewPath, 'utf-8');
    return JSON.parse(content) as TableView;
  } catch {
    return null;
  }
}

async function listConnectionViewNames(workspacePath: string, relPath: string): Promise<string[]> {
  try {
    const viewsDir = join(workspacePath, SCRATCH_DIR, CONNECTIONS_DIR, relPath, 'views');
    const entries = await readdir(viewsDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name.replace(/\.json$/, ''));
  } catch {
    return [];
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
 * Flattens a nested object into dot-separated keys.
 * `{ id: "a", fields: { field1: "b" } }` → `{ id: "a", "fields.field1": "b" }`
 * Arrays and non-plain-object values are kept as leaf values (not recursed into).
 *
 * When `leafPaths` is provided, any key path in the set is kept as a leaf value
 * even if the value is a plain object. This prevents flattening schema-leaf columns
 * (e.g. `originalSource` wrapped in `anyOf`) that should render as JSON.
 */
function flattenObject(obj: Record<string, unknown>, prefix = '', leafPaths?: Set<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && !leafPaths?.has(flatKey)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, flatKey, leafPaths));
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

function sortNormalizedRows(rows: NormalizedRecordRow[], column: string, order: 'asc' | 'desc'): NormalizedRecordRow[] {
  return [...rows].sort((a, b) => {
    const va = a.__raw[column];
    const vb = b.__raw[column];

    // Missing values sort last regardless of order
    if (va === undefined && vb === undefined) return 0;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;

    let cmp: number;
    if (typeof va === 'number' && typeof vb === 'number') {
      cmp = va - vb;
    } else {
      const sa = typeof va === 'string' ? va : (JSON.stringify(va) ?? '');
      const sb = typeof vb === 'string' ? vb : (JSON.stringify(vb) ?? '');
      cmp = sa.localeCompare(sb, undefined, { sensitivity: 'base', numeric: true });
    }

    return order === 'desc' ? -cmp : cmp;
  });
}

/** Counts record files in a folder with a single readdir (no per-file stat). */
async function countRecordFilesInFolder(folderPath: string): Promise<number> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith(HIDDEN_PREFIX)).length;
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
    if (dir !== root) {
      const fileCount = entries.filter((e) => e.isFile() && !e.name.startsWith(HIDDEN_PREFIX)).length;
      // POSIX-normalise on Windows so the workspace-relative name matches the
      // forward-slash shape the Rust side emits (and that consumers like the
      // validation/review dot maps use as their `${connection}/${folder_path}`
      // lookup key).
      const relativePath = dir
        .slice(root.length + 1)
        .split(/[\\/]/)
        .join('/');
      out.push({
        name: relativePath,
        path: dir,
        fileCount,
      });
    }
    return;
  }

  await Promise.all(subdirs.map((sub) => collectLeafFolders(root, join(dir, sub.name), out)));
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

// ── Diff grid data ──
//
// Slice F.5 retired the multi-worktree layout: the desktop no longer reads
// from `.scratch/connections/{dirty,master}/<conn>/` (those directories don't
// exist anymore). The "approved" and "published" snapshots come from a napi
// binding that reads `refs/heads/main` + `accepted-patches.json` directly
// from the bare repo. "Working" stays a TS-side fs read.

/**
 * Split `<workspace>/<conn>/<sub-path>` into the connection dir name + the
 * connection-relative folder path that the napi binding accepts. Throws if
 * `folderPath` isn't inside `workspacePath`.
 */
function splitWorkspaceFolderPath(
  workspacePath: string,
  folderPath: string,
): { connectionDirName: string; folderRelPath: string } {
  const rel = relative(workspacePath, folderPath);
  if (rel === '' || rel.startsWith('..')) {
    throw new Error(
      `folderPath ${JSON.stringify(folderPath)} is not inside workspace ${JSON.stringify(workspacePath)}`,
    );
  }
  const parts = rel.split(sep);
  const [connectionDirName, ...rest] = parts;
  // Use POSIX separators inside the workspace — accepted-patches.json and
  // the napi binding both speak `/`-joined repo-relative paths.
  const folderRelPath = rest.join('/');
  return { connectionDirName, folderRelPath };
}

function snapshotFromContent(content: string | null | undefined, leafPaths?: Set<string>): JsonFileSnapshot {
  if (content == null) return { kind: 'missing' };
  const parsed = parseTopLevelJsonObject(content);
  if (!parsed.ok) {
    return { kind: 'invalid', error: parsed.error };
  }
  return { kind: 'ok', flat: flattenObject(parsed.raw, '', leafPaths), raw: parsed.raw };
}

/**
 * Pull the `(published, approved)` content for the supplied filenames via the
 * napi binding and convert each into the `JsonFileSnapshot` shape the
 * comparison code expects. `filenames` bounds the read to the caller's page —
 * grid views pass the page's filename list; single-record views pass `[name]`.
 *
 * Returns empty maps when the workspace marker can't be resolved (treats
 * every record as new — matches the desktop's pre-F.5 fallback when the
 * deleted worktrees were empty).
 */
async function readFolderApprovedAndPublishedSnapshots(
  workspacePath: string,
  folderPath: string,
  leafPaths: Set<string> | undefined,
  filenames: string[],
): Promise<{ approved: Map<string, JsonFileSnapshot>; published: Map<string, JsonFileSnapshot> }> {
  const approved = new Map<string, JsonFileSnapshot>();
  const published = new Map<string, JsonFileSnapshot>();
  let connectionDirName: string;
  let folderRelPath: string;
  try {
    ({ connectionDirName, folderRelPath } = splitWorkspaceFolderPath(workspacePath, folderPath));
  } catch {
    // Folder outside workspace — return empty maps so the diff code treats
    // working files as "added" (the pre-F.5 behavior when the deleted
    // worktrees were empty).
    return { approved, published };
  }
  let blobs;
  try {
    blobs = await readFolderBlobsFiltered(workspacePath, connectionDirName, folderRelPath, filenames);
  } catch (err) {
    // Workspace marker missing, unknown connection, or other native error.
    // Log and degrade to empty — the grid still renders working files (as
    // "added"); the user can recover via `workspaces unsync` + re-init.
    console.debug('readFolderBlobsFiltered failed:', err);
    return { approved, published };
  }
  for (const blob of blobs) {
    approved.set(blob.filename, snapshotFromContent(blob.approved, leafPaths));
    published.set(blob.filename, snapshotFromContent(blob.published, leafPaths));
  }
  return { approved, published };
}

async function readJsonFileSnapshot(filePath: string, leafPaths?: Set<string>): Promise<JsonFileSnapshot> {
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
  return { kind: 'ok', flat: flattenObject(parsed.raw, '', leafPaths), raw: parsed.raw };
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
  addedApproved: number;
  modified: number;
  unpublished: number;
  deleted: number;
  deletedApproved: number;
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
    const allFields = Object.keys(workingRow);
    for (const k of allFields) columnSet.add(k);
    return { row: makeDiffRow(workingRow, 'added', allFields, {}, [], {}, filename), columns: Array.from(columnSet) };
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
        // Capture the master value too — once the user accepts this change, the
        // field flips to "unpublished" and the popover renders the master value
        // as "Last published". Without this we'd lose that baseline at accept time.
        masterFields[k] = comparableMasterRow[k];
      } else if (dStr !== mStr) {
        unpublishedFields.push(k);
        masterFields[k] = comparableMasterRow[k];
      }
    }

    // If there's no published version the record hasn't been published yet.
    // We're in the workingRow && dirtyRow branch, so the create has already
    // been approved — status is 'addedUnpublished' even if individual fields
    // have since been edited (those show as per-field diffs in the UI).
    const isNewRecord = !masterRow;
    const status: RowStatus = isNewRecord
      ? 'addedUnpublished'
      : changedFields.length > 0
        ? 'modified'
        : unpublishedFields.length > 0
          ? 'unpublished'
          : 'unchanged';

    return {
      row: makeDiffRow(
        workingRow,
        status,
        changedFields,
        fromFields,
        isNewRecord ? [] : unpublishedFields,
        masterFields,
        filename,
      ),
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
  const displayRaw: Record<string, unknown> =
    w.kind === 'ok' ? w.raw : d.kind === 'ok' ? d.raw : m.kind === 'ok' ? m.raw : {};

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
    const row = makeDiffRow(base, 'invalidJson', [], {}, [], {}, filename, parseError);
    (row as Record<string, unknown>)['__raw'] = displayRaw;
    return { row, columns: Array.from(columnSet) };
  }

  const wRow = w.kind === 'ok' ? w.flat : undefined;
  const dRow = d.kind === 'ok' ? d.flat : undefined;
  const mRow = m.kind === 'ok' ? m.flat : undefined;
  const result = compareFlattenedRecordVersions(wRow, dRow, mRow, filename);
  if (result) {
    (result.row as Record<string, unknown>)['__raw'] = displayRaw;
  }
  return result;
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
function buildInvalidJsonFileEntries(folderPath: string, rows: DiffRow[]): InvalidJsonFileEntry[] {
  // Pre-F.5 this returned `reviewedFilePath` + `publishedFilePath` pointing at
  // `.scratch/connections/{dirty,master}/<conn>/<filename>`. Those directories
  // no longer exist post-slice-F — the approved/published versions live as
  // git blobs in the bare repo. Only the working file is openable on disk.
  return rows
    .filter((r) => r.__rowStatus === 'invalidJson')
    .map((r) => ({
      filename: r.__filename,
      error: typeof r.__parseError === 'string' ? r.__parseError : 'Invalid JSON',
      workingFilePath: join(folderPath, r.__filename),
    }));
}

/**
 * Reads a paginated diff grid page backed by the SQLite folder index in the
 * CLI (`shared/folder_index.rs`). Pagination + global-scope filters + sorts
 * happen SQL-side via `scratchmd read-records`; only the page filenames are
 * read off disk for the diff comparison, so memory stays bounded at the page
 * size (D5: see docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md).
 *
 * Summary counts (`total`, `added`, `modified`, `unpublished`, `deleted`,
 * `invalidJson`, etc.) come full-folder from the CLI's `FolderSummary`
 * (`folder_index.rs::query_summary`'s row-status discriminator), not from
 * the page rows.
 *
 * Replaced the earlier in-memory V1 path that walked every record's three
 * versions on each page load.
 */
export async function readDiffGridDataPage(
  folderPath: string,
  workspacePath: string,
  opts: ReadDiffGridDataOptions,
  onProgress?: (line: string) => void,
): Promise<DiffGridResult> {
  const cliFolder = relative(workspacePath, folderPath);

  // Map sortBy to a CLI sort column. Unknown/row-status sorts fall back to 'filename'.
  let cliSortBy = 'filename';
  if (opts.sortBy && !opts.sortBy.startsWith('__')) {
    cliSortBy = opts.sortBy;
  }

  // Map global-scope DiffGridFilters to CLI filter ops. Column/text filters stay desktop-side.
  //
  // Slice E (2026-05-20) flipped the column semantics in `folder_index`:
  //   - `approvedChanges = 1` now means "the path has a patch entry in
  //     accepted-patches.json" — i.e. approved-pending-publish (UI: unpublished).
  //   - `unapprovedChanges = 1` now means "working file differs from
  //     apply(main, patch_entry_or_empty)" — i.e. unreviewed working-tree edits.
  // The CLI filter op names are kept stable; only the UI-kind mapping flips.
  const cliFilters: ReadRecordsFilterOp[] = [];
  const desktopFilters: DiffGridFilter[] = [];
  for (const f of opts.filters ?? []) {
    if (f.scope === 'global') {
      if (f.kind === 'unreviewed') {
        cliFilters.push({ op: 'unapprovedChanges' });
      } else if (f.kind === 'unpublished') {
        cliFilters.push({ op: 'approvedChanges' });
      } else if (f.kind === 'has-problems') {
        cliFilters.push({ op: 'hasErrors' });
      }
    } else {
      desktopFilters.push(f);
    }
  }

  // Run CLI spawns sequentially to avoid hitting the per-process FD limit when Electron
  // already has many FDs open (dev server HMR watchers, devtools, sockets, etc.).
  const cliResult = await readRecords(
    workspacePath,
    {
      folder: cliFolder,
      offset: opts.offset ?? 0,
      limit: opts.limit ?? GRID_DATA_MAX_PAGINATION,
      sortBy: cliSortBy,
      sortOrder: opts.sortOrder ?? 'asc',
      filters: cliFilters,
      validate: opts.validate ?? false,
    },
    onProgress,
  );
  const errorFilenameList: string[] = Object.keys(cliResult.row_errors).filter(
    (fn) => cliResult.row_errors[fn].length > 0,
  );
  const errorFieldPaths: string[] = Array.from(
    new Set(Object.values(cliResult.row_errors).flatMap((errors) => errors.map((e) => e.field_path))),
  );
  const schema = await readConnectionSchema(workspacePath, cliFolder);

  // Key the diff at the SAME granularity as the rendered columns. The active
  // view drills enveloped (Notion-style) properties to their value leaf — e.g.
  // `properties."Asked for Intro?".checkbox` rather than the whole envelope
  // `properties."Asked for Intro?"` — so sourcing the diff's leaf paths from the
  // view keeps __changedFields / __unpublishedFields / focusColumnIds aligned
  // with the grid column ids. Otherwise enveloped columns never match the diff
  // and so are never auto-focused by review filters nor diff-highlighted.
  // Fall back to the schema's own column definitions when there is no stored
  // view — that mirrors the renderer's `createFallbackTableView` fallback.
  const schemaColumns = schema ? buildColumnDefinitions(schema) : [];
  const view = await readConnectionView(workspacePath, cliFolder);
  const diffColumnIds = view ? tableViewColumnPaths(view) : schemaColumns.map((c) => c.id);
  const leafPaths = new Set(diffColumnIds);

  const workingPath = folderPath;

  // Working = TS-side fs reads (page filenames only). Approved + published =
  // napi binding restricted to the same page filenames so we don't pull
  // hundreds of MB into the Electron main process for 20k+ row folders
  // (mr29 D5). Slice F retired the on-disk mirrors at
  // `.scratch/connections/{dirty,master}/`.
  const [workingFiles, approvedAndPublished] = await Promise.all([
    readNamedSnapshots(workingPath, cliResult.filenames, leafPaths),
    readFolderApprovedAndPublishedSnapshots(workspacePath, folderPath, leafPaths, cliResult.filenames),
  ]);
  const { approved: approvedFiles, published: publishedFiles } = approvedAndPublished;

  const missingSnapshot: JsonFileSnapshot = { kind: 'missing' };
  const columnSet = new Set<string>();
  const rows: DiffRow[] = [];

  for (const name of cliResult.filenames) {
    const compared = compareRecordSnapshots(
      workingFiles.get(name) ?? missingSnapshot,
      approvedFiles.get(name) ?? missingSnapshot,
      publishedFiles.get(name) ?? missingSnapshot,
      name,
    );
    if (!compared) continue;
    for (const column of compared.columns) columnSet.add(column);
    rows.push(compared.row);
  }

  const errorFilenames = new Set(errorFilenameList);

  // Apply desktop-side filters on page rows
  const filteredRows = desktopFilters.length > 0 ? applyDiffGridFilters(rows, desktopFilters, errorFilenames) : rows;

  // Full-folder counts come from the CLI's SQL query (folder_index v4's
  // `query_summary` discriminator), so the modal badges show "1234 modified
  // / 12 unpublished" for the entire folder rather than only the visible
  // page. See D5 in docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md.
  const summary: DiffGridSummary = {
    total: cliResult.summary.total,
    added: cliResult.summary.added,
    addedApproved: cliResult.summary.added_approved,
    modified: cliResult.summary.modified,
    unpublished: cliResult.summary.unpublished,
    deleted: cliResult.summary.deleted,
    deletedApproved: cliResult.summary.deleted_approved,
    invalidJson: cliResult.summary.invalid_json,
  };

  const filterCounts = {
    unreviewed: cliResult.summary.unapproved_changes,
    unpublished: cliResult.summary.approved_changes,
    errors: cliResult.total_error_count,
  };

  let columns: ColumnDefinition[];
  if (schema) {
    // The leaf flatten above keys fields by the view's drilled paths, so treat
    // the view column ids as "known" too — otherwise every enveloped leaf
    // (properties.X.checkbox, .id, .type) would surface as a spurious extra
    // column. Genuine schema-drift fields (in the data, in neither the schema
    // nor the view) still come through.
    const knownIdSet = new Set<string>([...schemaColumns.map((c) => c.id), ...diffColumnIds]);
    const extraIds = Array.from(columnSet)
      .filter((id) => !knownIdSet.has(id))
      .sort((a, b) => a.localeCompare(b));
    const extraCols: ColumnDefinition[] = extraIds.map((id) => ({
      id,
      displayName: id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id,
      dataType: 'unknown' as const,
      attributes: { readOnly: false, required: false, nested: id.includes('.') },
    }));
    columns = [...schemaColumns, ...extraCols];
  } else {
    const sortedIds = Array.from(columnSet).sort((a, b) => a.localeCompare(b));
    columns = sortedIds.map((id) => ({
      id,
      displayName: id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id,
      dataType: 'unknown' as const,
      attributes: { readOnly: false, required: false, nested: id.includes('.') },
    }));
  }

  const focusFilters = (opts.filters ?? []).filter((filter) => filter.scope !== 'global');
  const focusRows = applyDiffGridFilters(filteredRows, focusFilters, errorFilenames);
  // Focus columns are matched against the leaf diff paths, so order them by the
  // leaf column ids (the view's drilled paths), not the envelope schema columns.
  const focusColumnIds = collectFocusColumnIds(focusRows, diffColumnIds, errorFieldPaths);

  const invalidJsonFiles = buildInvalidJsonFileEntries(workingPath, rows);

  return {
    rows: filteredRows,
    columns,
    total: cliResult.filtered_total,
    summary,
    filterCounts,
    focusColumnIds,
    invalidJsonFiles,
    staleCount: cliResult.stale_count,
    validationByCell: cliResult.row_errors,
    totalErrorCount: cliResult.total_error_count,
    totalProblemsStaleCount: cliResult.total_problems_stale_count,
  };
}

/**
 * Load snapshots for a specific set of filenames from a directory.
 * Returns a Map keyed by filename (same as readFolderSnapshots but targeted).
 * Missing files are excluded from the map; callers substitute `missingSnapshot`.
 */
async function readNamedSnapshots(
  dir: string,
  filenames: string[],
  leafPaths: Set<string>,
): Promise<Map<string, JsonFileSnapshot>> {
  const map = new Map<string, JsonFileSnapshot>();
  await Promise.all(
    filenames.map(async (filename) => {
      const snap = await readJsonFileSnapshot(join(dir, filename), leafPaths);
      if (snap.kind !== 'missing') {
        map.set(filename, snap);
      }
    }),
  );
  return map;
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
  return (
    row.__rowStatus === 'addedUnpublished' ||
    row.__rowStatus === 'deletedUnpublished' ||
    row.__unpublishedFields.length > 0
  );
}

function filterMatchesDiffRow(row: DiffRow, filter: DiffGridFilter, errorFilenames: ReadonlySet<string>): boolean {
  if (filter.scope === 'global') {
    if (filter.kind === 'has-problems') return errorFilenames.has(row.__filename);
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

function applyDiffGridFilters(
  rows: DiffRow[],
  filters: DiffGridFilter[],
  errorFilenames: ReadonlySet<string>,
): DiffRow[] {
  if (filters.length === 0) {
    return rows;
  }

  return rows.filter((row) => filters.every((filter) => filterMatchesDiffRow(row, filter, errorFilenames)));
}

function collectFocusColumnIds(
  rows: DiffRow[],
  orderedColumnIds: string[],
  errorFieldPaths: string[],
): DiffGridResult['focusColumnIds'] {
  const unreviewed = new Set<string>();
  const unpublished = new Set<string>();

  for (const row of rows) {
    for (const field of row.__changedFields) {
      unreviewed.add(field);
    }
    for (const field of row.__unpublishedFields) {
      unpublished.add(field);
    }
  }

  const orderedIds = orderedColumnIds;
  const errorFieldSet = new Set(errorFieldPaths);

  return {
    unreviewed: orderedIds.filter((id) => unreviewed.has(id)),
    unpublished: orderedIds.filter((id) => unpublished.has(id)),
    errors: orderedIds.filter((id) => errorFieldSet.has(id)),
  };
}

export async function findRecordOffset(
  folderPath: string,
  workspacePath: string,
  filename: string,
): Promise<number | null> {
  // Union of: filenames on disk (working tree) + filenames the napi binding
  // returns from main + accepted-patches. Together this covers every record
  // the grid would render — including approved-deleted files (only on main)
  // and pending-create files (only in the patch file).
  //
  // Slice F retired the on-disk mirrors at `.scratch/connections/{dirty,master}/`
  // that this used to enumerate as separate version folders.
  const names = new Set<string>();
  try {
    for (const name of await getCachedFileNames(folderPath)) {
      if (extname(name).toLowerCase() === '.json') {
        names.add(name);
      }
    }
  } catch {
    // Working folder may not exist on a partially-initialized workspace.
  }
  try {
    const { connectionDirName, folderRelPath } = splitWorkspaceFolderPath(workspacePath, folderPath);
    // Filename-only union of main + accepted-patches; no blob content read.
    // mr29 D5 follow-up: previously called `readFolderBlobs`, which loaded
    // every record's `(published, approved)` content (~200-500 MB on
    // HubSpot/Contacts) just to enumerate filenames. The `listFolderFilenames`
    // binding skips `cat-file` entirely — sub-second on 22k+ folders.
    const remoteNames = await listFolderFilenames(workspacePath, connectionDirName, folderRelPath);
    for (const name of remoteNames) names.add(name);
  } catch {
    // Workspace marker missing / unknown connection — fall through with just
    // the working-tree filenames.
  }

  const sortedNames = Array.from(names).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
  );
  const offset = sortedNames.findIndex((name) => name === filename);
  return offset >= 0 ? offset : null;
}

export async function readDiffRecordData(
  folderPath: string,
  workspacePath: string,
  filename: string,
): Promise<DiffRecordResult | null> {
  const workingFile = join(folderPath, filename);

  const relPath = relative(workspacePath, folderPath);
  const schema = await readConnectionSchema(workspacePath, relPath);
  const schemaColumns = schema ? buildColumnDefinitions(schema) : [];
  const leafPaths = new Set(schemaColumns.map((c) => c.id));

  // Working = fs read. Approved + published = napi read restricted to this
  // one filename (mr29 D5 — before this only the path key changed; the napi
  // call still loaded the entire folder's blobs into memory). Slice F retired
  // the per-version on-disk mirrors that this used to read directly.
  const [w, approvedAndPublished] = await Promise.all([
    readJsonFileSnapshot(workingFile, leafPaths),
    readFolderApprovedAndPublishedSnapshots(workspacePath, folderPath, leafPaths, [filename]),
  ]);
  const missingSnapshot: JsonFileSnapshot = { kind: 'missing' };
  const d = approvedAndPublished.approved.get(filename) ?? missingSnapshot;
  const m = approvedAndPublished.published.get(filename) ?? missingSnapshot;

  const compared = compareRecordSnapshots(w, d, m, filename);
  if (!compared) {
    return null;
  }

  const workingData = w.kind === 'ok' ? w.raw : null;
  const dirtyData = d.kind === 'ok' ? d.raw : null;
  const masterData = m.kind === 'ok' ? m.raw : null;

  // Derive ColumnDefinition[] from schema, falling back to data-union columns
  let columns: ColumnDefinition[];
  if (schema) {
    const schemaCols = buildColumnDefinitions(schema);
    const schemaIdSet = new Set(schemaCols.map((c) => c.id));
    const extraIds = compared.columns.filter((id) => !schemaIdSet.has(id));
    const extraCols: ColumnDefinition[] = extraIds.map((id) => ({
      id,
      displayName: id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id,
      dataType: 'unknown' as const,
      attributes: { readOnly: false, required: false, nested: id.includes('.') },
    }));
    columns = [...schemaCols, ...extraCols];
  } else {
    columns = compared.columns.map((id) => ({
      id,
      displayName: id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id,
      dataType: 'unknown' as const,
      attributes: { readOnly: false, required: false, nested: id.includes('.') },
    }));
  }

  return {
    row: compared.row,
    columns,
    workingData,
    dirtyData,
    masterData,
    displayData: pickDisplayRecordData(workingData, dirtyData, masterData),
  };
}

/**
 * Promotes an unreviewed working-tree field edit to approved. Used by the detail
 * view's per-field "Approve" button, which passes the field's current display
 * string. This shares the exact schema-free, existing-value-aware write as
 * {@link acceptFieldEditFromInputText} (interpreting the text against the value
 * already on disk) so that approving a field can never retype a leaf on its way
 * into the approved set — e.g. a numeric-looking string leaf stays a string
 * rather than being JSON-parsed to a number. See DEV-10308. Dot-separated
 * `fieldName` paths address nested fields.
 */
export async function acceptUnreviewedFieldEdit(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
  value: string,
): Promise<{ value: unknown }> {
  return acceptFieldEditFromInputText(folderPath, workspacePath, filename, fieldName, value);
}

/**
 * Applies direct user-entered cell text. The text is interpreted against the
 * value currently stored at that leaf on disk; the connector JSON schema only
 * contributes a scalar type hint for empty leaves and clear semantics, never the
 * structure written (see `coerceCellInputTextAgainstExistingValueOrSchema` /
 * DEV-10308). Just that one leaf is replaced and the rest of the record stays
 * byte-identical. Then the napi binding snapshots the disk state into
 * `accepted-patches.json`.
 */
export async function acceptFieldEditFromInputText(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
  value: string,
): Promise<{ value: unknown }> {
  const relPath = relative(workspacePath, folderPath);
  const folderSchema = await readConnectionSchema(workspacePath, relPath);
  const schemaHint = resolveSchemaLeafHint(folderSchema, fieldName);
  const { value: parsed } = await writeWorkingFileFieldFromInputText(
    join(folderPath, filename),
    fieldName,
    value,
    schemaHint,
  );
  await acceptCellField({ workspacePath, folderPath, filename, fieldName });
  return { value: parsed };
}

/** Reads `filePath` as a JSON object. Returns `{}` when the file is missing or is not a JSON object. */
async function readWorkingFileObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (!isFileNotFoundError(err)) throw err;
  }
  return {};
}

/**
 * Walks `obj` to the parent object of the dot-separated `fieldName` leaf,
 * creating intermediate objects as needed, and returns that parent plus the
 * final leaf key so the caller can read or replace just that leaf.
 */
function navigateToLeafParentCreatingIntermediates(
  obj: Record<string, unknown>,
  fieldName: string,
): { leafParentObject: Record<string, unknown>; leafKey: string } {
  const parts = fieldName.split('.');
  let leafParentObject: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      typeof leafParentObject[part] !== 'object' ||
      leafParentObject[part] === null ||
      Array.isArray(leafParentObject[part])
    ) {
      leafParentObject[part] = {};
    }
    leafParentObject = leafParentObject[part] as Record<string, unknown>;
  }
  return { leafParentObject, leafKey: parts[parts.length - 1] };
}

async function persistWorkingFileObject(filePath: string, obj: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // `formatRecordJson` is the one canonical serializer shared with the server's
  // git commits (2-space JSON + trailing newline), so an edit stays byte-identical
  // to a fresh pull except for the changed leaf.
  await writeFile(filePath, formatRecordJson(obj));
}

/**
 * Reads the value currently stored at `fieldName`, interprets the user's typed
 * `inputText` against that existing leaf's JSON type (with `schemaHint` only
 * contributing a scalar hint for empty leaves — see
 * `coerceCellInputTextAgainstExistingValueOrSchema`), surgically replaces just
 * that leaf, and writes the file back. Returns the parsed value so callers can
 * mirror it into their optimistic UI state.
 */
async function writeWorkingFileFieldFromInputText(
  filePath: string,
  fieldName: string,
  inputText: string,
  schemaHint: SchemaLeafHint | null,
): Promise<{ value: unknown }> {
  const obj = await readWorkingFileObject(filePath);
  const { leafParentObject, leafKey } = navigateToLeafParentCreatingIntermediates(obj, fieldName);
  const parsed = coerceCellInputTextAgainstExistingValueOrSchema(leafParentObject[leafKey], schemaHint, inputText);
  leafParentObject[leafKey] = parsed;
  await persistWorkingFileObject(filePath, obj);
  return { value: parsed };
}

/**
 * Reverts an unreviewed working-tree edit for a single cell back to the
 * approved value. Delegates to the napi binding's `rejectField`, which
 * restores the working file's value WITHOUT touching `accepted-patches.json`.
 * Strict invariant: Reject never mutates the patch file — use
 * `dropApprovedFieldAndRestoreToMain` (which calls `discardField`) when the caller
 * wants to also drop an existing approved patch entry.
 */
export async function revertUnreviewedFieldEditToApproved(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
): Promise<void> {
  await rejectCellField({ workspacePath, folderPath, filename, fieldName });
}

/**
 * Reverts a reviewed-but-unpublished cell back to the published (main) value.
 * Delegates to the napi binding's `discardField`, which mirrors the field-
 * level `Discard` semantics in `scratch-git-2/docs/REVIEW_MODEL.md`: drop the
 * field from `accepted-patches.json` AND restore the working file's value to
 * what `refs/heads/main` says.
 */
export async function dropApprovedFieldAndRestoreToMain(
  folderPath: string,
  workspacePath: string,
  filename: string,
  fieldName: string,
): Promise<void> {
  await discardCellField({ workspacePath, folderPath, filename, fieldName });
}

// Note: `restoreDeletedRecord` and `discardCreatedRecord` used to live here
// as direct local-filesystem helpers that wrote to the dirty worktree + ref.
// They were dead before slice H.3 — the IPC handlers in `index.ts` route
// through `restoreDeletedRecordViaCli` / `discardCreatedRecordViaCli` (shell-
// out to the `scratchmd` binary), which has the all-or-nothing batch
// semantics. Removed in H.3 along with the no-longer-needed JSON-field
// helpers (`patchJsonField`, `commitReviewedDirtyFile`, etc.) since the
// remaining cell-edit handlers now delegate to the napi binding.

function isFileNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
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
