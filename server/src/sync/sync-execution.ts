import {
  ColumnMapping,
  ColumnMappingV1,
  ColumnMappingV2,
  ColumnMappingWhen,
  Service,
  SyncMappingV1,
  TableMappingV1,
  TableMappingV2,
  TransformerConfig,
  TransformerType,
  TransformerTypes,
  transformV1ToV2,
} from '@spinner/shared-types';
import get from 'lodash/get';
import set from 'lodash/set';
import zipObjectDeep from 'lodash/zipObjectDeep';
import { WSLogger } from 'src/logger';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import {
  applyTransformerPipeline,
  getColumnMappingPhase,
  getTransformerConfigs,
  LookupTools,
  SyncPhase,
  SyncRecord,
} from 'src/sync/transformers';

export interface TransformRecordResult {
  fields: Record<string, unknown>;
  warnings: string[];
}

/**
 * Apply v1 column mappings to a single source record. Pure — no Nest deps.
 *
 * Used as the v1 column-source pipeline by `applyColumnMappings` and (still)
 * directly by the v1 unit-test surface in `sync.service.spec.ts`.
 *
 * @param baseFields - If provided (existing record), clones it and overlays the
 *   mapped values via lodash `set`, preserving the original JSON key ordering.
 *   Do NOT replace this with merge/spread/Object.assign — those reorder keys
 *   and corrupt the destination file layout. When omitted (new record), builds
 *   a fresh object with `zipObjectDeep`.
 */
export async function transformRecordAsync(
  sourceRecord: SyncRecord,
  columnMappings: ColumnMapping[],
  sourceTableSpec: BaseJsonTableSpec | null,
  destinationTableSpec: BaseJsonTableSpec | null,
  lookupTools?: LookupTools,
  phase: SyncPhase = 'DATA',
  baseFields?: Record<string, unknown>,
  syncContext?: { sourceService: Service; destinationService: Service },
): Promise<TransformRecordResult> {
  const definedPaths: string[] = [];
  const definedValues: unknown[] = [];
  const warnings: string[] = [];

  const phaseFilteredMappings = columnMappings.filter((mapping) => getColumnMappingPhase(mapping) === phase);

  for (const mapping of phaseFilteredMappings) {
    const sourceValue = get(sourceRecord.fields, mapping.sourceColumnId);

    if (sourceValue === undefined) {
      continue;
    }

    let transformedValue: unknown = sourceValue;
    let skip = false;

    const configs = getTransformerConfigs(mapping);
    if (configs.length > 0) {
      const result = await applyTransformerPipeline(configs, sourceValue, {
        sourceRecord,
        sourceFieldPath: mapping.sourceColumnId,
        sourceTableSpec,
        sourceService: syncContext!.sourceService,
        destinationFieldPath: mapping.destinationColumnId,
        destinationTableSpec,
        destinationService: syncContext!.destinationService,
        lookupTools: lookupTools ?? {
          getDestinationMappingForSourceFk: () => Promise.resolve(null),
          lookupFieldFromFkRecord: () => Promise.resolve(null),
          getOrCreateDestinationAssetMapping: () => Promise.reject(new Error('Asset lookup not available')),
          matchDestinationAssetByHash: () => Promise.resolve([]),
        },
        destinationValue: baseFields ? get(baseFields, mapping.destinationColumnId) : undefined,
        phase,
      });

      if (result.success) {
        if (result.skip) {
          skip = true;
        }
        if (result.warnings) {
          warnings.push(...result.warnings);
        }
        transformedValue = result.value;
      } else {
        if (result.useOriginal) {
          transformedValue = sourceValue;
        }
        WSLogger.error({
          source: 'transformRecordAsync',
          message: 'Failed to transform field',
          error: result.error,
          transformerType: result.failedTransformerType,
          sourceColumnId: mapping.sourceColumnId,
          sourceRecordId: sourceRecord.id,
        });
        throw new Error(`Failed to transform field "${mapping.sourceColumnId}": ${result.error}`);
      }
    }

    if (!skip) {
      definedPaths.push(mapping.destinationColumnId);
      definedValues.push(transformedValue);
    }
  }

  if (baseFields) {
    const fields = structuredClone(baseFields);
    for (let i = 0; i < definedPaths.length; i++) {
      set(fields, definedPaths[i], definedValues[i]);
    }
    return { fields, warnings };
  }

  return { fields: zipObjectDeep(definedPaths, definedValues) as Record<string, unknown>, warnings };
}

