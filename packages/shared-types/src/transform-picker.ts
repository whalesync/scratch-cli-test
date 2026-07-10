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
 * source→destination pair needs no transform. Otherwise it appends a generic
 * `auto_convert` to the destination type, making the derived pipeline TOTAL BY
 * CONSTRUCTION: a value of any shape can always be written into a coercible
 * destination column (a non-scalar into a text column serializes) rather than being
 * left as an un-bridged mismatch that fails save-time type validation or the connector
 * write. The coercion is the safe DEFAULT; a connector hint or user override enriches
 * the value on top of it. This fires even when the source type is unknown (a drilled /
 * computed path), because the destination column — not the source — is the invariant.
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

  // No connector hints on either side. Append a generic coercion to the destination
  // type so the derived pipeline is TOTAL BY CONSTRUCTION: the raw source value can
  // always be written into the destination column instead of being left as an
  // un-bridged mismatch that fails save-time type validation or the connector write.
  //
  // Crucially this fires even when the SOURCE type is UNKNOWN — a computed or drilled
  // path the flattener doesn't surface as its own field (e.g. a Notion property's inner
  // value `properties.X.multi_select`, whose unpack hint lives on the envelope). The
  // destination column is the invariant, and `auto_convert` to a scalar target is total:
  // a non-scalar going into a text column serializes rather than erroring (see
  // auto-convert.transformer.ts's convertToString). This coercion is the SAFE DEFAULT; a
  // connector unpack/pack hint (handled above) or a user override enriches the value on
  // top of it — but nothing is ever left unbridged.
  //
  // Skipped only when the destination type is unknown or has no generic coercion (a
  // structured/native destination — object, date, select, link — relies on its own pack
  // hint), or when the source is already known to be the same shape (no coercion needed).
  if (!destinationField?.type) return [];
  if (!AUTO_CONVERTIBLE_TARGET_TYPES.has(destinationField.type)) return [];
  if (sourceField?.type !== undefined && sourceField.type === destinationField.type) return [];
  return [
    {
      type: TransformerTypes.AutoConvert,
      options: { targetType: destinationField.type as AutoConvertOptions['targetType'] },
    },
  ];
}
