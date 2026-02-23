import type { ColumnMapping, SyncMapping, TransformerType } from '../../sync-mapping';

/** POST/PATCH body for creating or updating a sync */
export interface SaveSyncBody {
  displayName: string;
  mappings: SyncMapping;
  validateMappings: boolean;
}

/** POST body for preview-record endpoint */
export interface PreviewRecordBody {
  sourceId: string;
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
