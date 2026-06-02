import { Prisma, Schedule as PrismaSchedule } from '@prisma/client';
import {
  DataFolder,
  DataFolderGroup,
  DataFolderId,
  IncrementalPullSupport,
  Schedule,
  Service,
  WorkbookId,
} from '@spinner/shared-types';
import { DataFolderCluster } from '../../db/cluster-types';
import { ScheduleEntity } from '../../schedule/entities/schedule.entity';

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
  path: string | null;
  lock: string | null;
  version: number;
  tableId: string[];
  isAssetTable: boolean;
  options: Record<string, unknown> | null;
  schedules: Schedule[];
  lastFullPullAt: string | null;
  lastIncrementalPullAt: string | null;
  incrementalPullSupport: IncrementalPullSupport;

  constructor(
    dataFolder: DataFolderCluster.DataFolder,
    schedules: PrismaSchedule[] = [],
    incrementalPullSupport: IncrementalPullSupport = IncrementalPullSupport.NOT_SUPPORTED,
  ) {
    this.id = dataFolder.id as DataFolderId;
    this.workbookId = dataFolder.workbookId as WorkbookId;
    this.name = dataFolder.name;
    this.createdAt = dataFolder.createdAt.toISOString();
    this.updatedAt = dataFolder.updatedAt.toISOString();
    this.connectorAccountId = dataFolder.connectorAccountId;
    this.connectorService = dataFolder.connectorService ? dataFolder.connectorService : null;
    this.connectorDisplayName = dataFolder.connectorAccount ? dataFolder.connectorAccount.displayName : null;
    this.path = dataFolder.path;
    this.lock = dataFolder.lock;
    this.version = dataFolder.version;
    this.tableId = dataFolder.tableId;
    this.isAssetTable = dataFolder.isAssetTable;
    this.options = dataFolder.options
      ? normalizeJsonObject(dataFolder.options as Prisma.JsonValue | null | undefined)
      : {};
    this.schedules = schedules.map((s) => new ScheduleEntity(s));
    this.lastFullPullAt = dataFolder.lastFullPullAt ? dataFolder.lastFullPullAt.toISOString() : null;
    this.lastIncrementalPullAt = dataFolder.lastIncrementalPullAt
      ? dataFolder.lastIncrementalPullAt.toISOString()
      : null;
    this.incrementalPullSupport = incrementalPullSupport;
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
    this.service = connectorAccount ? connectorAccount.service : null;
    this.dataFolders = dataFolders;
  }
}
