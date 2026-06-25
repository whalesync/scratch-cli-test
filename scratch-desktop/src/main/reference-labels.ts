/**
 * Pure logic for resolving foreign-key (reference) cell values to the referenced
 * record's human-readable name in the grid (DEV-10530).
 *
 * A reference column's schema carries `x-scratch-foreign-key: { linkedTableId }`,
 * where `linkedTableId` is the target table's identity (its `wsId`, set by the
 * connector on the server). This module figures out, from declarative folder
 * metadata alone, (a) which local folder a `linkedTableId` points at and (b) how
 * to turn that folder's records into a `referenced-id -> name` map. It contains
 * **no** connector-specific branching — everything is driven by the schema
 * wrapper fields (`id.wsId`, `id.remoteId`, `slug`, `idColumnRemoteId`,
 * `titleColumnRemoteId`) that the server already emits.
 *
 * The actual filesystem I/O (listing folders, reading schema.json + record
 * files) lives in `local-files.ts`; this module stays pure so it can be unit
 * tested without a workspace on disk.
 */

import { getByPath } from '../shared/schema-columns';

/** The default remote-id path when a folder's schema declares none (mirrors the Rust `DEFAULT_ID_PATH`). */
export const DEFAULT_REFERENCE_ID_PATH = 'id';

/**
 * Per-folder reference metadata, distilled from a folder's `schema.json`
 * wrapper. Used both to match a `linkedTableId` to a folder and to extract the
 * id/name of each record in the matched folder.
 */
export interface FolderReferenceInfo {
  /** Absolute path to the folder on disk. */
  folderPath: string;
  /** The folder's workspace-scoped table id (`schema.id.wsId`) — the primary match key for `linkedTableId`. */
  wsId: string | null;
  /** Segments of the folder's remote table id (`schema.id.remoteId`) — a fallback match key (e.g. Airtable `tbl…`). */
  remoteIdSegments: string[];
  /** The folder's slug (`schema.slug`) — a last-resort match key (e.g. Supabase table name). */
  slug: string | null;
  /** Dot-path to the record's remote id (`schema.idColumnRemoteId`), defaulting to `id`. */
  idPath: string;
  /** Path segments to the record's display-name field (`schema.titleColumnRemoteId`), or null when none is declared. */
  titlePath: string[] | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Distil a folder's `schema.json` wrapper into the metadata needed to resolve
 * references into it. Returns null only when the wrapper itself is missing.
 */
export function extractFolderReferenceInfo(
  folderPath: string,
  schemaWrapper: Record<string, unknown> | null,
): FolderReferenceInfo | null {
  if (!schemaWrapper) return null;

  const idObject = isPlainObject(schemaWrapper.id) ? schemaWrapper.id : undefined;
  const wsId = idObject ? asString(idObject.wsId) : null;
  const remoteIdSegments = idObject ? asStringArray(idObject.remoteId) : [];
  const slug = asString(schemaWrapper.slug);
  const idPath = asString(schemaWrapper.idColumnRemoteId) ?? DEFAULT_REFERENCE_ID_PATH;
  const titleSegments = asStringArray(schemaWrapper.titleColumnRemoteId);

  return {
    folderPath,
    wsId,
    remoteIdSegments,
    slug,
    idPath,
    titlePath: titleSegments.length > 0 ? titleSegments : null,
  };
}

/**
 * Resolve a FK's `linkedTableId` to the local folder it references.
 *
 * `linkedTableId` is the target table's `wsId` (the connector's canonical
 * identity), so that's the primary match. We fall back to matching against a
 * segment of the folder's `remoteId` (covers connectors whose FK stores a raw
 * sub-id, e.g. Airtable's `tbl…` inside `[appId, tblId]`) and finally the slug
 * (covers connectors whose `wsId` is a workspace/project id rather than the
 * table's, e.g. Supabase). First match wins, in that priority order; within a
 * tier the first folder (by the caller's ordering) wins.
 */
export function resolveLinkedFolder(
  linkedTableId: string,
  folders: readonly FolderReferenceInfo[],
): FolderReferenceInfo | null {
  if (!linkedTableId) return null;

  const byWsId = folders.find((folder) => folder.wsId === linkedTableId);
  if (byWsId) return byWsId;

  const byRemoteSegment = folders.find((folder) => folder.remoteIdSegments.includes(linkedTableId));
  if (byRemoteSegment) return byRemoteSegment;

  const bySlug = folders.find((folder) => folder.slug === linkedTableId);
  if (bySlug) return bySlug;

  return null;
}

/**
 * Coerce a reference value to the string key used in the id->name map. FK values
 * are remote ids: strings for most connectors, numbers for a few (Affinity,
 * Pipedrive, Copper). Anything else (object/array/null) is not a single id.
 */
export function referenceIdToString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return null;
}

/**
 * Collect the referenced id(s) from a single FK cell value. Handles both
 * single references (a scalar id) and multi-references (an array of ids).
 */
export function collectReferencedIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    const ids: string[] = [];
    for (const entry of value) {
      const id = referenceIdToString(entry);
      if (id !== null) ids.push(id);
    }
    return ids;
  }
  const single = referenceIdToString(value);
  return single !== null ? [single] : [];
}

/**
 * Coerce a title field value to a display string. Only simple scalar names are
 * used (strings/numbers/booleans); structured values (arrays/objects, e.g.
 * Notion title arrays) are skipped so we never surface raw JSON as a "name" —
 * the cell falls back to the raw id instead.
 */
export function referenceNameToString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Build a `referenced-id -> name` map from a linked folder's records. Records
 * whose id or name can't be extracted are skipped.
 */
export function buildIdToNameMap(
  records: readonly Record<string, unknown>[],
  idPath: string,
  titlePath: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  const titleDotPath = titlePath.join('.');
  for (const record of records) {
    const id = referenceIdToString(getByPath(record, idPath));
    if (id === null) continue;
    const name = referenceNameToString(getByPath(record, titleDotPath));
    if (name === null) continue;
    map.set(id, name);
  }
  return map;
}
