import { ColumnMapping, TransformerConfig, TransformerType } from '@spinner/shared-types';
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

export interface PipelineBaseContext {
  sourceRecord: SyncRecord;
  sourceFieldPath: string;
  lookupTools: LookupTools;
  destinationValue?: unknown;
  phase: SyncPhase;
}

export type PipelineResult =
  | { success: true; value?: unknown; skip?: boolean }
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
      lookupTools: baseCtx.lookupTools,
      destinationValue: baseCtx.destinationValue,
      options: (config.options ?? {}) as TransformContext['options'],
      phase: baseCtx.phase,
    };

    const result = await transformer.transform(ctx);

    if (!result.success) {
      return { ...result, failedTransformerType: config.type };
    }

    if (result.skip) {
      return result;
    }

    currentValue = result.value;
  }

  return { success: true, value: currentValue };
}
