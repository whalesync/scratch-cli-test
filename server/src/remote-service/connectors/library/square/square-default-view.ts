import { TSchema } from '@sinclair/typebox';
import { TablePropertyType, TableView, TableViewCol, X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { nonNullArmOf } from './square-json-schema';
import { SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE, SquareEntityType } from './square-types';

/** A JSON Schema node as the Square record schema declares it. */
interface JsonSchemaNode {
  type?: string;
  format?: string;
  properties?: Record<string, JsonSchemaNode>;
  anyOf?: JsonSchemaNode[];
  [annotation: string]: unknown;
}

interface ForeignKeyTarget {
  linkedTableId: string;
  linkedTableRemoteId: string[];
  isSingleValued: boolean;
}

// ── Priority fields per table ──
// Listed fields come first, in this order; everything else follows alphabetically. Catalog tables
// list their `<type>_data` property first, which the view expands into the object's own fields.
const PRIORITY_FIELDS: Record<SquareEntityType, string[]> = {
  locations: ['name', 'id', 'status', 'business_name', 'type', 'currency', 'timezone', 'country', 'address'],
  customers: ['given_name', 'family_name', 'email_address', 'phone_number', 'company_name', 'id', 'created_at'],
  catalog_items: ['item_data', 'id', 'is_deleted', 'present_at_all_locations', 'updated_at'],
  catalog_item_variations: ['item_variation_data', 'id', 'is_deleted', 'present_at_all_locations', 'updated_at'],
  catalog_categories: ['category_data', 'id', 'is_deleted', 'updated_at'],
  catalog_modifier_lists: ['modifier_list_data', 'id', 'is_deleted', 'updated_at'],
  catalog_taxes: ['tax_data', 'id', 'is_deleted', 'updated_at'],
  catalog_discounts: ['discount_data', 'id', 'is_deleted', 'updated_at'],
  orders: [
    'id',
    'location_id',
    'state',
    'customer_id',
    'total_money',
    'total_tax_money',
    'total_discount_money',
    'total_tip_money',
    'total_service_charge_money',
    'net_amount_due_money',
    'created_at',
    'updated_at',
    'closed_at',
  ],
  payments: [
    'id',
    'location_id',
    'order_id',
    'customer_id',
    'status',
    'source_type',
    'amount_money',
    'tip_money',
    'total_money',
    'refunded_money',
    'created_at',
    'updated_at',
  ],
  refunds: ['id', 'payment_id', 'order_id', 'location_id', 'status', 'amount_money', 'reason', 'created_at'],
  invoices: ['invoice_number', 'id', 'title', 'status', 'location_id', 'order_id', 'primary_recipient', 'created_at'],
  team_members: ['given_name', 'family_name', 'email_address', 'status', 'is_owner', 'id', 'created_at'],
  payouts: ['id', 'location_id', 'status', 'type', 'amount_money', 'arrival_date', 'created_at'],
  payout_entries: [
    'id',
    'payout_id',
    'type',
    'gross_amount_money',
    'fee_amount_money',
    'net_amount_money',
    'effective_at',
  ],
  gift_cards: ['gan', 'id', 'type', 'state', 'balance_money', 'customer_ids', 'created_at'],
  gift_card_activities: [
    'id',
    'gift_card_id',
    'gift_card_gan',
    'type',
    'location_id',
    'gift_card_balance_money',
    'created_at',
  ],
  subscriptions: [
    'id',
    'customer_id',
    'location_id',
    'plan_variation_id',
    'status',
    'start_date',
    'charged_through_date',
    'canceled_date',
    'created_at',
  ],
};

/**
 * Plumbing hidden by default. Kept SHORT on purpose: a hidden column is dropped from Live Export
 * field selection entirely, so only values with no meaning to a user belong here — optimistic-
 * concurrency counters, Connect v1 id mappings, and a catalog object's `type` (constant within
 * each catalog table).
 */
const HIDDEN_FIELDS_ON_EVERY_TABLE = new Set(['version', 'version_token', 'catalog_v1_ids']);
const HIDDEN_FIELDS_ON_CATALOG_TABLES = new Set(['type']);

/**
 * Objects expanded into one column per field even though they are neither money nor an address:
 * an invoice's recipient is a small set of ordinary contact fields (including the customer link),
 * and an order's `source` is just the name of the channel it came from.
 */
const COMPOSITE_OBJECT_FIELD_NAMES = new Set(['primary_recipient', 'source']);

/**
 * Links that live BELOW the top level, where the schema's own foreign-key annotations don't reach
 * (they sit on top-level fields only — see square-json-schema.ts). The view declares them so the
 * export can still create a relation.
 */
const NESTED_FOREIGN_KEY_TARGET_ENTITY_TYPE_BY_PATH: Record<string, SquareEntityType> = {
  'primary_recipient.customer_id': 'customers',
  'item_variation_data.item_id': 'catalog_items',
  'item_data.reporting_category.id': 'catalog_categories',
};

/** Build the default TableView for a Square table from its record schema. */
export function buildSquareDefaultView(schema: TSchema, entityType: SquareEntityType): TableView {
  const properties = (schema as JsonSchemaNode).properties ?? {};
  const entityConfig = SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType];
  const hiddenFieldNames = new Set([
    ...HIDDEN_FIELDS_ON_EVERY_TABLE,
    ...(entityConfig.catalogObjectType ? HIDDEN_FIELDS_ON_CATALOG_TABLES : []),
  ]);

  const usedColumnNames = new Set<string>();
  const cols: TableViewCol[] = [];
  for (const fieldName of sortFields(Object.keys(properties), PRIORITY_FIELDS[entityType])) {
    const fieldSchema = properties[fieldName];
    if (hiddenFieldNames.has(fieldName)) {
      cols.push({ ...buildLeafCol(fieldName, formatFieldName(fieldName), fieldSchema), hidden: true });
      continue;
    }
    if (fieldName === entityConfig.catalogTypeDataPropertyName) {
      // The `<type>_data` object IS the catalog record's content, so its fields are named on their
      // own ("Name", "Price Money (Amount)") rather than as "Item Data (Name)".
      cols.push(...expandObjectCols(fieldName, '', fieldSchema, 2));
      continue;
    }
    cols.push(...buildColsForField(fieldName, formatFieldName(fieldName), fieldSchema));
  }

  return { name: 'Default', cols: cols.map((col) => withUniqueName(col, usedColumnNames)) };
}

