/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildStripeJsonTableSpec } from '../stripe-json-schema';
import { StripeEntityType } from '../stripe-types';

describe('buildStripeJsonTableSpec', () => {
  const allEntityTypes: StripeEntityType[] = [
    'customers',
    'products',
    'prices',
    'subscriptions',
    'invoices',
    'payment_intents',
    'charges',
  ];

  // ---------------------------------------------------------------------------
  // Common spec metadata
  // ---------------------------------------------------------------------------

  it.each(allEntityTypes)('builds spec with correct metadata for %s', (entityType) => {
    const entityId = { wsId: entityType, remoteId: [entityType] };
    const spec = buildStripeJsonTableSpec(entityId, entityType);

    expect(spec.slug).toBe(entityType);
    expect(spec.idColumnRemoteId).toBe('id');
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

  it.each(allEntityTypes)('includes livemode flag for %s', (entityType) => {
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
    expect(spec.titleColumnRemoteId).toEqual(['name']);
  });

  it('uses name as title for products', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'products', remoteId: ['products'] }, 'products');
    expect(spec.titleColumnRemoteId).toEqual(['name']);
  });

  it('uses nickname as title for prices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'prices', remoteId: ['prices'] }, 'prices');
    expect(spec.titleColumnRemoteId).toEqual(['nickname']);
  });

  it('uses number as title for invoices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'invoices', remoteId: ['invoices'] }, 'invoices');
    expect(spec.titleColumnRemoteId).toEqual(['number']);
  });

  it('uses id as title for subscriptions', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'subscriptions', remoteId: ['subscriptions'] }, 'subscriptions');
    expect(spec.titleColumnRemoteId).toEqual(['id']);
  });

  // ---------------------------------------------------------------------------
  // Slug field paths (for auto-generated filenames)
  // ---------------------------------------------------------------------------

  it('uses name as slug for customers', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'customers', remoteId: ['customers'] }, 'customers');
    expect(spec.slugFieldPath).toBe('name');
  });

  it('uses name as slug for products', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'products', remoteId: ['products'] }, 'products');
    expect(spec.slugFieldPath).toBe('name');
  });

  it('uses nickname as slug for prices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'prices', remoteId: ['prices'] }, 'prices');
    expect(spec.slugFieldPath).toBe('nickname');
  });

  it('uses number as slug for invoices', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'invoices', remoteId: ['invoices'] }, 'invoices');
    expect(spec.slugFieldPath).toBe('number');
  });

  it('uses id as slug for subscriptions', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'subscriptions', remoteId: ['subscriptions'] }, 'subscriptions');
    expect(spec.slugFieldPath).toBe('id');
  });

  it('uses id as slug for payment_intents', () => {
    const spec = buildStripeJsonTableSpec(
      { wsId: 'payment_intents', remoteId: ['payment_intents'] },
      'payment_intents',
    );
    expect(spec.slugFieldPath).toBe('id');
  });

  it('uses id as slug for charges', () => {
    const spec = buildStripeJsonTableSpec({ wsId: 'charges', remoteId: ['charges'] }, 'charges');
    expect(spec.slugFieldPath).toBe('id');
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
      expect(props.product[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'products' });
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
      expect(props).toHaveProperty('current_period_start');
      expect(props).toHaveProperty('current_period_end');
      expect(props).toHaveProperty('cancel_at_period_end');
      expect(props).toHaveProperty('items');
    });

    it('links customer to customers table', () => {
      expect(props.customer[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'customers' });
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
      expect(props).toHaveProperty('subscription');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('amount_due');
      expect(props).toHaveProperty('amount_paid');
      expect(props).toHaveProperty('total');
      expect(props).toHaveProperty('number');
      expect(props).toHaveProperty('hosted_invoice_url');
      expect(props).toHaveProperty('invoice_pdf');
    });

    it('links to customers and subscriptions tables', () => {
      const customerJson = JSON.stringify(props.customer);
      const subscriptionJson = JSON.stringify(props.subscription);
      expect(customerJson).toContain('customers');
      expect(subscriptionJson).toContain('subscriptions');
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

    it('links to payment_intents and invoices tables', () => {
      const piJson = JSON.stringify(props.payment_intent);
      const invoiceJson = JSON.stringify(props.invoice);
      expect(piJson).toContain('payment_intents');
      expect(invoiceJson).toContain('invoices');
    });
  });
});
