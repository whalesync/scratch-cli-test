/**
 * Local file access layer for Scratch Desktop.
 *
 * All filesystem I/O for workspace files lives here, in the main process.
 * The renderer accesses these functions via IPC handlers registered in index.ts.
 *
 * Target format: Rust CLI / .scratch workspace layout.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, extname, join, relative } from 'path';

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
  const schema = await readSchema(workspacePath, folderName);

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

interface GridDataResult {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  total: number;
  offset: number;
  schema: Record<string, unknown> | null;
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

  for (let i = 0; i < allNames.length; i += BATCH_CONCURRENCY) {
    const batch = allNames.slice(i, i + BATCH_CONCURRENCY);
    const batchRows = await Promise.all(
      batch.map(async (name) => {
        try {
          const content = await readFile(join(folderPath, name), 'utf-8');
          const parsed: unknown = JSON.parse(content);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return null;
          }
          const flat = flattenObject(parsed as Record<string, unknown>);
          flat.__filename = name;
          return flat;
        } catch {
          return null;
        }
      }),
    );

    for (const row of batchRows) {
      if (row === null) {
        continue;
      }
      for (const key of Object.keys(row)) {
        columnSet.add(key);
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
      const filtered: Record<string, unknown> = {};
      for (const col of columns) {
        if (col in row) {
          filtered[col] = row[col];
        }
      }
      return filtered;
    });
  }

  // Load schema if workspacePath is available
  let schema: Record<string, unknown> | null = null;
  if (opts.workspacePath) {
    const relPath = relative(opts.workspacePath, folderPath);
    schema = await readFolderSchema(opts.workspacePath, relPath);
  }

  return { rows, columns, total, offset, schema };
}

/**
 * Reads the schema for a data folder from its connection-relative path.
 * Schema lives at: <workspace>/.scratch/connections/scratch/<relPath>/schema.json
 */
async function readFolderSchema(workspacePath: string, relPath: string): Promise<Record<string, unknown> | null> {
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
