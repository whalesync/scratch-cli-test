import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
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

// ── Reference (`*Ref`) columns ──

/**
 * The subfield a `*Ref` column collapses to when it has NO foreign-key target we
 * expose as a table (`CurrencyRef`, `ClassRef`, `DepartmentRef`, `AgencyRef`, …):
 * the human-readable `name`, or — for the refs QBO returns without one — the bare
 * `value`. Nothing links to these, so the flattened label IS the honest export.
 */
const REF_NAME_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'name', name: 'Name', type: 'string' }];
const REF_VALUE_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'value', name: 'Value', type: 'string' }];

/**
 * QBO's single-value wrapper objects: a scalar the API hands back inside a
 * one-key object. Left as plain objects they exported as raw JSON
 * (`{"Address":"a@b.com"}`) — unusable at the destination, where you can't click
 * a mailto, filter on a domain, or read a memo without stripping JSON
 * (DEV-11135). Each collapses to its inner value with the SEMANTIC type the value
 * carries, so a destination that has an email / phone / url field type gets one.
 *
 * Only the wrappers with a single obvious inner value are listed. QBO's genuinely
 * composite objects — `BillAddr`, `ShipAddr`, `ShipFromAddr`, `Line`,
 * `CustomField`, `LinkedTxn`, `TxnTaxDetail`, `DeliveryInfo` — are NOT here: text
 * / JSON is the honest representation for them, and some (`TxnTaxDetail`,
 * `DeliveryInfo`) only LOOK single-keyed because the upstream manifest under-
 * declares them. Each entry applies only when the entity's schema actually
 * declares that inner property, so an under-declared wrapper is left whole
 * rather than collapsed onto a key it doesn't have.
 */
const SINGLE_VALUE_WRAPPER_SUBFIELD_BY_FIELD_NAME: Record<string, TableViewSubfield> = {
  PrimaryEmailAddr: { relativePath: 'Address', name: 'Address', type: 'email' },
  BillEmail: { relativePath: 'Address', name: 'Address', type: 'email' },
  CustomerCommunicationEmailAddr: { relativePath: 'Address', name: 'Address', type: 'email' },
  Email: { relativePath: 'Address', name: 'Address', type: 'email' },
  PrimaryPhone: { relativePath: 'FreeFormNumber', name: 'Number', type: 'phone' },
  Mobile: { relativePath: 'FreeFormNumber', name: 'Number', type: 'phone' },
  Fax: { relativePath: 'FreeFormNumber', name: 'Number', type: 'phone' },
  WebAddr: { relativePath: 'URI', name: 'URI', type: 'url' },
  CustomerMemo: { relativePath: 'value', name: 'Memo', type: 'string' },
};

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

  inPriority.sort((a, b) => (priorityIndex.get(a) ?? 0) - (priorityIndex.get(b) ?? 0));
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

/** The property names a field's schema declares, across any union variants. */
function declaredPropertyNames(fieldSchema: TSchema | undefined): Set<string> {
  const propertyNames = new Set<string>();
  const inner = unwrapOptional(fieldSchema);
  if (!inner) return propertyNames;

  const collectFrom = (schema: TSchema): void => {
    const properties = (schema as TSchema & { properties?: Record<string, TSchema> }).properties;
    for (const propertyName of Object.keys(properties ?? {})) propertyNames.add(propertyName);
  };

  collectFrom(inner);
  for (const variant of (inner as TSchema & { anyOf?: TSchema[] }).anyOf ?? []) collectFrom(variant);
  return propertyNames;
}

/**
 * A QBO reference object: a field named `*Ref` holding `{ name, value }` — or, for
 * the handful QBO returns without a label (`ParentRef`, `Payment.PaymentMethodRef`,
 * `Vendor.TermRef`, …), `{ value }` alone. In both shapes `value` is the target
 * record's `Id`.
 */
function refObjectPropertyNames(fieldId: string, fieldSchema: TSchema | undefined): Set<string> | undefined {
  if (!fieldId.endsWith('Ref')) return undefined;
  const propertyNames = declaredPropertyNames(fieldSchema);
  return propertyNames.has('value') || propertyNames.has('name') ? propertyNames : undefined;
}

