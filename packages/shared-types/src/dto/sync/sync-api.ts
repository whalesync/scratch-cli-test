import type { Sync } from '../../db/sync';
import { DataFolderId } from '../../ids';
import type { ColumnMapping, SyncMapping, TransformerType } from '../../sync-mapping';

/** POST/PATCH body for creating or updating a sync */
export interface SaveSyncBody {
  displayName: string;
  mappings: SyncMapping;
  validateMappings: boolean;
  /** Optional cron expression for a sync schedule. Empty string means "no schedule". */
  schedule?: string;
  /** Whether to automatically trigger publish after a successful sync. Ignored on create. */
  publishAfterSync?: boolean;
}

/** POST body for preview-record endpoint */
export interface PreviewRecordBody {
  sourceFolderId: DataFolderId;
  destFolderId: DataFolderId;
  filePath: string;
  columnMappings: ColumnMapping[];
}

/** POST body for validate-mapping endpoint */
export interface ValidateMappingBody {
  sourceId: string;
  destId: string;
  columnMappings: ColumnMapping[];
}

export interface PreviewFieldResult {
  sourceField: string;
  destinationField: string;
  sourceValue: unknown;
  transformedValue: unknown;
  transformerType?: TransformerType;
  warning?: string;
}

export interface PreviewRecordResponse {
  recordId: string;
  fields: PreviewFieldResult[];
}

/** Response from the AI context endpoint */
export interface AiContextResponse {
  markdown: string;
}

/** POST body for AI sync generation */
export interface AiGenerateSyncBody {
  prompt: string;
  model?: string;
}

/** POST body for AI sync edit (re-prompts using existing prompt history) */
export interface AiEditSyncBody {
  prompt: string;
  model?: string;
}

export interface AiGenerateSyncTablePairing {
  sourceFolderId: DataFolderId;
  sourceFolderName: string;
  sourceConnectorService: string | null;
  destFolderId: DataFolderId;
  destFolderName: string;
  destConnectorService: string | null;
}

export interface AiGenerateSyncResponse {
  sync: Sync;
  tablePairings: AiGenerateSyncTablePairing[];
  history?: string;
  summary?: string;
  result?: 'success' | 'message';
}
