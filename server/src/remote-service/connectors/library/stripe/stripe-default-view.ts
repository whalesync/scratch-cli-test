import { TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { STRIPE_UNIX_TIMESTAMP_DATA_TYPE, StripeEntityType } from './stripe-types';

// ── Priority fields per entity type ──
// Fields listed here appear first, in this order. Anything not listed goes after alphabetically.
const PRIORITY_FIELDS: Record<StripeEntityType, string[]> = {
  customers: ['name', 'id', 'email', 'phone', 'description', 'currency', 'balance', 'delinquent', 'created'],
  products: ['name', 'id', 'description', 'active', 'type', 'default_price', 'url', 'created'],
  prices: ['nickname', 'id', 'product', 'active', 'currency', 'unit_amount', 'type', 'recurring', 'created'],
  // No current period columns: Stripe reports the billing period per line item
  // (`items.data[].current_period_start|end`), which this flat view can't address.
  subscriptions: ['id', 'customer', 'status', 'currency', 'start_date', 'cancel_at_period_end', 'created'],
  invoices: [
    'number',
    'id',
    'customer',
    'status',
    'currency',
    'amount_due',
    'amount_paid',
    'total',
    'due_date',
    'created',
  ],
  payment_intents: ['id', 'customer', 'amount', 'amount_received', 'currency', 'status', 'description', 'created'],
  charges: ['id', 'customer', 'amount', 'currency', 'status', 'paid', 'captured', 'refunded', 'description', 'created'],
};

/**
 * Fields hidden by default — genuine plumbing present on every Stripe object, whose value is a
 * constant or an open-ended bag.
 *
 * Kept deliberately SHORT. A hidden column is not merely collapsed in the grid: it is dropped from
 * Live Export field selection entirely, so the user is never even offered it. This set used to also
 * hold `address`, `shipping`, `billing_details`, `images` and `items` — real, populated customer
 * data that could therefore never reach a destination (DEV-11148). Those are now exported: the
 * address-shaped objects expand into one column per subfield (see COMPOSITE_OBJECT_FIELDS) and the
 * list-shaped ones ride through as downgraded text, which is honest rather than silently absent.
 * `metadata` stays hidden because it is an open-ended `Record` with no declared keys.
 */
const HIDDEN_FIELDS = new Set(['object', 'livemode', 'metadata', 'invoice_prefix']);

/**
 * Nested objects flattened into one column per leaf — `address.city` as `Address (City)` — plus the
 * raw container appended hidden so nothing is lost. These are compound VALUES a user thinks of as a
 * set of ordinary fields, not as a document; left whole they would each downgrade to a single blob
 * of JSON text. Mirrors the Pipedrive composite pattern (DEV-11036).
 */
const COMPOSITE_OBJECT_FIELDS = new Set([
  'address',
  'shipping',
  'billing_details',
  'invoice_settings',
  'status_transitions',
]);

/**
 * Objects where one inner scalar is what a user actually wants to see, offered as selectable
 * subfields with the most useful preselected (DEV-11149). Unlike a composite these are alternative
 * VIEWS of one value, so the user picks one rather than getting a column each — `interval` is what
 * anyone filters or groups a price by; the raw container stays available as the built-in "All"
 * option, so the full JSON is never lost.
 */
const PLUCKED_SUBFIELDS_BY_FIELD_NAME: Record<string, { relativePath: string; name: string }[]> = {
  recurring: [
    { relativePath: 'interval', name: 'Interval' },
    { relativePath: 'interval_count', name: 'Interval Count' },
    { relativePath: 'usage_type', name: 'Usage Type' },
  ],
  // An invoice's link to the subscription that generated it lives two levels down, where Stripe
  // reports it (`parent.subscription_details.subscription`, DEV-11144). Plucking it surfaces the
  // schema's foreign-key annotation as a real relation column; left whole, `parent` downgrades to
  // a JSON text blob and the invoice → subscription relation never materializes (DEV-11154).
  parent: [{ relativePath: 'subscription_details.subscription', name: 'Subscription' }],
};

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
    cols.push(...buildColsForField(fieldId, properties[fieldId]));
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

  inPriority.sort((a, b) => (priorityIndex.get(a) ?? 0) - (priorityIndex.get(b) ?? 0));
  rest.sort((a, b) => a.localeCompare(b));

  return [...inPriority, ...rest];
}

/**
 * Strip a nullable/optional union down to the arm that carries the real shape. Stripe declares
 * almost every field as `Union([<shape>, Null])`, so without this the object/array checks below
 * would see a bare union and fall through.
 */
