import { Type, type TSchema } from '@sinclair/typebox';
import {
  getSuggestedTransform,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  type CreateFieldType,
  type TableView,
  type TransformerConfig,
} from '@spinner/shared-types';
import { applyDisplayTransformer } from '@spinner/shared-types/transform';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { inferLogicalFieldType } from 'src/schema-builder/schema-builder-plan-generator';
import {
  columnTransformInputFromSchemaField,
  resolveColumnTransformInput,
} from 'src/sync/resolve-column-transform-input';
import { validateSchemaMapping } from 'src/sync/schema-validator';
import { getSchemaAtFieldPath, readFieldValueAtPath } from 'src/utils/field-path';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';
import { EntityId } from '../../../types';
import { buildAirtableCreateField } from '../../airtable/airtable-create-schema';
import { POSTGRES_SCHEMA_CREATION_CAPABILITIES } from '../../pg-common/pg-create-schema';
import { mapPgType } from '../../pg-common/pg-type-mapping';
import { buildStripeDefaultView } from '../stripe-default-view';
import { buildStripeJsonTableSpec } from '../stripe-json-schema';
import { StripeEntityType } from '../stripe-types';

/**
 * End-to-end Live Export coverage for Stripe: what a user actually ends up with on a destination.
 *
 * The unit specs check each layer in isolation; this one walks the whole chain the export takes —
 * default view → plan field selection → logical field type → the destination pack's native field —
 * because every Stripe Live Export bug in this batch was a seam between two of those layers rather
 * than a fault inside any one of them (DEV-11145, DEV-11147, DEV-11148, DEV-11149).
 */

function specFor(entityType: StripeEntityType) {
  const id = { wsId: entityType, remoteId: [entityType] } as unknown as EntityId;
  return buildStripeJsonTableSpec(id, entityType);
}

function viewFor(entityType: StripeEntityType): TableView {
  return buildStripeDefaultView(specFor(entityType).schema, entityType);
}

/** Every path the plan would propose as a destination field — i.e. what the user is offered. */
function exportedPaths(entityType: StripeEntityType): string[] {
  const spec = specFor(entityType);
  return selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: viewFor(entityType),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  }).schemaFields.map((field) => field.path);
}

/** The create-field type the schema builder would give this column's destination field. */
function createFieldTypeFor(entityType: StripeEntityType, path: string): CreateFieldType {
  const spec = specFor(entityType);
  const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: viewFor(entityType),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  });
  const field = schemaFields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`No plan field at ${path} — it is not offered for export`);
  return inferLogicalFieldType(field, viewTypeByPath[path], 'Stripe').fieldType;
}

/**
 * The create-field type a Postgres destination (the business warehouse) would get for this column — the
 * same inputs `SchemaBuilderService` hands the plan generator: the view's type hint, the view column's own
 * unpack codec in place of the schema's, and Postgres's JSON / list column support.
 */
function postgresCreateFieldTypeFor(entityType: StripeEntityType, path: string): CreateFieldType {
  const spec = specFor(entityType);
  const { schemaFields, viewTypeByPath, viewUnpackTransformerByPath } = selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: viewFor(entityType),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  });
  const field = schemaFields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`No plan field at ${path} — it is not offered for export`);
  const viewUnpackTransformer = viewUnpackTransformerByPath[path];
  return inferLogicalFieldType(
    viewUnpackTransformer ? { ...field, suggestedTransformer: viewUnpackTransformer } : field,
    viewTypeByPath[path],
    'Stripe',
    {
      supportedFieldKinds: POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds,
      supportedArrayElementKinds: POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedArrayElementKinds,
      nativeTypeSystem: POSTGRES_SCHEMA_CREATION_CAPABILITIES.nativeTypeSystem,
    },
  ).fieldType;
}

/** A Postgres destination column's schema as the Postgres connector reports it after creating the column. */
function postgresColumnSchema(dataType: string, udtName: string): TSchema {
  const { schema, pgType } = mapPgType(dataType, udtName, true);
  return { ...schema, [X_SCRATCH_CONNECTOR_DATA_TYPE]: pgType } as TSchema;
}

