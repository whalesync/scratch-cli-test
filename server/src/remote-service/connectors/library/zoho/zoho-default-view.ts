import { type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_CUSTOM_FIELD,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
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

    // A single Zoho lookup (lookup/ownerlookup/userlookup) is stored verbatim as a
    // `{ id, name, … }` object carrying an `x-scratch-foreign-key` annotation. Point
    // the column at the id inside it so the shared FK id-extraction — which reuses
    // the column's `displayTransformer` jsonpath to pull the id ARRAY that feeds
    // `source_fk_to_dest_fk` — resolves `$.id` instead of returning null and leaking
    // the raw object into the sync transform, which aborts the whole run (DEV-11096).
    // Purely a view/display change: the on-disk `{id,name}` object is untouched.
    const linkedTableId = foreignKeyLinkedTableId(propertySchema);
    if (linkedTableId) {
      // Zoho single lookups reference at most one record, so mark the FK single-valued.
      col.foreignKey = { linkedTableId, isSingleValued: true };
      col.displayTransformer = { type: 'jsonpath', options: { expression: '$.id', arrayHandling: 'array' } };
    }

    (propertySchema[X_SCRATCH_CUSTOM_FIELD] === true ? customFieldCols : cols).push(col);
  }

  if (customFieldCols.length > 0) {
    cols.push({ kind: 'banner-group', name: 'Custom Fields', cols: customFieldCols });
  }

  return { name: 'Default', cols };
}

/**
 * Read the foreign-key target table id off a schema property's `x-scratch-foreign-key`
 * annotation, if present. Only single-lookup fields (lookup/ownerlookup/userlookup)
 * carry it — the connector attaches it in `zoho-json-schema.ts`; multi-valued and
 * polymorphic references deliberately have no FK. Returns `undefined` when absent so
 * the caller leaves the column as a plain object.
 */
function foreignKeyLinkedTableId(propertySchema: Record<string, unknown>): string | undefined {
  const foreignKeyOptions = propertySchema[X_SCRATCH_FOREIGN_KEY_OPTIONS];
  if (foreignKeyOptions && typeof foreignKeyOptions === 'object') {
    const linkedTableId = (foreignKeyOptions as { linkedTableId?: unknown }).linkedTableId;
    if (typeof linkedTableId === 'string' && linkedTableId.length > 0) return linkedTableId;
  }
  return undefined;
}

/** Map a Zoho `data_type` to a table-view column type hint (display formatting only). */
function tablePropertyTypeForZohoField(dataType: string): TablePropertyType {
  switch (dataType) {
    case 'boolean':
      return 'checkbox';
    case 'integer':
    case 'double':
    case 'currency':
    case 'percent':
    case 'rollup_summary':
    case 'aggregation':
      return 'number';
    // bigint is stored verbatim AS A STRING (zoho-json-schema.ts) because it can
    // exceed 2^53 — record ids, big counters. Declaring it 'number' drives a
    // numeric destination column that forces a lossy string→double coercion and
    // silently truncates values past 2^53 (DEV-11097). Keep it a string, matching
    // the connector's storage and the string-typed record `id`.
    case 'bigint':
      return 'string';
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