// ============================================================================
// v2 column-mapping helpers
// ============================================================================

/**
 * Returns the equivalent v1 shape if `m.source.kind === 'column'`, otherwise
 * `null`. Lets executor-internal helpers that read `sourceColumnId` or
 * transformer configs reuse their v1 logic without duplicating the shape
 * dispatch in every call site.
 */
export function v2ColumnAsV1(m: ColumnMappingV2): ColumnMappingV1 | null {
  if (m.source.kind !== 'column') {
    return null;
  }
  return {
    sourceColumnId: m.source.columnId,
    destinationColumnId: m.destinationColumnId,
    ...(m.source.transformer !== undefined ? { transformer: m.source.transformer } : {}),
    ...(m.source.transformers !== undefined ? { transformers: m.source.transformers } : {}),
  };
}

/**
 * Defensive coerce: returns the input unchanged if it's already v2, otherwise
 * transforms a v1 `TableMapping` to its v2 equivalent. Lets the executor entry
 * points and any direct caller (integration tests, future internal callers)
 * pass either shape without forcing a transform at every call site.
 *
 * Implementation reuses `transformV1ToV2` by wrapping the single table in a
 * one-element `SyncMappingV1` — no second transform path to keep in sync.
 */
export function ensureTableMappingV2(t: TableMappingV1 | TableMappingV2): TableMappingV2 {
  if (t.columnMappings.length === 0 || 'source' in t.columnMappings[0]) {
    return t as TableMappingV2;
  }
  const v1Sync: SyncMappingV1 = { version: 1, tableMappings: [t as TableMappingV1] };
  return transformV1ToV2(v1Sync).tableMappings[0];
}

/** Normalize a v2 mapping's transformer configs. Empty for constant sources. */
export function getTransformerConfigsV2(mapping: ColumnMappingV2): TransformerConfig[] {
  if (mapping.source.kind !== 'column') {
    return [];
  }
  if (mapping.source.transformers) {
    return mapping.source.transformers;
  }
  if (mapping.source.transformer) {
    return [mapping.source.transformer];
  }
  return [];
}

/** Filter a v2 mapping's transformer configs by type. */
export function findTransformerConfigsV2(mapping: ColumnMappingV2, type: TransformerType): TransformerConfig[] {
  return getTransformerConfigsV2(mapping).filter((c) => c.type === type);
}

/**
 * Determines which sync phase a v2 column mapping belongs to. Mappings with a
 * SourceFkToDestFk or SourceAssetToDestAsset transformer run in the
 * FOREIGN_KEY_MAPPING phase; all others (including constants) run in DATA.
 */
export function getColumnMappingPhaseV2(mapping: ColumnMappingV2): SyncPhase {
  const configs = getTransformerConfigsV2(mapping);
  const fkPhaseTypes: string[] = [TransformerTypes.SourceFkToDestFk, TransformerTypes.SourceAssetToDestAsset];
  return configs.some((c) => fkPhaseTypes.includes(c.type)) ? 'FOREIGN_KEY_MAPPING' : 'DATA';
}

/** True when the mapping's `when` (default `'matched'`) is applicable to `bucket`. */
function mappingAppliesToBucket(mapping: ColumnMappingV2, bucket: ColumnMappingWhen): boolean {
  const when = mapping.when ?? 'matched';
  return when === bucket || when === 'always';
}

export interface ApplyColumnMappingsArgs {
  /** Which bucket is being processed. */
  bucket: ColumnMappingWhen;
  /** Source record for the matched bucket; `null` for the unmatched bucket. */
  sourceRecord: SyncRecord | null;
  /**
   * Existing destination fields. When defined the result is a structural-clone
   * overlay (preserves JSON key ordering); when undefined a fresh field map
   * is returned.
   */
  baseFields: Record<string, unknown> | undefined;
  mappings: ColumnMappingV2[];
  sourceTableSpec: BaseJsonTableSpec | null;
  destinationTableSpec: BaseJsonTableSpec | null;
  lookupTools?: LookupTools;
  phase: SyncPhase;
  syncContext?: { sourceService: Service; destinationService: Service };
}

