import { Kind, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_READONLY,
  type TablePropertyType,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import { customFieldColumnKey } from './copper-custom-fields';
import { CopperCustomFieldDefinition } from './copper-types';

/**
 * Default view for a Copper entity.
 *
 * The connector reshapes Copper's verbatim `custom_fields` array into a keyed
 * object (`{ cf_<id>: value }`) so each custom field becomes an editable column
 * (see `copper-custom-fields.ts`). This view lays the grid out around that:
 * the entity's **system fields render flat** (record id first), and the user's
 * **custom fields gather under a "Custom Fields" banner group** — a real,
 * pre-existing Copper concept (the set of fields the user defined in Settings →
 * Custom Fields), not an invented theme, so it satisfies the banner-group
 * contract.
 *
 * Each column's `readonly` is read straight off the built schema's
 * `x-scratch-readonly` flag (the single source of truth — system timestamps /
 * ids, and computed / `Connect` custom fields), so the grid blocks edits that
 * publish would drop anyway.
 */
export function buildCopperDefaultView(
  schemaProperties: Record<string, TSchema>,
  customFieldDefinitions: CopperCustomFieldDefinition[],
): TableView {
  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  // System fields, flat and in schema order (custom fields are handled below).
  for (const key of Object.keys(schemaProperties)) {
    if (key === 'custom_fields') continue;
    const propertySchema = schemaProperties[key] as Record<string, unknown>;
    cols.push({
      kind: 'col',
      path: key,
      name: titleCaseSnakeCase(key),
      type: tablePropertyTypeForSchema(schemaProperties[key]),
      readonly: propertySchema[X_SCRATCH_READONLY] === true,
    });
  }

  // Custom fields, grouped under a banner. Each column points at the reshaped
  // keyed-object sub-property; readonly comes from that sub-property's schema.
  const customFieldSubSchemas = customFieldsSubSchemas(schemaProperties.custom_fields);
  const customFieldCols: TableViewCol[] = [];
  for (const definition of customFieldDefinitions) {
    const columnKey = customFieldColumnKey(definition.id);
    const subSchema = customFieldSubSchemas[columnKey] as Record<string, unknown> | undefined;
    customFieldCols.push({
      kind: 'col',
      path: `custom_fields.${columnKey}`,
      name: definition.name,
      type: tablePropertyTypeForCopperCustomFieldDataType(definition.data_type),
      readonly: subSchema?.[X_SCRATCH_READONLY] === true,
    });
  }
  if (customFieldCols.length > 0) {
    cols.push({ kind: 'banner-group', name: 'Custom Fields', cols: customFieldCols });
  }

  return { name: 'Default', cols };
}

/** The `properties` map of the reshaped `custom_fields` keyed-object schema (or `{}`). */
function customFieldsSubSchemas(customFieldsSchema: TSchema | undefined): Record<string, TSchema> {
  return (customFieldsSchema as (TSchema & { properties?: Record<string, TSchema> }) | undefined)?.properties ?? {};
}

/** Map a Copper custom-field `data_type` to a table-view column type hint. */
function tablePropertyTypeForCopperCustomFieldDataType(dataType: string): TablePropertyType {
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

/** Map a built TypeBox schema (usually `Union([X, Null])`) to a column type hint. */
function tablePropertyTypeForSchema(schema: TSchema | undefined): TablePropertyType {
  const inner = unwrapNonNull(schema);
  if (!inner) return 'string';
  const format = (inner as TSchema & { format?: string }).format;
  if (format === 'uri') return 'url';
  if (format === 'date' || format === 'date-time') return 'date';
  switch (inner[Kind]) {
    case 'Boolean':
      return 'checkbox';
    case 'Number':
    case 'Integer':
      return 'number';
    case 'Array':
    case 'Object':
      return 'object';
    default:
      return 'string';
  }
}

/** Unwrap a `Union([X, Null])` (or plain schema) to the first non-null member. */
function unwrapNonNull(schema: TSchema | undefined): TSchema | undefined {
  if (!schema) return undefined;
  const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) return anyOf.find((member) => member[Kind] !== 'Null') ?? schema;
  return schema;
}

/** `first_name` → `First Name` (Copper system field keys are snake_case). */
function titleCaseSnakeCase(key: string): string {
  return key
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
