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
 */
export function buildGitFilesFromConnectorFiles(
  parentPath: string,
  records: ConnectorFile[],
  tableSpec: BaseJsonTableSpec,
  usedFileNames: Set<string>,
  existingFileNames: Map<string, string>,
  suggestedFileNames: (string | undefined)[],
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

    let fileName = existingFileNames.get(recordId);

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

    const fullPath = fullPathFromFolderAndFileName(parentPath, fileName);

    processedFiles.push({ path: fullPath, content, recordId, parsedRecord });
  }

  return processedFiles;
}
