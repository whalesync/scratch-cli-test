import { Service } from '../enums/enums';
import { DataFolderId, WorkbookId } from '../ids';
import { Schedule } from './schedule';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma DataFolder model
/// Begin "keep in sync" section
///

export interface DataFolder {
  id: DataFolderId;
  createdAt: string;
  updatedAt: string;
  name: string;
  workbookId: WorkbookId;
  connectorAccountId: string | null;
  connectorDisplayName: string | null;
  connectorService: Service | null;
  lastSchemaRefreshAt: string | null;
  parentId: string | null;
  path: string | null;
  // TODO - instead of returning the raw lock this should be a status object that denotes "downloading" or "syncing"
  lock: string | null;
  lastSyncTime: string | null;
  version: number;
  tableId: string[];
  isAssetTable: boolean;
  options: Record<string, unknown> | null;
  schedules: Schedule[];
}

///
/// End "keep in sync" section
///

export interface DataFolderGroup {
  name: string;
  service: Service | null;
  dataFolders: DataFolder[];
}
