import type { TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { STRIPE_OBJECT_SCHEMAS_BY_STRIPE_OBJECT_NAME, type StripeObjectName } from './stripe-object-schemas.generated';
import { STRIPE_UNIX_TIMESTAMP_DATA_TYPE, StripeEntityType } from './stripe-types';

/**
 * Display names for Stripe entity types
 */
const ENTITY_DISPLAY_NAMES: Record<StripeEntityType, string> = {
  customers: 'Customers',
  products: 'Products',
  prices: 'Prices',
  subscriptions: 'Subscriptions',
  invoices: 'Invoices',
  payment_intents: 'Payment Intents',
  charges: 'Charges',
  refunds: 'Refunds',
  disputes: 'Disputes',
  credit_notes: 'Credit Notes',
  coupons: 'Coupons',
  promotion_codes: 'Promotion Codes',
  balance_transactions: 'Balance Transactions',
  subscription_schedules: 'Subscription Schedules',
  events: 'Events',
};

/**
 * Path under the Stripe dashboard for each entity type's list view. Most match
 * the entity name, but payment intents, charges, and refunds all live under
 * /payments, credit notes under /invoices, promotion codes under /coupons, and
 * subscription schedules under /subscriptions.
 */
const STRIPE_DASHBOARD_PATHS: Record<StripeEntityType, string> = {
  customers: 'customers',
  products: 'products',
  prices: 'prices',
  subscriptions: 'subscriptions',
  invoices: 'invoices',
  payment_intents: 'payments',
  charges: 'payments',
  refunds: 'payments',
  disputes: 'disputes',
  credit_notes: 'invoices',
  coupons: 'coupons',
  promotion_codes: 'coupons',
  balance_transactions: 'balance/overview',
  subscription_schedules: 'subscriptions',
  events: 'events',
};

/**
 * Get the title column remote ID for an entity type.
 */
function getTitleColumnRemoteId(entityType: StripeEntityType): string[] {
  switch (entityType) {
    case 'customers':
      return ['name'];
    case 'products':
      return ['name'];
    case 'prices':
      return ['nickname'];
    case 'subscriptions':
      return ['id'];
    case 'invoices':
      return ['number'];
    case 'payment_intents':
      return ['id'];
    case 'charges':
      return ['id'];
    case 'credit_notes':
      return ['number'];
    case 'coupons':
      return ['name'];
    case 'promotion_codes':
      return ['code'];
    case 'refunds':
    case 'disputes':
    case 'balance_transactions':
    case 'subscription_schedules':
    case 'events':
      return ['id'];
  }
}

/**
 * Get the slug field path for auto-generated filenames.
 * Falls back to 'id' for entity types without a good human-readable field.
 */
function getSlugFieldPath(entityType: StripeEntityType): string {
  switch (entityType) {
    case 'customers':
      return 'name';
    case 'products':
      return 'name';
    case 'prices':
      return 'nickname';
    case 'invoices':
      return 'number';
    case 'credit_notes':
      return 'number';
    case 'coupons':
      return 'name';
    case 'promotion_codes':
      return 'code';
    case 'subscriptions':
    case 'payment_intents':
    case 'charges':
    case 'refunds':
    case 'disputes':
    case 'balance_transactions':
    case 'subscription_schedules':
    case 'events':
      return 'id';
  }
}

/** The Stripe object each table holds, by Stripe's own object name. */
const STRIPE_OBJECT_NAME_BY_ENTITY_TYPE: Record<StripeEntityType, StripeObjectName> = {
  customers: 'customer',
  products: 'product',
  prices: 'price',
  subscriptions: 'subscription',
  invoices: 'invoice',
  payment_intents: 'payment_intent',
  charges: 'charge',
  refunds: 'refund',
  disputes: 'dispute',
  credit_notes: 'credit_note',
  coupons: 'coupon',
  promotion_codes: 'promotion_code',
  balance_transactions: 'balance_transaction',
  subscription_schedules: 'subscription_schedule',
  events: 'event',
};

/** The table holding each Stripe object, for turning an id that points at one into a foreign key. */
const ENTITY_TYPE_BY_STRIPE_OBJECT_NAME = new Map<string, StripeEntityType>(
  Object.entries(STRIPE_OBJECT_NAME_BY_ENTITY_TYPE).map(([entityType, stripeObjectName]) => [
    stripeObjectName,
    entityType as StripeEntityType,
  ]),
);

/**
 * Marker the generator leaves on an expandable field's string id: the Stripe objects the id can point
 * at (`['customer', 'deleted_customer']`). Stripe returns the id because the connector expands nothing.
 */
const STRIPE_EXPANDABLE_RESOURCES_KEY = 'x-stripe-expandable-resources';

/** Stripe's own `format` for an integer holding a Unix-epoch time in seconds. */
const STRIPE_UNIX_TIME_FORMAT = 'unix-time';

/** A JSON Schema node as the generated file declares it (plain JSON, no TypeBox symbols). */
interface JsonSchemaNode {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  [annotation: string]: unknown;
}

/**
 * The table an expandable id points at, or undefined when it can point at objects in several tables
 * (a balance transaction's `source` is a charge, refund, payout, or one of a dozen others) or at an
 * object the connector has no table for. A deleted object (`deleted_customer`) is the same table's
 * record after deletion.
 */
function entityTypeReferencedByExpandableId(stripeObjectNames: string[]): StripeEntityType | undefined {
  const referencedEntityTypes = new Set(
    stripeObjectNames.map((stripeObjectName) =>
      ENTITY_TYPE_BY_STRIPE_OBJECT_NAME.get(stripeObjectName.replace(/^deleted_/, '')),
    ),
  );
  if (referencedEntityTypes.size !== 1) return undefined;
  const [referencedEntityType] = referencedEntityTypes;
  return referencedEntityType;
}

/**
 * Turn the generator's Stripe-native markers on one schema node, and everything below it, into Scratch
 * annotations: an epoch-seconds integer gets the timestamp annotation (so the view builds a date
 * column backed by an `epoch_to_iso` codec), and an id pointing at a Stripe table becomes a foreign
 * key. Annotations go on the node itself — on a nullable field, the `anyOf` wrapper — which is where
 * the view and the schema flattener read them.
 */
function annotateSchemaNode(node: JsonSchemaNode): void {
  const nonNullArms = node.anyOf?.filter((arm) => arm.type !== 'null');
  if (nonNullArms && nonNullArms.length > 1) {
    for (const arm of nonNullArms) annotateSchemaNode(arm);
    return;
  }
  const shape = nonNullArms?.[0] ?? node;

  if (shape.format === STRIPE_UNIX_TIME_FORMAT) {
    delete shape.format;
    node[X_SCRATCH_CONNECTOR_DATA_TYPE] = STRIPE_UNIX_TIMESTAMP_DATA_TYPE;
  }

  const expandableResourceNames = shape[STRIPE_EXPANDABLE_RESOURCES_KEY] as string[] | undefined;
  if (expandableResourceNames) {
    delete shape[STRIPE_EXPANDABLE_RESOURCES_KEY];
    const referencedEntityType = entityTypeReferencedByExpandableId(expandableResourceNames);
    if (referencedEntityType) {
      node[X_SCRATCH_FOREIGN_KEY_OPTIONS] = {
        linkedTableId: referencedEntityType,
        linkedTableRemoteId: [referencedEntityType],
      };
    }
  }

  for (const propertySchema of Object.values(shape.properties ?? {})) annotateSchemaNode(propertySchema);
  if (shape.additionalProperties) annotateSchemaNode(shape.additionalProperties);
  if (shape.items) annotateSchemaNode(shape.items);
}

/**
 * Mark a top-level field read-only, since the connector is. An `x-scratch-*` key on an object makes
 * the schema flattener treat it as one opaque value and stop walking into it, which would hide a
 * foreign key nested inside (a promotion code's `promotion.coupon`). So a non-nullable object gets
 * the same one-arm `anyOf` wrapper a nullable one already has, and the annotation goes on that.
 */
function readonlyTopLevelField(fieldSchema: JsonSchemaNode): JsonSchemaNode {
  if (!fieldSchema.anyOf && fieldSchema.type === 'object' && fieldSchema.properties) {
    const { description, ...objectShape } = fieldSchema;
    return { anyOf: [objectShape], ...(description ? { description } : {}), [X_SCRATCH_READONLY]: true };
  }
  fieldSchema[X_SCRATCH_READONLY] = true;
  return fieldSchema;
}

/**
 * Build the record schema for one Stripe table from the shapes generated from Stripe's OpenAPI spec
 * (`stripe-object-schemas.generated.ts`), so every field Stripe returns is declared — and can reach a
 * Live Export — without being typed in by hand.
 */
export function buildStripeRecordSchema(entityType: StripeEntityType): TSchema {
  const schema = structuredClone(
    STRIPE_OBJECT_SCHEMAS_BY_STRIPE_OBJECT_NAME[STRIPE_OBJECT_NAME_BY_ENTITY_TYPE[entityType]],
  ) as JsonSchemaNode;

  annotateSchemaNode(schema);

  const properties: Record<string, JsonSchemaNode> = {};
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    properties[fieldName] = readonlyTopLevelField(fieldSchema);
  }
  schema.properties = properties;
  schema.$id = `stripe/${entityType}`;
  schema.title = ENTITY_DISPLAY_NAMES[entityType];
  return schema as TSchema;
}

