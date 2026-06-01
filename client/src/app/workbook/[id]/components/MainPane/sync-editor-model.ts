/**
 * Pure model + conversions for the sync editor's v2 (unmatched-aware) mapping shape.
 *
 * The editor works on an in-memory `FolderPair[]` / `FieldMapping[]` model that is
 * easy to render and mutate. These helpers convert that model to/from the persisted
 * `SyncMappingV2` shape and provide the small bits of derived state the render layer
 * needs (grouping by destination column, conflict detection, constant defaults).
 *
 * Everything here is pure (no React, no network) so it can be unit-tested directly —
 * see `__tests__/sync-editor-model.test.ts`.
 */
import type {
  ColumnMappingV2,
  ColumnMappingWhen,
  DataFolder,
  StoredSyncMapping,
  SyncMappingV2,
  TableMappingV2,
  TransformerConfig,
} from '@spinner/shared-types';
import { transformV1ToV2 } from '@spinner/shared-types';

/** Literal value a `kind: 'constant'` mapping writes. JSON primitives only for v1-of-v2. */
export type ConstantValue = string | number | boolean | null;

/** The value-source kind for a single editor mapping row. */
export type FieldMappingKind = 'column' | 'constant';

/**
 * One value rule for a destination column, under a specific bucket (`when`). The
 * editor keeps both the column-copy fields and the constant value on the same object
 * (only the ones relevant to `kind` are meaningful) so the render layer can switch a
 * row between kinds without losing the other side's draft.
 */
export interface FieldMapping {
  id: string;
  destField: string;
  /** Which bucket this rule fires for. Defaults to 'matched' (today's behavior). */
  when: ColumnMappingWhen;
  kind: FieldMappingKind;
  /** Source column to copy from. Meaningful when `kind === 'column'`. */
  sourceField: string;
  /** Transformer pipeline. Meaningful when `kind === 'column'`. */
  transformers: TransformerConfig[];
  /** Literal value to write. Meaningful when `kind === 'constant'`. */
  constantValue: ConstantValue;
}

export type UnmatchedSourcePolicyChoice = 'create' | 'ignore';
export type UnmatchedDestinationPolicyChoice = 'ignore' | 'apply';

/** One source→destination DataFolder pairing (a single table mapping) in editor form. */
export interface FolderPair {
  id: string;
  sourceId: string;
  sourceFolderExists: boolean;
  destId: string;
  destFolderExists: boolean;
  fieldMappings: FieldMapping[];
  matchingDestinationField: string;
  matchingSourceField: string;
  /** What to do with source records that have no destination match. Default 'create'. */
  unmatchedSourcePolicy: UnmatchedSourcePolicyChoice;
  /** Unmatched destination records whose match-key field is populated. Default 'ignore'. */
  unmatchedWithMatchKey: UnmatchedDestinationPolicyChoice;
  /** Unmatched destination records whose match-key field is empty/null. Default 'ignore'. */
  unmatchedWithoutMatchKey: UnmatchedDestinationPolicyChoice;
}

let mappingIdCounter = 0;
let pairIdCounter = 0;

export function createFieldMapping(overrides: Partial<FieldMapping> = {}): FieldMapping {
  return {
    id: `mapping-${++mappingIdCounter}`,
    destField: '',
    when: 'matched',
    kind: 'column',
    sourceField: '',
    transformers: [],
    constantValue: '',
    ...overrides,
  };
}

export function createFolderPair(overrides: Partial<FolderPair> = {}): FolderPair {
  return {
    id: `pair-${++pairIdCounter}`,
    sourceId: '',
    sourceFolderExists: false,
    destId: '',
    destFolderExists: false,
    fieldMappings: [createFieldMapping()],
    matchingDestinationField: '',
    matchingSourceField: '',
    unmatchedSourcePolicy: 'create',
    unmatchedWithMatchKey: 'ignore',
    unmatchedWithoutMatchKey: 'ignore',
    ...overrides,
  };
}

/** True when the field mapping carries enough to persist as a `ColumnMappingV2`. */
export function isFieldMappingComplete(mapping: FieldMapping): boolean {
  if (!mapping.destField) return false;
  if (mapping.kind === 'column') return !!mapping.sourceField;
  // Constants are valid with any primitive value, including '' / false / 0.
  return true;
}

/** True when a folder pair is complete enough to persist (folders set + at least one rule). */
export function isFolderPairComplete(pair: FolderPair): boolean {
  return !!pair.sourceId && !!pair.destId && pair.fieldMappings.some(isFieldMappingComplete);
}

