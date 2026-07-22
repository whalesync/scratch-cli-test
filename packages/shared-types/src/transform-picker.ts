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

/**
 * The connector-neutral CORE value — the lingua franca a value is copied *through* during a
 * sync (and the single value a grid cell renders). Standardized so that N connectors need 2N
 * codecs (a `toCore`/`fromCore` pair each), not N².
 *
 * Elements are ALWAYS `string`: numbers base-10, dates ISO-8601, booleans `"true"`/`"false"`.
 * A `number`/`boolean` element would be float64 and silently corrupt ids, ZIPs, phone numbers,
 * and precise decimals in transit (the Connector Prime Directive forbids this) — and the type
 * needed to write a destination already lives in its schema, so it need not ride the value too.
 * Only the *container* varies, by the field's cardinality (`allowsMultipleValues`):
 *   - `null`     — no value / cleared (always a legal write);
 *   - `string`   — a single-valued (scalar) field;
 *   - `string[]` — a multi-valued field (multi_select, people, files, …).
 */
export type CoreValue = null | string | string[];

/**
 * One candidate way to copy a value between two columns — a complete transformer chain plus
 * (future) the metadata to present it to a user when more than one option exists.
 */
export type TransformOption = {
  /** The ordered transformer pipeline: source `toCore` → cardinality reshape → dest `fromCore`/floor. */
  transformerChain: TransformerConfig[];
  // Future expansion when returning multiple transformation options for the user to pick between:
  // displayName: string;
  // isDefault?: boolean;
};

/**
 * The result of asking the suggestion service how to copy a value from one column to another.
 * `valid` always carries at least one `TransformOption` (the never-fail coercion floor keeps
 * every value pair valid); `invalid` (with a human-readable `reason`) is reserved for a
 * STRUCTURAL mismatch that has no meaningful chain — e.g. a reference (FK) column paired with a
 * non-reference column, or mismatched reference targets. Lossiness is a per-option concern, not
 * incompatibility; a genuinely bad value skips-with-issue at run-time, not at pick-time.
 */
export type TransformSuggestion =
  | { result: 'valid'; options: [TransformOption, ...TransformOption[]] }
  | { result: 'invalid'; reason: string };

/** Whether a column holds a single value (`null | string`) or many (`string[]`). */
export type ColumnCardinality = 'single' | 'multi';

/**
 * A column resolved to everything the pure picker needs to compose a transform for it — the output
 * of the (server-side, View-keyed) resolver and the input to {@link getSuggestedTransform}.
 * Deliberately connector-agnostic and dependency-free so a future in-UI sync builder can build it
 * from two existing columns and call the picker unchanged.
 */
export interface ColumnTransformInput {
  /** Single (scalar) vs multi (array) arm of the CoreValue. Drives the cardinality reshape. */
  cardinality: ColumnCardinality;
  /**
   * Semantic field kind used for the type-aware multi→single collapse (join vs first): text-like
   * kinds (`'string'`, `'richtext'`, `'url'`) join comma-separated; strict kinds (`'single_select'`,
   * `'number'`, `'date'`, `'checkbox'`, …) take the first element.
   */
  logicalType?: string;
  /**
   * JSON-schema primitive type (`'string' | 'number' | 'integer' | 'boolean' | 'array'`) used for the
   * coercion floor's `auto_convert` target when the destination declares no `fromCore` pack.
   */
  primitiveType?: string;
  /**
   * Resolved extract codec (native → CoreValue); consumed when this column is the sync SOURCE. The
   * server-side resolver may source this from the View `ColumnCodec` (client-safe) OR a schema
   * `suggestedTransformer` hint (full union), so this is the broad `TransformerConfig`.
   */
  toCore?: TransformerConfig;
  /** Resolved pack codec (CoreValue → native); consumed when this column is the sync DESTINATION. */
  fromCore?: TransformerConfig;
}

const AUTO_CONVERTIBLE_TARGET_TYPES: ReadonlySet<string> = new Set<AutoConvertOptions['targetType']>([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
]);

/**
 * JSON-schema primitive types whose value is NON-SCALAR — a nested object or a JSON array. A source
 * column of one of these does not hold a valid {@link CoreValue} (which is always a `string`, base-10
 * numbers/dates/booleans as strings; see the CoreValue doc above), so its raw value can't be handed
 * straight to a destination `fromCore` pack that assumes a CoreValue string.
 */
const NON_SCALAR_SOURCE_PRIMITIVE_TYPES: ReadonlySet<string> = new Set(['object', 'array']);

/**
 * Whether a source field's declared type (from {@link FieldTransformHints.type}) gives NO guarantee
 * that the runtime value entering a destination pack is a string: the type is absent, the schema says
 * `'unknown'` (an un-modeled connector field, `Type.Unknown()`), or it is a nested `object`. A declared
 * `array` deliberately does NOT count — an array source's natural pairing is an array-consuming pack.
 */
