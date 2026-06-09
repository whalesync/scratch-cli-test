import { WorkbookId } from '../ids';
import { DataFolder } from './data-folder';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma Workbook model.
/// (The persisted model + server route are still named "Workbook"; the
/// user-facing data type is "Workspace" to match the desktop and web apps.)
/// Begin "keep in sync" section
///

export interface Workspace {
  id: WorkbookId;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  isPendingDelete: boolean;
  dataFolders?: DataFolder[];
  userId: string | null;
  organizationId: string;
}

///
/// End "keep in sync" section
///
