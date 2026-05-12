import { TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { AirtableDataType, AirtableFieldsV2, AirtableTableV2 } from './airtable-types';

// Airtable field types that map to specific TablePropertyType values.
const TYPE_MAP: Partial<Record<string, TablePropertyType>> = {
  [AirtableDataType.NUMBER]: 'number',
  [AirtableDataType.PERCENT]: 'number',
  [AirtableDataType.CURRENCY]: 'number',
  [AirtableDataType.DURATION]: 'number',
  [AirtableDataType.RATING]: 'number',
  [AirtableDataType.AUTO_NUMBER]: 'number',
  [AirtableDataType.COUNT]: 'number',
  [AirtableDataType.CHECKBOX]: 'checkbox',
  [AirtableDataType.DATE]: 'date',
  [AirtableDataType.DATE_TIME]: 'date',
  [AirtableDataType.CREATED_TIME]: 'date',
  [AirtableDataType.LAST_MODIFIED_TIME]: 'date',
  [AirtableDataType.URL]: 'url',
  [AirtableDataType.RICH_TEXT]: 'richtext',
  [AirtableDataType.MULTIPLE_ATTACHMENTS]: 'object',
  [AirtableDataType.MULTIPLE_RECORD_LINKS]: 'object',
  [AirtableDataType.MULTIPLE_SELECTS]: 'object',
  [AirtableDataType.MULTIPLE_COLLABORATORS]: 'object',
  [AirtableDataType.MULTIPLE_LOOKUP_VALUES]: 'object',
  [AirtableDataType.BARCODE]: 'object',
  [AirtableDataType.SINGLE_COLLABORATOR]: 'object',
  [AirtableDataType.CREATED_BY]: 'object',
  [AirtableDataType.LAST_MODIFIED_BY]: 'object',
};

// Formula/rollup/lookup result types that map to a known TablePropertyType.
// The connector data type for these is "formula-<resultType>", "rollup-<resultType>", etc.
const FORMULA_RESULT_TYPE_MAP: Partial<Record<string, TablePropertyType>> = {
  [AirtableDataType.NUMBER]: 'number',
  [AirtableDataType.PERCENT]: 'number',
  [AirtableDataType.CURRENCY]: 'number',
  [AirtableDataType.DURATION]: 'number',
  [AirtableDataType.RATING]: 'number',
  [AirtableDataType.AUTO_NUMBER]: 'number',
  [AirtableDataType.COUNT]: 'number',
  [AirtableDataType.CHECKBOX]: 'checkbox',
  [AirtableDataType.DATE]: 'date',
  [AirtableDataType.DATE_TIME]: 'date',
  [AirtableDataType.CREATED_TIME]: 'date',
  [AirtableDataType.LAST_MODIFIED_TIME]: 'date',
  [AirtableDataType.URL]: 'url',
  [AirtableDataType.RICH_TEXT]: 'richtext',
};

/**
 * Build a default TableView for an Airtable table.
 * Uses the table's field metadata to order and type columns. The primary field
 * appears first, followed by remaining fields in Airtable's native order.
 */
export function buildAirtableDefaultView(table: AirtableTableV2, fieldsSchema: Record<string, TSchema>): TableView {
  const cols: TableViewCol[] = [];

  // Order fields: primary field first, then the rest in Airtable order
  const ordered = orderFields(table.fields, table.primaryFieldId);

  for (const field of ordered) {
    const fieldSchema = fieldsSchema[field.name];
    cols.push(buildCol(field, fieldSchema));
  }

  // Add createdTime as a trailing column
  cols.push({
    kind: 'col',
    path: 'createdTime',
    name: 'Created Time',
    type: 'date',
    readonly: true,
  });

  return { name: 'Default', cols };
}

// Collaborator types that share the {id, email, name} shape.
const COLLABORATOR_TYPES = new Set<string>([
  AirtableDataType.SINGLE_COLLABORATOR,
  AirtableDataType.CREATED_BY,
  AirtableDataType.LAST_MODIFIED_BY,
  AirtableDataType.MULTIPLE_COLLABORATORS,
]);

const COLLABORATOR_SUBFIELDS: TableViewSubfield[] = [
  { relativePath: 'email', name: 'Email', type: 'string' },
  { relativePath: 'name', name: 'Name', type: 'string' },
  { relativePath: 'id', name: 'Id', type: 'string' },
];

// ── Helpers ──

/** Order fields with the primary field first, then the rest in their original order. */
function orderFields(fields: AirtableFieldsV2[], primaryFieldId?: string): AirtableFieldsV2[] {
  if (!primaryFieldId) return fields;
  const primary = fields.find((f) => f.id === primaryFieldId);
  const rest = fields.filter((f) => f.id !== primaryFieldId);
  return primary ? [primary, ...rest] : fields;
}

/** Map an Airtable connector data type to a TablePropertyType. */
function mapType(connectorDataType: string | undefined): TablePropertyType | undefined {
  if (!connectorDataType) return undefined;

  // Direct match for simple types
  const direct = TYPE_MAP[connectorDataType];
  if (direct) return direct;

  // Formula/rollup/lookup types are like "formula-number", "rollup-dateTime"
  const dashIdx = connectorDataType.indexOf('-');
  if (dashIdx > 0) {
    const resultType = connectorDataType.slice(dashIdx + 1);
    return FORMULA_RESULT_TYPE_MAP[resultType];
  }

  return undefined;
}

/** Build a TableViewCol for an Airtable field. */
function buildCol(field: AirtableFieldsV2, fieldSchema: TSchema | undefined): TableViewCol {
  const connectorDataType = fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;

  const col: TableViewCol = {
    kind: 'col',
    path: `fields.${field.name}`,
    name: field.name,
    type: mapType(connectorDataType),
    readonly: isReadonly || undefined,
  };

  // Collaborator fields are objects with {id, email, name} — default to showing email
  if (connectorDataType && COLLABORATOR_TYPES.has(connectorDataType)) {
    col.subfields = COLLABORATOR_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  return col;
}