/** The destination schema field for a single Postgres column. */
function postgresDestinationField(columnName: string, dataType: string, udtName: string): SchemaField {
  const [field] = extractSchemaFields(Type.Object({ [columnName]: postgresColumnSchema(dataType, udtName) }));
  return field;
}

/** The transformer chain Live Export stores for copying a Stripe column into a Postgres column. */
function transformerChainIntoPostgres(
  entityType: StripeEntityType,
  sourcePath: string,
  destinationField: SchemaField,
): TransformerConfig[] {
  const spec = specFor(entityType);
  const sourceFieldsByPath = new Map(extractSchemaFields(spec.schema).map((field) => [field.path, field]));
  const suggestion = getSuggestedTransform(
    resolveColumnTransformInput({
      columnId: sourcePath,
      schema: spec.schema,
      fieldsByPath: sourceFieldsByPath,
      view: viewFor(entityType),
    }),
    columnTransformInputFromSchemaField(destinationField),
  );
  if (suggestion.result !== 'valid') throw new Error(suggestion.reason);
  return suggestion.options[0].transformerChain;
}

/** The native Airtable field the destination pack would create for a column. */
function airtableFieldFor(entityType: StripeEntityType, path: string) {
  const built = buildAirtableCreateField(
    { name: path, fieldType: createFieldTypeFor(entityType, path) },
    { baseId: 'appBASE' },
  );
  if ('skip' in built) throw new Error(`Airtable skipped ${path}: ${built.skip}`);
  return built.field;
}

// ── DEV-11145 ──
describe('Unix-epoch timestamps reach a destination as real dates', () => {
  it('creates a time-bearing date field, not a number', () => {
    // The whole point: `created` used to land as a number column holding 1785436554.
    expect(createFieldTypeFor('customers', 'created')).toEqual({ kind: 'date', includesTime: true });
  });

  it('becomes an Airtable dateTime column that keeps the time of day', () => {
    const field = airtableFieldFor('customers', 'created');

    expect(field.type).toBe('dateTime');
  });

  it('reports the field as cleanly mapped, with no downgrade warning', () => {
    const spec = specFor('customers');
    const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: viewFor('customers'),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    });
    const created = schemaFields.find((field) => field.path === 'created');
    if (!created) throw new Error('created is not offered for export');

    expect(inferLogicalFieldType(created, viewTypeByPath['created'], 'Stripe').status).toBe('mapped');
  });

  it('renders the raw epoch as a date in the grid', () => {
    const created = viewFor('customers').cols.find((c) => c.kind === 'col' && c.path === 'created');
    const displayTransformer = created?.kind === 'col' ? created.displayTransformer : undefined;
    if (!displayTransformer) throw new Error('created has no display transformer');

    expect(applyDisplayTransformer(displayTransformer, 1785436554)).toEqual({
      ok: true,
      value: '2026-07-30T18:35:54.000Z',
    });
  });

  it('leaves an ordinary number field as a number', () => {
    expect(createFieldTypeFor('customers', 'balance')).toEqual({ kind: 'number' });
  });
});

// ── DEV-11148 ──
describe('fields that used to be dropped are now offered for export', () => {
  it('exports a customer address as one destination field per subfield', () => {
    const paths = exportedPaths('customers');

    expect(paths).toEqual(expect.arrayContaining(['address.city', 'address.line1', 'address.postal_code']));
    // The raw container stays hidden, so it is NOT proposed as a duplicate field.
    expect(paths).not.toContain('address');
  });

  it('exports a nested shipping address', () => {
    expect(exportedPaths('customers')).toEqual(
      expect.arrayContaining(['shipping.name', 'shipping.address.city', 'shipping.address.line1']),
    );
  });

  it('exports charge billing details', () => {
    expect(exportedPaths('charges')).toEqual(
      expect.arrayContaining(['billing_details.email', 'billing_details.address.city']),
    );
  });

  it('exports product images and subscription items rather than dropping them silently', () => {
    expect(exportedPaths('products')).toContain('images');
    expect(exportedPaths('subscriptions')).toContain('items');
  });

  it('creates address subfields as ordinary text columns', () => {
    expect(createFieldTypeFor('customers', 'address.city')).toEqual({ kind: 'text' });
  });

  it('warns rather than silently dropping when a list can only ride through as text', () => {
    const spec = specFor('products');
    const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: viewFor('products'),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    });
    const images = schemaFields.find((field) => field.path === 'images');
    if (!images) throw new Error('images is not offered for export');
    const inferred = inferLogicalFieldType(images, viewTypeByPath['images'], 'Stripe');

    expect(inferred.status).toBe('downgraded');
    expect(inferred.fieldType).toEqual({ kind: 'text' });
  });

  it('still keeps genuine plumbing out of the export', () => {
    const paths = exportedPaths('customers');

    expect(paths).not.toContain('object');
    expect(paths).not.toContain('livemode');
  });

  it.each<StripeEntityType>([
    'customers',
    'products',
    'prices',
    'subscriptions',
    'invoices',
    'payment_intents',
    'charges',
  ])('exports %s metadata as one downgraded-text column', (entityType) => {
    const spec = specFor(entityType);
    const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: viewFor(entityType),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    });
    const metadata = schemaFields.find((field) => field.path === 'metadata');
    if (!metadata) throw new Error(`${entityType}.metadata is not offered for export`);
    const inferred = inferLogicalFieldType(metadata, viewTypeByPath['metadata'], 'Stripe');

    expect(inferred.status).toBe('downgraded');
    expect(inferred.fieldType).toEqual({ kind: 'text' });
  });
});

