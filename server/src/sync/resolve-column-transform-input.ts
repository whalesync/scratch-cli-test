import type { TSchema } from '@sinclair/typebox';
import {
  type ColumnCardinality,
  type ColumnTransformInput,
  type TableView,
  type TableViewCol,
  type TransformerConfig,
  TransformerTypes,
} from '@spinner/shared-types';
import { resolveSchemaTypeAtPath, type SchemaField } from 'src/utils/schema-helpers';

/**
 * Resolve a column — identified by the drilled / subfield path a sync mapping references — into the
 * connector-agnostic {@link ColumnTransformInput} the pure picker (`getSuggestedTransform`) consumes.
 *
 * This is the piece that dissolves the Notion inner-path mole: the codec/type are read at the SAME path
 * the mapping references (a drilled column at `properties.X.multi_select`, or a subfield leaf
 * `properties.X.select.name`), resolving View-FIRST and walking UP to the envelope schema field only for a
 * fallback hint — instead of an exact lookup in the envelope-only flattening that misses the drilled path.
 *
 * Resolution order:
 *   toCore   : the view node's `codec.toCore` → derived from its `displayTransformer` (a jsonpath extract,
 *              reused verbatim) → the nearest-ancestor schema `suggestedTransformer` → undefined.
 *   fromCore : the view node's `codec.fromCore` → the nearest-ancestor schema `suggestedInTransformer` → undefined.
 *   cardinality : from the resolved `toCore` (a jsonpath `arrayHandling: 'array'` means multi; a reducing
 *              handler — concat/join/first — means single), else `'single'`. We DON'T read it from the raw
 *              JSON shape because many single-valued fields are natively arrays (`rich_text`, `title`); a
 *              proper semantic `allowsMultipleValues` signal is a follow-up. Defaulting to single keeps the
 *              cardinality reshape OFF until a connector declares an `'array'` codec, so an un-enhanced
 *              column copies/floors exactly as today.
 *   logicalType/primitiveType : the view node's `type` (semantic) / the JSON type at the drilled path.
 */
export function resolveColumnTransformInput(args: {
  columnId: string;
  schema: TSchema;
  fieldsByPath: Map<string, SchemaField>;
  view: TableView | null;
}): ColumnTransformInput {
  const { columnId, schema, fieldsByPath, view } = args;

  const viewNode = view ? findViewNodeAtPath(view, columnId) : undefined;
  const ancestorField = findSchemaFieldOrAncestor(columnId, fieldsByPath);

  const toCore =
    viewNode?.codec?.toCore ??
    displayTransformerAsToCore(viewNode?.displayTransformer) ??
    ancestorField?.suggestedTransformer;
  const fromCore = viewNode?.codec?.fromCore ?? ancestorField?.suggestedInTransformer;
  // The pack's declared input primitive rides with the schema hint, not the view codec — so it applies
  // only when `fromCore` came from the ancestor field's `suggestedInTransformer` (a native pack), not a
  // view-supplied codec.
  const fromCoreInputType =
    viewNode?.codec?.fromCore === undefined ? ancestorField?.suggestedInTransformerInputType : undefined;

  const jsonType = resolveSchemaTypeAtPath(schema, columnId);
  const logicalType = viewNode?.logicalType ?? ancestorField?.type;

  return {
    // A declared `toCore` states its own output cardinality (a fancy Notion field extracting one string is
    // SINGLE even though its native shape is an array); only a raw field with no codec falls back to the
    // native JSON shape — honest for connectors that store values in their natural shape.
    cardinality: toCore ? transformerOutputCardinality(toCore) : nativeCardinality(jsonType),
    ...(jsonType !== 'unknown' ? { primitiveType: jsonType } : {}),
    ...(logicalType !== undefined ? { logicalType } : {}),
    ...(toCore ? { toCore } : {}),
    ...(fromCore ? { fromCore } : {}),
    ...(fromCoreInputType ? { fromCoreInputType } : {}),
  };
}

/**
 * Build a {@link ColumnTransformInput} directly from a flattened schema field — used for a DESTINATION
 * column, matched by name to a just-created field, where only the field's own type + pack hint are
 * available (no drilled path / view). `fromCore` comes from the field's `suggestedInTransformer`.
 * Cardinality is what the `fromCore` pack CONSUMES (else the field's native JSON shape) — so a raw
 * Airtable options field (`string[]`, no pack) is multi and a raw text field is single.
 */