function sourceValueMayReachPackAsNonString(sourceType: string | undefined): boolean {
  return sourceType === undefined || sourceType === 'unknown' || sourceType === 'object';
}

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
  if (sourceField?.suggestedTransformer) {
    transformers.push(sourceField.suggestedTransformer);
  } else if (destinationField?.suggestedInTransformer && sourceValueMayReachPackAsNonString(sourceField?.type)) {
    // Same hole as getSuggestedTransform's pre-pack stringify (see below): a destination pack
    // consumes a CoreValue STRING, but with no source unpack hint nothing normalizes the raw
    // value. A source whose declared type is `object`, or whose type is UNKNOWN (absent /
    // `'unknown'` — an un-modeled connector field like Webflow's e-commerce `sku-properties`,
    // or a drilled path with no flattened field), can hand the pack a raw object that the
    // service then rejects (DEV-10828 / DEV-10875: objects landing in Notion rich_text's
    // string-only `content` slot). JSON-stringify first — identity for strings, total for
    // everything else. Known scalars (number/boolean) still reach a native pack un-stringified,
    // and a declared `array` source is left alone (its natural pairing is an array-consuming
    // pack, e.g. a multi_select `map_array`).
    transformers.push({ type: TransformerTypes.AutoConvert, options: { targetType: 'string' } });
  }
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

/**
 * Destination logical kinds treated as FREE TEXT: a multi→single collapse joins into them
 * (comma-separated, keeping every value). Everything else is "strict" (single-select, number, date,
 * checkbox, …), where a compound string would be rejected — so we take the first element. An unknown
 * destination kind is treated as text-like (join is non-destructive).
 */
const TEXT_LIKE_DESTINATION_LOGICAL_TYPES: ReadonlySet<string> = new Set(['string', 'richtext', 'url']);

/** The middle stage: the transformers that reshape the cardinality, plus the JSON primitive that
 *  reshape guarantees on its output (so the coercion floor can skip a redundant re-coercion). */
interface CardinalityReshape {
  transformers: TransformerConfig[];
  /** The primitive the reshape guarantees, if any: `join_comma` yields `'string'`, `wrap` yields `'array'`,
   *  `first` yields an element of unknown type (undefined). */
  outputPrimitive?: 'string' | 'array';
}

/**
 * The connector-agnostic "magic middle": the transformer(s) that reshape a value from the SOURCE
 * column's cardinality arm to the DESTINATION column's. Because CoreValue elements are always strings,
 * this only reshapes the CONTAINER — it never type-coerces. Chosen purely from the two cardinalities
 * (+ the destination's logical type for the collapse policy); connectors never declare it.
 */
function selectCardinalityReshape(
  sourceCardinality: ColumnCardinality,
  destinationCardinality: ColumnCardinality,
  destinationLogicalType: string | undefined,
): CardinalityReshape {
  // single→single and multi→multi: identity — no reshape.
  if (sourceCardinality === destinationCardinality) return { transformers: [] };

  if (sourceCardinality === 'multi' && destinationCardinality === 'single') {
    // Collapse string[] → string. Type-aware default: comma-join into text-like (or unknown) targets —
    // keeps every value — vs take-first into strict targets that would reject a compound string.
    const joinAllValues =
      destinationLogicalType === undefined || TEXT_LIKE_DESTINATION_LOGICAL_TYPES.has(destinationLogicalType);
    if (joinAllValues) {
      // `auto_convert(string)` joins string elements with `", "` AND degrades an un-extracted object
      // array (a raw multi_select before a codec extracts its names) to JSON rather than FAILING the way
      // jsonpath `join_comma` would — so an un-enhanced column keeps landing exactly as today, and only a
      // column whose `toCore` already yields clean strings gets the tidy join. Total either way.
      return {
        transformers: [{ type: TransformerTypes.AutoConvert, options: { targetType: 'string' } }],
        outputPrimitive: 'string',
      };
    }
    // take-first: the element's type is unknown, so a strict target still needs the floor to type it.
    return {
      transformers: [{ type: TransformerTypes.JSONPath, options: { expression: '$[*]', arrayHandling: 'first' } }],
    };
  }

  // single→multi: wrap the scalar into a one-element array (`"x"` → `["x"]`, `null` → `[]`). Lossless.
  return {
    transformers: [{ type: TransformerTypes.AutoConvert, options: { targetType: 'array' } }],
    outputPrimitive: 'array',
  };
}

/**
 * The never-fail coercion floor for the destination: when the destination declares no `fromCore` pack,
 * append a generic `auto_convert` to its primitive type so the pipeline is TOTAL BY CONSTRUCTION
 * (a non-scalar going into a text column serializes rather than failing save-time validation). Skipped
 * when the destination primitive is unknown / non-coercible (a structured native destination relies on
 * its own pack), when the cardinality reshape already guaranteed that primitive, or when the pair is
 * already the same shape and same type (no coercion needed).
 */