// ── DEV-11149 ──
describe('prices.recurring exports a real interval column, not raw JSON', () => {
  it('proposes the plucked subfield path instead of the container', () => {
    const paths = exportedPaths('prices');

    expect(paths).toContain('recurring.interval');
    expect(paths).not.toContain('recurring');
  });

  it('creates it as text rather than downgrading an object to a JSON blob', () => {
    expect(createFieldTypeFor('prices', 'recurring.interval')).toEqual({ kind: 'text' });
  });
});

// ── DEV-11147 ──
describe('multi-line text survives the Airtable destination pack', () => {
  it('creates a Stripe description as multilineText, which preserves newlines', () => {
    // `singleLineText` silently collapses newlines and tabs to spaces.
    expect(airtableFieldFor('customers', 'description').type).toBe('multilineText');
  });
});

// ── Business warehouse (Postgres) gaps, in the order they were reported ──
describe('subscriptions.cancellation_details reaches Postgres as jsonb', () => {
  it('is offered for export and created as a json column', () => {
    expect(exportedPaths('subscriptions')).toContain('cancellation_details');
    expect(postgresCreateFieldTypeFor('subscriptions', 'cancellation_details')).toEqual({ kind: 'json' });
  });

  it('copies the object into the jsonb column whole', () => {
    expect(
      transformerChainIntoPostgres(
        'subscriptions',
        'cancellation_details',
        postgresDestinationField('cancellation_details', 'jsonb', 'jsonb'),
      ),
    ).toEqual([]);
  });
});

describe('invoices.total_taxes reaches Postgres as a jsonb array', () => {
  it('is created as a json column rather than flattened to text', () => {
    expect(postgresCreateFieldTypeFor('invoices', 'total_taxes')).toEqual({ kind: 'json' });
  });

  it('copies the array in whole instead of joining it into `{…},{…}` text', () => {
    const chain = transformerChainIntoPostgres(
      'invoices',
      'total_taxes',
      postgresDestinationField('total_taxes', 'jsonb', 'jsonb'),
    );

    expect(chain).toEqual([]);
  });

  it('passes save-time validation with no transformers', () => {
    const destinationSchema = Type.Object({ total_taxes: postgresColumnSchema('jsonb', 'jsonb') });

    expect(
      validateSchemaMapping(specFor('invoices').schema, destinationSchema, [
        { sourceColumnId: 'total_taxes', destinationColumnId: 'total_taxes' },
      ]),
    ).toEqual([]);
  });
});

describe('invoice line items and discounts', () => {
  it.each(['lines', 'total_discount_amounts'])('creates invoices.%s as a json column', (path) => {
    expect(postgresCreateFieldTypeFor('invoices', path)).toEqual({ kind: 'json' });
  });

  it('creates invoices.discounts (discount ids) as a text list', () => {
    expect(postgresCreateFieldTypeFor('invoices', 'discounts')).toEqual({ kind: 'text', isArray: true });
  });
});

