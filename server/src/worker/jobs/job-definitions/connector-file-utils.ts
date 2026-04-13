import type { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import { formatJsonWithPrettier } from '../../../utils/json-formatter';
import type { JsonSafeObject } from '../../../utils/objects';
import { deduplicateFileName, normalizeFileName } from '../../../workbook/util';

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
  const idColumnRemoteId = tableSpec.idColumnRemoteId;
  const processedFiles: BuiltFile[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const parsedRecord = record as JsonSafeObject;
    const content = formatJsonWithPrettier(parsedRecord as Record<string, unknown>);
    const recordId = String(record[idColumnRemoteId]);

    let fileName = existingFileNames.get(recordId);

    if (!fileName) {
      const suggested = suggestedFileNames[i];
      const baseName = suggested && suggested.trim() ? normalizeFileName(suggested) : recordId;
      fileName = deduplicateFileName(baseName, '.json', usedFileNames, recordId);
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
