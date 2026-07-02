/**
 * Affinity stores each record's field values as a verbatim array:
 *
 *   fields: [{ id, name, type, enrichmentSource, value: { type, data } }, …]
 *
 * We store that array **exactly as Affinity returns it** (the Connector Prime
 * Directive — no array→keyed-object reshape on disk). To still expose each field
 * as its own editable, individually-diffable column, the `fields` array property
 * is annotated with `x-scratch-array-keyed-by` (see
 * {@link buildAffinityFieldsArrayKeyedByOptions}): the generic column engine,
 * path read/write engine, and publish diff address each element by its stable
 * `id` — the filter path `fields.[id=field-1234]`.
 *
 * Unlike Copper (whose editable value is the element's `.value`), for Affinity
 * the **whole element is the editable value**, so the annotation carries **no
 * `valuePath`** — the column path stops at the filter segment. The per-field
 * `value.data` / `value.type` / `type` / `enrichmentSource` are surfaced as
 * subfields relative to that element in the default view.
 *
 * The field `id` is the key field because it is **rename-stable** (Affinity's
 * field ids like `field-1234` / `affinity-data-location` are stable slugs),
 * **collision-free**, and path-safe.
 *
 * This module holds the field metadata shared by the schema builder
 * ({@link ./affinity-json-schema}), the default view
 * ({@link ./affinity-default-view}), and the write-translation layer
 * ({@link ./affinity-write-translation}); keeping it here avoids an import cycle
 * between those files.
 */
import {
  ArrayKeyedByOptions,
  ArrayKeyedColumn,
  buildKeyedArrayColumnPath,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
  type TablePropertyType,
} from '@spinner/shared-types';
import { AffinityFieldMetadata, AffinityValueType } from './affinity-types';

/** The property that holds a record's field values on every Affinity record (top-level or under `entity`). */
export const FIELDS_KEY = 'fields';

/** The element field whose value identifies each field within the array (its stable id). */
export const FIELD_KEY_FIELD = 'id';

/**
 * Connector-local annotation, mounted on the verbatim `fields` array property,
 * carrying a per-field-id map `{ [fieldId]: { x-scratch-connector-data-type,
 * x-scratch-readonly? } }`. It preserves the per-field `valueType` + read-only
 * bit that used to live on each field's own object schema (before the array was
 * reshaped to a keyed object) — the write-translation layer needs the exact
 * Affinity `valueType` to narrow a stored value into the write payload, and the
 * default view needs it to detect location fields. It is server-only connector
 * metadata; the frontends ignore it (they read the generic
 * `x-scratch-array-keyed-by` columns instead).
 */
export const X_SCRATCH_AFFINITY_FIELDS_BY_ID = 'x-scratch-affinity-fields-by-id';

/**
 * Field-category types that are computed by Affinity and can never be written:
 * `enriched` (Affinity Data / Dealroom / Crunchbase enrichment) and
 * `relationship-intelligence` (derived from email/calendar activity).
 * Only `list` and `global` category fields accept value updates.
 */
export const READ_ONLY_AFFINITY_FIELD_CATEGORIES: ReadonlySet<string> = new Set([
  'enriched',
  'relationship-intelligence',
]);

/**
 * Value types with no entry in the v2 `FieldValueUpdate` union — they cannot
 * be written even when the field's category is writable.
 */
export const READ_ONLY_AFFINITY_VALUE_TYPES: ReadonlySet<string> = new Set(['interaction', 'formula-number']);

/**
 * Decide whether a field is writable from its metadata annotations.
 * Used at schema-build time (to label the keyed-array column read-only) and at
 * publish time (to refuse rather than silently drop an unwritable edit).
 */
export function isReadOnlyAffinityField(fieldCategory: string | undefined, valueType: string | undefined): boolean {
  if (fieldCategory !== undefined && READ_ONLY_AFFINITY_FIELD_CATEGORIES.has(fieldCategory)) return true;
  if (valueType !== undefined && READ_ONLY_AFFINITY_VALUE_TYPES.has(valueType)) return true;
  return false;
}

