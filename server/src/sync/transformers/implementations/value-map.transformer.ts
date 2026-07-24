import { Type } from '@sinclair/typebox';
import { TransformerTypes, ValueMapOptions } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Replaces a scalar value with its entry in a static dictionary, keyed by the
 * value's STRING form (`String(value)`, so the number `33` is looked up as `"33"`).
 *
 * Built for select-style fields whose stored value is an option id and whose
 * human-readable label lives only in service metadata (e.g. a Pipedrive enum
 * custom field storing `33` for the option labelled "Opt, B"): the connector
 * bakes the id → label dictionary into the config at view-build time, so the
 * mapping stays as fresh as the schema it was derived from. Wrap in `map_array`
 * to map a multi-select's id array element-wise.
 *
 * Pure (value → value) and client-safe — keep the semantics byte-for-byte in
 * step with `applyValueMap` in
 * `packages/shared-types/src/transform/apply-client-safe-transformer.ts`.
 */
export const valueMapTransformer: FieldTransformer = {
  type: TransformerTypes.ValueMap,

  optionsSchema: [],

  paramType: () => Type.Any(),
  returnType: () => Type.String(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { mapping, onUnmapped = 'passthrough' } = options as ValueMapOptions;

    if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
      return { success: true, value: null };
    }

    if (typeof sourceValue !== 'string' && typeof sourceValue !== 'number' && typeof sourceValue !== 'boolean') {
      return {
        success: false,
        error: 'value_map requires a scalar source value; wrap it in map_array for arrays',
        useOriginal: true,
      };
    }

    const mappingKey = String(sourceValue);
    const mappedValue = mapping[mappingKey];
    if (mappedValue !== undefined) {
      return { success: true, value: mappedValue };
    }
    return { success: true, value: onUnmapped === 'null' ? null : mappingKey };
  },
};

// Auto-register on import
registerTransformer(valueMapTransformer);
