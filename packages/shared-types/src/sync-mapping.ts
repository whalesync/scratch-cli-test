import { DataFolderId } from './ids';

// ============================================================================
// Sync Mapping Types
// ============================================================================

// Make sure to keep the Zod schema up to date with this in @server/src/sync/sync-mapping.schema.ts
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

  /** Optional pipeline of transformers applied sequentially (mutually exclusive with `transformer`) */
  transformers?: TransformerConfig[];
}

// ============================================================================
// Transformer Types
// ============================================================================

/** Canonical transformer type constants. Add new transformers here. */
export const TransformerTypes = {
  AutoConvert: 'auto_convert',
  ArrayAutoConvert: 'array_auto_convert',
  StringToNumber: 'string_to_number',
  SourceFkToDestFk: 'source_fk_to_dest_fk',
  LookupField: 'lookup_field',
  NotionToHtml: 'notion_to_html',
  AirmarkToHtml: 'airmark_to_html',
  HtmlToAirmark: 'html_to_airmark',
  WebflowOption: 'webflow_option',
  WebflowOptionIdToValue: 'webflow_option_id_to_value',
  Slugify: 'slugify',
  JSONPath: 'jsonpath',
  SourceAssetToDestAsset: 'source_asset_to_dest_asset',
  EnsureType: 'ensure_type',
  NotionFileUrl: 'notion_file_url',
  EscapeHtml: 'escape_html',
  Trim: 'trim',
  MatchAssetByHash: 'match_asset_by_hash',
  SkipIfDestMatches: 'skip_if_dest_matches',
} as const;

export type TransformerType = (typeof TransformerTypes)[keyof typeof TransformerTypes];

export interface TransformerTypeInfo {
  type: TransformerType;
  label: string;
  /** If true, this transformer is only visible when dev tools are enabled */
  devOnly?: boolean;
}

export const TRANSFORMER_TYPES: TransformerTypeInfo[] = [
  { type: TransformerTypes.AutoConvert, label: 'Auto Convert' },
  { type: TransformerTypes.ArrayAutoConvert, label: 'Array Auto Convert' },
  { type: TransformerTypes.StringToNumber, label: 'String to Number' },
  { type: TransformerTypes.SourceFkToDestFk, label: 'Foreign Key Lookup' },
  { type: TransformerTypes.LookupField, label: 'Lookup Field' },
  { type: TransformerTypes.NotionToHtml, label: 'Notion to HTML' },
  { type: TransformerTypes.AirmarkToHtml, label: 'AirMark to HTML' },
  { type: TransformerTypes.HtmlToAirmark, label: 'HTML to AirMark' },
  { type: TransformerTypes.WebflowOption, label: 'Webflow Option' },
  { type: TransformerTypes.WebflowOptionIdToValue, label: 'Webflow Option ID to Value' },
  { type: TransformerTypes.Slugify, label: 'Slugify' },
  { type: TransformerTypes.JSONPath, label: 'JSONPath' },
  { type: TransformerTypes.SourceAssetToDestAsset, label: 'Asset Lookup' },
  { type: TransformerTypes.EnsureType, label: 'Ensure Type' },
  { type: TransformerTypes.NotionFileUrl, label: 'Notion File URL' },
  { type: TransformerTypes.EscapeHtml, label: 'Escape HTML' },
  { type: TransformerTypes.Trim, label: 'Trim' },
  { type: TransformerTypes.MatchAssetByHash, label: 'Match Asset by Hash' },
  { type: TransformerTypes.SkipIfDestMatches, label: 'Skip If Dest Matches' },
];

/** Get the display label for a transformer type */
export function getTransformerLabel(type: TransformerType): string {
  return TRANSFORMER_TYPES.find((t) => t.type === type)?.label ?? type.replace(/_/g, ' ');
}

/** Options for the auto_convert transformer */
export interface AutoConvertOptions {
  /** The target type to convert the source value to */
  targetType: 'string' | 'number' | 'integer' | 'boolean' | 'array';
}

/** Options for the array_auto_convert transformer */
export interface ArrayAutoConvertOptions {
  /** The target element type to convert each array element to */
  targetType: 'string' | 'number' | 'integer' | 'boolean';
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
  /** What to do when a referenced record cannot be found. Default: 'fail' */
  onUnresolved?: 'fail' | 'ignore';
  /** Output shape: 'array' (default) preserves arrays, 'single' unwraps to the first element or null */
  outputType?: 'array' | 'single';
}

/** Options for the lookup_field transformer */
export interface LookupFieldOptions {
  /** The DataFolder ID containing the referenced records */
  referencedDataFolderId: DataFolderId;
  /** The field path to extract from the referenced record (e.g. 'name' or 'company.displayName') */
  referencedFieldPath: string;
}

/** How to handle multiple results from a JSONPath expression */
export type JSONPathArrayHandling = 'first' | 'array' | 'join_space' | 'join_comma' | 'concat';

