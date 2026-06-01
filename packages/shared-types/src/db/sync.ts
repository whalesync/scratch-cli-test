import { SyncState } from '../enums/enums';
import { DataFolderId, SyncId, SyncTablePairId } from '../ids';
import { SyncMapping, SyncMappingV2 } from '../sync-mapping';

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
  /**
   * Frozen v1 on-disk shape. Once `mappingsV2` is first written this column is
   * a frozen v1 snapshot (or the sentinel `{ version: 1, tableMappings: [] }`
   * for syncs created after v2 shipped). Read `mappingsV2` first — see the
   * `mappingsV2 ?? mappings` resolution in the sync editor's load path.
   */
  mappings: SyncMapping;
  /**
   * The authoritative v2 shape when present (non-null). Null for syncs that
   * have not yet been migrated/backfilled to v2. Mirrors `Sync.mappingsV2` in
   * server/prisma/schema.prisma.
   */
  mappingsV2: SyncMappingV2 | null;
  syncState: SyncState;
  syncStateLastChanged: string | null;
  lastSyncTime: string | null;
  publishAfterSync: boolean;
  syncTablePairs: SyncTablePair[];
}

///
/// End "keep in sync" section
///
