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
  /**
   * ISO-8601. Set when the row is created or its filename/connection changes; otherwise a pull
   * or publish that re-affirms the row refreshes it at most once every 24 hours. So a row that
   * is still being seen carries a timestamp from within the last day, while an orphan keeps
   * ageing — it is NOT "the last time a pull touched this row".
   */
  lastSeenAt: string | null;
}
