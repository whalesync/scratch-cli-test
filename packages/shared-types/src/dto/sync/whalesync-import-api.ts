import type { SaveSyncBody } from './sync-api';

export interface WhalesyncImportPreviewBody {
  whalesyncApiToken: string;
  coreBaseId: string;
}

export type CaveatSeverity = 'error' | 'warning' | 'info';

export interface Caveat {
  severity: CaveatSeverity;
  message: string;
  context?: string;
}

export interface UnmatchedFolder {
  whalesyncTableName: string;
  connectorType: string;
  remoteBaseId: string;
  remoteTableId: string;
  side: 'left' | 'right';
  message: string;
}

export interface WhalesyncImportPreviewResponse {
  syncs: SaveSyncBody[];
  caveats: Caveat[];
  unmatchedFolders: UnmatchedFolder[];
}
