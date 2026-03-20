import type { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import { formatJsonWithPrettier } from '../../../utils/json-formatter';
import { deduplicateFileName, normalizeFileName } from '../../../workbook/util';

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
): { path: string; content: string }[] {
  const prefix = parentPath === '/' ? '' : parentPath;
  const idColumnRemoteId = tableSpec.idColumnRemoteId;
  const processedFiles: { path: string; content: string }[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const content = formatJsonWithPrettier(record as Record<string, unknown>);
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

    const fullPath = prefix ? `${prefix}/${fileName}` : `/${fileName}`;

    processedFiles.push({ path: fullPath, content });
  }

  return processedFiles;
}