/** Map an Affinity field `valueType` to a table-view column type hint. */
const AFFINITY_VALUE_TYPE_TO_TABLE_PROPERTY_TYPE: Partial<Record<string, TablePropertyType>> = {
  text: 'string',
  'filterable-text': 'string',
  number: 'number',
  'formula-number': 'number',
  datetime: 'date',
};

/** Map an Affinity field `valueType` to a `TablePropertyType` (structured/unknown types fall back to `object`). */
export function tablePropertyTypeForAffinityValueType(valueType: string | undefined): TablePropertyType {
  if (!valueType) return 'object';
  return AFFINITY_VALUE_TYPE_TO_TABLE_PROPERTY_TYPE[valueType] ?? 'object';
}

/** The editable column path for one field (`fields.[id=field-1234]`). The whole element is the value — no `valuePath`. */
export function affinityFieldColumnPath(fieldId: string): string {
  return buildKeyedArrayColumnPath(FIELDS_KEY, FIELD_KEY_FIELD, fieldId);
}

/**
 * Build the `x-scratch-array-keyed-by` options for the `fields` array: one
 * expandable column per discovered field definition. Carries **no `valuePath`**
 * — the whole element is the editable value, so the column path is
 * `fields.[id=<id>]`.
 */
export function buildAffinityFieldsArrayKeyedByOptions(definitions: AffinityFieldMetadata[]): ArrayKeyedByOptions {
  const columns: ArrayKeyedColumn[] = definitions.map((definition) => ({
    key: definition.id,
    name: definition.name,
    type: tablePropertyTypeForAffinityValueType(definition.valueType),
    readonly: isReadOnlyAffinityField(definition.type, definition.valueType) || undefined,
  }));
  return { keyField: FIELD_KEY_FIELD, columns };
}

/**
 * Build the per-field-id metadata map mounted under
 * {@link X_SCRATCH_AFFINITY_FIELDS_BY_ID}: each field id → the minimal annotated
 * schema the write-translation layer reads (its `valueType` and read-only bit).
 * This reconstructs exactly the annotations that used to sit on each field's own
 * object schema, so downstream code that reads `x-scratch-connector-data-type` /
 * `x-scratch-readonly` off a per-field schema keeps working unchanged.
 */
export function buildAffinityFieldSchemasById(
  definitions: AffinityFieldMetadata[],
): Record<string, Record<string, unknown>> {
  const fieldSchemasById: Record<string, Record<string, unknown>> = {};
  for (const definition of definitions) {
    const fieldSchema: Record<string, unknown> = { [X_SCRATCH_CONNECTOR_DATA_TYPE]: definition.valueType };
    if (isReadOnlyAffinityField(definition.type, definition.valueType)) {
      fieldSchema[X_SCRATCH_READONLY] = true;
    }
    fieldSchemasById[definition.id] = fieldSchema;
  }
  return fieldSchemasById;
}

/**
 * Read the {@link X_SCRATCH_AFFINITY_FIELDS_BY_ID} map off a `fields` array
 * property schema, or `undefined` if absent. Looks on the property directly and
 * inside its `anyOf`/`oneOf` members (the nullable/optional pattern keeps the
 * annotation on the array member).
 */
export function getAffinityFieldSchemasById(
  fieldsPropertySchema: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (typeof fieldsPropertySchema !== 'object' || fieldsPropertySchema === null) return undefined;
  const propertyRecord = fieldsPropertySchema as Record<string, unknown>;
  const direct = propertyRecord[X_SCRATCH_AFFINITY_FIELDS_BY_ID];
  if (typeof direct === 'object' && direct !== null) {
    return direct as Record<string, Record<string, unknown>>;
  }
  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const union = propertyRecord[unionKey];
    if (!Array.isArray(union)) continue;
    for (const member of union) {
      const found = getAffinityFieldSchemasById(member);
      if (found) return found;
    }
  }
  return undefined;
}

/** The Affinity field valueType recorded for one field id, or `undefined` if the field isn't in the map. */
export function affinityFieldValueTypeFromSchemasById(
  fieldSchemasById: Record<string, Record<string, unknown>> | undefined,
  fieldId: string,
): AffinityValueType | undefined {
  return fieldSchemasById?.[fieldId]?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as AffinityValueType | undefined;
}