function unwrapNullableSchema(fieldSchema: TSchema | undefined): TSchema | undefined {
  if (!fieldSchema) return undefined;
  const unionArms = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (!unionArms) return fieldSchema;
  return unionArms.find((arm) => (arm as TSchema & { type?: string }).type !== 'null') ?? fieldSchema;
}

/** The declared object properties of a field, or undefined when it isn't an object. */
function objectPropertiesOf(fieldSchema: TSchema | undefined): Record<string, TSchema> | undefined {
  const shape = unwrapNullableSchema(fieldSchema);
  if (!shape || (shape as TSchema & { type?: string }).type !== 'object') return undefined;
  // A `Record` (Stripe's open-ended `metadata`) is `type: 'object'` with no declared `properties`;
  // there is nothing to expand, so it is not a composite.
  return (shape as TSchema & { properties?: Record<string, TSchema> }).properties;
}

/**
 * The schema declared at a dot-separated path below an object's properties, unwrapping the
 * `Union([<shape>, Null])` wrapper at every hop — an invoice's subscription link sits two
 * nullable-union levels down (`parent.subscription_details.subscription`). Undefined when any
 * segment isn't declared.
 */
function schemaAtRelativePath(properties: Record<string, TSchema>, relativePath: string): TSchema | undefined {
  let currentLevelProperties: Record<string, TSchema> | undefined = properties;
  let resolvedSchema: TSchema | undefined;
  for (const segment of relativePath.split('.')) {
    resolvedSchema = currentLevelProperties?.[segment];
    if (!resolvedSchema) return undefined;
    currentLevelProperties = objectPropertiesOf(resolvedSchema);
  }
  return resolvedSchema;
}

/**
 * Map a schema to a TablePropertyType.
 *
 * NB: reads the serialized JSON-Schema `type` keyword, never TypeBox's `Kind` symbol. A view can be
 * rebuilt from a stored (JSON-parsed) schema, where symbols are gone — a `Kind`-based mapping
 * silently types every column `undefined` there. Same reasoning as `pipedrive-default-view.ts`.
 */
function mapType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  const shape = unwrapNullableSchema(fieldSchema);
  if (!shape) return undefined;

  const format = (shape as TSchema & { format?: string }).format;
  if (format === 'date-time' || format === 'date') return 'date';

  switch ((shape as TSchema & { type?: string }).type) {
    case 'boolean':
      return 'checkbox';
    case 'number':
    case 'integer':
      return 'number';
    case 'string':
      return 'string';
    case 'array':
    case 'object':
      return 'object';
    default:
      return undefined;
  }
}

/** Whether the service reports this field as a Unix-epoch timestamp (see the schema annotation). */
function isUnixTimestampField(fieldSchema: TSchema | undefined): boolean {
  return (
    (fieldSchema as (TSchema & { [X_SCRATCH_CONNECTOR_DATA_TYPE]?: string }) | undefined)?.[
      X_SCRATCH_CONNECTOR_DATA_TYPE
    ] === STRIPE_UNIX_TIMESTAMP_DATA_TYPE
  );
}

/** Format a snake_case field ID as a human-readable column name. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * A Unix-epoch column, rendered as a date and exported as one.
 *
 * The raw value stays the integer Stripe sent; everything here is view/codec, so records on disk are
 * byte-identical to the API response. Three parts, each consumed by a different layer (DEV-11145):
 *  - `type: 'string'` — the TEXT cell is the only grid cell that consults `displayTransformer`, so
 *    the column must render through it for the user to see a date rather than `1785436554`.
 *  - `logicalType: 'datetime'` — what the value actually IS, which is what the export layer reads to
 *    create a real datetime destination field (`'date'` alone would drop the time-of-day, since the
 *    generic time-bearing signal is a `format` the raw number can't carry).
 *  - `codec.toCore` — converts the epoch to ISO-8601 on the way into a sync, so the destination is
 *    handed a date and not the bare integer.
 */
