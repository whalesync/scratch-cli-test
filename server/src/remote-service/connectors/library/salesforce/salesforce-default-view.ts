import { type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_CUSTOM_FIELD,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_WRITE_ONCE,
  type TablePropertyType,
  type TableView,
  type TableViewCol,
} from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';
import { SALESFORCE_RECORD_ATTRIBUTES_KEY, SALESFORCE_RECORD_ID_FIELD } from './salesforce-json-schema';

/**
 * Plumbing every Salesforce object carries that a user rarely wants to see: the record's own metadata block, the
 * recycle-bin flag, the system timestamp the incremental pull reads, the current user's last-viewed timestamps,
 * and the merge-master pointer. Hidden, not removed — the column picker still offers them.
 */
const HIDDEN_SYSTEM_FIELD_API_NAMES = new Set([
  SALESFORCE_RECORD_ATTRIBUTES_KEY,
  'IsDeleted',
  'SystemModstamp',
  'LastViewedDate',
  'LastReferencedDate',
  'MasterRecordId',
]);

/**
 * Compound values Salesforce derives from component fields (`BillingAddress` from `BillingStreet`, `BillingCity`,
 * …). Read-only; the editable components already have their own columns, so the compound column starts hidden.
 */
const COMPOUND_DATA_TYPES = new Set(['salesforce/address', 'salesforce/location']);

/** Map a field's `x-scratch-connector-data-type` to the grid's column type. */
function tablePropertyTypeForSalesforceDataType(connectorDataType: string): TablePropertyType {
  switch (connectorDataType) {
    case 'salesforce/boolean':
      return 'checkbox';
    case 'salesforce/int':
    case 'salesforce/long':
    case 'salesforce/double':
    case 'salesforce/currency':
    case 'salesforce/percent':
      return 'number';
    case 'salesforce/date':
    case 'salesforce/datetime':
      return 'date';
    case 'salesforce/url':
      return 'url';
    case 'salesforce/richtextarea':
      return 'richtext';
    case 'salesforce/address':
    case 'salesforce/location':
    case 'salesforce/attributes':
    case 'salesforce/anyType':
    case 'salesforce/complexvalue':
      return 'object';
    default:
      return 'string';
  }
}

function foreignKeyOfProperty(propertySchema: Record<string, unknown>): TableViewCol['foreignKey'] {
  const foreignKeyOptions = propertySchema[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
    | { linkedTableId?: unknown; linkedTableRemoteId?: unknown }
    | undefined;
  if (!foreignKeyOptions || typeof foreignKeyOptions.linkedTableId !== 'string') {
    return undefined;
  }
  const linkedTableRemoteId =
    Array.isArray(foreignKeyOptions.linkedTableRemoteId) &&
    foreignKeyOptions.linkedTableRemoteId.every((segment): segment is string => typeof segment === 'string')
      ? foreignKeyOptions.linkedTableRemoteId
      : undefined;
  return {
    linkedTableId: foreignKeyOptions.linkedTableId,
    ...(linkedTableRemoteId ? { linkedTableRemoteId } : {}),
    // A Salesforce lookup holds one record id.
    isSingleValued: true,
  };
}

function columnForSchemaProperty(fieldApiName: string, propertySchema: Record<string, unknown>): TableViewCol {
  const rawConnectorDataType = propertySchema[X_SCRATCH_CONNECTOR_DATA_TYPE];
  const connectorDataType = typeof rawConnectorDataType === 'string' ? rawConnectorDataType : '';
  const col: TableViewCol = {
    kind: 'col',
    path: fieldApiName,
    name:
      fieldApiName === SALESFORCE_RECORD_ID_FIELD
        ? 'Record ID'
        : typeof propertySchema.description === 'string'
          ? propertySchema.description
          : fieldApiName,
    type: tablePropertyTypeForSalesforceDataType(connectorDataType),
    readonly: propertySchema[X_SCRATCH_READONLY] === true,
  };
  if (propertySchema[X_SCRATCH_WRITE_ONCE] === true) {
    col.writeOnce = true;
  }
  if (connectorDataType === 'salesforce/datetime') {
    // The value carries a time of day, but its `+0000` offset keeps it off `format: 'date-time'` (see
    // salesforceFieldValueSchema), so the export layer needs to be told it's a timestamp.
    col.logicalType = 'datetime';
  }
  const foreignKey = foreignKeyOfProperty(propertySchema);
  if (foreignKey) {
    col.foreignKey = foreignKey;
  }
  if (HIDDEN_SYSTEM_FIELD_API_NAMES.has(fieldApiName) || COMPOUND_DATA_TYPES.has(connectorDataType)) {
    col.hidden = true;
  }
  return col;
}

/**
 * Default view for a Salesforce object — a pure function of the spec.
 *
 * Every field is a top-level property, so this is grouping and ordering only. The object's name field (the
 * spec's `titlePath`: `Name`, `CaseNumber`, `Subject`, …) leads; standard fields follow in describe order; the
 * org's custom fields (`__c`, recorded on the schema as `x-scratch-custom-field`) gather under a "Custom Fields"
 * banner, mirroring Salesforce's own standard/custom split. System plumbing and compound address/location values
 * start hidden.
 */
export function buildSalesforceDefaultView(spec: BaseJsonTableSpec): TableView {
  const schemaProperties = (spec.schema as TSchema & { properties?: Record<string, Record<string, unknown>> })
    .properties;
  const titleFieldApiName = spec.titlePath ? String(spec.titlePath) : undefined;

  const titleCols: TableViewCol[] = [];
  const standardFieldCols: TableViewCol[] = [];
  const customFieldCols: TableViewCol[] = [];
  for (const [fieldApiName, propertySchema] of Object.entries(schemaProperties ?? {})) {
    const col = columnForSchemaProperty(fieldApiName, propertySchema);
    if (fieldApiName === titleFieldApiName) {
      titleCols.push(col);
    } else if (propertySchema[X_SCRATCH_CUSTOM_FIELD] === true) {
      customFieldCols.push(col);
    } else {
      standardFieldCols.push(col);
    }
  }

  return {
    name: 'Default',
    cols: [
      ...titleCols,
      ...standardFieldCols,
      ...(customFieldCols.length > 0
        ? [{ kind: 'banner-group' as const, name: 'Custom Fields', cols: customFieldCols }]
        : []),
    ],
  };
}
