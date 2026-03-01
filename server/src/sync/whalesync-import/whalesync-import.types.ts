import type { SaveSyncBody } from '@spinner/shared-types';

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

export interface WhalesyncImportResult {
  syncs: SaveSyncBody[];
  caveats: Caveat[];
  unmatchedFolders: UnmatchedFolder[];
}
