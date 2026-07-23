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
import { readFieldValueAtPath, setFieldValueAtPath } from 'src/utils/field-path';

export interface TransformRecordResult {
  fields: Record<string, unknown>;
  warnings: string[];
}

/**
 * Force `preserveNull` on every `auto_convert` config in a pipeline so a `null`
 * source passes through as `null` instead of being coerced to a type zero-value
 * (`0` / `false` / `''` / `[]`).
 *
 * Used ONLY on the clear path (an absent/cleared source rewritten to `null` — see
 * `transformRecordAsync`). `auto_convert` is the single registered transformer
 * that manufactures a non-null value from a null source; every other transformer
 * already short-circuits a null source to `null` (or `skip`). Its never-fail
 * coercion floor (`pickMappingTransformers` / `coercionFloorForDestination` in
 * `transform-picker.ts`) attaches a `preserveNull`-less `auto_convert` to nearly
 * every cross-type mapping, so without this a cleared numeric/boolean/text/array
 * cell would be written as a literal zero-value rather than emptied — the silent
 * corruption tracked in DEV-10817, which undercut the DEV-10797 clear fix.
 *
 * Deliberately scoped to the genuine-clear path: on the normal path a source that
 * carries an explicit `null` keeps the zero-value coercion, which is the
 * intentional `auto_convert` default (added to stop empty sources flipping a
 * destination to `null`). See the `preserveNull` option on `AutoConvertOptions`.
 */
function forceAutoConvertToPreserveNullForClear(configs: TransformerConfig[]): TransformerConfig[] {
  return configs.map((config) =>
    config.type === TransformerTypes.AutoConvert
      ? { type: config.type, options: { ...config.options, preserveNull: true } }
      : config,
  );
}

