import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';

// ── Per-entity priority field ordering ──

const ENTITY_PRIORITY_FIELDS: Record<string, string[]> = {
  Customer: ['DisplayName', 'Id', 'PrimaryEmailAddr', 'PrimaryPhone', 'Balance', 'CompanyName', 'Active'],
  Invoice: ['DocNumber', 'Id', 'CustomerRef', 'TotalAmt', 'Balance', 'DueDate', 'TxnDate'],
  Item: ['Name', 'Id', 'Type', 'UnitPrice', 'QtyOnHand', 'Active', 'Description'],
  Vendor: ['DisplayName', 'Id', 'PrimaryEmailAddr', 'PrimaryPhone', 'Balance', 'CompanyName', 'Active'],
  Employee: ['DisplayName', 'Id', 'PrimaryEmailAddr', 'PrimaryPhone', 'Active'],
  Payment: ['Id', 'CustomerRef', 'TotalAmt', 'TxnDate', 'PaymentMethodRef'],
  Bill: ['Id', 'VendorRef', 'TotalAmt', 'Balance', 'DueDate', 'TxnDate'],
  Account: ['Name', 'Id', 'AccountType', 'AccountSubType', 'CurrentBalance', 'Active'],
};

// ── Hidden fields ──

const HIDDEN_FIELDS = new Set(['MetaData', 'SyncToken', 'domain', 'sparse']);

// ── Ref subfields ──

const REF_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'name', name: 'Name', type: 'string' }];

/**
 * Build a default TableView for a QuickBooks entity type.
 * Uses the TypeBox schema to discover fields and applies per-entity priority ordering.
 */
export function buildQuickBooksDefaultView(schema: TSchema, entityType: string): TableView {
  const topLevel: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(topLevel);
  const sortedFields = sortFields(fieldIds, entityType);

  const cols: TableViewCol[] = [];
  for (const fieldId of sortedFields) {
    cols.push(buildCol(fieldId, topLevel[fieldId]));
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort fields: priority fields first (in defined order), then the rest in schema order. Hidden fields go last. */
function sortFields(fieldIds: string[], entityType: string): string[] {
  const priorityList = ENTITY_PRIORITY_FIELDS[entityType];

  if (!priorityList) {
    // Default fallback: Id first, then all other fields in schema order
    const idIdx = fieldIds.indexOf('Id');
    if (idIdx <= 0) return fieldIds;
    const result = [...fieldIds];
    result.splice(idIdx, 1);
    return ['Id', ...result];
  }

  const priorityIndex = new Map(priorityList.map((f, i) => [f, i]));
  const inPriority: string[] = [];
  const rest: string[] = [];

  for (const id of fieldIds) {
    if (priorityIndex.has(id)) {
      inPriority.push(id);
    } else {
      rest.push(id);
    }
  }

  inPriority.sort((a, b) => priorityIndex.get(a)! - priorityIndex.get(b)!);
  return [...inPriority, ...rest];
}

/** Map a field's TypeBox schema to a TablePropertyType. */
function mapFieldType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  const inner = unwrapOptional(fieldSchema);
  if (!inner) return undefined;

  // Check X_SCRATCH_CONNECTOR_DATA_TYPE first
  const connectorDataType = inner[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  if (connectorDataType === 'date' || connectorDataType === 'datetime') return 'date';

  // Check format
  const format = (inner as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';
  if (format === 'date') return 'date';

  // Check Kind
  const kind = inner[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'Array') return 'object';
  if (kind === 'Object') return 'object';

  return undefined;
}

/** Check if a field name is a Ref field (ends with "Ref") and has name/value subfields. */
function isRefField(fieldId: string, fieldSchema: TSchema | undefined): boolean {
  if (!fieldId.endsWith('Ref')) return false;
  if (!fieldSchema) return false;

  // Look for an object with name and value properties inside the union
  const inner = unwrapOptional(fieldSchema);
  if (!inner) return false;

  const props = (inner as TSchema & { properties?: Record<string, TSchema> }).properties;
  if (props && 'name' in props && 'value' in props) return true;

  // Check inside Union's anyOf
  const anyOf = (inner as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    for (const variant of anyOf) {
      const variantProps = (variant as TSchema & { properties?: Record<string, TSchema> }).properties;
      if (variantProps && 'name' in variantProps && 'value' in variantProps) return true;
    }
  }

  return false;
}

/** Build a TableViewCol for a QuickBooks field. */
function buildCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const inner = unwrapOptional(fieldSchema);
  const isReadonly = inner?.[X_SCRATCH_READONLY] === true || undefined;
  const hidden = HIDDEN_FIELDS.has(fieldId) || undefined;
  const type = mapFieldType(fieldSchema);

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: fieldId,
    type,
    readonly: isReadonly,
    hidden,
  };

  // Ref fields: add name subfield
  if (isRefField(fieldId, fieldSchema)) {
    col.subfields = REF_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  return col;
}

/** Unwrap TypeBox Optional/Union to get the inner non-null schema. */
function unwrapOptional(schema: TSchema | undefined): TSchema | undefined {
  if (!schema) return undefined;

  // TypeBox Optional wraps with anyOf
  const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    // Find the first non-null variant
    const nonNull = anyOf.find((s) => s[Kind] !== 'Null');
    if (nonNull) return unwrapOptional(nonNull);
    return schema;
  }

  return schema;
}
