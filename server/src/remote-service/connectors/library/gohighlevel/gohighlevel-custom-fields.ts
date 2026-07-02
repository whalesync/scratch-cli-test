/**
 * GoHighLevel returns a record's custom-field values as a verbatim array under
 * `customFields`, one element per field:
 *
 *   customFields: [{ id: '<definitionId>', value: unknown }, …]        // Contacts
 *   customFields: [{ id: '<definitionId>', fieldValue: unknown }, …]   // Opportunities
 *
 * We store that array **exactly as the API returns it** (the Connector Prime
 * Directive — the on-disk record must match the API response). To still expose
 * each custom field as its own editable, individually-diffable column, the
 * `customFields` array property is annotated with `x-scratch-array-keyed-by`
 * (see {@link buildGoHighLevelCustomFieldsArrayKeyedByOptions}): the generic
 * column engine, path read/write engine, and publish diff address each element
 * by its stable `id` — no array→object reshape on disk. Mirrors the Copper
 * migration (DEV-10637).
 *
 * The element `id` (the custom-field definition id) is the key field because it
 * is **rename-stable** (a name/fieldKey-derived key would churn and can collide)
 * and **collision-free**.
 *
 * GHL's read shape is asymmetric: Contacts carry the value under `value`,
 * Opportunities under `fieldValue`. The write shape uses `field_value` for both,
 * so publish translates the verbatim element into the API's write shape at the
 * connector boundary (write translation is allowed to reshape; only the on-disk
 * record must be verbatim).
 *
 * This module holds the metadata shared by the schema builder
 * ({@link ../gohighlevel-json-schema}) and the connector's write path.
 */
import {
  ArrayKeyedByOptions,
  ArrayKeyedColumn,
  buildKeyedArrayColumnPath,
  type TablePropertyType,
} from '@spinner/shared-types';
import { GoHighLevelCustomFieldDefinition } from './gohighlevel-types';

/** The top-level array holding custom-field values on a GHL record (the verbatim API key). */
export const CUSTOM_FIELDS_KEY = 'customFields';

/** The element field that identifies each custom field within the array (the definition id). */
export const CUSTOM_FIELD_KEY_FIELD = 'id';

/**
 * The element sub-path that holds the editable value. GHL's read shape is
 * asymmetric — Contacts use `value`, Opportunities use `fieldValue`.
 */
export type GoHighLevelCustomFieldValueKey = 'value' | 'fieldValue';

/** The API write value key used for both entities (`customFields: [{ id, field_value }]`). */
export const CUSTOM_FIELD_WRITE_VALUE_KEY = 'field_value';

/** Map a GoHighLevel custom-field `dataType` to a table-view column type hint. */
export function tablePropertyTypeForGoHighLevelDataType(dataType: string | undefined): TablePropertyType {
  switch ((dataType ?? '').toUpperCase()) {
    case 'NUMERICAL':
    case 'FLOAT':
    case 'MONETORY':
      return 'number';
    case 'DATE':
      return 'date';
    case 'CHECKBOX':
    case 'MULTIPLE_OPTIONS':
      return 'object';
    default:
      return 'string';
  }
}

/** The editable column path for one custom field (`customFields.[id=<id>].value`). */
export function goHighLevelCustomFieldColumnPath(id: string, valueKey: GoHighLevelCustomFieldValueKey): string {
  return buildKeyedArrayColumnPath(CUSTOM_FIELDS_KEY, CUSTOM_FIELD_KEY_FIELD, id, valueKey);
}

/**
 * Build the `x-scratch-array-keyed-by` options for the `customFields` array: one
 * expandable column per discovered definition, keyed by the element `id`.
 * `valueKey` is the per-entity value sub-path (`value` for Contacts, `fieldValue`
 * for Opportunities). GHL exposes no read-only signal on a definition, so columns
 * carry no `readonly`.
 */
export function buildGoHighLevelCustomFieldsArrayKeyedByOptions(
  definitions: GoHighLevelCustomFieldDefinition[],
  valueKey: GoHighLevelCustomFieldValueKey,
): ArrayKeyedByOptions {
  const columns: ArrayKeyedColumn[] = definitions.map((definition) => ({
    key: definition.id,
    name: definition.name ?? definition.id,
    type: tablePropertyTypeForGoHighLevelDataType(definition.dataType),
  }));
  return { keyField: CUSTOM_FIELD_KEY_FIELD, valuePath: valueKey, columns };
}