function fieldMappingToColumnMappingV2(mapping: FieldMapping): ColumnMappingV2 {
  const when = mapping.when;
  const base = when === 'matched' ? {} : { when };
  if (mapping.kind === 'constant') {
    return {
      destinationColumnId: mapping.destField,
      ...base,
      source: { kind: 'constant', value: mapping.constantValue },
    };
  }
  return {
    destinationColumnId: mapping.destField,
    ...base,
    source: {
      kind: 'column',
      columnId: mapping.sourceField,
      ...(mapping.transformers.length > 0 ? { transformers: mapping.transformers } : {}),
    },
  };
}

/** Serialize the editor model to the persisted `SyncMappingV2` shape. */
export function folderPairsToV2(pairs: FolderPair[]): SyncMappingV2 {
  const validPairs = pairs.filter(isFolderPairComplete);
  return {
    version: 2,
    tableMappings: validPairs.map((pair): TableMappingV2 => {
      const columnMappings = pair.fieldMappings.filter(isFieldMappingComplete).map(fieldMappingToColumnMappingV2);

      const hasDestinationPolicy = pair.unmatchedWithMatchKey === 'apply' || pair.unmatchedWithoutMatchKey === 'apply';

      return {
        sourceDataFolderId: pair.sourceId as TableMappingV2['sourceDataFolderId'],
        destinationDataFolderId: pair.destId as TableMappingV2['destinationDataFolderId'],
        columnMappings,
        ...(pair.matchingSourceField && pair.matchingDestinationField
          ? {
              recordMatching: {
                sourceColumnId: pair.matchingSourceField,
                destinationColumnId: pair.matchingDestinationField,
              },
            }
          : {}),
        // Omit policies that match the defaults to keep the persisted JSON clean.
        ...(pair.unmatchedSourcePolicy === 'ignore' ? { unmatchedSourcePolicy: { type: 'ignore' } } : {}),
        ...(hasDestinationPolicy
          ? {
              unmatchedDestinationPolicy: {
                withMatchKey: pair.unmatchedWithMatchKey,
                withoutMatchKey: pair.unmatchedWithoutMatchKey,
              },
            }
          : {}),
      };
    }),
  };
}

function columnMappingV2ToFieldMapping(cm: ColumnMappingV2): FieldMapping {
  const when = cm.when ?? 'matched';
  if (cm.source.kind === 'constant') {
    return createFieldMapping({
      destField: cm.destinationColumnId,
      when,
      kind: 'constant',
      constantValue: cm.source.value,
    });
  }
  return createFieldMapping({
    destField: cm.destinationColumnId,
    when,
    kind: 'column',
    sourceField: cm.source.columnId,
    transformers: cm.source.transformers ?? (cm.source.transformer ? [cm.source.transformer] : []),
  });
}

/** Build the editor model from a persisted `SyncMappingV2`. */
export function v2ToFolderPairs(mapping: SyncMappingV2, allFolders: DataFolder[]): FolderPair[] {
  return mapping.tableMappings.map((tm) => {
    const fieldMappings = tm.columnMappings.map(columnMappingV2ToFieldMapping);
    return createFolderPair({
      sourceId: tm.sourceDataFolderId,
      sourceFolderExists: allFolders.some((f) => f.id === tm.sourceDataFolderId),
      destId: tm.destinationDataFolderId,
      destFolderExists: allFolders.some((f) => f.id === tm.destinationDataFolderId),
      fieldMappings: fieldMappings.length > 0 ? fieldMappings : [createFieldMapping()],
      matchingDestinationField: tm.recordMatching?.destinationColumnId ?? '',
      matchingSourceField: tm.recordMatching?.sourceColumnId ?? '',
      unmatchedSourcePolicy: tm.unmatchedSourcePolicy?.type === 'ignore' ? 'ignore' : 'create',
      unmatchedWithMatchKey: tm.unmatchedDestinationPolicy?.withMatchKey === 'apply' ? 'apply' : 'ignore',
      unmatchedWithoutMatchKey: tm.unmatchedDestinationPolicy?.withoutMatchKey === 'apply' ? 'apply' : 'ignore',
    });
  });
}

/** Normalize any stored shape (v1 or v2) to v2, transforming v1 in memory. */
export function storedMappingToV2(stored: StoredSyncMapping): SyncMappingV2 {
  return stored.version === 2 ? stored : transformV1ToV2(stored);
}