// ── Helpers ──

/** Sort field names so priority fields come first (in their defined order), then the rest alphabetically. */
function sortFields(fieldNames: string[], priorityFieldNames: string[]): string[] {
  const priorityIndexByFieldName = new Map(priorityFieldNames.map((fieldName, index) => [fieldName, index]));
  const priorityFieldsPresent = fieldNames
    .filter((fieldName) => priorityIndexByFieldName.has(fieldName))
    .sort((a, b) => (priorityIndexByFieldName.get(a) ?? 0) - (priorityIndexByFieldName.get(b) ?? 0));
  const remainingFields = fieldNames
    .filter((fieldName) => !priorityIndexByFieldName.has(fieldName))
    .sort((a, b) => a.localeCompare(b));
  return [...priorityFieldsPresent, ...remainingFields];
}

/** `amount_money` → `Amount Money`. */
function formatFieldName(fieldName: string): string {
  return fieldName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Whether the schema is Square's `Money` object: `{ amount, currency }`. */
function isMoneySchema(fieldSchema: JsonSchemaNode | undefined): boolean {
  const propertyNames = Object.keys(nonNullArmOf(fieldSchema)?.properties ?? {}).sort();
  return propertyNames.length === 2 && propertyNames[0] === 'amount' && propertyNames[1] === 'currency';
}

/** Whether the schema is Square's `Address` object. */
function isAddressSchema(fieldSchema: JsonSchemaNode | undefined): boolean {
  const properties = nonNullArmOf(fieldSchema)?.properties;
  return properties !== undefined && 'address_line_1' in properties && 'locality' in properties;
}

/**
 * Map a field's schema to its render type and its export (logical) type. Explicit on every column
 * so the Live Export plan never depends on the schema flattener reaching a nested field.
 */
function columnTypesFor(fieldSchema: JsonSchemaNode | undefined): {
  type: TablePropertyType;
  logicalType: TablePropertyType;
} {
  const shape = nonNullArmOf(fieldSchema);
  if (shape?.format === 'date-time') return { type: 'date', logicalType: 'datetime' };
  if (shape?.format === 'date') return { type: 'date', logicalType: 'date' };
  switch (shape?.type) {
    case 'boolean':
      return { type: 'checkbox', logicalType: 'checkbox' };
    case 'integer':
    case 'number':
      return { type: 'number', logicalType: 'number' };
    case 'string':
      return { type: 'string', logicalType: 'string' };
    default:
      // Arrays, open-ended objects, and objects nested too deep to expand travel as JSON.
      return { type: 'object', logicalType: 'object' };
  }
}

function foreignKeyTargetFor(path: string, fieldSchema: JsonSchemaNode | undefined): ForeignKeyTarget | undefined {
  const declaredOnSchema = fieldSchema?.[X_SCRATCH_FOREIGN_KEY_OPTIONS] as ForeignKeyTarget | undefined;
  if (declaredOnSchema) return declaredOnSchema;
  const nestedTargetEntityType = NESTED_FOREIGN_KEY_TARGET_ENTITY_TYPE_BY_PATH[path];
  if (!nestedTargetEntityType) return undefined;
  return { linkedTableId: nestedTargetEntityType, linkedTableRemoteId: [nestedTargetEntityType], isSingleValued: true };
}

/** A single typed, read-only column. */
function buildLeafCol(path: string, name: string, fieldSchema: JsonSchemaNode | undefined): TableViewCol {
  const foreignKey = foreignKeyTargetFor(path, fieldSchema);
  return {
    kind: 'col',
    path,
    name,
    ...columnTypesFor(fieldSchema),
    readonly: true,
    ...(foreignKey ? { foreignKey } : {}),
  };
}

/**
 * Expand an object into one column per field, recursing into nested objects up to
 * `remainingObjectLevels` deep, and append the raw container hidden so nothing is lost. A
 * `namePrefix` of `''` names sub-columns by their own field name only.
 */
function expandObjectCols(
  path: string,
  namePrefix: string,
  fieldSchema: JsonSchemaNode | undefined,
  remainingObjectLevels: number,
): TableViewCol[] {
  const properties = nonNullArmOf(fieldSchema)?.properties ?? {};
  const cols: TableViewCol[] = [];
  for (const [subfieldName, subfieldSchema] of Object.entries(properties)) {
    const subfieldPath = `${path}.${subfieldName}`;
    const subfieldDisplayName = formatFieldName(subfieldName);
    const subfieldColumnName = namePrefix ? `${namePrefix} (${subfieldDisplayName})` : subfieldDisplayName;
    const subfieldHasProperties = Object.keys(nonNullArmOf(subfieldSchema)?.properties ?? {}).length > 0;
    if (subfieldHasProperties && remainingObjectLevels > 1) {
      cols.push(...expandObjectCols(subfieldPath, subfieldColumnName, subfieldSchema, remainingObjectLevels - 1));
    } else {
      cols.push(buildLeafCol(subfieldPath, subfieldColumnName, subfieldSchema));
    }
  }
  cols.push({
    kind: 'col',
    path,
    name: namePrefix ? `${namePrefix} (raw)` : `${formatFieldName(path)} (raw)`,
    type: 'object',
    logicalType: 'object',
    readonly: true,
    hidden: true,
  });
  return cols;
}

/** The column(s) one top-level field contributes. */
function buildColsForField(fieldName: string, displayName: string, fieldSchema: JsonSchemaNode): TableViewCol[] {
  if (isMoneySchema(fieldSchema) || isAddressSchema(fieldSchema) || COMPOSITE_OBJECT_FIELD_NAMES.has(fieldName)) {
    return expandObjectCols(fieldName, displayName, fieldSchema, 1);
  }
  return [buildLeafCol(fieldName, displayName, fieldSchema)];
}

/**
 * Keep column names unique within the view: destinations reject duplicate field names. A clash
 * (rare — e.g. a catalog data field named like an envelope field) gets a numeric suffix.
 */
function withUniqueName(col: TableViewCol, usedColumnNames: Set<string>): TableViewCol {
  const baseName = col.name ?? col.path;
  let uniqueName = baseName;
  for (let suffix = 2; usedColumnNames.has(uniqueName); suffix++) {
    uniqueName = `${baseName} ${suffix}`;
  }
  usedColumnNames.add(uniqueName);
  return uniqueName === col.name ? col : { ...col, name: uniqueName };
}
