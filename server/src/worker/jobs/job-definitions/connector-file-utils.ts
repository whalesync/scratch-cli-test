import _ from 'lodash';
import type { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import { formatJsonWithPrettier } from '../../../utils/json-formatter';
import { deduplicateFileName, resolveBaseFileName } from '../../../workbook/util';

/**
 * Constructs git file payloads from connector files, applying slug > title > id naming.
 * Deduplicates filenames across the entire pull (maintained in usedFileNames across batches).
 */
export function buildGitFilesFromConnectorFiles(
  parentPath: string,
  records: ConnectorFile[],
  tableSpec: BaseJsonTableSpec,
  usedFileNames: Set<string>,
  existingFileNames: Map<string, string>,
): { path: string; content: string }[] {
  const prefix = parentPath === '/' ? '' : parentPath;
  const idColumnRemoteId = tableSpec.idColumnRemoteId;
  const processedFiles: { path: string; content: string }[] = [];

  for (const record of records) {
    const content = formatJsonWithPrettier(record as Record<string, unknown>);
    const recordId = String(record[idColumnRemoteId]);

    let fileName = existingFileNames.get(recordId);

    if (!fileName) {
      // Resolve filename: slug > title > id
      const slugValue = tableSpec.slugColumnRemoteId
        ? (_.get(record, tableSpec.slugColumnRemoteId) as string | undefined)
        : undefined;
      const titleValue = tableSpec.titleColumnRemoteId
        ? (_.get(record, tableSpec.titleColumnRemoteId[0]) as string | undefined)
        : undefined;

      const baseName = resolveBaseFileName({ slugValue, titleValue, idValue: recordId });
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
