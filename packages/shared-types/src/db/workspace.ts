import { WorkbookManager } from '../enums/enums';
import { WorkbookId } from '../ids';
import { DataFolder } from './data-folder';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma Workbook model.
/// (The persisted model + server route are still named "Workbook"; the
/// user-facing data type is "Workspace" to match the desktop and web apps.)
/// Begin "keep in sync" section
///

/** Arbitrary client-supplied config metadata stored on a workbook as a flat key/value map. */
export interface WorkbookSettings {
  [key: string]: string | number | boolean;
}

export interface Workspace {
  id: WorkbookId;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  isPendingDelete: boolean;
  // Which external app owns and manages this workspace, if any. `null` means a
  // standalone Scratch workbook; `ws_export` means it is managed by Whalesync's CRM Mirror.
  managedBy: WorkbookManager | null;
  // Arbitrary client-supplied config metadata as a flat key/value map. Updated via a
  // merge patch (PATCH /workbook/:id/settings); null values in a patch delete the key.
  settings?: WorkbookSettings;
  dataFolders?: DataFolder[];
  userId: string | null;
  organizationId: string;

  ///
  /// End "keep in sync" section
  ///

  /**
   * Computed by the REST API (NOT a persisted Workbook column): the workspace's total
   * record count, summed from `dataFolders[].recordCount`. Present only when `dataFolders`
   * are loaded; `undefined` otherwise (we don't fabricate a total without the folders).
   */
  recordCount?: number;

  /**
   * Computed by the REST API (NOT a persisted Workbook column): the record count attributed to the
   * Whalesync plan for this workspace. For a CRM-mirror workspace (`managedBy === ws_export`) it is the
   * LARGER of the two connection sides — a CRM mirror syncs the same records across both connections,
   * so each record exists on both sides and is counted once (the bigger side). `0` for a non-CRM-mirror
   * workspace. Present only when `dataFolders` are loaded; `undefined` otherwise (same as `recordCount`).
   */
  whalesyncEligibleRecordCount?: number;
}
