/**
 * Stripe connector live API integration test.
 *
 * Exercises the real Stripe API: validates credentials, discovers tables,
 * builds schemas, pulls records, and fetches individual records by ID.
 *
 * Since the Stripe connector is read-only, there are no create/update/delete
 * tests — only connection, discovery, and pull operations.
 *
 * Requires STRIPE_CONNECTOR_API_KEY in .env.integration (sk_test_... recommended).
 * Run via: cd server && yarn test:integration -- stripe-connector
 */

// Break the circular import chain
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { StripeConnector } from 'src/remote-service/connectors/library/stripe/stripe-connector';
import { StripeEntityType } from 'src/remote-service/connectors/library/stripe/stripe-types';
import { BaseJsonTableSpec, ConnectorFile, EntityId } from 'src/remote-service/connectors/types';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const API_KEY = process.env.STRIPE_CONNECTOR_API_KEY;

const ENTITY_IDS: Record<StripeEntityType, EntityId> = {
  customers: { wsId: 'customers', remoteId: ['customers'] },
  products: { wsId: 'products', remoteId: ['products'] },
  prices: { wsId: 'prices', remoteId: ['prices'] },
  subscriptions: { wsId: 'subscriptions', remoteId: ['subscriptions'] },
  invoices: { wsId: 'invoices', remoteId: ['invoices'] },
  payment_intents: { wsId: 'payment_intents', remoteId: ['payment_intents'] },
  charges: { wsId: 'charges', remoteId: ['charges'] },
};

function createConnector(): StripeConnector {
  return new StripeConnector({ apiKey: API_KEY! });
}

/**
 * Pull records, collecting at most `maxRecords` before aborting.
 * Stripe accounts can have thousands of records; we only need to verify
 * that pagination works, not exhaust the entire dataset.
 */
async function collectPulledFiles(
  connector: StripeConnector,
  tableSpec: BaseJsonTableSpec,
  maxRecords = 200,
): Promise<ConnectorFile[]> {
  const allFiles: ConnectorFile[] = [];
  const abortSignal = { aborted: false };

  try {
    await connector.pullRecordFiles(
      tableSpec,
      async ({ files }) => {
        allFiles.push(...files);
        if (allFiles.length >= maxRecords) {
          abortSignal.aborted = true;
          // Throw to break out of pagination loop — caught below
          throw new Error('__PULL_LIMIT_REACHED__');
        }
      },
      {},
      { forceFull: false },
    );
  } catch (e) {
    if (!(e instanceof Error && e.message === '__PULL_LIMIT_REACHED__')) {
      throw e;
    }
  }

  return allFiles;
}

// Skip the entire suite if no API key is configured
const describeIfKey = API_KEY ? describe : describe.skip;

