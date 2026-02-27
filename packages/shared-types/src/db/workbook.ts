import { WorkbookId } from '../ids';
import { DataFolder } from './data-folder';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma Workbook model
/// Begin "keep in sync" section
///

export interface Workbook {
  id: WorkbookId;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  dataFolders?: DataFolder[];
  userId: string;
}

///
/// End "keep in sync" section
///
