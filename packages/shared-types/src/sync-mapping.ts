import { DataFolderId } from './ids';

// ============================================================================
// Sync Mapping Types
// ============================================================================

export interface SyncMapping {
  /** Version number for future migrations */
  version: 1;

  /** Column mappings from source to destination */
  tableMappings: TableMapping[];
}

export interface TableMapping {
  sourceDataFolderId: DataFolderId;
  destinationDataFolderId: DataFolderId;

  /** Column mappings from source to destination */
  columnMappings: ColumnMapping[];

  /**
   * When records from source and destination
   * have the same value in these columns, they are considered the same record.
   */
  recordMatching?: {
    /** Column ID in the source DataFolder to use for matching */
    sourceColumnId: string;
    /** Column ID in the destination DataFolder to use for matching */
    destinationColumnId: string;
  };
}

export interface ColumnMapping {
  /** Column ID in the source DataFolder schema */
  sourceColumnId: string;

  /** Column ID in the destination DataFolder schema */
  destinationColumnId: string;

  /** Optional transformer to apply to the value during sync */
  transformer?: TransformerConfig;
}

// ============================================================================
// Transformer Types
// ============================================================================

export type TransformerType =
  | 'string_to_number'
  | 'source_fk_to_dest_fk'
  | 'lookup_field'
  | 'notion_to_html'
  | 'airmark_to_html'
  | 'html_to_airmark';

/** Options for the string_to_number transformer */
export interface StringToNumberOptions {
  /** Strip currency symbols ($, €, £, etc.) before parsing */
  stripCurrency?: boolean;
  /** Parse as integer (truncate) instead of float */
  parseInteger?: boolean;
}

/** Options for the source_fk_to_dest_fk transformer */
export interface SourceFkToDestFkOptions {
  /** The DataFolder ID containing the referenced records */
  referencedDataFolderId: DataFolderId;
}

/** Options for the lookup_field transformer */
export interface LookupFieldOptions {
  /** The DataFolder ID containing the referenced records */
  referencedDataFolderId: DataFolderId;
  /** The field path to extract from the referenced record (e.g. 'name' or 'company.displayName') */
  referencedFieldPath: string;
}

/** Union of all transformer options types */
export type TransformerOptions = StringToNumberOptions | SourceFkToDestFkOptions | LookupFieldOptions;

/** Configuration for a field transformer with strictly typed options */
export type TransformerConfig =
  | { type: 'string_to_number'; options?: StringToNumberOptions }
  | { type: 'source_fk_to_dest_fk'; options: SourceFkToDestFkOptions }
  | { type: 'lookup_field'; options: LookupFieldOptions }
  | { type: 'notion_to_html'; options?: Record<string, never> }
  | { type: 'airmark_to_html'; options?: Record<string, never> }
  | { type: 'html_to_airmark'; options?: Record<string, never> };
