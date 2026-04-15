import { TRANSFORMER_TYPES, TransformerMetadata, TransformerType } from '@spinner/shared-types';
import { FieldTransformer } from './transformer.types';

/**
 * Registry of available field transformers.
 * New transformers should be added here after implementation.
 */
const transformerRegistry: Map<TransformerType, FieldTransformer> = new Map();

/**
 * Registers a transformer in the registry.
 */
export function registerTransformer(transformer: FieldTransformer): void {
  transformerRegistry.set(transformer.type, transformer);
}

/**
 * Gets a transformer by type.
 * @param type - The transformer type
 * @returns The transformer, or undefined if not found
 */
export function getTransformer(type: TransformerType): FieldTransformer | undefined {
  return transformerRegistry.get(type);
}

/**
 * Checks if a transformer type is registered.
 */
export function hasTransformer(type: TransformerType): boolean {
  return transformerRegistry.has(type);
}

/**
 * Gets all registered transformer types.
 */
export function getRegisteredTransformerTypes(): TransformerType[] {
  return Array.from(transformerRegistry.keys());
}

/**
 * Returns metadata for all registered transformers, suitable for serving to the client.
 * Includes UI field descriptors and computed default options.
 */
export function getAllTransformerMetadata(): TransformerMetadata[] {
  return TRANSFORMER_TYPES.map((info) => {
    const transformer = transformerRegistry.get(info.type);
    const fields = transformer?.optionsSchema ?? [];

    const defaultOptions: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.defaultValue !== undefined) {
        defaultOptions[field.key] = field.defaultValue;
      }
    }

    return {
      type: info.type,
      label: info.label,
      devOnly: info.devOnly,
      fields,
      defaultOptions,
    };
  });
}
