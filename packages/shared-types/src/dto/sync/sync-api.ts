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
}

/** Response from the AI context endpoint (for external agents) */
export interface AiContextResponse {
  markdown: string;
}
