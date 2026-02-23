import { Prisma } from '@prisma/client';
import { DataFolder, DataFolderGroup, DataFolderId, Service, WorkbookId } from '@spinner/shared-types';
import { DataFolderCluster } from '../../db/cluster-types';

export function normalizeJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

export class DataFolderEntity implements DataFolder {
  id: DataFolderId;
  name: string;
  createdAt: string;
  updatedAt: string;
  workbookId: WorkbookId;
  connectorAccountId: string | null;
  connectorService: Service | null;
  connectorDisplayName: string | null;
  parentId: string | null;
  path: string | null;
  schema: Record<string, unknown> | null;
  lastSchemaRefreshAt: string | null;
  lock: string | null;
  lastSyncTime: string | null;
  version: number;
  tableId: string[];
  filter: string | null;
  options: Record<string, unknown> | null;

  constructor(dataFolder: DataFolderCluster.DataFolder) {
    this.id = dataFolder.id as DataFolderId;
    this.workbookId = dataFolder.workbookId as WorkbookId;
    this.name = dataFolder.name;
    this.createdAt = dataFolder.createdAt.toISOString();
    this.updatedAt = dataFolder.updatedAt.toISOString();
    this.connectorAccountId = dataFolder.connectorAccountId;
    this.connectorService = dataFolder.connectorService ? (dataFolder.connectorService as Service) : null;
    this.connectorDisplayName = dataFolder.connectorAccount ? dataFolder.connectorAccount.displayName : null;
    this.parentId = dataFolder.parentId;
    this.path = dataFolder.path;
    this.lastSchemaRefreshAt = dataFolder.lastSchemaRefreshAt ? dataFolder.lastSchemaRefreshAt.toISOString() : null;
    this.lock = dataFolder.lock;
    this.lastSyncTime = dataFolder.lastSyncTime ? dataFolder.lastSyncTime.toISOString() : null;
    this.version = dataFolder.version;
    this.tableId = dataFolder.tableId;
    const normalizedOptions = dataFolder.options
      ? normalizeJsonObject(dataFolder.options as Prisma.JsonValue | null | undefined)
      : {};
    this.filter = (normalizedOptions?.filter as string) ?? null;
    this.options = normalizedOptions;
    this.schema = {};
  }
}

export class DataFolderGroupEntity implements DataFolderGroup {
  name: string;
  service: Service | null;
  dataFolders: DataFolder[];

  constructor(
    name: string,
    connectorAccount: DataFolderCluster.DataFolder['connectorAccount'] | null,
    dataFolders: DataFolder[],
  ) {
    this.name = name;
    this.service = connectorAccount ? (connectorAccount.service as Service) : null;
    this.dataFolders = dataFolders;
  }
}