/**
 * The `x-scratch-foreign-key` annotation on a field, which the codegen puts on the
 * `Type.Union([…, Type.Null()], { … })` wrapper — i.e. on the field schema itself,
 * NOT on the inner object {@link unwrapOptional} returns.
 */
function foreignKeyFromSchema(fieldSchema: TSchema | undefined): TableViewCol['foreignKey'] | undefined {
  const foreignKeyOptions = (fieldSchema as Record<string, unknown> | undefined)?.[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
    | { linkedTableId?: unknown; linkedTableRemoteId?: unknown }
    | undefined;
  if (typeof foreignKeyOptions?.linkedTableId !== 'string') return undefined;

  const linkedTableRemoteId =
    Array.isArray(foreignKeyOptions.linkedTableRemoteId) &&
    foreignKeyOptions.linkedTableRemoteId.every((segment): segment is string => typeof segment === 'string')
      ? foreignKeyOptions.linkedTableRemoteId
      : undefined;

  return {
    linkedTableId: foreignKeyOptions.linkedTableId,
    ...(linkedTableRemoteId ? { linkedTableRemoteId } : {}),
    // Every QBO reference points at exactly one record.
    isSingleValued: true,
  };
}

/** A single-value jsonpath extract of `relativePath` out of this column's own value. */
function innerValueJsonPath(relativePath: string): { expression: string } {
  return { expression: `$.${relativePath}` };
}

/**
 * Turn a `*Ref` column that HAS a foreign-key target into a real link column.
 *
 * Every named `*Ref` used to render (and therefore export) as its `.name` string
 * via `subfields`/`selectedSubfield`, which silently threw the relation away: the
 * subfield branch of `selectPlanFieldsFromTableView` rewrites the source path to
 * `CustomerRef.name` and never reads the column's foreign key, so a heavily
 * relational service exported as denormalized text with no downgrade note
 * (DEV-11132 — the same trap Linear and Shopify hit in DEV-11017).
 *
 * So the column keeps its path at the reference object and declares the link,
 * following Affinity's and Pipedrive's reference columns: the `codec.toCore`
 * extract yields `value` — the target's `Id`, which the FK phase resolves against
 * the linked table's synced records — while the `displayTransformer` keeps the
 * grid showing the human-readable `name`, so nothing about how the cell reads
 * changes. Refs QBO returns without a `name` display their id instead.
 *
 * Display-and-export only: no `fromCore`, matching Affinity — editing the label
 * can't be turned back into a `{ name, value }` pair, and the verbatim object on
 * disk is untouched either way (Connector Prime Directive).
 */
function applyRefForeignKeyColumn(
  col: TableViewCol,
  foreignKey: NonNullable<TableViewCol['foreignKey']>,
  refPropertyNames: Set<string>,
): void {
  const displayPath = refPropertyNames.has('name') ? 'name' : 'value';
  col.type = 'string';
  col.foreignKey = foreignKey;
  col.displayTransformer = { type: 'jsonpath', options: innerValueJsonPath(displayPath) };
  col.codec = { toCore: { type: TransformerTypes.JSONPath, options: innerValueJsonPath('value') } };
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

  const refPropertyNames = refObjectPropertyNames(fieldId, fieldSchema);
  if (refPropertyNames) {
    const foreignKey = foreignKeyFromSchema(fieldSchema);
    if (foreignKey) {
      applyRefForeignKeyColumn(col, foreignKey, refPropertyNames);
    } else {
      // A ref to something we don't surface as a table — show its label (or its id).
      col.subfields = refPropertyNames.has('name') ? REF_NAME_SUBFIELDS : REF_VALUE_SUBFIELDS;
      col.selectedSubfield = 0;
    }
    return col;
  }

  const wrapperSubfield = SINGLE_VALUE_WRAPPER_SUBFIELD_BY_FIELD_NAME[fieldId];
  if (wrapperSubfield && declaredPropertyNames(fieldSchema).has(wrapperSubfield.relativePath)) {
    col.subfields = [wrapperSubfield];
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
