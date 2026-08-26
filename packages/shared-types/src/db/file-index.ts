import type { WorkbookId } from '../ids';

/// Keep this in sync with the server/prisma/schema.prisma FileIndex model.

/**
 * One row of a workbook's file index: the mapping between a git record file
 * (`folderPath` + `filename`) and its external-service record id. Served by the
 * dev-tools file-index endpoint (`GET /workbook/:workbookId/publish-v2/index/files`).
 */
export interface FileIndex {
  id: string;
  workbookId: WorkbookId;
  connectorAccountId: string | null;
  folderPath: string;
  recordId: string;
  filename: string;
  lastSeenAt: string | null;
}