/**
 * v2-aware column-mapping application.
 *
 * Filters to mappings whose `when ∈ {bucket, 'always'}` and dispatches on
 * `source.kind`:
 *   - `'column'` → delegates to `transformRecordAsync` using the round-trip
 *     v1 mapping. Behavior matches today's executor exactly.
 *   - `'constant'` → writes the literal value to the destination path. Skipped
 *     in the FOREIGN_KEY_MAPPING phase (constants are DATA-phase only).
 *
 * For `bucket === 'unmatched'`: `sourceRecord` is expected to be `null` and only
 * constant sources fire. Save-time refinement forbids `kind: 'column'` with
 * `when ∈ {'unmatched', 'always'}`; this function is defensive at runtime and
 * silently skips any such mapping that survives.
 */
export async function applyColumnMappings(args: ApplyColumnMappingsArgs): Promise<TransformRecordResult> {
  const applicable = args.mappings.filter((m) => mappingAppliesToBucket(m, args.bucket));

  const columnMappingsV1: ColumnMappingV1[] = [];
  const constantMappings: { destinationColumnId: string; value: string | number | boolean | null }[] = [];

  for (const m of applicable) {
    if (m.source.kind === 'column') {
      if (args.bucket !== 'matched' || args.sourceRecord === null) {
        continue;
      }
      const v1 = v2ColumnAsV1(m);
      if (v1 !== null) {
        columnMappingsV1.push(v1);
      }
    } else {
      constantMappings.push({ destinationColumnId: m.destinationColumnId, value: m.source.value });
    }
  }

  let result: TransformRecordResult;
  if (columnMappingsV1.length > 0 && args.sourceRecord !== null) {
    result = await transformRecordAsync(
      args.sourceRecord,
      columnMappingsV1,
      args.sourceTableSpec,
      args.destinationTableSpec,
      args.lookupTools,
      args.phase,
      args.baseFields,
      args.syncContext,
    );
  } else {
    result = {
      fields: args.baseFields ? structuredClone(args.baseFields) : {},
      warnings: [],
    };
  }

  if (args.phase === 'DATA' && constantMappings.length > 0) {
    for (const c of constantMappings) {
      set(result.fields, c.destinationColumnId, c.value);
    }
  }

  return result;
}

// ============================================================================
// Destination-record classification (Pass 3)
// ============================================================================

/**
 * Set-theoretic classification of a destination record relative to the source
 * side this run. The three buckets are mutually exclusive.
 *
 * - `matched` — destination record paired with a source record this run.
 * - `unmatchedWithMatchKey` — destination record whose match-key field is
 *   populated, but whose source counterpart isn't present this run. Typically
 *   records this sync previously wrote whose source has since been deleted.
 * - `unmatchedWithoutMatchKey` — destination record whose match-key field is
 *   empty/null/whitespace, or a non-string/number value. Typically hand-authored
 *   or pre-existing records that this sync never managed.
 */
export type DestinationRecordClassification = 'matched' | 'unmatchedWithMatchKey' | 'unmatchedWithoutMatchKey';

/**
 * Classifies a single destination record against the source match-key set
 * built in Pass 1. Pure — no Nest deps. See `DestinationRecordClassification`
 * for bucket semantics.
 *
 * The match-key normalization rules mirror `insertMatchKeys` exactly: only
 * string or number values count, and they are `String()`-coerced + trimmed.
 * Anything else (null, undefined, arrays, objects, booleans, whitespace-only
 * strings) is treated as no match key — preventing accidental matches via a
 * coerced object representation like `"[object Object]"`.
 */
export function classifyDestinationRecord(
  destRecord: SyncRecord,
  sourceMatchKeySet: ReadonlySet<string>,
  destinationMatchColumnId: string,
): DestinationRecordClassification {
  const raw = get(destRecord.fields, destinationMatchColumnId);
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return 'unmatchedWithoutMatchKey';
  }
  const key = String(raw).trim();
  if (key === '') {
    return 'unmatchedWithoutMatchKey';
  }
  return sourceMatchKeySet.has(key) ? 'matched' : 'unmatchedWithMatchKey';
}
