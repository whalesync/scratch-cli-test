import { DataFolderId } from './ids';

// ============================================================================
// Sync Mapping Types — V1 (legacy on-disk shape)
// ============================================================================
//
// V1 is frozen as of the introduction of the `Sync.mappingsV2` column. Existing
// rows that have not yet been backfilled still hold v1; new writes go to v2.
// Keep the Zod schema in @server/src/sync/sync-mapping.schema.ts in sync.
//
// Read path: SyncService.getMappings() returns a discriminated union over
// `version` — see `StoredSyncMapping` below.

export interface SyncMappingV1 {
  /** On-disk schema version. */
  version: 1;

  /** Per-table mappings. */
  tableMappings: TableMappingV1[];
}

export interface TableMappingV1 {
  sourceDataFolderId: DataFolderId;
  destinationDataFolderId: DataFolderId;

  /** Column mappings from source to destination */
  columnMappings: ColumnMappingV1[];

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

export interface ColumnMappingV1 {
  /** Column ID in the source DataFolder schema */
  sourceColumnId: string;

  /** Column ID in the destination DataFolder schema */
  destinationColumnId: string;

  /** Optional transformer to apply to the value during sync */
  transformer?: TransformerConfig;

  /** Optional pipeline of transformers applied sequentially (mutually exclusive with `transformer`) */
  transformers?: TransformerConfig[];
}

// Back-compat aliases. Pre-v2 consumers import these unsuffixed names; routing
// each one through the v2 shape happens in follow-up tasks (server choke point,
// client editor). Removed in the Phase 4 cleanup along with the v1 column.
export type SyncMapping = SyncMappingV1;
export type TableMapping = TableMappingV1;
export type ColumnMapping = ColumnMappingV1;

// ============================================================================
// Sync Mapping Types — V2 (unmatched-aware shape)
// ============================================================================
//
// V2 lifts `when` to the top-level `ColumnMapping` and makes `source` a
// discriminated union so a single destination column can carry distinct rules
// for the matched bucket and the unmatched bucket. Adds per-table policies
// describing what to do with unmatched source / destination records.

export interface SyncMappingV2 {
  /** On-disk schema version. */
  version: 2;

  /** Per-table mappings. */
  tableMappings: TableMappingV2[];
}

export interface TableMappingV2 {
  sourceDataFolderId: DataFolderId;
  destinationDataFolderId: DataFolderId;

  /** Column mappings from source to destination, partitioned by `when`. */
  columnMappings: ColumnMappingV2[];

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

  /**
   * What to do with source records that have no destination match.
   * Defaults to `{ type: 'create' }` (today's behavior).
   */
  unmatchedSourcePolicy?: UnmatchedSourcePolicy;

  /**
   * What to do with destination records that have no source match —
   * subdivided by whether the destination's match-key field is populated.
   * Defaults to `{ withMatchKey: 'ignore', withoutMatchKey: 'ignore' }`
   * (today's behavior — unmatched destination records are not visited).
   */
  unmatchedDestinationPolicy?: UnmatchedDestinationPolicy;
}

export interface ColumnMappingV2 {
  /** Column ID in the destination DataFolder schema */
  destinationColumnId: string;

  /**
   * Which bucket the mapping applies to. Defaults to 'matched'.
   *
   * Structural constraint (enforced by zod refinement at save time):
   *   `source.kind === 'column'` with `when` of 'unmatched' or 'always' is
   *   illegal — there is no source value to copy for an unmatched destination record.
   */
  when?: ColumnMappingWhen;

