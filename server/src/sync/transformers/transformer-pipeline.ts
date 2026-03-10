import { ColumnMapping, TransformerConfig, TransformerType, TransformerTypes } from '@spinner/shared-types';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { getTransformer } from './transformer-registry';
import { LookupTools, SyncPhase, SyncRecord, TransformContext } from './transformer.types';

/**
 * Normalizes a ColumnMapping's transformer config(s) into a single array.
 * Returns `transformers` if set, `[transformer]` if set, or `[]`.
 */
export function getTransformerConfigs(mapping: ColumnMapping): TransformerConfig[] {
  if (mapping.transformers) {
    return mapping.transformers;
  }
  if (mapping.transformer) {
    return [mapping.transformer];
  }
  return [];
}

/**
 * Returns all TransformerConfig entries matching a given type from either
 * `transformer` or `transformers`.
 */
export function findTransformerConfigs(mapping: ColumnMapping, type: TransformerType): TransformerConfig[] {
  return getTransformerConfigs(mapping).filter((c) => c.type === type);
}

/**
 * Determines which sync phase a column mapping belongs to based on its transformer configs.
 * Mappings with a SourceFkToDestFk transformer run in FOREIGN_KEY_MAPPING phase; all others in DATA.
 */
export function getColumnMappingPhase(mapping: ColumnMapping): SyncPhase {
  const configs = getTransformerConfigs(mapping);
  return configs.some((c) => c.type === TransformerTypes.SourceFkToDestFk) ? 'FOREIGN_KEY_MAPPING' : 'DATA';
}

export interface PipelineBaseContext {
  sourceRecord: SyncRecord;
  sourceFieldPath: string;
  sourceTableSpec: BaseJsonTableSpec | null;
  destinationFieldPath: string;
  destinationTableSpec: BaseJsonTableSpec | null;
  lookupTools: LookupTools;
  destinationValue?: unknown;
  phase: SyncPhase;
}

export type PipelineResult =
  | { success: true; value?: unknown; skip?: boolean; warnings?: string[] }
  | { success: false; error: string; useOriginal?: boolean; failedTransformerType?: TransformerType };

/**
 * Applies a sequence of transformers to an initial value.
 * Each step feeds its output value as the next step's sourceValue.
 *
 * Short-circuits on `skip: true` or a failure result.
 * Returns `{ success: true, value: <final> }` when all steps succeed.
 */
export async function applyTransformerPipeline(
  configs: TransformerConfig[],
  initialValue: unknown,
  baseCtx: PipelineBaseContext,
): Promise<PipelineResult> {
  let currentValue: unknown = initialValue;
  const accumulatedWarnings: string[] = [];

  for (const config of configs) {
    const transformer = getTransformer(config.type);
    if (!transformer) {
      return {
        success: false,
        error: `Unknown transformer type: ${config.type}`,
        failedTransformerType: config.type,
      };
    }

    const ctx: TransformContext = {
      sourceRecord: baseCtx.sourceRecord,
      sourceFieldPath: baseCtx.sourceFieldPath,
      sourceValue: currentValue,
      sourceTableSpec: baseCtx.sourceTableSpec,
      destinationFieldPath: baseCtx.destinationFieldPath,
      destinationTableSpec: baseCtx.destinationTableSpec,
      lookupTools: baseCtx.lookupTools,
      destinationValue: baseCtx.destinationValue,
      options: (config.options ?? {}) as TransformContext['options'],
      phase: baseCtx.phase,
    };

    const result = await transformer.transform(ctx);

    if (!result.success) {
      return { ...result, failedTransformerType: config.type };
    }

    if (result.warnings) {
      accumulatedWarnings.push(...result.warnings);
    }

    if (result.skip) {
      return accumulatedWarnings.length > 0 ? { ...result, warnings: accumulatedWarnings } : result;
    }

    currentValue = result.value;
  }

  return accumulatedWarnings.length > 0
    ? { success: true, value: currentValue, warnings: accumulatedWarnings }
    : { success: true, value: currentValue };
}