/**
 * Build the JSON Table Spec for a Stripe entity type.
 *
 * FIXTURE NOTE: real `schema.json` output of this generator is checked in as a codec-test input
 * under `server/src/sync/__fixtures__/view-codec/stripe-*`. Those fixtures are captured inputs,
 * NOT snapshots — there is no automated regeneration. When the generated Stripe schemas change
 * (a regenerated `stripe-object-schemas.generated.ts`, or a change to `buildStripeRecordSchema`),
 * update the matching fixture `schema.json` to match and re-run
 * `jest -u server/src/sync/view-codec-snapshots.spec.ts`, or the view-codec guardrail keeps
 * exercising the old shape.
 */
export function buildStripeJsonTableSpec(id: EntityId, entityType: StripeEntityType): BaseJsonTableSpec {
  const schema = buildStripeRecordSchema(entityType);

  return {
    id,
    slug: id.wsId,
    name: ENTITY_DISPLAY_NAMES[entityType],
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath(getTitleColumnRemoteId(entityType).join('.')),
    slugPath: dotPath(getSlugFieldPath(entityType)),
    basePath: [],
    // Deep link to this entity's list view in the Stripe dashboard, e.g.
    // https://dashboard.stripe.com/customers (live mode).
    remoteWebUrl: `https://dashboard.stripe.com/${STRIPE_DASHBOARD_PATHS[entityType]}`,
    generatedAt: new Date().toISOString(),
  };
}