export function columnTransformInputFromSchemaField(field: SchemaField | undefined): ColumnTransformInput {
  const jsonType = field?.type;
  const fromCore = field?.suggestedInTransformer;
  const fromCoreInputType = field?.suggestedInTransformerInputType;
  return {
    cardinality: fromCore ? transformerInputCardinality(fromCore) : nativeCardinality(jsonType),
    ...(jsonType && jsonType !== 'unknown' ? { primitiveType: jsonType, logicalType: jsonType } : {}),
    ...(fromCore ? { fromCore } : {}),
    ...(fromCoreInputType ? { fromCoreInputType } : {}),
  };
}

/** The transform-relevant bits of the view node (a column, or a selected subfield leaf) at a path. */
interface ViewNodeAtPath {
  codec?: TableViewCol['codec'];
  displayTransformer?: TableViewCol['displayTransformer'];
  logicalType?: string;
}

/** Find the view node (column OR a subfield leaf `col.path + '.' + relativePath`) sitting at `path`. */
function findViewNodeAtPath(view: TableView, path: string): ViewNodeAtPath | undefined {
  const columns: TableViewCol[] = [];
  for (const entry of view.cols) {
    if (entry.kind === 'banner-group') columns.push(...entry.cols);
    else columns.push(entry);
  }
  for (const col of columns) {
    if (col.path === path) {
      return { codec: col.codec, displayTransformer: col.displayTransformer, logicalType: col.type };
    }
    for (const subfield of col.subfields ?? []) {
      if (`${col.path}.${subfield.relativePath}` === path) {
        return { codec: subfield.codec, logicalType: subfield.type };
      }
    }
  }
  return undefined;
}

/** The schema field at `path`, or the nearest ANCESTOR field (the envelope) that carries hints/type. */
function findSchemaFieldOrAncestor(path: string, fieldsByPath: Map<string, SchemaField>): SchemaField | undefined {
  const exact = fieldsByPath.get(path);
  if (exact) return exact;
  let candidate = path;
  while (candidate.includes('.')) {
    candidate = candidate.slice(0, candidate.lastIndexOf('.'));
    const ancestor = fieldsByPath.get(candidate);
    if (ancestor) return ancestor;
  }
  return undefined;
}

/**
 * Reuse a column's DISPLAY transformer as its `toCore` extract when it's a jsonpath one — the same
 * expression and array-handling that render the grid cell also produce the sync's source value. Mirrors
 * `foreignKeyIdExtractionTransformer`. Undefined for a non-jsonpath (e.g. computed-field) display transformer.
 */
function displayTransformerAsToCore(
  displayTransformer: TableViewCol['displayTransformer'],
): TransformerConfig | undefined {
  if (displayTransformer?.type !== 'jsonpath') return undefined;
  return {
    type: TransformerTypes.JSONPath,
    options: {
      expression: displayTransformer.options.expression,
      ...(displayTransformer.options.arrayHandling ? { arrayHandling: displayTransformer.options.arrayHandling } : {}),
    },
  };
}

/** Cardinality read straight off the native JSON shape — used only when no transformer declares it. A
 *  connector that stores values in their natural shape (Airtable: text = `string`, options = `string[]`)
 *  is honest here; the misleading "native array but single" fields (Notion `rich_text`) always declare a
 *  transformer, so they never reach this fallback. */
export function nativeCardinality(jsonType: string | undefined): ColumnCardinality {
  return jsonType === 'array' ? 'multi' : 'single';
}

/** The cardinality a `toCore` extract EMITS: a jsonpath keeping the list (`arrayHandling: 'array'`), an
 *  `auto_convert` to `array`, or an element-wise `array`/`map` transformer is multi; everything else emits
 *  a single value (a jsonpath concat/join/first, `wrap_object`, `notion_to_html`, `slugify`, …). */
export function transformerOutputCardinality(toCore: TransformerConfig): ColumnCardinality {
  switch (toCore.type) {
    case TransformerTypes.JSONPath:
      return toCore.options.arrayHandling === 'array' ? 'multi' : 'single';
    case TransformerTypes.NotionFileUrl:
      // Options default to `arrayHandling: 'array'` (multiple file URLs); only 'first' collapses to one.
      return toCore.options?.arrayHandling === 'first' ? 'single' : 'multi';
    case TransformerTypes.AutoConvert:
      return toCore.options.targetType === 'array' ? 'multi' : 'single';
    case TransformerTypes.ArrayAutoConvert:
    case TransformerTypes.MapArray:
      return 'multi';
    default:
      return 'single';
  }
}

/** The cardinality a `fromCore` pack CONSUMES: `map_array` folds an array; every other pack takes a single
 *  value (`wrap_object` wraps one value into a native envelope, `html_to_airmark` takes one string, …). */
function transformerInputCardinality(fromCore: TransformerConfig): ColumnCardinality {
  return fromCore.type === TransformerTypes.MapArray ? 'multi' : 'single';
}
