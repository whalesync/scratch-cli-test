/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { extractSchemaFields } from '../../../../../utils/schema-helpers';
import { STRIPE_CONNECTOR_API_VERSION } from '../stripe-api-client';
import { buildStripeJsonTableSpec, buildStripeRecordSchema } from '../stripe-json-schema';
import {
  STRIPE_OBJECT_SCHEMAS_API_VERSION,
  STRIPE_OBJECT_SCHEMAS_BY_STRIPE_OBJECT_NAME,
} from '../stripe-object-schemas.generated';
import { STRIPE_UNIX_TIMESTAMP_DATA_TYPE, StripeEntityType } from '../stripe-types';

describe('buildStripeJsonTableSpec', () => {
  const allEntityTypes: StripeEntityType[] = [
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
  ];

  it.each<[StripeEntityType, string, string, string]>([
    ['refunds', 'Refunds', 'id', 'payments'],
    ['disputes', 'Disputes', 'id', 'disputes'],
    ['credit_notes', 'Credit Notes', 'number', 'invoices'],
    ['coupons', 'Coupons', 'name', 'coupons'],
    ['promotion_codes', 'Promotion Codes', 'code', 'coupons'],
    ['balance_transactions', 'Balance Transactions', 'id', 'balance/overview'],
    ['subscription_schedules', 'Subscription Schedules', 'id', 'subscriptions'],
    ['events', 'Events', 'id', 'events'],
  ])('names %s "%s", titles it by %s, and links to /%s', (entityType, name, titleAndSlugPath, dashboardPath) => {
    const spec = buildStripeJsonTableSpec({ wsId: entityType, remoteId: [entityType] }, entityType);

    expect(spec.name).toBe(name);
    expect(spec.titlePath).toBe(titleAndSlugPath);
    expect(spec.slugPath).toBe(titleAndSlugPath);
    expect(spec.remoteWebUrl).toBe(`https://dashboard.stripe.com/${dashboardPath}`);
  });

  // ---------------------------------------------------------------------------
  // Common spec metadata
  // ---------------------------------------------------------------------------

  it.each(allEntityTypes)('builds spec with correct metadata for %s', (entityType) => {
    const entityId = { wsId: entityType, remoteId: [entityType] };
    const spec = buildStripeJsonTableSpec(entityId, entityType);

    expect(spec.slug).toBe(entityType);
    expect(spec.idPath).toBe('id');
    expect(spec.basePath).toEqual([]);
    expect(spec.generatedAt).toBeDefined();
  });

  it.each(allEntityTypes)('includes id field for %s', (entityType) => {
    const entityId = { wsId: entityType, remoteId: [entityType] };
    const spec = buildStripeJsonTableSpec(entityId, entityType);

    expect(spec.schema.properties).toHaveProperty('id');
    expect(spec.schema.properties.id[X_SCRATCH_READONLY]).toBe(true);
  });

  it.each(allEntityTypes)('includes created timestamp for %s', (entityType) => {
    const entityId = { wsId: entityType, remoteId: [entityType] };
    const spec = buildStripeJsonTableSpec(entityId, entityType);

    expect(spec.schema.properties).toHaveProperty('created');
    expect(spec.schema.properties.created[X_SCRATCH_READONLY]).toBe(true);
  });

  // Stripe's refund and balance transaction objects carry no `livemode`.
  const entityTypesWithLivemode = allEntityTypes.filter(
    (entityType) => entityType !== 'refunds' && entityType !== 'balance_transactions',
  );

  it.each(entityTypesWithLivemode)('includes livemode flag for %s', (entityType) => {
    const entityId = { wsId: entityType, remoteId: [entityType] };
    const spec = buildStripeJsonTableSpec(entityId, entityType);

    expect(spec.schema.properties).toHaveProperty('livemode');
    expect(spec.schema.properties.livemode[X_SCRATCH_READONLY]).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Title columns
  // ---------------------------------------------------------------------------

  it('uses name as title for customers', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'customers', remoteId: ['customers'] }, 'customers');
    expect(spec.titlePath).toEqual('name');
  });

  it('uses name as title for products', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'products', remoteId: ['products'] }, 'products');
    expect(spec.titlePath).toEqual('name');
  });

  it('uses nickname as title for prices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'prices', remoteId: ['prices'] }, 'prices');
    expect(spec.titlePath).toEqual('nickname');
  });

  it('uses number as title for invoices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'invoices', remoteId: ['invoices'] }, 'invoices');
    expect(spec.titlePath).toEqual('number');
  });

  it('uses id as title for subscriptions', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'subscriptions', remoteId: ['subscriptions'] }, 'subscriptions');
    expect(spec.titlePath).toEqual('id');
  });

  // ---------------------------------------------------------------------------
  // Slug field paths (for auto-generated filenames)
  // ---------------------------------------------------------------------------

  it('uses name as slug for customers', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'customers', remoteId: ['customers'] }, 'customers');
    expect(spec.slugPath).toBe('name');
  });

  it('uses name as slug for products', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'products', remoteId: ['products'] }, 'products');
    expect(spec.slugPath).toBe('name');
  });

  it('uses nickname as slug for prices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'prices', remoteId: ['prices'] }, 'prices');
    expect(spec.slugPath).toBe('nickname');
  });

  it('uses number as slug for invoices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'invoices', remoteId: ['invoices'] }, 'invoices');
    expect(spec.slugPath).toBe('number');
  });

  it('uses id as slug for subscriptions', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'subscriptions', remoteId: ['subscriptions'] }, 'subscriptions');
    expect(spec.slugPath).toBe('id');
  });

  it('uses id as slug for payment_intents', () => {
    const spec = buildStripeJsonTableSpec(
      { wsId: 'payment_intents', remoteId: ['payment_intents'] },
      'payment_intents',
    );
    expect(spec.slugPath).toBe('id');
  });

  it('uses id as slug for charges', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'charges', remoteId: ['charges'] }, 'charges');
    expect(spec.slugPath).toBe('id');
  });

  // ---------------------------------------------------------------------------
  // Customers
  // ---------------------------------------------------------------------------

  describe('customers', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'customers', remoteId: ['customers'] }, 'customers');
    const props = spec.schema.properties;

    it('includes customer-specific fields', () => {
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('email');
      expect(props).toHaveProperty('phone');
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('address');
      expect(props).toHaveProperty('balance');
      expect(props).toHaveProperty('delinquent');
      expect(props).toHaveProperty('metadata');
      expect(props).toHaveProperty('currency');
    });

    it('has name as Customers', () => {
      expect(spec.name).toBe('Customers');
    });
  });

  // ---------------------------------------------------------------------------
  // Products
  // ---------------------------------------------------------------------------

  describe('products', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'products', remoteId: ['products'] }, 'products');
    const props = spec.schema.properties;

    it('includes product-specific fields', () => {
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('active');
      expect(props).toHaveProperty('default_price');
      expect(props).toHaveProperty('images');
      expect(props).toHaveProperty('url');
    });

    it('links default_price to prices table', () => {
      // default_price is wrapped in Optional(Union([String, Null]))
      // The FOREIGN_KEY_OPTIONS may be on the union wrapper
      const defaultPrice = props.default_price;
      const hasForeignKey = JSON.stringify(defaultPrice).includes('prices');
      expect(hasForeignKey).toBe(true);
    });

    it('has updated timestamp', () => {
      expect(props).toHaveProperty('updated');
      expect(props.updated[X_SCRATCH_READONLY]).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Prices
  // ---------------------------------------------------------------------------

  describe('prices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'prices', remoteId: ['prices'] }, 'prices');
    const props = spec.schema.properties;

    it('includes price-specific fields', () => {
      expect(props).toHaveProperty('product');
      expect(props).toHaveProperty('active');
      expect(props).toHaveProperty('currency');
      expect(props).toHaveProperty('unit_amount');
      expect(props).toHaveProperty('type');
      expect(props).toHaveProperty('recurring');
      expect(props).toHaveProperty('nickname');
    });

    it('links product to products table', () => {
      expect(props.product[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'products',
        linkedTableRemoteId: ['products'],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  describe('subscriptions', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'subscriptions', remoteId: ['subscriptions'] }, 'subscriptions');
    const props = spec.schema.properties;

    it('includes subscription-specific fields', () => {
      expect(props).toHaveProperty('customer');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('cancel_at_period_end');
      expect(props).toHaveProperty('items');
    });

    it('declares the billing period on line items, not on the subscription', () => {
      expect(props).not.toHaveProperty('current_period_start');
      expect(props).not.toHaveProperty('current_period_end');

      // A non-nullable object field carries its read-only flag on a one-arm `anyOf` wrapper.
      const itemProps = props.items.anyOf[0].properties.data.items.properties;
      expect(itemProps).toHaveProperty('current_period_start');
      expect(itemProps).toHaveProperty('current_period_end');
    });

    it('links customer to customers table', () => {
      expect(props.customer[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'customers',
        linkedTableRemoteId: ['customers'],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------

  describe('invoices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'invoices', remoteId: ['invoices'] }, 'invoices');
    const props = spec.schema.properties;

    it('includes invoice-specific fields', () => {
      expect(props).toHaveProperty('customer');
      expect(props).toHaveProperty('parent');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('amount_due');
      expect(props).toHaveProperty('amount_paid');
      expect(props).toHaveProperty('total');
      expect(props).toHaveProperty('number');
      expect(props).toHaveProperty('hosted_invoice_url');
      expect(props).toHaveProperty('invoice_pdf');
    });

    it('drops the fields Stripe removed from the invoice object', () => {
      expect(props).not.toHaveProperty('subscription');
      expect(props).not.toHaveProperty('paid');
      expect(props).not.toHaveProperty('tax');
    });

    it('carries their replacements', () => {
      expect(props).toHaveProperty('status_transitions');
      expect(props).toHaveProperty('total_taxes');
    });

    it('links to customers, and to subscriptions via parent', () => {
      const customerJson = JSON.stringify(props.customer);
      expect(customerJson).toContain('customers');

      const subscriptionFk =
        props.parent.anyOf[0].properties.subscription_details.anyOf[0].properties.subscription[
          X_SCRATCH_FOREIGN_KEY_OPTIONS
        ];
      expect(subscriptionFk).toEqual({ linkedTableId: 'subscriptions', linkedTableRemoteId: ['subscriptions'] });
    });

    it('exposes the nested subscription link as an extractable foreign key', () => {
      const subscriptionField = extractSchemaFields(spec.schema).find(
        (field) => field.path === 'parent.subscription_details.subscription',
      );
      expect(subscriptionField?.foreignKey?.linkedTableId).toBe('subscriptions');
    });
  });

  // ---------------------------------------------------------------------------
  // Payment Intents
  // ---------------------------------------------------------------------------

  describe('payment_intents', () => {
    const spec = buildStripeJsonTableSpec(
      { wsId: 'payment_intents', remoteId: ['payment_intents'] },
      'payment_intents',
    );
    const props = spec.schema.properties;

    it('includes payment intent fields', () => {
      expect(props).toHaveProperty('amount');
      expect(props).toHaveProperty('amount_received');
      expect(props).toHaveProperty('currency');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('payment_method');
      expect(props).toHaveProperty('latest_charge');
    });

    // Same removal as `charge.invoice` — see the charges suite.
    it('does not declare an invoice link', () => {
      expect(props).not.toHaveProperty('invoice');
    });

    it('has name Payment Intents', () => {
      expect(spec.name).toBe('Payment Intents');
    });
  });

  // ---------------------------------------------------------------------------
  // Charges
  // ---------------------------------------------------------------------------

  describe('charges', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'charges', remoteId: ['charges'] }, 'charges');
    const props = spec.schema.properties;

    it('includes charge-specific fields', () => {
      expect(props).toHaveProperty('amount');
      expect(props).toHaveProperty('amount_captured');
      expect(props).toHaveProperty('amount_refunded');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('paid');
      expect(props).toHaveProperty('captured');
      expect(props).toHaveProperty('refunded');
      expect(props).toHaveProperty('disputed');
      expect(props).toHaveProperty('billing_details');
      expect(props).toHaveProperty('receipt_url');
      expect(props).toHaveProperty('failure_code');
    });

    it('links to the payment_intents table', () => {
      const piJson = JSON.stringify(props.payment_intent);
      expect(piJson).toContain('payment_intents');
    });

    // Stripe removed `charge.invoice` when invoices gained multiple partial payments; declaring it
    // would only produce a column that is null on every record and a relation that never resolves.
    it('does not declare an invoice link', () => {
      expect(props).not.toHaveProperty('invoice');
    });
  });
});

// The record schemas come from Stripe's OpenAPI spec (stripe-object-schemas.generated.ts); these pin how
// buildStripeRecordSchema turns the generated shapes into Scratch schemas.
describe('schemas generated from the Stripe OpenAPI spec', () => {
  const allEntityTypes: StripeEntityType[] = [
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
  ];

  function fieldPathsWithForeignKeyTo(entityType: StripeEntityType): Record<string, string> {
    const linkedTableIdByPath: Record<string, string> = {};
    for (const field of extractSchemaFields(buildStripeRecordSchema(entityType))) {
      if (field.foreignKey) linkedTableIdByPath[field.path] = field.foreignKey.linkedTableId;
    }
    return linkedTableIdByPath;
  }

  // The `Stripe-Version` header we send must match the shapes we declare.
  it('was generated from the API version the connector pins', () => {
    expect(STRIPE_OBJECT_SCHEMAS_API_VERSION).toBe(STRIPE_CONNECTOR_API_VERSION);
  });

  it.each(allEntityTypes)('leaves no Stripe-only markers in the %s schema', (entityType) => {
    const serializedSchema = JSON.stringify(buildStripeRecordSchema(entityType));

    expect(serializedSchema).not.toContain('x-stripe-');
    expect(serializedSchema).not.toContain('"format":"unix-time"');
  });

  it.each(allEntityTypes)('marks every top-level %s field read-only', (entityType) => {
    for (const fieldSchema of Object.values(buildStripeRecordSchema(entityType).properties as Record<string, object>)) {
      expect(fieldSchema).toHaveProperty([X_SCRATCH_READONLY], true);
    }
  });

  it('does not modify the generated shapes it builds from', () => {
    buildStripeRecordSchema('subscriptions');

    expect(JSON.stringify(STRIPE_OBJECT_SCHEMAS_BY_STRIPE_OBJECT_NAME.subscription)).toContain('x-stripe-');
  });

  it('declares fields the hand-written schemas never had', () => {
    const subscriptionFields = buildStripeRecordSchema('subscriptions').properties;
    const invoiceFields = buildStripeRecordSchema('invoices').properties;

    expect(subscriptionFields).toHaveProperty('cancellation_details');
    expect(subscriptionFields).toHaveProperty('billing_cycle_anchor');
    expect(invoiceFields).toHaveProperty('customer_email');
    expect(invoiceFields).toHaveProperty('total_pretax_credit_amounts');
  });

  it("leaves out fields Stripe returns only when a request asks for them, so they don't export empty", () => {
    const customerFields = buildStripeRecordSchema('customers').properties;

    expect(customerFields).not.toHaveProperty('tax_ids');
    expect(customerFields).not.toHaveProperty('subscriptions');
    expect(buildStripeRecordSchema('charges').properties).not.toHaveProperty('refunds');
  });

  it('keeps product.type, which Stripe still returns but its spec no longer declares', () => {
    expect(buildStripeRecordSchema('products').properties).toHaveProperty('type');
  });

  it('turns Stripe epoch-second integers into timestamp fields, at any depth', () => {
    const invoiceFields = buildStripeRecordSchema('invoices').properties;

    expect(invoiceFields.created[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(STRIPE_UNIX_TIMESTAMP_DATA_TYPE);
    expect(invoiceFields.next_payment_attempt[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(STRIPE_UNIX_TIMESTAMP_DATA_TYPE);
    const statusTransitions = invoiceFields.status_transitions.anyOf[0].properties;
    expect(statusTransitions.paid_at[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(STRIPE_UNIX_TIMESTAMP_DATA_TYPE);
  });

  it('turns an id that points at one Stripe table into a foreign key, including nested ones', () => {
    expect(fieldPathsWithForeignKeyTo('subscriptions')).toMatchObject({
      customer: 'customers',
      latest_invoice: 'invoices',
      schedule: 'subscription_schedules',
    });
    expect(fieldPathsWithForeignKeyTo('invoices')).toMatchObject({
      customer: 'customers',
      'parent.subscription_details.subscription': 'subscriptions',
      latest_revision: 'invoices',
    });
    expect(fieldPathsWithForeignKeyTo('charges')).toMatchObject({
      balance_transaction: 'balance_transactions',
      payment_intent: 'payment_intents',
    });
    expect(fieldPathsWithForeignKeyTo('prices')).toMatchObject({ product: 'products' });
    expect(fieldPathsWithForeignKeyTo('promotion_codes')).toMatchObject({ 'promotion.coupon': 'coupons' });
  });

  it('gives no foreign key to an id that can point at several kinds of object', () => {
    expect(fieldPathsWithForeignKeyTo('balance_transactions')).not.toHaveProperty('source');
  });

  it('gives no foreign key to an id pointing at an object the connector has no table for', () => {
    expect(fieldPathsWithForeignKeyTo('subscriptions')).not.toHaveProperty('default_payment_method');
  });
});
