import { AutoConvertOptions, TransformerConfig, TransformerTypes } from './sync-mapping';

/**
 * The connector-declared transform hints a field carries in its JSON schema,
 * surfaced onto a flattened schema field. These drive automatic transformer
 * selection when a value is copied from one field to another in a sync.
 *
 * The model is a plain/normalized value as the lingua franca between connectors:
 *   - `suggestedTransformer` (the `x-scratch-suggested-transformer` hint) unpacks
 *     the field's native value INTO that plain value, and applies when the field
 *     is the sync SOURCE (e.g. a Notion `rich_text` array → a plain string).
 *   - `suggestedInTransformer` (the `x-scratch-suggested-in-transformer` hint)
 *     packs a plain value INTO the field's native shape, and applies when the
 *     field is the sync DESTINATION (e.g. a plain string → a Notion `rich_text`
 *     envelope).
 */
export interface FieldTransformHints {
  /** JSON-schema primitive type of the field's value (`string`, `number`, `object`, …). */
  type?: string;
  /** Unpack transform applied when this field is a sync source. */
  suggestedTransformer?: TransformerConfig;
  /** Pack transform applied when this field is a sync destination. */
  suggestedInTransformer?: TransformerConfig;
}

const AUTO_CONVERTIBLE_TARGET_TYPES: ReadonlySet<string> = new Set<AutoConvertOptions['targetType']>([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
]);

/**
 * Pick the transformer pipeline to copy a value from `sourceField` to
 * `destinationField`, from the connector-declared schema hints on each:
 *
 *   transformers = [ source.suggestedTransformer?  (native → plain),
 *                    destination.suggestedInTransformer?  (plain → native) ]
 *
 * Either hint may be absent — a connector that stores the value verbatim (a plain
 * scalar, like an Airtable text field) declares neither, so a same-shaped
 * source→destination pair needs no transform. When NEITHER field declares a hint
 * but their primitive types differ, falls back to a generic `auto_convert` to the
 * destination type (number↔string, etc.) — the long-standing editor behavior.
 *
 * Pure and connector-agnostic: it reads only the generic hints, so it is shared by
 * the web sync editor (mapping existing fields), the server's create-schema plan
 * (mapping a source field to a field about to be created), and any future
 * sync-building flow. A new connector lights up across all of them just by
 * declaring its hints.
 */
export function pickMappingTransformers(
  sourceField: FieldTransformHints | undefined,
  destinationField: FieldTransformHints | undefined,
): TransformerConfig[] {
  const transformers: TransformerConfig[] = [];
  if (sourceField?.suggestedTransformer) transformers.push(sourceField.suggestedTransformer);
  if (destinationField?.suggestedInTransformer) transformers.push(destinationField.suggestedInTransformer);
  if (transformers.length > 0) return transformers;

  // No connector hints on either side: fall back to a generic primitive coercion
  // when (and only when) the two primitive types actually differ.
  if (!sourceField?.type || !destinationField?.type) return [];
  if (sourceField.type === destinationField.type) return [];
  if (!AUTO_CONVERTIBLE_TARGET_TYPES.has(destinationField.type)) return [];
  return [
    {
      type: TransformerTypes.AutoConvert,
      options: { targetType: destinationField.type as AutoConvertOptions['targetType'] },
    },
  ];
}