describe('fields added to existing tables', () => {
  it.each<[StripeEntityType, string, CreateFieldType]>([
    ['subscriptions', 'cancel_at', { kind: 'date', includesTime: true }],
    ['subscriptions', 'discounts', { kind: 'text', isArray: true }],
    ['subscriptions', 'pause_collection', { kind: 'json' }],
    ['invoices', 'billing_reason', { kind: 'text' }],
    ['invoices', 'attempt_count', { kind: 'number' }],
    ['invoices', 'next_payment_attempt', { kind: 'date', includesTime: true }],
    ['prices', 'recurring.interval_count', { kind: 'number' }],
  ])('creates %s.%s as %j', (entityType, path, expectedFieldType) => {
    expect(postgresCreateFieldTypeFor(entityType, path)).toEqual(expectedFieldType);
  });

  // The warehouse export already maps `recurring.interval` → "Recurring"; switching `recurring` from a
  // plucked column to one column per subfield must leave that mapping resolving to the same value.
  it('keeps the existing prices recurring.interval mapping valid', () => {
    expect(exportedPaths('prices')).toEqual(expect.arrayContaining(['recurring.interval', 'recurring.interval_count']));
    expect(
      validateSchemaMapping(
        specFor('prices').schema,
        Type.Object({ Recurring: postgresColumnSchema('text', 'text') }),
        [{ sourceColumnId: 'recurring.interval', destinationColumnId: 'Recurring' }],
      ),
    ).toEqual([]);
  });
});

describe("subscriptions' current period, read from the first item", () => {
  const periodStartPath = 'items.data.0.current_period_start';

  it('is offered for export as a timestamp column', () => {
    expect(exportedPaths('subscriptions')).toEqual(
      expect.arrayContaining([periodStartPath, 'items.data.0.current_period_end']),
    );
    expect(postgresCreateFieldTypeFor('subscriptions', periodStartPath)).toEqual({ kind: 'date', includesTime: true });
  });

  it('converts the epoch to ISO on the way into a timestamptz column', () => {
    expect(
      transformerChainIntoPostgres(
        'subscriptions',
        periodStartPath,
        postgresDestinationField('current_period_start', 'timestamp with time zone', 'timestamptz'),
      ),
    ).toEqual([{ type: TransformerTypes.EpochToIso, options: { unit: 'seconds' } }]);
  });

  it('passes save-time validation of the source path', () => {
    expect(
      validateSchemaMapping(
        specFor('subscriptions').schema,
        Type.Object({ current_period_start: postgresColumnSchema('timestamp with time zone', 'timestamptz') }),
        [
          {
            sourceColumnId: periodStartPath,
            destinationColumnId: 'current_period_start',
            transformers: [{ type: TransformerTypes.EpochToIso, options: { unit: 'seconds' } }],
          },
        ],
      ),
    ).toEqual([]);
  });

  it('reads the period from a subscription record as Stripe returns it', () => {
    const subscription = {
      id: 'sub_1',
      items: {
        object: 'list',
        data: [{ id: 'si_1', current_period_start: 1785436554, current_period_end: 1788114954 }],
      },
    };

    expect(readFieldValueAtPath(subscription, periodStartPath)).toBe(1785436554);
  });
});

describe('new tables', () => {
  it.each<[StripeEntityType, string, string]>([
    ['refunds', 'charge', 'charges'],
    ['refunds', 'balance_transaction', 'balance_transactions'],
    ['disputes', 'charge', 'charges'],
    ['credit_notes', 'invoice', 'invoices'],
    ['promotion_codes', 'promotion.coupon', 'coupons'],
    ['subscription_schedules', 'subscription', 'subscriptions'],
  ])('exports %s.%s as a foreign key to %s', (entityType, path, linkedTableId) => {
    const spec = specFor(entityType);
    const planField = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: viewFor(entityType),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    }).schemaFields.find((field) => field.path === path);

    expect(planField?.foreignKey).toEqual({ linkedTableId, linkedTableRemoteId: [linkedTableId] });
  });

  it.each<[StripeEntityType, string]>([
    ['balance_transactions', 'fee_details'],
    ['credit_notes', 'lines'],
    ['disputes', 'balance_transactions'],
    ['subscription_schedules', 'phases'],
  ])('creates %s.%s as a json column', (entityType, path) => {
    expect(postgresCreateFieldTypeFor(entityType, path)).toEqual({ kind: 'json' });
  });

  it('exports the money columns a reconciliation needs from balance transactions', () => {
    expect(exportedPaths('balance_transactions')).toEqual(
      expect.arrayContaining(['amount', 'fee', 'net', 'source', 'reporting_category', 'available_on']),
    );
  });
});

