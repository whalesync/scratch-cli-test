import { SyncState } from '../enums/enums';
import { DataFolderId, SyncId, SyncTablePairId } from '../ids';
import { SyncMapping } from '../sync-mapping';

export interface SyncTablePair {
  id: SyncTablePairId;
  syncId: SyncId;
  sourceDataFolderId: DataFolderId;
  destinationDataFolderId: DataFolderId;
  createdAt: string;
  updatedAt: string;
}

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma Sync model
/// Begin "keep in sync" section
///

export interface Sync {
  id: SyncId;
  createdAt: string;
  updatedAt: string;
  displayName: string;
  displayOrder: number;
  mappings: SyncMapping;
  syncState: SyncState;
  syncStateLastChanged: string | null;
  lastSyncTime: string | null;
  publishAfterSync: boolean;
  syncTablePairs: SyncTablePair[];
}

///
/// End "keep in sync" section
///
