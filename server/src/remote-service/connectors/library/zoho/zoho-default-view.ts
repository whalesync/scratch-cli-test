import { type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_READONLY,
  type TablePropertyType,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import { ZohoFieldMetadata } from './zoho-types';

/**
 * Default view for a Zoho CRM module.
 *
 * Zoho stores every field as a top-level keyed property (one column per field),
 * so this is pure view-layer grouping — no record reshape. Fields split on
 * Zoho's own `custom_field` flag: built-in **standard** fields render flat (the
 * record id first, then standard fields in module order), and the user's
 * **custom** fields gather under a "Custom Fields" banner group. That grouping
 * is structural (Zoho's own standard-vs-custom distinction, surfaced in its
 * field manager), not an invented theme — so it satisfies the banner-group
 * contract.
 *
 * Each column's `readonly` is read straight off the built schema's
 * `x-scratch-readonly` flag (the single source of truth set by
 * `isReadonlyZohoField`), so the grid blocks edits to server-computed / audit
 * fields that publish would drop anyway.
 */
export function buildZohoDefaultView(
  fields: ZohoFieldMetadata[],
  schemaProperties: Record<string, TSchema>,
): TableView {
  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  // The implicit record id (added to the schema separately, not in `fields`).
  if (schemaProperties.id) {
    cols.push({ kind: 'col', path: 'id', name: 'Record ID', type: 'string', readonly: true });
  }

  const customFieldCols: TableViewCol[] = [];
  for (const field of fields) {
    if (field.api_name === 'id') continue;
    // Only surface fields that actually made it into the schema (a field whose
    // data_type the schema builder skipped would have no column path to point at).
    const propertySchema = schemaProperties[field.api_name] as Record<string, unknown> | undefined;
    if (!propertySchema) continue;

    const col: TableViewCol = {
      kind: 'col',
      path: field.api_name,
      name: field.field_label ?? field.api_name,
      type: tablePropertyTypeForZohoField(field.data_type),
      // Derive read-only from the schema flag, not a recomputation — keeps the
      // view and schema in lock-step (server timestamps, formulas, ids, …).
      readonly: propertySchema[X_SCRATCH_READONLY] === true,
    };

    (field.custom_field === true ? customFieldCols : cols).push(col);
  }

  if (customFieldCols.length > 0) {
    cols.push({ kind: 'banner-group', name: 'Custom Fields', cols: customFieldCols });
  }

  return { name: 'Default', cols };
}

/** Map a Zoho `data_type` to a table-view column type hint (display formatting only). */
function tablePropertyTypeForZohoField(dataType: string): TablePropertyType {
  switch (dataType) {
    case 'boolean':
      return 'checkbox';
    case 'integer':
    case 'bigint':
    case 'double':
    case 'currency':
    case 'percent':
    case 'rollup_summary':
    case 'aggregation':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'website':
      return 'url';
    // Lookups, multiselects, subforms and other structured values render as objects.
    case 'lookup':
    case 'ownerlookup':
    case 'userlookup':
    case 'multiselectpicklist':
    case 'multiselectlookup':
    case 'multi_module_lookup':
    case 'multimodulelookup':
    case 'subform':
    case 'subformfield':
      return 'object';
    default:
      return 'string';
  }
}
