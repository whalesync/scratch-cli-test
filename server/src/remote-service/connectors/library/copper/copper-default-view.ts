import { Kind, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_READONLY,
  type TablePropertyType,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import {
  copperCustomFieldColumnPath,
  isReadonlyCopperCustomField,
  tablePropertyTypeForCopperCustomFieldDataType,
} from './copper-custom-fields';
import { CopperCustomFieldDefinition } from './copper-types';

/**
 * Default view for a Copper entity.
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
 * A system column's `readonly` is read off the built schema's `x-scratch-readonly`
 * flag; a custom-field column's `readonly` comes from its definition (computed /
 * `Connect` fields), so the grid blocks edits that publish would drop anyway.
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

  // Custom fields, grouped under a banner. Each column addresses its verbatim
  // array element by definition id; readonly comes from the definition.
  const customFieldCols: TableViewCol[] = customFieldDefinitions.map((definition) => ({
    kind: 'col',
    path: copperCustomFieldColumnPath(definition.id),
    name: definition.name,
    type: tablePropertyTypeForCopperCustomFieldDataType(definition.data_type),
    readonly: isReadonlyCopperCustomField(definition) || undefined,
  }));
  if (customFieldCols.length > 0) {
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
