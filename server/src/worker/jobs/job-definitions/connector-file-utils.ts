import { formatRecordJson } from '@spinner/shared-types';
import {
  type BaseJsonTableSpec,
  type ConnectorFile,
  readRecordIdAsString,
} from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import {
  deduplicateFileName,
  isUsableFileNameSlug,
  normalizeFileName,
  sanitizeRecordIdForFileName,
} from '../../../workbook/util';

/** Joins a data-folder path with a file name without producing `//` (collapse slashes, trim trailing). */
export function fullPathFromFolderAndFileName(parentPath: string, fileName: string): string {
  const collapsed = parentPath.trim().replace(/\/+/g, '/');
  const withoutTrailingSlashes = collapsed.replace(/\/+$/, '');
  if (withoutTrailingSlashes === '') {
    return `/${fileName}`;
  }
  return `${withoutTrailingSlashes}/${fileName}`;
}

/** A file ready for git commit, with parsed record data for downstream index updates. */
export type BuiltFile = {
  path: string;
  content: string;
  recordId: string;
  parsedRecord: JsonSafeObject;
};

/**
 * Constructs git file payloads from connector files, using suggested filenames from the connector.
 * Deduplicates filenames across the entire pull (maintained in usedFileNames across batches).
 *
 * @param suggestedFileNames - Parallel array from connector.getSuggestedRecordFileNames().
 *   Each element is a suggested name (without extension) or undefined to fall back to the record ID.
 * @param fileNamesAssignedByRecordIdInThisRun - Names this pull run has already minted, keyed by
 *   record ID. Created once per run and carried across batches by the caller, exactly like
 *   `usedFileNames`. See the re-delivery note below for why the `existingFileNames` index lookup
 *   alone isn't enough.
 */
export function buildGitFilesFromConnectorFiles(
  parentPath: string,
  records: ConnectorFile[],
  tableSpec: BaseJsonTableSpec,
  usedFileNames: Set<string>,
  existingFileNames: Map<string, string>,
  suggestedFileNames: (string | undefined)[],
  fileNamesAssignedByRecordIdInThisRun: Map<string, string> = new Map(),
): BuiltFile[] {
  const idPath = tableSpec.idPath;
  const processedFiles: BuiltFile[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const parsedRecord = record as JsonSafeObject;
    const content = formatRecordJson(parsedRecord as Record<string, unknown>);
    const recordId = readRecordIdAsString(record, idPath) ?? '';
    // Sanitized once and used both as the fallback filename base and as the
    // collision-breaking suffix below. The raw record ID can contain path
    // separators (Shopify GIDs are `gid://shopify/.../<id>`); using it verbatim in
    // either position turns the filename into a nested path and loses the record
    // (DEV-11015). Sanitizing preserves per-record uniqueness (no lowercasing/
    // stripping), so the dedup suffix still disambiguates.
    const sanitizedRecordId = sanitizeRecordIdForFileName(recordId);

    // A connector may deliver the same record twice in one run — most visibly
    // Notion, whose 10,000-result continuation re-returns the pages sharing the
    // rolled window's boundary minute, but any connector with an unstable page
    // boundary can do it. `existingFileNames` comes from the FileIndex, which
    // knows nothing about a record first seen earlier in THIS run (and, within a
    // single batch, nothing about one seen moments ago), so a re-delivered new
    // record would find its own freshly-claimed name already taken and mint an
    // id-suffixed twin — two files for one record. Resolving through the run's
    // own assignments first makes re-delivery converge on the same path, which
    // is what makes the commit genuinely idempotent.
    let fileName = fileNamesAssignedByRecordIdInThisRun.get(recordId) ?? existingFileNames.get(recordId);

    if (!fileName) {
      const suggested = suggestedFileNames[i];
      let baseName = sanitizedRecordId;
      if (suggested && suggested.trim()) {
        const normalized = normalizeFileName(suggested);
        // Reject results that would produce hidden-file (`.json`) or flag-like
        // (`-foo.json`) filenames once the extension is appended. Falls back
        // to the sanitized record ID, which is guaranteed a usable, path-safe base.
        if (isUsableFileNameSlug(normalized)) {
          baseName = normalized;
        }
      }
      fileName = deduplicateFileName(baseName, '.json', usedFileNames, sanitizedRecordId);
    } else {
      // If we reuse an existing filename, we should still mark it as used
      // so we don't accidentally derive it for another new file.
      usedFileNames.add(fileName);
    }
    fileNamesAssignedByRecordIdInThisRun.set(recordId, fileName);

    const fullPath = fullPathFromFolderAndFileName(parentPath, fileName);

    processedFiles.push({ path: fullPath, content, recordId, parsedRecord });
  }

  return processedFiles;
}