// The source paths the business warehouse's Stripe → Postgres export maps today. Generating the schemas
// from Stripe's OpenAPI spec must keep every one of them declared (save-time validation resolves each
// path against the schema) and offered by the default view, or that export stops saving.
const SOURCE_PATHS_MAPPED_BY_AN_EXISTING_EXPORT: Partial<Record<StripeEntityType, string[]>> = {
  charges: [
    'customer',
    'amount',
    'currency',
    'status',
    'paid',
    'captured',
    'refunded',
    'description',
    'created',
    'amount_captured',
    'amount_refunded',
    'billing_details.name',
    'billing_details.email',
    'billing_details.phone',
    'billing_details.address.city',
    'billing_details.address.country',
    'billing_details.address.line1',
    'billing_details.address.line2',
    'billing_details.address.postal_code',
    'billing_details.address.state',
    'disputed',
    'failure_code',
    'failure_message',
    'payment_intent',
    'payment_method',
    'receipt_email',
    'receipt_url',
    'metadata',
  ],
  customers: [
    'name',
    'email',
    'phone',
    'description',
    'currency',
    'balance',
    'delinquent',
    'created',
    'address.city',
    'address.country',
    'address.line1',
    'address.line2',
    'address.postal_code',
    'address.state',
    'default_source',
    'invoice_settings.default_payment_method',
    'invoice_settings.footer',
    'shipping.name',
    'shipping.phone',
    'shipping.address.city',
    'shipping.address.country',
    'shipping.address.line1',
    'shipping.address.line2',
    'shipping.address.postal_code',
    'shipping.address.state',
    'tax_exempt',
    'metadata',
  ],
  invoices: [
    'number',
    'customer',
    'status',
    'currency',
    'amount_due',
    'amount_paid',
    'total',
    'due_date',
    'created',
    'amount_remaining',
    'collection_method',
    'description',
    'hosted_invoice_url',
    'invoice_pdf',
    'parent.subscription_details.subscription',
    'period_end',
    'period_start',
    'status_transitions.finalized_at',
    'status_transitions.marked_uncollectible_at',
    'status_transitions.paid_at',
    'status_transitions.voided_at',
    'subtotal',
    'total_taxes',
    'metadata',
  ],
  payment_intents: [
    'customer',
    'amount',
    'amount_received',
    'currency',
    'status',
    'description',
    'created',
    'capture_method',
    'confirmation_method',
    'latest_charge',
    'payment_method',
    'metadata',
  ],
  prices: [
    'nickname',
    'product',
    'active',
    'currency',
    'unit_amount',
    'type',
    'recurring.interval',
    'created',
    'billing_scheme',
    'lookup_key',
    'unit_amount_decimal',
    'metadata',
  ],
  products: [
    'name',
    'description',
    'active',
    'type',
    'default_price',
    'url',
    'created',
    'images',
    'updated',
    'metadata',
  ],
  subscriptions: [
    'customer',
    'status',
    'currency',
    'start_date',
    'cancel_at_period_end',
    'created',
    'canceled_at',
    'collection_method',
    'default_payment_method',
    'ended_at',
    'items',
    'latest_invoice',
    'trial_end',
    'trial_start',
    'metadata',
  ],
};

