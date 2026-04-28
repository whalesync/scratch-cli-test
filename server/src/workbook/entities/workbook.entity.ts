import { Schedule } from '@prisma/client';
import { WorkbookId } from '@spinner/shared-types';
import { WorkbookCluster } from '../../db/cluster-types';
import { DataFolderEntity } from './data-folder.entity';

export class Workbook {
  id: WorkbookId;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  isPendingDelete: boolean;
  userId: string | null;
  organizationId: string;
  dataFolders?: DataFolderEntity[];

  constructor(workbook: WorkbookCluster.Workbook, schedulesByEntityId?: Map<string, Schedule[]>) {
    this.id = workbook.id as WorkbookId;
    this.name = workbook.name ?? null;
    this.createdAt = workbook.createdAt;
    this.updatedAt = workbook.updatedAt;
    this.version = workbook.version;
    this.isPendingDelete = workbook.isPendingDelete;
    this.userId = workbook.userId ?? null;
    this.organizationId = workbook.organizationId;
    this.dataFolders = workbook.dataFolders?.map(
      (df) => new DataFolderEntity(df, schedulesByEntityId?.get(df.id) ?? []),
    );
  }
}