// Individual pull tests can be slow — paginating through all records in a Stripe account
jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfKey('StripeConnector — live API', () => {
  let connector: StripeConnector;

  beforeAll(() => {
    connector = createConnector();
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects invalid credentials', async () => {
      const badConnector = new StripeConnector({ apiKey: 'sk_test_invalid_key_123' });
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns all 7 entity types', async () => {
      const tables = await connector.listTables();
      const ids = tables.map((t) => t.id.wsId);

      expect(ids).toContain('customers');
      expect(ids).toContain('products');
      expect(ids).toContain('prices');
      expect(ids).toContain('subscriptions');
      expect(ids).toContain('invoices');
      expect(ids).toContain('payment_intents');
      expect(ids).toContain('charges');
    });

    it('marks all tables as read-only', async () => {
      const tables = await connector.listTables();
      for (const table of tables) {
        expect(table.disabledCreates).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Read-only enforcement
  // -------------------------------------------------------------------------

  describe('read-only enforcement', () => {
    let customersSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      customersSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.customers);
    });

    it('throws on createRecords', () => {
      expect(() => connector.createRecords(customersSpec, [{ name: 'Test' }])).toThrow('read-only');
    });

    it('throws on updateRecords', () => {
      expect(() => connector.updateRecords(customersSpec, [{ id: 'cus_123' }])).toThrow('read-only');
    });

    it('throws on deleteRecords', () => {
      expect(() => connector.deleteRecords(customersSpec, [{ id: 'cus_123' }])).toThrow('read-only');
    });
  });

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  describe('customers', () => {
    let customersSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      customersSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.customers);
    });

    it('builds a schema with customer fields', () => {
      expect(customersSpec.name).toBe('Customers');
      expect(customersSpec.idPath).toBe('id');
      expect(customersSpec.titlePath).toEqual('name');

      const props = customersSpec.schema.properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('email');
      expect(props).toHaveProperty('metadata');
      expect(props.id[X_SCRATCH_READONLY]).toBe(true);
      expect(props.created[X_SCRATCH_READONLY]).toBe(true);
    });

    it('pulls customers from the live API', async () => {
      const files = await collectPulledFiles(connector, customersSpec);

      // Test accounts should have at least some data; if empty that's still valid
      expect(Array.isArray(files)).toBe(true);

      if (files.length > 0) {
        const first = files[0] as unknown as { id: string; object: string };
        expect(first.id).toMatch(/^cus_/);
        expect(first.object).toBe('customer');
      }
    });

    it('fetches a customer by ID', async () => {
      const allCustomers = await collectPulledFiles(connector, customersSpec);
      if (allCustomers.length === 0) {
        // No customers to fetch — skip gracefully
        return;
      }

      const customerId = String((allCustomers[0] as unknown as { id: string }).id);

      const fetched: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(customersSpec, [customerId], async ({ files: batch }) => {
        fetched.push(...batch);
      });

      expect(fetched).toHaveLength(1);
      expect((fetched[0] as unknown as { id: string }).id).toBe(customerId);
    });

    it('returns empty for non-existent customer ID', async () => {
      const fetched: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(customersSpec, ['cus_nonexistent_999999'], async ({ files: batch }) => {
        fetched.push(...batch);
      });

      expect(fetched).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------

  describe('products', () => {
    let productsSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      productsSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.products);
    });

    it('builds a schema with product fields', () => {
      expect(productsSpec.name).toBe('Products');
      expect(productsSpec.titlePath).toEqual('name');

      const props = productsSpec.schema.properties;
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('active');
      expect(props).toHaveProperty('default_price');
    });

    it('pulls products from the live API', async () => {
      const files = await collectPulledFiles(connector, productsSpec);
      expect(Array.isArray(files)).toBe(true);

      if (files.length > 0) {
        const first = files[0] as unknown as { id: string; object: string };
        expect(first.id).toMatch(/^prod_/);
        expect(first.object).toBe('product');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  describe('prices', () => {
    let pricesSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      pricesSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.prices);
    });

    it('builds a schema with price fields', () => {
      expect(pricesSpec.name).toBe('Prices');
      expect(pricesSpec.titlePath).toEqual('nickname');

      const props = pricesSpec.schema.properties;
      expect(props).toHaveProperty('product');
      expect(props).toHaveProperty('currency');
      expect(props).toHaveProperty('unit_amount');
      expect(props).toHaveProperty('type');
      expect(props).toHaveProperty('recurring');
    });

    it('pulls prices from the live API', async () => {
      const files = await collectPulledFiles(connector, pricesSpec);
      expect(Array.isArray(files)).toBe(true);

      if (files.length > 0) {
        const first = files[0] as unknown as { id: string; object: string; currency: string };
        expect(first.id).toMatch(/^price_/);
        expect(first.object).toBe('price');
        expect(first.currency).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  describe('subscriptions', () => {
    let subscriptionsSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      subscriptionsSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.subscriptions);
    });

    it('builds a schema with subscription fields', () => {
      expect(subscriptionsSpec.name).toBe('Subscriptions');

      const props = subscriptionsSpec.schema.properties;
      expect(props).toHaveProperty('customer');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('items');
      // The billing period moved onto the line items; declaring it at the top level produced a
      // column that was null on every record (DEV-11144).
      expect(props).not.toHaveProperty('current_period_start');
      expect(props).not.toHaveProperty('current_period_end');
    });

    it('pulls subscriptions from the live API', async () => {
      const files = await collectPulledFiles(connector, subscriptionsSpec);
      expect(Array.isArray(files)).toBe(true);

      if (files.length > 0) {
        const first = files[0] as unknown as { id: string; object: string; status: string };
        expect(first.id).toMatch(/^sub_/);
        expect(first.object).toBe('subscription');
        expect(first.status).toBeDefined();
      }
    });

    // Guards the pinned API version: on a stale pin the period would come back at the top level
    // instead, silently reintroducing the always-null columns this schema was fixed to avoid.
    it('receives the billing period on line items, matching the pinned API version', async () => {
      const files = await collectPulledFiles(connector, subscriptionsSpec);

      if (files.length > 0) {
        const first = files[0] as unknown as {
          current_period_start?: number;
          items: { data: { current_period_start?: number; current_period_end?: number }[] };
        };
        expect(first.current_period_start).toBeUndefined();
        expect(first.items.data.length).toBeGreaterThan(0);
        expect(typeof first.items.data[0].current_period_start).toBe('number');
        expect(typeof first.items.data[0].current_period_end).toBe('number');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Invoices
  // -------------------------------------------------------------------------

  describe('invoices', () => {
    let invoicesSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      invoicesSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.invoices);
    });

    it('builds a schema with invoice fields', () => {
      expect(invoicesSpec.name).toBe('Invoices');
      expect(invoicesSpec.titlePath).toEqual('number');

      const props = invoicesSpec.schema.properties;
      expect(props).toHaveProperty('customer');
      expect(props).toHaveProperty('amount_due');
      expect(props).toHaveProperty('amount_paid');
      expect(props).toHaveProperty('total');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('hosted_invoice_url');
      // Replaced by `parent`, `status_transitions` and `total_taxes` (DEV-11144).
      expect(props).not.toHaveProperty('subscription');
      expect(props).not.toHaveProperty('paid');
      expect(props).not.toHaveProperty('tax');
      expect(props).toHaveProperty('parent');
    });

    it('pulls invoices from the live API', async () => {
      const files = await collectPulledFiles(connector, invoicesSpec);
      expect(Array.isArray(files)).toBe(true);

      if (files.length > 0) {
        const first = files[0] as unknown as { id: string; object: string };
        expect(first.id).toMatch(/^in_/);
        expect(first.object).toBe('invoice');
      }
    });

    // Guards the pinned API version the same way the subscriptions period check does: these fields
    // must stay gone, and the subscription link must arrive under `parent`.
    it('receives invoices in the shape the pinned API version declares', async () => {
      const files = await collectPulledFiles(connector, invoicesSpec);

      if (files.length > 0) {
        const first = files[0] as unknown as Record<string, unknown>;
        expect(first).not.toHaveProperty('subscription');
        expect(first).not.toHaveProperty('paid');
        expect(first).not.toHaveProperty('tax');
        expect(first).toHaveProperty('parent');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Payment Intents
  // -------------------------------------------------------------------------

  describe('payment_intents', () => {
    let paymentIntentsSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      paymentIntentsSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.payment_intents);
    });

    it('builds a schema with payment intent fields', () => {
      expect(paymentIntentsSpec.name).toBe('Payment Intents');

      const props = paymentIntentsSpec.schema.properties;
      expect(props).toHaveProperty('amount');
      expect(props).toHaveProperty('amount_received');
      expect(props).toHaveProperty('currency');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('payment_method');
    });

    it('pulls payment intents from the live API', async () => {
      const files = await collectPulledFiles(connector, paymentIntentsSpec);
      expect(Array.isArray(files)).toBe(true);

      if (files.length > 0) {
        const first = files[0] as unknown as { id: string; object: string };
        expect(first.id).toMatch(/^pi_/);
        expect(first.object).toBe('payment_intent');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  describe('charges', () => {
    let chargesSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      chargesSpec = await connector.fetchJsonTableSpec(ENTITY_IDS.charges);
    });

    it('builds a schema with charge fields', () => {
      expect(chargesSpec.name).toBe('Charges');

      const props = chargesSpec.schema.properties;
      expect(props).toHaveProperty('amount');
      expect(props).toHaveProperty('currency');
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('paid');
      expect(props).toHaveProperty('captured');
      expect(props).toHaveProperty('billing_details');
      expect(props).toHaveProperty('receipt_url');
    });

    it('pulls charges from the live API', async () => {
      const files = await collectPulledFiles(connector, chargesSpec);
      expect(Array.isArray(files)).toBe(true);

      if (files.length > 0) {
        const first = files[0] as unknown as { id: string; object: string };
        expect(first.id).toMatch(/^ch_/);
        expect(first.object).toBe('charge');
      }
    });
  });
});