function buildUnixTimestampCol(path: string, name: string, isReadonly: boolean): TableViewCol {
  return {
    kind: 'col',
    path,
    name,
    type: 'string',
    logicalType: 'datetime',
    // Stripe reports every timestamp in epoch SECONDS. Fresh objects per column: a view is
    // serialized per table, so nothing should share mutable structure between columns.
    displayTransformer: { type: 'epoch_to_iso', options: { unit: 'seconds' } },
    codec: { toCore: { type: TransformerTypes.EpochToIso, options: { unit: 'seconds' } } },
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/** A single leaf column — a timestamp if the schema says so, otherwise a plain typed column. */
function buildLeafCol(path: string, name: string, fieldSchema: TSchema | undefined, isReadonly: boolean): TableViewCol {
  if (isUnixTimestampField(fieldSchema)) return buildUnixTimestampCol(path, name, isReadonly);
  return {
    kind: 'col',
    path,
    name,
    type: mapType(fieldSchema),
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/**
 * Expand a composite object into one column per leaf, plus the raw container hidden.
 *
 * Recurses one level for a nested object so a shipping/billing address's own fields become real
 * columns (`shipping.address.city` → `Shipping (Address City)`) instead of one JSON blob. Names are
 * qualified with the parent field so sibling composites don't collide — a customer has both an
 * `address.city` and a `shipping.address.city`.
 */
function expandCompositeObjectCols(
  path: string,
  name: string,
  properties: Record<string, TSchema>,
  isReadonly: boolean,
): TableViewCol[] {
  const cols: TableViewCol[] = [];

  for (const [subfieldKey, subfieldSchema] of Object.entries(properties)) {
    const subfieldPath = `${path}.${subfieldKey}`;
    const subfieldName = `${name} (${formatFieldName(subfieldKey)})`;
    const isSubfieldReadonly = isReadonly || subfieldSchema?.[X_SCRATCH_READONLY] === true;

    const nestedProperties = objectPropertiesOf(subfieldSchema);
    if (nestedProperties) {
      for (const [nestedKey, nestedSchema] of Object.entries(nestedProperties)) {
        cols.push(
          buildLeafCol(
            `${subfieldPath}.${nestedKey}`,
            `${name} (${formatFieldName(subfieldKey)} ${formatFieldName(nestedKey)})`,
            nestedSchema,
            isSubfieldReadonly || nestedSchema?.[X_SCRATCH_READONLY] === true,
          ),
        );
      }
      continue;
    }

    cols.push(buildLeafCol(subfieldPath, subfieldName, subfieldSchema, isSubfieldReadonly));
  }

  cols.push({
    kind: 'col',
    path,
    name: `${name} (raw)`,
    type: 'object',
    hidden: true,
    ...(isReadonly ? { readonly: true } : {}),
  });

  return cols;
}

/**
 * A column offering the object's useful inner scalars as selectable subfields, with the first
 * preselected. Only subfields the schema actually declares are offered, so a shape change in the
 * API can't leave the view pointing at a path that isn't there. A relative path may span several
 * levels (`subscription_details.subscription`); every hop is resolved through the schema.
 */
function buildPluckedSubfieldCol(
  path: string,
  name: string,
  properties: Record<string, TSchema>,
  pluckable: { relativePath: string; name: string }[],
  isReadonly: boolean,
): TableViewCol | undefined {
  const subfields: TableViewSubfield[] = [];
  for (const candidate of pluckable) {
    const declaredSubfieldSchema = schemaAtRelativePath(properties, candidate.relativePath);
    if (declaredSubfieldSchema === undefined) continue;
    subfields.push({
      name: candidate.name,
      relativePath: candidate.relativePath,
      type: mapType(declaredSubfieldSchema),
      ...(isReadonly ? { readonly: true } : {}),
    });
  }

  if (subfields.length === 0) return undefined;

  return {
    kind: 'col',
    path,
    name,
    type: 'object',
    subfields,
    selectedSubfield: 0,
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/** Build the column(s) a single top-level schema field contributes to the view. */
function buildColsForField(fieldId: string, fieldSchema: TSchema): TableViewCol[] {
  const name = formatFieldName(fieldId);
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;

  if (HIDDEN_FIELDS.has(fieldId)) {
    return [
      {
        kind: 'col',
        path: fieldId,
        name,
        type: mapType(fieldSchema),
        ...(isReadonly ? { readonly: true } : {}),
        hidden: true,
      },
    ];
  }

  const properties = objectPropertiesOf(fieldSchema);

  if (properties) {
    const pluckable = PLUCKED_SUBFIELDS_BY_FIELD_NAME[fieldId];
    if (pluckable) {
      const pluckedCol = buildPluckedSubfieldCol(fieldId, name, properties, pluckable, isReadonly);
      if (pluckedCol) return [pluckedCol];
    }

    if (COMPOSITE_OBJECT_FIELDS.has(fieldId)) {
      return expandCompositeObjectCols(fieldId, name, properties, isReadonly);
    }
  }

  return [buildLeafCol(fieldId, name, fieldSchema, isReadonly)];
}