/**
 * Resolve the authoritative mapping for an opened sync. The list/get endpoints return
 * the raw row with both columns; `mappingsV2` (when present) is the source of truth,
 * otherwise the frozen v1 `mappings`. Mirrors the server's `parseStoredMappings`.
 */
export function resolveStoredMapping(sync: {
  mappings?: StoredSyncMapping | null;
  mappingsV2?: SyncMappingV2 | null;
}): StoredSyncMapping | null {
  if (sync.mappingsV2 != null) return sync.mappingsV2;
  if (sync.mappings != null) return sync.mappings;
  return null;
}

/** Structural shape check for an unknown value that claims to be a v1 `SyncMapping`. */
function looksLikeV1(value: Record<string, unknown>): boolean {
  if (value.version !== 1) return false;
  if (!Array.isArray(value.tableMappings)) return false;
  return (value.tableMappings as Record<string, unknown>[]).every((tm) => {
    if (typeof tm.sourceDataFolderId !== 'string') return false;
    if (typeof tm.destinationDataFolderId !== 'string') return false;
    if (!Array.isArray(tm.columnMappings)) return false;
    return (tm.columnMappings as Record<string, unknown>[]).every(
      (cm) => typeof cm.sourceColumnId === 'string' && typeof cm.destinationColumnId === 'string',
    );
  });
}

/** Structural shape check for an unknown value that claims to be a `SyncMappingV2`. */
function looksLikeV2(value: Record<string, unknown>): boolean {
  if (value.version !== 2) return false;
  if (!Array.isArray(value.tableMappings)) return false;
  return (value.tableMappings as Record<string, unknown>[]).every((tm) => {
    if (typeof tm.sourceDataFolderId !== 'string') return false;
    if (typeof tm.destinationDataFolderId !== 'string') return false;
    if (!Array.isArray(tm.columnMappings)) return false;
    return (tm.columnMappings as Record<string, unknown>[]).every((cm) => {
      if (typeof cm.destinationColumnId !== 'string') return false;
      const source = cm.source as Record<string, unknown> | undefined;
      if (!source || typeof source !== 'object') return false;
      if (source.kind === 'column') return typeof source.columnId === 'string';
      if (source.kind === 'constant') return 'value' in source;
      return false;
    });
  });
}

/**
 * Mirror the server-side v2 zod refinements so the editor can reject illegal shapes
 * with a friendly inline message instead of letting save fail with a raw zod error.
 * Returns the first violation message, or null when the mapping is valid. Checks:
 *  (a) a `kind: 'column'` source may only run for the matched bucket;
 *  (b) a `kind: 'constant'` rule may not target the record-matching destination column;
 *  (d) at most one rule per `(destinationColumnId, when)` pair.
 */
export function validateV2Semantics(mapping: SyncMappingV2): string | null {
  for (const tableMapping of mapping.tableMappings) {
    const matchKeyDestinationColumnId = tableMapping.recordMatching?.destinationColumnId;
    const seenColumnWhenPairs = new Set<string>();
    for (const columnMapping of tableMapping.columnMappings) {
      const when = columnMapping.when ?? 'matched';
      if (columnMapping.source.kind === 'column' && when !== 'matched') {
        return `Column “${columnMapping.destinationColumnId}” copies a source column but is set to the “${when}” case. A source-column copy can only run for matched records.`;
      }
      if (
        columnMapping.source.kind === 'constant' &&
        matchKeyDestinationColumnId &&
        columnMapping.destinationColumnId === matchKeyDestinationColumnId
      ) {
        return `Column “${columnMapping.destinationColumnId}” is the record-matching key and cannot be set to a constant value.`;
      }
      const columnWhenKey = `${columnMapping.destinationColumnId}::${when}`;
      if (seenColumnWhenPairs.has(columnWhenKey)) {
        return `Destination column “${columnMapping.destinationColumnId}” has more than one rule for the “${when}” case. Only one rule per column per case is allowed.`;
      }
      seenColumnWhenPairs.add(columnWhenKey);
    }
  }
  return null;
}

export type CoerceToV2Result =
  | { ok: true; mapping: SyncMappingV2; upgradedFromV1: boolean }
  | { ok: false; error: string };

/**
 * Parse and normalize an unknown value (e.g. pasted JSON) to `SyncMappingV2`. Accepts
 * either v1 or v2 shapes; v1 is silently upgraded via `transformV1ToV2` and the caller
 * is told so it can surface the "upgraded to v2" toast. Also runs `validateV2Semantics`
 * so an illegal-but-structurally-valid mapping is rejected here rather than silently
 * entering the visual editor and failing only at save.
 */
