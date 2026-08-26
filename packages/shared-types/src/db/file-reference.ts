import type { WorkbookId } from '../ids';

/// Keep this in sync with the server/prisma/schema.prisma FileReference model.

/**
 * One row of a workbook's reference index: a dependency from a source record
 * file to the remote record it links to. Served by the dev-tools ref-index
 * endpoint (`GET /workbook/:workbookId/publish-v2/index/refs`).
 */
export interface FileReference {
  id: string;
  workbookId: WorkbookId;
  sourceFilePath: string;
  targetRemoteTableId: string | null;
  targetRemoteId: string | null;
  branch: string;
}