function coercionFloorForDestination(
  source: ColumnTransformInput,
  destination: ColumnTransformInput,
  reshapeOutputPrimitive: CardinalityReshape['outputPrimitive'],
): TransformerConfig | undefined {
  const targetType = destination.primitiveType;
  if (!targetType || !AUTO_CONVERTIBLE_TARGET_TYPES.has(targetType)) return undefined;
  if (reshapeOutputPrimitive === targetType) return undefined; // the middle already produced this shape
  const isSameShapeSameType =
    source.toCore === undefined &&
    source.cardinality === destination.cardinality &&
    source.primitiveType !== undefined &&
    source.primitiveType === targetType;
  if (isSameShapeSameType) return undefined;
  return {
    type: TransformerTypes.AutoConvert,
    options: { targetType: targetType as AutoConvertOptions['targetType'] },
  };
}

/**
 * The pure, connector-agnostic VALUE picker: given a source and destination column (already resolved by
 * the View-keyed adapter into {@link ColumnTransformInput}), compose the transformer chain that copies a
 * value between them —
 *
 *   [ source.toCore?                    // native → CoreValue (source arm), dest-agnostic
 *     cardinality reshape?              // the magic middle: source arm → dest arm
 *     dest.fromCore | coercion floor ]  // CoreValue → native (dest arm), source-agnostic
 *
 * Each stage may be empty (identity — e.g. a same-shape scalar copy yields an empty chain). The floor
 * keeps the chain TOTAL, so a value pair is always `{ result: 'valid' }`. `'invalid'` is reserved for
 * STRUCTURAL mismatches (reference/asset), which the exhaustive server orchestrator classifies BEFORE
 * reaching this value path and never routes here.
 *
 * Pure and dependency-free — no server deps, no cross-record lookups — so the web/desktop sync builder
 * imports it unchanged. Reference (FK) and asset columns are resolved in their own phases, not here.
 */
export function getSuggestedTransform(
  source: ColumnTransformInput,
  destination: ColumnTransformInput,
): TransformSuggestion {
  const transformerChain: TransformerConfig[] = [];

  // 1. Source half: native → CoreValue (dest-agnostic).
  if (source.toCore) {
    transformerChain.push(source.toCore);
  } else if (
    destination.fromCore &&
    source.cardinality === 'single' &&
    (source.primitiveType === undefined || NON_SCALAR_SOURCE_PRIMITIVE_TYPES.has(source.primitiveType))
  ) {
    // A scalar-cardinality source whose raw value is a nested object / JSON array is NOT a valid
    // CoreValue (which must be a string), and with no `toCore` codec nothing normalizes it. A
    // destination `fromCore` pack assumes it receives a CoreValue and substitutes the value straight
    // into its native envelope — e.g. Notion's `rich_text` pack drops it into a string-only `content`
    // slot via `wrap_object` — so the raw object reaches the connector's write API and is rejected
    // (DEV-10828: Shopify's `featuredImage` / `category` objects mapped to a Notion rich_text column).
    // JSON-stringify it into a CoreValue string first. This mirrors the coercion floor's own
    // object→string degrade on the pack-LESS path (see `coercionFloorForDestination` and
    // auto-convert's `convertToString`), extending it to the pack path the floor skips. Gated on
    // `destination.fromCore` so the pack-less path keeps flooring exactly as before (no double
    // coercion).
    //
    // An UNKNOWN-typed source (`primitiveType` absent — the connector schema declares no type, e.g.
    // Webflow's un-modeled e-commerce fields `sku-properties`/`sku-values`, typed `Type.Unknown()`
    // until DEV-10937 models them) is stringified too: nothing guarantees its runtime value is a
    // CoreValue string, and an object/array slipping through the pack un-stringified is a guaranteed
    // connector rejection (DEV-10875's Notion `validation_error` cascade). `auto_convert('string')`
    // is identity for strings and total for everything else, so the chain stays correct for every
    // runtime shape. The one trade-off: an unknown-typed source that happens to hold a number now
    // reaches a native number/checkbox pack as "5" instead of 5 — that pairing only arises from a
    // schema-blind manual mapping, and the durable fix there is typing the source schema. KNOWN
    // scalar sources (number/boolean) still reach a native pack un-stringified.
    transformerChain.push({ type: TransformerTypes.AutoConvert, options: { targetType: 'string' } });
  }

  // 2. Middle: reshape the source cardinality arm to the destination's (the only stage that knows both).
  const reshape = selectCardinalityReshape(source.cardinality, destination.cardinality, destination.logicalType);
  transformerChain.push(...reshape.transformers);

  // 3. Destination half: CoreValue → native (source-agnostic). Explicit pack, else the coercion floor.
  if (destination.fromCore) {
    transformerChain.push(destination.fromCore);
  } else {
    // The JSON primitive the chain is known to produce before any floor: the reshape's guarantee, else —
    // when a `toCore` ran — the arm implied by the destination cardinality (single→string, multi→array).
    // This lets the floor no-op when the value already matches the target (rich_text→text is just [toCore]).
    const guaranteedPrimitive =
      reshape.outputPrimitive ??
      (source.toCore ? (destination.cardinality === 'multi' ? 'array' : 'string') : undefined);
    const floor = coercionFloorForDestination(source, destination, guaranteedPrimitive);
    if (floor) transformerChain.push(floor);
  }

  return { result: 'valid', options: [{ transformerChain }] };
}