  /** Value source — either a copy from a source column or a literal constant. */
  source: ColumnMappingSource;
}

/**
 * - 'matched'   — fires when the source record exists and is paired with this destination.
 * - 'unmatched' — fires when the destination has no source counterpart this run.
 * - 'always'    — fires for both buckets.
 */
export type ColumnMappingWhen = 'matched' | 'unmatched' | 'always';

export type ColumnMappingSource =
  | {
      kind: 'column';
      /** Source column to copy from. */
      columnId: string;
      /** Optional transformer to apply to the value during sync */
      transformer?: TransformerConfig;
      /** Optional pipeline of transformers applied sequentially (mutually exclusive with `transformer`) */
      transformers?: TransformerConfig[];
    }
  | {
      kind: 'constant';
      /**
       * Literal value to write. V1 of v2 limits this to JSON primitives;
       * arrays/objects come later once per-element destination-column
       * type-checking lands.
       */
      value: string | number | boolean | null;
    };

export type UnmatchedSourcePolicy =
  | { type: 'create' } // DEFAULT — today's behavior
  | { type: 'ignore' };

/**
 * What to do with an unmatched destination record, per bucket.
 *
 * - 'ignore' — leave the record untouched (default).
 * - 'apply'  — apply the table's `when: 'unmatched'` constant column mappings to
 *              the record (the archive case — e.g. flip `archived` to `true`).
 * - 'delete' — delete the destination record file outright. The source record is
 *              gone, so its destination counterpart is removed. Unlike 'apply'
 *              this needs no column mappings; it removes the file.
 */
export type UnmatchedDestinationAction = 'ignore' | 'apply' | 'delete';

export interface UnmatchedDestinationPolicy {
  /** Records that claim to be synced — destination match-key field is populated. */
  withMatchKey: UnmatchedDestinationAction;
  /** Records that were never managed by this sync — match-key field is empty/null. */
  withoutMatchKey: UnmatchedDestinationAction;
}

// ============================================================================
// Storage discriminated union + v1 → v2 transform
// ============================================================================

/**
 * Shape returned by `SyncService.getMappings()`. Consumers narrow on
 * `mapping.version`. The executor and the editor transform v1 → v2 in memory
 * at their entry points; the read path itself never normalizes.
 */
export type StoredSyncMapping = SyncMappingV1 | SyncMappingV2;

/**
 * Thrown when an input that claims to be a `SyncMappingV1` is structurally
 * corrupt (missing required fields, wrong primitive types). Mapped to HTTP
 * 500 `SYNC_MAPPING_NORMALIZE_FAILED` by `SyncExceptionFilter`.
 */
export class SyncMappingNormalizeError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Sync mapping normalization failed: ${detail}`);
    this.name = 'SyncMappingNormalizeError';
    this.detail = detail;
  }
}

/**
 * Thrown when a stored mapping carries an unknown `version` value. Mapped to
 * HTTP 500 `SYNC_MAPPING_UNKNOWN_VERSION` by `SyncExceptionFilter`.
 */
export class SyncMappingVersionError extends Error {
  readonly receivedVersion: unknown;

  constructor(receivedVersion: unknown) {
    super(`Unknown sync mapping version: ${String(receivedVersion)}`);
    this.name = 'SyncMappingVersionError';
    this.receivedVersion = receivedVersion;
  }
}

/**
 * Thrown at sync save time when a `{ kind: 'constant' }` column mapping's
 * literal value does not match the declared type of its destination column —
 * e.g. writing the string `"true"` into a boolean column. Mapped to HTTP 400
 * `INVALID_CONSTANT_TYPE` by `SyncExceptionFilter`.
 *
 * `expected` and `got` use the destination-schema type vocabulary
 * (`string` | `number` | `integer` | `boolean` | `object` | `array`).
 */
export class ConstantTypeMismatchError extends Error {
  readonly destinationColumnId: string;
  readonly expected: string;
  readonly got: string;

  constructor(destinationColumnId: string, expected: string, got: string) {
    super(
      `Constant value for destination column "${destinationColumnId}" has type "${got}" but the column expects "${expected}"`,
    );
    this.name = 'ConstantTypeMismatchError';
    this.destinationColumnId = destinationColumnId;
    this.expected = expected;
    this.got = got;
  }
}

/**
 * Pure shape transform from the v1 on-disk shape to the v2 in-memory shape.
 *
 * Not used by the read path — `SyncService.getMappings()` returns the on-disk
 * shape via the `StoredSyncMapping` discriminated union. Used by:
 *   - the executor's entry point (`syncTableMapping`),
 *   - the editor's "open v1 sync" flow,
 *   - the v1 → v2 backfill descriptor.
 *
 * Transformed v1 mappings have no unmatched-destination policy and every
 * column mapping defaults to `when: 'matched'`, so Pass 3 is a no-op and v1
 * syncs behave exactly as before.
 */
export function transformV1ToV2(mapping: SyncMappingV1): SyncMappingV2 {
  if (mapping === null || typeof mapping !== 'object') {
    throw new SyncMappingNormalizeError('mapping is not an object');
  }
  if (mapping.version !== 1) {
    throw new SyncMappingVersionError(mapping.version);
  }
  if (!Array.isArray(mapping.tableMappings)) {
    throw new SyncMappingNormalizeError('tableMappings is not an array');
  }

  return {
    version: 2,
    tableMappings: mapping.tableMappings.map((table, tableIndex) => transformTableMappingV1ToV2(table, tableIndex)),
  };
}

function transformTableMappingV1ToV2(table: TableMappingV1, tableIndex: number): TableMappingV2 {
  if (table === null || typeof table !== 'object') {
    throw new SyncMappingNormalizeError(`tableMappings[${tableIndex}] is not an object`);
  }
  if (!Array.isArray(table.columnMappings)) {
    throw new SyncMappingNormalizeError(`tableMappings[${tableIndex}].columnMappings is not an array`);
  }

  return {
    sourceDataFolderId: table.sourceDataFolderId,
    destinationDataFolderId: table.destinationDataFolderId,
    columnMappings: table.columnMappings.map((column, columnIndex) =>
      transformColumnMappingV1ToV2(column, tableIndex, columnIndex),
    ),
    ...(table.recordMatching !== undefined ? { recordMatching: table.recordMatching } : {}),
  };
}

function transformColumnMappingV1ToV2(
  column: ColumnMappingV1,
  tableIndex: number,
  columnIndex: number,
): ColumnMappingV2 {
  const location = `tableMappings[${tableIndex}].columnMappings[${columnIndex}]`;
  if (column === null || typeof column !== 'object') {
    throw new SyncMappingNormalizeError(`${location} is not an object`);
  }
  if (typeof column.sourceColumnId !== 'string') {
    throw new SyncMappingNormalizeError(`${location}.sourceColumnId is missing or not a string`);
  }
  if (typeof column.destinationColumnId !== 'string') {
    throw new SyncMappingNormalizeError(`${location}.destinationColumnId is missing or not a string`);
  }

  return {
    destinationColumnId: column.destinationColumnId,
    source: {
      kind: 'column',
      columnId: column.sourceColumnId,
      ...(column.transformer !== undefined ? { transformer: column.transformer } : {}),
      ...(column.transformers !== undefined ? { transformers: column.transformers } : {}),
    },
  };
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
  PortableTextToHtml: 'portable_text_to_html',
  RicosToHtml: 'ricos_to_html',
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
  ReplaceNewlines: 'replace_newlines',
  ReplaceRegex: 'replace_regex',
  WrapObject: 'wrap_object',
  MapArray: 'map_array',
  SkipIfDestArrayMatches: 'skip_if_dest_array_matches',
  ValueMap: 'value_map',
  EpochToIso: 'epoch_to_iso',
  SerialDateToIso: 'serial_date_to_iso',
  IsoToSerialDate: 'iso_to_serial_date',
  TranscriptToSrt: 'transcript_to_srt',
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
  { type: TransformerTypes.PortableTextToHtml, label: 'Portable Text to HTML' },
  { type: TransformerTypes.RicosToHtml, label: 'Ricos to HTML' },
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
  { type: TransformerTypes.ReplaceNewlines, label: 'Replace Newlines' },
  { type: TransformerTypes.ReplaceRegex, label: 'Replace Regex' },
  { type: TransformerTypes.WrapObject, label: 'Wrap Object' },
  { type: TransformerTypes.MapArray, label: 'Map Array' },
  { type: TransformerTypes.SkipIfDestArrayMatches, label: 'Skip If Dest Array Matches' },
  { type: TransformerTypes.ValueMap, label: 'Value Map' },
  { type: TransformerTypes.EpochToIso, label: 'Unix Timestamp to Date' },
  { type: TransformerTypes.SerialDateToIso, label: 'Spreadsheet Serial to Date' },
  { type: TransformerTypes.IsoToSerialDate, label: 'Date to Spreadsheet Serial' },
  { type: TransformerTypes.TranscriptToSrt, label: 'Transcript to SRT' },
];

/** Get the display label for a transformer type */
export function getTransformerLabel(type: TransformerType): string {
  return TRANSFORMER_TYPES.find((t) => t.type === type)?.label ?? type.replace(/_/g, ' ');
}

/** Options for the auto_convert transformer */
export interface AutoConvertOptions {
  /** The target type to convert the source value to */
  targetType: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  /** When true, null/undefined values pass through as null instead of being converted (e.g. null stays null for string instead of becoming '') */
  preserveNull?: boolean;
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
  /**
   * What to do when a referenced record cannot be found. Default: `'ignore'` — warn rather than
   * fail. The field is held back untouched if writing it would ERASE a link the destination already
   * holds; a write that only adds to the destination's links still goes through, with the
   * unresolvable one left empty. A reference whose target is gone from the source is normal (it was
   * deleted upstream and the surviving records keep its id), and failing the record failed its whole
   * table (DEV-11222). `'fail'` opts back into stopping the sync. An AMBIGUOUS target key fails
   * under either setting.
   */
  onUnresolved?: 'fail' | 'ignore';
  /**
   * Stringified source values that mean "not linked" and must be dropped BEFORE resolution,
   * for a service that writes a sentinel instead of null (WordPress `featured_media: 0`).
   * Treated exactly like `null`, so they are dropped silently — where a value outside this list
   * that resolves to nothing is reported as an unresolved foreign key (and, under the default
   * `onUnresolved`, warned about rather than failed). See `ForeignKeyOptionSchema.valuesMeaningNoLink`,
   * which is where it comes from.
   */
  valuesMeaningNoLink?: string[];
  /** Output shape: 'array' (default) preserves arrays, 'single' unwraps to the first element or null */
  outputType?: 'array' | 'single';
  /**
   * Dot path in the REFERENCED record that this foreign key's values match, when they are not
   * the referenced record's remote id (Framer's references name their target by `slug`).
   * Absent ⇒ the value is already the remote id. Mirrors the connector schema's
   * `x-scratch-foreign-key.targetKeyPath`, which is where it originates.
   */
  targetKeyPath?: string;
}

/** Options for the lookup_field transformer */
export interface LookupFieldOptions {
  /** The DataFolder ID containing the referenced records */
  referencedDataFolderId: DataFolderId;
  /** The field path to extract from the referenced record (e.g. 'name' or 'company.displayName') */
  referencedFieldPath: string;
}

/** How to handle multiple results from a JSONPath expression */
export type JSONPathArrayHandling = 'first' | 'array' | 'join_space' | 'join_comma' | 'concat' | 'join_matches_space';

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

/** Options for the replace_newlines transformer */
export interface ReplaceNewlinesOptions {
  /** The string to substitute for each newline character (default: "") */
  replacement?: string;
}

/** Options for the replace_regex transformer */
export interface ReplaceRegexOptions {
  /** Regex pattern string (compiled with global flag) */
  pattern: string;
  /** Replacement string, supports capture groups ($1, $2, etc.) (default: "") */
  replacement?: string;
}

/**
 * Options for the epoch_to_iso transformer — a Unix-epoch NUMBER to an ISO-8601 date-time
 * string. Services that report times as bare epochs (Stripe, Intercom, ClickUp) otherwise
 * export a date as a raw number, so a destination creates a number column and the value is
 * unusable as a date. Annotating such a field `format: 'date-time'` alone makes it WORSE:
 * the destination gets a real date column and is still handed the bare integer. The
 * conversion has to happen in the value pipeline, which is what this transformer is for.
 */
export interface EpochToIsoOptions {
  /** Unit of the incoming epoch value. Defaults to `'seconds'` (what most REST APIs emit). */
  unit?: 'seconds' | 'milliseconds';
}

/**
 * Options for the serial_date_to_iso / iso_to_serial_date transformers — spreadsheet
 * serial date NUMBERS (days since 1899-12-30, the Excel/Google Sheets/LibreOffice
 * encoding; the fraction is the time of day) to/from ISO-8601 strings. Sheets' API
 * returns date cells as serial numbers when read losslessly
 * (`valueRenderOption=UNFORMATTED_VALUE`), so without the conversion a date exports
 * as a bare number like `46238.5` — same failure mode as {@link EpochToIsoOptions}.
 *
 * Serial values are timezone-naive wall-clock times, so the ISO side carries no
 * `Z`/offset: `45870` ↔ `2025-08-01`, `45870.5` ↔ `2025-08-01T12:00:00`. The
 * ISO-consuming direction also accepts `Z`-suffixed timestamps (a source service's
 * UTC instant becomes the serial of its UTC wall clock).
 */
export interface SerialDateOptions {
  /**
   * Force the ISO output shape of serial_date_to_iso. Default `'auto'`: an
   * integer serial emits a date-only string, a fractional serial emits a
   * date-time string.
   */
  isoShape?: 'auto' | 'date' | 'datetime';
}

/** Options for the wrap_object transformer */
export interface WrapObjectOptions {
  /** Template object where "$value" strings are replaced with the source value */
  template: Record<string, unknown>;
  /**
   * Static shape emitted when the source value is empty (null/undefined/""), used to
   * CLEAR the field rather than wrap the empty value. Carries no "$value". When omitted,
   * an empty source packs to `null` (which a connector's write path typically drops, i.e.
   * leaves the field unchanged). A connector declares this to make "sync an empty value →
   * clear the field" work — e.g. Notion date → `{ type: 'date', date: null }`.
   */
  emptyTemplate?: Record<string, unknown>;
}

/** Options for the map_array transformer */
export interface MapArrayOptions {
  /** Transformer to apply to each array element */
  elementTransformer: TransformerConfig;
  /**
   * Optional envelope applied AFTER the element mapping: an object template in which every
   * `"$value"` (at any depth) is replaced with the mapped array — the same substitution
   * wrap_object uses. Lets a single map_array config express a "map the elements, then wrap
   * the list" destination pack, e.g. Notion's relation property: elements `id → { id }`, then
   * `{ type: 'relation', relation: '$value' }`. When present, a null/undefined input maps to
   * an EMPTY array before wrapping (yielding the service's "cleared" shape, e.g.
   * `{ type: 'relation', relation: [] }`) — mirroring wrap_object's emptyTemplate
   * clear-on-empty behavior. Without it, null passes through as null (field left unchanged),
   * exactly as before.
   */
  resultTemplate?: Record<string, unknown>;
}

/** Options for the value_map transformer */
export interface ValueMapOptions {
  /**
   * Source value → output string, keyed by the source value's STRING form (`String(value)`, so the
   * number `33` is looked up as `"33"`). Built for select-style fields whose stored value is an
   * option id and whose human label lives only in metadata: the connector bakes the id → label
   * dictionary into the config at view-build time (the view regenerates on every pull, so the
   * dictionary stays as fresh as the schema itself).
   */
  mapping: Record<string, string>;
  /**
   * What to do with a scalar that has no `mapping` entry: `'passthrough'` (default) emits its
   * string form verbatim — right for open option sets where an unknown id is still meaningful —
   * or `'null'` drops it.
   */
  onUnmapped?: 'passthrough' | 'null';
}

/** Options for the skip_if_dest_array_matches transformer */
export interface SkipIfDestArrayMatchesOptions {
  /** JSONPath expression to extract a comparable value from each source element (default: "$") */
  sourceElementExpression?: string;
  /** JSONPath expression to extract a comparable value from each destination element (default: "$") */
  destinationElementExpression?: string;
  /** Whether element order must match (default: false) */
  matchOrdering?: boolean;
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
  | SkipIfDestMatchesOptions
  | ReplaceNewlinesOptions
  | ReplaceRegexOptions
  | WrapObjectOptions
  | MapArrayOptions
  | SkipIfDestArrayMatchesOptions
  | ValueMapOptions
  | EpochToIsoOptions
  | SerialDateOptions
  | TranscriptToSrtOptions;

/** Options for the notion_file_url transformer */
export interface NotionFileUrlOptions {
  /** How to handle multiple matched values. Defaults to 'array'. */
  arrayHandling?: 'first' | 'array';
}

/** Configuration for a field transformer with strictly typed options */

/**
 * Options for the transcript_to_srt transformer: render an array of
 * speaker-attributed transcript segments (each holding millisecond-timed
 * sentences) as a SubRip (SRT) document with "Speaker N:" labels. All shape
 * knowledge rides in these dot paths, so the transformer stays
 * connector-agnostic. See `transform/apply-transcript-to-srt.ts` for the
 * rendering contract.
 */
export interface TranscriptToSrtOptions {
  /** Dot path IN EACH SEGMENT to its speaker identifier; omitted ⇒ cues carry no speaker label */
  speakerPath?: string;
  /** Dot path IN EACH SEGMENT to its timed-sentence array; omitted ⇒ each segment IS one timed sentence */
  sentencesPath?: string;
  /** Dot path IN EACH SENTENCE to the spoken text (default 'text') */
  textPath?: string;
  /** Dot path IN EACH SENTENCE to its start time in milliseconds (default 'start') */
  startMsPath?: string;
  /** Dot path IN EACH SENTENCE to its end time in milliseconds (default 'end') */
  endMsPath?: string;
}

export type TransformerConfig =
  | { type: typeof TransformerTypes.AutoConvert; options: AutoConvertOptions }
  | { type: typeof TransformerTypes.ArrayAutoConvert; options: ArrayAutoConvertOptions }
  | { type: typeof TransformerTypes.StringToNumber; options?: StringToNumberOptions }
  | { type: typeof TransformerTypes.SourceFkToDestFk; options: SourceFkToDestFkOptions }
  | { type: typeof TransformerTypes.LookupField; options: LookupFieldOptions }
  | { type: typeof TransformerTypes.NotionToHtml; options?: Record<string, never> }
  | { type: typeof TransformerTypes.PortableTextToHtml; options?: Record<string, never> }
  | { type: typeof TransformerTypes.RicosToHtml; options?: Record<string, never> }
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
  | { type: typeof TransformerTypes.SkipIfDestMatches; options?: SkipIfDestMatchesOptions }
  | { type: typeof TransformerTypes.ReplaceNewlines; options?: ReplaceNewlinesOptions }
  | { type: typeof TransformerTypes.ReplaceRegex; options: ReplaceRegexOptions }
  | { type: typeof TransformerTypes.WrapObject; options: WrapObjectOptions }
  | { type: typeof TransformerTypes.MapArray; options: MapArrayOptions }
  | { type: typeof TransformerTypes.SkipIfDestArrayMatches; options?: SkipIfDestArrayMatchesOptions }
  | { type: typeof TransformerTypes.ValueMap; options: ValueMapOptions }
  | { type: typeof TransformerTypes.EpochToIso; options?: EpochToIsoOptions }
  | { type: typeof TransformerTypes.SerialDateToIso; options?: SerialDateOptions }
  | { type: typeof TransformerTypes.IsoToSerialDate; options?: Record<string, never> }
  | { type: typeof TransformerTypes.TranscriptToSrt; options?: TranscriptToSrtOptions };

/**
 * Transformer arms that are SERVER-ONLY: their options carry a branded `DataFolderId` and
 * their runtime needs cross-record `LookupTools` (foreign-key / asset / lookup resolution).
 * They must never be serialized onto a View column that gets sent to a frontend, and they are
 * resolved in dedicated sync phases (`FOREIGN_KEY_MAPPING`), not the per-value codec.
 */
export type ServerOnlyTransformerType =
  | typeof TransformerTypes.SourceFkToDestFk
  | typeof TransformerTypes.LookupField
  | typeof TransformerTypes.SourceAssetToDestAsset
  | typeof TransformerTypes.MatchAssetByHash;

/**
 * The subset of {@link TransformerConfig} that is safe to serialize onto a View column (and
 * hence to send to the web / desktop / CLI frontends): every arm EXCEPT the server-only
 * FK/asset/lookup arms ({@link ServerOnlyTransformerType}). This is the vocabulary a View
 * column's `toCore` / `fromCore` codec may use — a widened superset of the display-only
 * `DisplayTransformerConfig`, admitting the pure pack transformers (`wrap_object`,
 * `html_to_airmark`, `slugify`, …) that `fromCore` needs while keeping DataFolderId-bearing
 * arms out of client-facing payloads.
 *
 * NOTE: `map_array`'s nested `elementTransformer` is still typed as the full
 * `TransformerConfig`; the client-safe guarantee is enforced at the top level only.
 */
export type ClientSafeTransformer = Exclude<TransformerConfig, { type: ServerOnlyTransformerType }>;