/**
 * Apply v1 column mappings to a single source record. Pure — no Nest deps.
 *
 * Used as the v1 column-source pipeline by `applyColumnMappings` and (still)
 * directly by the v1 unit-test surface in `sync.service.spec.ts`.
 *
 * @param baseFields - If provided (existing record), clones it and overlays the
 *   mapped values at their destination paths (via {@link setFieldValueAtPath}),
 *   preserving the original JSON key ordering. Do NOT replace this with
 *   merge/spread/Object.assign — those reorder keys and corrupt the destination
 *   file layout. When omitted (new record), builds a fresh object the same way.
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

  // Destination schema doubles as the dot-safe segmentation dictionary for every
  // destination-path write below: a created Notion property literally named
  // `col.with.dots` lands at that flat key rather than nested `col → with → dots`.
  const destinationSchema = destinationTableSpec?.schema;

  for (const mapping of phaseFilteredMappings) {
    let sourceValue = readFieldValueAtPath(sourceRecord.fields, mapping.sourceColumnId);
    let clearingAbsentSourceField = false;

    if (sourceValue === undefined) {
      // The source field is absent/cleared. Some connectors represent a cleared
      // value by omitting the key entirely (e.g. Notion drills the destination
      // path down to `properties.Status.select.name`, which resolves to
      // `undefined` once the parent `select` is nulled), so an undefined source
      // value on a *mapped* column means the destination should be cleared too —
      // the sync owns every mapped column, so "no source value" is a clear, not
      // "leave as-is".
      //
      // This only matters on the update path (`baseFields` present) and only
      // when the destination currently holds a value: on a create there is
      // nothing to clear, and emitting a cleared value would add a key the
      // destination's own pull omits for an empty field.
      const destinationHoldsValueToClear =
        baseFields !== undefined && readFieldValueAtPath(baseFields, mapping.destinationColumnId) !== undefined;
      if (!destinationHoldsValueToClear) {
        continue;
      }
      // Propagate the clear by treating the absent source as an explicit `null`
      // and falling through to the normal write path — the same route a
      // connector that returns explicit `null` on clear (e.g. Webflow) already
      // takes, so both spellings of "cleared" produce identical destination
      // bytes. A transformer-less mapping writes `null`, which publish
      // translates into a real clear on the service (removing the JSON key
      // instead would be ignored by the publish diff — see CONNECTOR_GUIDE,
      // "Removed keys are not tracked"). A mapping WITH transformers runs its
      // pipeline on `null` so the clear takes the connector's declared cleared
      // shape rather than a raw `null` the destination service may reject
      // (e.g. wrap_object's `emptyTemplate` producing Notion's
      // `{ type: 'select', select: null }` envelope), and skip-style
      // transformers keep their skip semantics.
      //
      // All but one registered transformer short-circuit a `null` source to
      // `null` (or `skip`). The exception is `auto_convert`: its coercion floor
      // rides nearly every cross-type mapping and, by default, manufactures a
      // type zero-value (`0`/`false`/`''`/`[]`) from a `null` source — which
      // would write a literal zero into a cleared cell instead of emptying it
      // (DEV-10817). Flag this iteration so we run the pipeline with `auto_convert`
      // forced to preserve the clear; see `forceAutoConvertToPreserveNullForClear`.
      sourceValue = null;
      clearingAbsentSourceField = true;
    }

    let transformedValue: unknown = sourceValue;
    let skip = false;

    const configs = clearingAbsentSourceField
      ? forceAutoConvertToPreserveNullForClear(getTransformerConfigs(mapping))
      : getTransformerConfigs(mapping);
    if (configs.length > 0) {
      if (!syncContext) {
        throw new Error('transformRecordAsync requires syncContext when column mappings include transformers');
      }
      const result = await applyTransformerPipeline(configs, sourceValue, {
        sourceRecord,
        sourceFieldPath: mapping.sourceColumnId,
        sourceTableSpec,
        sourceService: syncContext.sourceService,
        destinationFieldPath: mapping.destinationColumnId,
        destinationTableSpec,
        destinationService: syncContext.destinationService,
        lookupTools: lookupTools ?? {
          getDestinationMappingForSourceFk: () => Promise.resolve(null),
          lookupFieldFromFkRecord: () => Promise.resolve(null),
          getOrCreateDestinationAssetMapping: () => Promise.reject(new Error('Asset lookup not available')),
          matchDestinationAssetByHash: () => Promise.resolve([]),
        },
        destinationValue: baseFields ? readFieldValueAtPath(baseFields, mapping.destinationColumnId) : undefined,
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
      } else if (result.useOriginal) {
        // Never-fail coercion floor: the transformer could not coerce this cell
        // (e.g. `auto_convert(number)` on an un-parseable "N/A"), so write the
        // original source value and keep the rest of the record rather than
        // dropping the whole row. Surface a warning so the failed coercion is
        // not silently swallowed — publish then rejects the original value at
        // the service boundary if the destination column can't hold it.
        warnings.push(
          `Could not transform field "${mapping.sourceColumnId}"` +
            `${result.failedTransformerType ? ` (${result.failedTransformerType})` : ''}: ${result.error}. ` +
            `Wrote the original value instead.`,
        );
        transformedValue = sourceValue;
      } else {
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
      setFieldValueAtPath(fields, definedPaths[i], definedValues[i], destinationSchema);
    }
    return { fields, warnings };
  }

  // New record: build a fresh fields object. Segment each destination path against
  // the destination schema (the target keys don't exist yet, so the object itself
  // can't be the segmentation dictionary) so a dotted property name is written as
  // a flat key — the dot-safe replacement for `zipObjectDeep`.
  const fields: Record<string, unknown> = {};
  for (let i = 0; i < definedPaths.length; i++) {
    setFieldValueAtPath(fields, definedPaths[i], definedValues[i], destinationSchema);
  }
  return { fields, warnings };
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
      setFieldValueAtPath(result.fields, c.destinationColumnId, c.value, args.destinationTableSpec?.schema);
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
 * Takes the destination record's already-canonicalized match key
 * (`deriveCanonicalMatchKey`), or `null` when the field can't serve as a match
 * key for this record (non-primitive with no extraction transformer, or
 * empty/missing). Both sides are canonicalized by the same reducer, so equal
 * keys here mean the same `matchId` the Pass 2 join compared.
 */
export function classifyDestinationRecord(
  destinationMatchKey: string | null,
  sourceMatchKeySet: ReadonlySet<string>,
): DestinationRecordClassification {
  if (destinationMatchKey === null) {
    return 'unmatchedWithoutMatchKey';
  }
  return sourceMatchKeySet.has(destinationMatchKey) ? 'matched' : 'unmatchedWithMatchKey';
}
