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

/** Canonical transformer type constants. Add new transformers here. */
export const TransformerTypes = {
  StringToNumber: 'string_to_number',
  SourceFkToDestFk: 'source_fk_to_dest_fk',
  LookupField: 'lookup_field',
  NotionToHtml: 'notion_to_html',
  AirmarkToHtml: 'airmark_to_html',
  HtmlToAirmark: 'html_to_airmark',
} as const;

export type TransformerType = (typeof TransformerTypes)[keyof typeof TransformerTypes];

export interface TransformerTypeInfo {
  type: TransformerType;
  label: string;
}

export const TRANSFORMER_TYPES: TransformerTypeInfo[] = [
  { type: TransformerTypes.StringToNumber, label: 'String to Number' },
  { type: TransformerTypes.SourceFkToDestFk, label: 'Foreign Key Lookup' },
  { type: TransformerTypes.LookupField, label: 'Lookup Field' },
  { type: TransformerTypes.NotionToHtml, label: 'Notion to HTML' },
  { type: TransformerTypes.AirmarkToHtml, label: 'AirMark to HTML' },
  { type: TransformerTypes.HtmlToAirmark, label: 'HTML to AirMark' },
];

/** Get the display label for a transformer type */
export function getTransformerLabel(type: TransformerType): string {
  return TRANSFORMER_TYPES.find((t) => t.type === type)?.label ?? type.replace(/_/g, ' ');
}

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
  | { type: typeof TransformerTypes.StringToNumber; options?: StringToNumberOptions }
  | { type: typeof TransformerTypes.SourceFkToDestFk; options: SourceFkToDestFkOptions }
  | { type: typeof TransformerTypes.LookupField; options: LookupFieldOptions }
  | { type: typeof TransformerTypes.NotionToHtml; options?: Record<string, never> }
  | { type: typeof TransformerTypes.AirmarkToHtml; options?: Record<string, never> }
  | { type: typeof TransformerTypes.HtmlToAirmark; options?: Record<string, never> };
