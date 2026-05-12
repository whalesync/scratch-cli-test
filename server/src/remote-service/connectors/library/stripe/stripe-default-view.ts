import { Kind, TSchema } from '@sinclair/typebox';
import { TablePropertyType, TableView, TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { StripeEntityType } from './stripe-types';

// ── Priority fields per entity type ──
// Fields listed here appear first, in this order. Anything not listed goes after alphabetically.
const PRIORITY_FIELDS: Record<StripeEntityType, string[]> = {
  customers: ['name', 'id', 'email', 'phone', 'description', 'currency', 'balance', 'delinquent', 'created'],
  products: ['name', 'id', 'description', 'active', 'type', 'default_price', 'url', 'created'],
  prices: ['nickname', 'id', 'product', 'active', 'currency', 'unit_amount', 'type', 'recurring', 'created'],
  subscriptions: [
    'id',
    'customer',
    'status',
    'currency',
    'current_period_start',
    'current_period_end',
    'cancel_at_period_end',
    'created',
  ],
  invoices: [
    'number',
    'id',
    'customer',
    'status',
    'currency',
    'amount_due',
    'amount_paid',
    'total',
    'paid',
    'due_date',
    'created',
  ],
  payment_intents: ['id', 'customer', 'amount', 'amount_received', 'currency', 'status', 'description', 'created'],
  charges: ['id', 'customer', 'amount', 'currency', 'status', 'paid', 'captured', 'refunded', 'description', 'created'],
};

// Fields that should be hidden by default — system metadata present on every Stripe object.
const HIDDEN_FIELDS = new Set([
  'object',
  'livemode',
  'metadata',
  'invoice_settings',
  'default_source',
  'invoice_prefix',
  'billing_details',
  'shipping',
  'address',
  'items',
  'images',
]);

/**
 * Build a default TableView for a Stripe entity type by reading the TypeBox schema.
 * Prioritizes important business fields, hides system metadata, and maps types.
 */
export function buildStripeDefaultView(schema: TSchema, entityType: StripeEntityType): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(properties);
  const priority = PRIORITY_FIELDS[entityType];
  const sorted = sortFields(fieldIds, priority);
  const cols: TableViewCol[] = [];

  for (const fieldId of sorted) {
    const fieldSchema = properties[fieldId];
    cols.push(buildCol(fieldId, fieldSchema));
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort field IDs so priority fields come first (in their defined order), then the rest alphabetically. */
function sortFields(fieldIds: string[], priority: string[]): string[] {
  const priorityIndex = new Map(priority.map((f, i) => [f, i]));
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
  rest.sort((a, b) => a.localeCompare(b));

  return [...inPriority, ...rest];
}

/** Map a TypeBox schema to a TablePropertyType based on Kind and format annotations. */
function mapType(fieldSchema: TSchema): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  const format = (fieldSchema as TSchema & { format?: string }).format;
  if (format === 'date-time' || format === 'date') return 'date';

  const kind = fieldSchema[Kind];
  switch (kind) {
    case 'Boolean':
      return 'checkbox';
    case 'Number':
    case 'Integer':
      return 'number';
    case 'Array':
      return 'object';
    case 'Object':
      return 'object';
    case 'Record':
      return 'object';
    case 'Union': {
      const anyOf = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
      if (anyOf) {
        const nonNull = anyOf.find((s) => s[Kind] !== 'Null');
        if (nonNull) return mapType(nonNull);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Format a snake_case field ID as a human-readable column name. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Build a TableViewCol from a field ID and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema): TableViewCol {
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  const hidden = HIDDEN_FIELDS.has(fieldId) || undefined;

  return {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapType(fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };
}