/** Options for the jsonpath transformer */
export interface JSONPathOptions {
  /** RFC 9535 JSONPath expression to evaluate against the source value */
  expression: string;
  /** How to handle multiple matched values. Defaults to 'first'. */
  arrayHandling?: JSONPathArrayHandling;
}

/** Options for the match_asset_by_hash transformer */
export interface MatchAssetByHashOptions {
  /** The DataFolder ID for the source assets (where the source asset remote IDs live) */
  sourceDataFolderId: DataFolderId;
  /** The DataFolder ID for the destination assets (to search for matching hashes) */
  destinationDataFolderId: DataFolderId;
  /** Dot-path to extract the asset ID from each source element (e.g. 'id' for Airtable's {id, url, ...}) */
  sourceIdPath?: string;
  /** Dot-path to extract the asset ID from each destination element for comparison (e.g. 'fileId' for Webflow's {fileId, url, alt}) */
  destinationIdPath?: string;
  /** What to do when no hash match is found. Default: 'fail' */
  onUnresolved?: 'fail' | 'ignore';
  /** Output shape: 'array' (default) preserves arrays, 'single' unwraps to first element */
  outputType?: 'array' | 'single';
}

/** Options for the source_asset_to_dest_asset transformer */
export interface SourceAssetToDestAssetOptions {
  /** The DataFolder ID for the source assets table — primary scope for source asset lookup */
  sourceDataFolderId: DataFolderId;
  /** The DataFolder ID on the destination side where created assets will be associated */
  destinationDataFolderId: DataFolderId;
  /** What to do when a source asset is not found or not rehosted. Default: 'fail' */
  onUnresolved?: 'fail' | 'ignore';
  /** Output shape: 'array' (default) preserves arrays, 'single' unwraps to the first element or null */
  outputType?: 'array' | 'single';
}

/** Options for the ensure_type transformer */
export interface EnsureTypeOptions {
  /** The type the value must match to be considered valid */
  expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** Action to take when validation fails */
  onFailure: 'null' | 'error' | 'omit' | 'other';
  /** Value to return when onFailure is 'other' */
  fallbackValue?: string;
}

/** Options for the skip_if_dest_matches transformer */
export interface SkipIfDestMatchesOptions {
  /** JSONPath expression to extract a value from the source (default: "$") */
  sourceExpression?: string;
  /** JSONPath expression to extract a value from the destination (default: "$") */
  destinationExpression?: string;
}

/** Union of all transformer options types */
export type TransformerOptions =
  | AutoConvertOptions
  | ArrayAutoConvertOptions
  | StringToNumberOptions
  | SourceFkToDestFkOptions
  | LookupFieldOptions
  | JSONPathOptions
  | SourceAssetToDestAssetOptions
  | MatchAssetByHashOptions
  | EnsureTypeOptions
  | NotionFileUrlOptions
  | SkipIfDestMatchesOptions;

/** Options for the notion_file_url transformer */
export interface NotionFileUrlOptions {
  /** How to handle multiple matched values. Defaults to 'array'. */
  arrayHandling?: 'first' | 'array';
}

/** Configuration for a field transformer with strictly typed options */
export type TransformerConfig =
  | { type: typeof TransformerTypes.AutoConvert; options: AutoConvertOptions }
  | { type: typeof TransformerTypes.ArrayAutoConvert; options: ArrayAutoConvertOptions }
  | { type: typeof TransformerTypes.StringToNumber; options?: StringToNumberOptions }
  | { type: typeof TransformerTypes.SourceFkToDestFk; options: SourceFkToDestFkOptions }
  | { type: typeof TransformerTypes.LookupField; options: LookupFieldOptions }
  | { type: typeof TransformerTypes.NotionToHtml; options?: Record<string, never> }
  | { type: typeof TransformerTypes.AirmarkToHtml; options?: Record<string, never> }
  | { type: typeof TransformerTypes.HtmlToAirmark; options?: Record<string, never> }
  | { type: typeof TransformerTypes.WebflowOption; options?: Record<string, never> }
  | { type: typeof TransformerTypes.WebflowOptionIdToValue; options?: Record<string, never> }
  | { type: typeof TransformerTypes.Slugify; options?: Record<string, never> }
  | { type: typeof TransformerTypes.JSONPath; options: JSONPathOptions }
  | { type: typeof TransformerTypes.SourceAssetToDestAsset; options: SourceAssetToDestAssetOptions }
  | { type: typeof TransformerTypes.EnsureType; options: EnsureTypeOptions }
  | { type: typeof TransformerTypes.NotionFileUrl; options?: NotionFileUrlOptions }
  | { type: typeof TransformerTypes.EscapeHtml; options?: Record<string, never> }
  | { type: typeof TransformerTypes.Trim; options?: Record<string, never> }
  | { type: typeof TransformerTypes.MatchAssetByHash; options: MatchAssetByHashOptions }
  | { type: typeof TransformerTypes.SkipIfDestMatches; options?: SkipIfDestMatchesOptions };
