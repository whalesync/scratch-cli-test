/**
 * Copper stores a record's custom-field values as a verbatim array:
 *
 *   custom_fields: [{ custom_field_definition_id: number, value: unknown }, …]
 *
 * We store that array **exactly as Copper returns it** (the product's "store the
 * verbatim API response" invariant). To still expose each custom field as its
 * own editable, individually-diffable column, the `custom_fields` array property
 * is annotated with `x-scratch-array-keyed-by` (see
 * {@link buildCopperCustomFieldsArrayKeyedByOptions}): the generic column engine,
 * path read/write engine, and publish diff address each element by its stable
 * `custom_field_definition_id` — no array→object reshape on disk.
 *
 * The definition id is the key field because it is **rename-stable** (Copper
 * exposes no stable field slug, so a name-derived key would churn on every
 * rename), **collision-free** (ids are unique), and numeric/path-safe.
 *
 * This module holds the custom-field metadata shared by the schema builder
 * ({@link ../copper-json-schema}) and the default view
 * ({@link ../copper-default-view}); keeping it here avoids an import cycle
 * between those two.
 */
import {
  ArrayKeyedByOptions,
  ArrayKeyedColumn,
  buildKeyedArrayColumnPath,
  type TablePropertyType,
} from '@spinner/shared-types';
import { CopperCustomFieldDefinition } from './copper-types';

/** The top-level field that holds custom-field values on every Copper record. */
export const CUSTOM_FIELDS_KEY = 'custom_fields';

/** The element field whose value identifies each custom field within the array. */
export const CUSTOM_FIELD_KEY_FIELD = 'custom_field_definition_id';

/** The element sub-path that holds the editable value. */
export const CUSTOM_FIELD_VALUE_PATH = 'value';

/** Copper custom-field data types that Copper computes / won't accept on write. */
export function isReadonlyCopperCustomField(definition: CopperCustomFieldDefinition): boolean {
  return definition.is_computed === true || definition.data_type === 'Connect';
}

/** Map a Copper custom-field `data_type` to a table-view column type hint. */
export function tablePropertyTypeForCopperCustomFieldDataType(dataType: string): TablePropertyType {
  switch (dataType) {
    case 'Checkbox':
      return 'checkbox';
    case 'Float':
    case 'Currency':
    case 'Percentage':
      return 'number';
    case 'URL':
      return 'url';
    case 'MultiSelect':
      return 'object';
    // String / Text / Dropdown / Date / Connect render as strings (Date and
    // Dropdown values are an epoch / option-id stored verbatim — see Pass 2).
    default:
      return 'string';
  }
}

/** The editable column path for one custom field (`custom_fields.[custom_field_definition_id=700123].value`). */
export function copperCustomFieldColumnPath(definitionId: number): string {
  return buildKeyedArrayColumnPath(CUSTOM_FIELDS_KEY, CUSTOM_FIELD_KEY_FIELD, definitionId, CUSTOM_FIELD_VALUE_PATH);
}

/**
 * Build the `x-scratch-array-keyed-by` options for the `custom_fields` array:
 * one expandable column per discovered custom-field definition.
 */
export function buildCopperCustomFieldsArrayKeyedByOptions(
  definitions: CopperCustomFieldDefinition[],
): ArrayKeyedByOptions {
  const columns: ArrayKeyedColumn[] = definitions.map((definition) => ({
    key: definition.id,
    name: definition.name,
    type: tablePropertyTypeForCopperCustomFieldDataType(definition.data_type),
    readonly: isReadonlyCopperCustomField(definition) || undefined,
  }));
  return { keyField: CUSTOM_FIELD_KEY_FIELD, valuePath: CUSTOM_FIELD_VALUE_PATH, columns };
}
