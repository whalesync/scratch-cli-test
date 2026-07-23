import { Service, TransformerConfig } from '@spinner/shared-types';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { applyTransformerPipeline, createNullLookupTools, SyncRecord } from 'src/sync/transformers';
import { readFieldValueAtPath } from 'src/utils/field-path';
import { extractSchemaFields } from 'src/utils/schema-helpers';

/**
 * Everything needed to reduce one side's match field to a canonical primitive.
 *
 * The field being reduced is always placed in the transformer pipeline's SOURCE
 * position, because the connector-declared extraction (unpack) transformers read
 * the source slot of the transform context (e.g. `webflow_option_id_to_value`
 * resolves against `sourceTableSpec`/`sourceFieldPath`).
 */
export interface MatchFieldReductionContext {
  record: SyncRecord;
  fieldPath: string;
  tableSpec: BaseJsonTableSpec | null;
  /** Required only to apply an extraction transformer; primitives reduce without it. */
  service?: Service;
}

/** The only value shapes that can serve as a match key after trimming. */
function isNonEmptyMatchPrimitive(value: unknown): value is string | number {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim() !== '';
}

/**
 * Resolves the connector-declared extraction (unpack) transformer for a field —
 * the `x-scratch-suggested-transformer` hint that turns the field's native value
 * INTO a plain primitive (e.g. a Notion `rich_text` array → a plain string).
 *
 * Returns undefined when the field already stores a plain value (declares no
 * hint). Reuses `extractSchemaFields` so virtual fields (e.g. Notion `title`) and
 * nullable unions resolve identically to the sync editor.
 */
export function getFieldUnpackTransformer(
  tableSpec: BaseJsonTableSpec | null,
  columnId: string,
): TransformerConfig | undefined {
  if (!tableSpec?.schema) {
    return undefined;
  }
  return extractSchemaFields(tableSpec.schema).find((field) => field.path === columnId)?.suggestedTransformer;
}

/**
 * Reduces a record's match-field value to its canonical match key string, or
 * null when the field can't serve as a match key for this record.
 *
 * Direction-independent: it uses the field's OWN connector-declared extraction
 * transformer, never the sync's copy transformers. The rule mirrors
 * `getMatchFieldCompatibility` in shared-types:
 *   1. primitive (string/number) → use directly,
 *   2. non-primitive + extraction transformer → unpack, then require a primitive,
 *   3. otherwise → null (unmatchable).
 *
 * Applied identically to the source and destination sides so that, e.g., a plain
 * Postgres string and a Notion `rich_text` envelope wrapping the same string both
 * reduce to the same key — making record matching work in both sync directions.
 *
 * Pass `suggestedUnpackTransformer` from `getFieldUnpackTransformer` once per
 * field (it is per-field, not per-record) and reuse it across the record batch.
 */
export async function deriveCanonicalMatchKey(
  field: MatchFieldReductionContext,
  suggestedUnpackTransformer: TransformerConfig | undefined,
): Promise<string | null> {
  const rawValue = readFieldValueAtPath(field.record.fields, field.fieldPath);

  if (isNonEmptyMatchPrimitive(rawValue)) {
    return String(rawValue).trim();
  }

  if (
    rawValue === undefined ||
    rawValue === null ||
    suggestedUnpackTransformer === undefined ||
    field.service === undefined
  ) {
    return null;
  }

  const result = await applyTransformerPipeline([suggestedUnpackTransformer], rawValue, {
    sourceRecord: field.record,
    sourceFieldPath: field.fieldPath,
    sourceTableSpec: field.tableSpec,
    sourceService: field.service,
    destinationFieldPath: field.fieldPath,
    destinationTableSpec: field.tableSpec,
    destinationService: field.service,
    lookupTools: createNullLookupTools(),
    phase: 'DATA',
  });

  if (result.success && isNonEmptyMatchPrimitive(result.value)) {
    return String(result.value).trim();
  }

  return null;
}
