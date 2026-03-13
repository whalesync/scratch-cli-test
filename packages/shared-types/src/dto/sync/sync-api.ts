import { DataFolderId } from '../../ids';
import type { ColumnMapping, SyncMapping, TransformerConfig, TransformerType } from '../../sync-mapping';

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
  /** Optional record matching config. When provided, the preview validates the match field value. */
  recordMatching?: {
    sourceColumnId: string;
    destinationColumnId: string;
  };
}

/** POST body for validate-mapping endpoint */
export interface ValidateMappingBody {
  sourceId: string;
  destId: string;
  columnMappings: ColumnMapping[];
}

/** POST body for validate-mapping-type endpoint (admin only). Traces type through one mapping's pipeline. */
export interface ValidateMappingTypeBody {
  sourceFolderId: DataFolderId;
  destFolderId: DataFolderId;
  sourceColumnId: string;
  destinationColumnId: string;
  transformers: TransformerConfig[];
}

/** One step in the type pipeline for validate-mapping-type response. Has either type or error. */
export interface MappingTypeTraceStep {
  transformerName: string;
  type?: Record<string, unknown>;
  error?: string;
}

/** Response from validate-mapping-type: type trace for a single mapping */
export interface MappingTypeTraceResponse {
  sourceType: Record<string, unknown>;
  steps: MappingTypeTraceStep[];
  destinationType: Record<string, unknown>;
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
  /** Warning about the record matching field value (e.g. missing, invalid type, empty). */
  recordMatchingWarning?: string;
}

/** Response from the AI context endpoint (for external agents) */
export interface AiContextResponse {
  markdown: string;
}

/** Exported sync configuration — compatible with SaveSyncBody for re-import via update. */
export interface ExportSyncConfig {
  /** Sync ID (used to target updates, ignored on create) */
  id: string;
  displayName: string;
  mappings: SyncMapping;
  validateMappings: boolean;
  /** Cron expression for sync schedule, or empty string if none */
  schedule: string;
  publishAfterSync: boolean;
  /** Read-only metadata — ignored by create/update endpoints */
  _metadata: {
    syncState: string;
    lastSyncTime: string | null;
    createdAt: string;
    updatedAt: string;
  };
}