export function coerceUnknownToV2(value: unknown): CoerceToV2Result {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'Mapping must be a JSON object.' };
  }
  const record = value as Record<string, unknown>;
  let mapping: SyncMappingV2;
  let upgradedFromV1: boolean;
  if (looksLikeV2(record)) {
    mapping = value as SyncMappingV2;
    upgradedFromV1 = false;
  } else if (looksLikeV1(record)) {
    try {
      mapping = transformV1ToV2(value as Parameters<typeof transformV1ToV2>[0]);
      upgradedFromV1 = true;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to upgrade v1 mapping.' };
    }
  } else {
    return {
      ok: false,
      error:
        'Invalid SyncMapping structure. Expected version 1 or 2 with a tableMappings array; each table mapping needs sourceDataFolderId, destinationDataFolderId, and columnMappings.',
    };
  }
  const semanticError = validateV2Semantics(mapping);
  if (semanticError) {
    return { ok: false, error: semanticError };
  }
  return { ok: true, mapping, upgradedFromV1 };
}

/** A destination-column group of rules for the stacked render layout. */
export interface DestColumnGroup {
  /** The shared destination column id ('' for incomplete rows still being authored). */
  destField: string;
  /** Rules in render order, carrying their original index into `fieldMappings`. */
  rules: { mapping: FieldMapping; index: number }[];
}

/** True when `when` puts a rule in the matched section (matched / always). */
export function isMatchedBucket(when: ColumnMappingWhen): boolean {
  return when !== 'unmatched';
}

/**
 * Group field mappings by destination column for the stacked render. Incomplete rows
 * (no destField yet) each get their own group so they render as standalone authoring
 * rows. Within a non-empty group, matched/always rules sort before unmatched rules,
 * each preserving its original relative order.
 */
export function groupByDestColumn(fieldMappings: FieldMapping[]): DestColumnGroup[] {
  const groups: DestColumnGroup[] = [];
  const indexByDest = new Map<string, number>();

  fieldMappings.forEach((mapping, index) => {
    if (!mapping.destField) {
      groups.push({ destField: '', rules: [{ mapping, index }] });
      return;
    }
    let groupIndex = indexByDest.get(mapping.destField);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      indexByDest.set(mapping.destField, groupIndex);
      groups.push({ destField: mapping.destField, rules: [] });
    }
    groups[groupIndex].rules.push({ mapping, index });
  });

  for (const group of groups) {
    if (group.destField) {
      group.rules.sort((a, b) => {
        const aMatched = isMatchedBucket(a.mapping.when) ? 0 : 1;
        const bMatched = isMatchedBucket(b.mapping.when) ? 0 : 1;
        return aMatched - bMatched;
      });
    }
  }

  return groups;
}

/**
 * A "simple" group renders as a plain flat source→dest row (today's look): exactly one
 * rule, in the matched bucket, copying a column. Everything else (constants, unmatched
 * rules, multiple rules for one dest) renders as a stacked group block.
 */
export function isSimpleGroup(group: DestColumnGroup): boolean {
  if (group.rules.length !== 1) return false;
  const { mapping } = group.rules[0];
  return !!mapping.destField && mapping.kind === 'column' && isMatchedBucket(mapping.when);
}

/**
 * Find rules that collide on `(destinationColumnId, when)` — the persisted invariant is
 * one rule per pair. Returns the set of colliding field-mapping ids so the render layer
 * can flag them inline (the server enforces this too, via zod refinement).
 */
export function findConflictingMappingIds(fieldMappings: FieldMapping[]): Set<string> {
  const seen = new Map<string, FieldMapping[]>();
  for (const mapping of fieldMappings) {
    if (!isFieldMappingComplete(mapping)) continue;
    const key = `${mapping.destField}::${mapping.when}`;
    const bucket = seen.get(key);
    if (bucket) bucket.push(mapping);
    else seen.set(key, [mapping]);
  }
  const conflicting = new Set<string>();
  for (const bucket of seen.values()) {
    if (bucket.length > 1) bucket.forEach((m) => conflicting.add(m.id));
  }
  return conflicting;
}

/** Default constant value for a destination column of the given schema type. */
export function constantDefaultForType(type: string | undefined): ConstantValue {
  switch (type) {
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    default:
      return '';
  }
}
