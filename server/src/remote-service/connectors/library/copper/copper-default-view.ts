import { Kind, type TSchema } from '@sinclair/typebox';
import {
  buildKeyedArrayColumnPath,
  getArrayKeyedByOptions,
  X_SCRATCH_READONLY,
  type TablePropertyType,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';
import { CUSTOM_FIELDS_KEY } from './copper-custom-fields';

/**
 * Default view for a Copper entity — a PURE function of the table spec.
 *
 * Copper's `custom_fields` array is stored verbatim; each element is exposed as
 * an editable column via the `x-scratch-array-keyed-by` annotation (see
 * `copper-custom-fields.ts`), addressed by the filtered path
 * `custom_fields.[custom_field_definition_id=<id>].value`. This view lays the
 * grid out around that: the entity's **system fields render flat** (record id
 * first), and the user's **custom fields gather under a "Custom Fields" banner
 * group** — a real, pre-existing Copper concept (the set of fields the user
 * defined in Settings → Custom Fields), not an invented theme, so it satisfies
 * the banner-group contract.
 *
 * A system column's `readonly` is read off the schema's `x-scratch-readonly`
 * flag; a custom-field column's `{key,name,type,readonly}` is read back off the
 * `custom_fields` array's `x-scratch-array-keyed-by` annotation (which the
 * schema stage populated from the very same custom-field definitions), so the
 * view needs no raw API input.
 */
export function buildCopperDefaultView(spec: BaseJsonTableSpec): TableView {
  const schemaProperties = (spec.schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  // System fields, flat and in schema order (custom fields are handled below).
  for (const key of Object.keys(schemaProperties)) {
    if (key === CUSTOM_FIELDS_KEY) continue;
    const propertySchema = schemaProperties[key] as Record<string, unknown>;
    cols.push({
      kind: 'col',
      path: key,
      name: titleCaseSnakeCase(key),
      type: tablePropertyTypeForSchema(schemaProperties[key]),
      readonly: propertySchema[X_SCRATCH_READONLY] === true,
    });
  }

  // Custom fields, grouped under a banner. The `x-scratch-array-keyed-by`
  // annotation on `custom_fields` already carries one {key,name,type,readonly}
  // column per definition, in definition order — the same data the schema stage
  // derived from the API's custom-field definitions.
  const customFieldsKeyedBy = getArrayKeyedByOptions(schemaProperties[CUSTOM_FIELDS_KEY]);
  if (customFieldsKeyedBy && customFieldsKeyedBy.columns.length > 0) {
    const customFieldCols: TableViewCol[] = customFieldsKeyedBy.columns.map((column) => ({
      kind: 'col',
      path: buildKeyedArrayColumnPath(
        CUSTOM_FIELDS_KEY,
        customFieldsKeyedBy.keyField,
        column.key,
        customFieldsKeyedBy.valuePath,
      ),
      name: column.name,
      type: (column.type ?? 'string') as TablePropertyType,
      readonly: column.readonly,
    }));
    cols.push({ kind: 'banner-group', name: 'Custom Fields', cols: customFieldCols });
  }

  return { name: 'Default', cols };
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
