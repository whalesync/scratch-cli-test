import { type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_CUSTOM_FIELD,
  X_SCRATCH_READONLY,
  type TablePropertyType,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';

/**
 * Default view for a Zoho CRM module — a PURE function of the spec.
 *
 * Zoho stores every field as a top-level keyed property (one column per field),
 * so this is pure view-layer grouping — no record reshape. Fields split on
 * Zoho's own standard-vs-custom distinction (surfaced in its field manager and
 * recorded on the schema as `x-scratch-custom-field`): built-in **standard**
 * fields render flat (the record id first, then standard fields in module
 * order), and the user's **custom** fields gather under a "Custom Fields" banner
 * group. That grouping is structural, not an invented theme — so it satisfies
 * the banner-group contract.
 *
 * Every column's name (`description`), type (`x-scratch-connector-data-type`,
 * `"zoho/<data_type>"`), read-only flag (`x-scratch-readonly`), and standard/
 * custom bucket (`x-scratch-custom-field`) are read straight off the schema, so
 * the view never touches raw API field metadata.
 */
export function buildZohoDefaultView(spec: BaseJsonTableSpec): TableView {
  const schemaProperties = (spec.schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  // The implicit record id (added to the schema separately, first).
  if (schemaProperties.id) {
    cols.push({ kind: 'col', path: 'id', name: 'Record ID', type: 'string', readonly: true });
  }

  const customFieldCols: TableViewCol[] = [];
  for (const [apiName, rawPropertySchema] of Object.entries(schemaProperties)) {
    if (apiName === 'id') continue;
    const propertySchema = rawPropertySchema as Record<string, unknown>;
    const rawConnectorDataType = propertySchema[X_SCRATCH_CONNECTOR_DATA_TYPE];
    const connectorDataType = typeof rawConnectorDataType === 'string' ? rawConnectorDataType : '';
    const dataType = connectorDataType.startsWith('zoho/')
      ? connectorDataType.slice('zoho/'.length)
      : connectorDataType;

    const col: TableViewCol = {
      kind: 'col',
      path: apiName,
      name: typeof propertySchema.description === 'string' ? propertySchema.description : apiName,
      type: tablePropertyTypeForZohoField(dataType),
      // Derive read-only from the schema flag, not a recomputation — keeps the
      // view and schema in lock-step (server timestamps, formulas, ids, …).
      readonly: propertySchema[X_SCRATCH_READONLY] === true,
    };

    (propertySchema[X_SCRATCH_CUSTOM_FIELD] === true ? customFieldCols : cols).push(col);
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