describe('an existing export keeps working on the generated schemas', () => {
  const mappedPathCases = Object.entries(SOURCE_PATHS_MAPPED_BY_AN_EXISTING_EXPORT).flatMap(([entityType, paths]) =>
    (paths ?? []).map((path): [StripeEntityType, string] => [entityType as StripeEntityType, path]),
  );

  it.each(mappedPathCases)('still declares and offers %s.%s', (entityType, path) => {
    expect(getSchemaAtFieldPath(specFor(entityType).schema, path)).toBeDefined();
    expect(exportedPaths(entityType)).toContain(path);
  });

  it.each(
    mappedPathCases.filter(([, path]) => path.endsWith('created') || path.endsWith('_at') || path.endsWith('_date')),
  )('still exports %s.%s as a datetime', (entityType, path) => {
    expect(postgresCreateFieldTypeFor(entityType, path)).toEqual({ kind: 'date', includesTime: true });
  });

  it.each<[StripeEntityType, string, string]>([
    ['charges', 'customer', 'customers'],
    ['charges', 'payment_intent', 'payment_intents'],
    ['invoices', 'customer', 'customers'],
    ['invoices', 'parent.subscription_details.subscription', 'subscriptions'],
    ['payment_intents', 'customer', 'customers'],
    ['payment_intents', 'latest_charge', 'charges'],
    ['prices', 'product', 'products'],
    ['products', 'default_price', 'prices'],
    ['subscriptions', 'customer', 'customers'],
    ['subscriptions', 'latest_invoice', 'invoices'],
  ])('still links %s.%s to %s', (entityType, path, linkedTableId) => {
    const spec = specFor(entityType);
    const planField = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: viewFor(entityType),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    }).schemaFields.find((field) => field.path === path);

    expect(planField?.foreignKey).toEqual({ linkedTableId, linkedTableRemoteId: [linkedTableId] });
  });
});

describe('client secrets never reach a destination', () => {
  it.each<[StripeEntityType, string]>([
    ['payment_intents', 'client_secret'],
    ['invoices', 'confirmation_secret'],
  ])('keeps %s.%s out of the export', (entityType, path) => {
    expect(specFor(entityType).schema.properties).toHaveProperty(path);
    expect(exportedPaths(entityType)).not.toContain(path);
  });

  // An event's `data` is a snapshot of the object that changed, client secret included.
  it("keeps an event's data snapshot out of the export", () => {
    expect(exportedPaths('events').some((path) => path === 'data' || path.startsWith('data.object.'))).toBe(true);
    expect(exportedPaths('events')).not.toContain('data');
  });

  it.each(['data.object.id', 'data.object.object'])('exports events.%s as text, and it saves', (path) => {
    expect(exportedPaths('events')).toContain(path);
    expect(postgresCreateFieldTypeFor('events', path)).toEqual({ kind: 'text' });
    expect(
      validateSchemaMapping(
        specFor('events').schema,
        Type.Object({ object_id: postgresColumnSchema('text', 'text') }),
        [{ sourceColumnId: path, destinationColumnId: 'object_id' }],
      ),
    ).toEqual([]);
  });

  it.each<[StripeEntityType, string]>([
    ['payment_intents', 'last_payment_error'],
    ['invoices', 'last_finalization_error'],
  ])("exports %s.%s's codes and message, not the objects it embeds", (entityType, errorField) => {
    const paths = exportedPaths(entityType);

    expect(paths).toEqual(
      expect.arrayContaining([`${errorField}.code`, `${errorField}.decline_code`, `${errorField}.message`]),
    );
    expect(paths).not.toContain(errorField);
    expect(paths).not.toContain(`${errorField}.setup_intent`);
    expect(paths).not.toContain(`${errorField}.payment_intent`);
  });

  // A guard for every table: no exported column's schema holds a client secret at any depth, so a JSON
  // column can't carry one in an embedded object either.
  it.each<StripeEntityType>([
    'customers',
    'products',
    'prices',
    'subscriptions',
    'invoices',
    'payment_intents',
    'charges',
    'refunds',
    'disputes',
    'credit_notes',
    'coupons',
    'promotion_codes',
    'balance_transactions',
    'subscription_schedules',
    'events',
  ])('exports no column from %s that can hold a client secret', (entityType) => {
    const schema = specFor(entityType).schema;
    for (const path of exportedPaths(entityType)) {
      expect({ path, schema: JSON.stringify(getSchemaAtFieldPath(schema, path)) }).not.toMatchObject({
        schema: expect.stringContaining('client_secret') as unknown,
      });
    }
  });

  it('reads the id of the object an event is about', () => {
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', object: 'payment_intent', client_secret: 'pi_1_secret_x' } },
    };

    expect(readFieldValueAtPath(event, 'data.object.id')).toBe('pi_1');
  });
});
