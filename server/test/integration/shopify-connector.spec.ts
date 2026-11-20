/**
 * Shopify connector live API integration test.
 *
 * Pulls every table through the real ShopifyConnector from a Shopify store, with a token holding exactly the
 * `/shopify-custom-app` setup guide's scopes, then checks what DEV-12868 claims: Customers, Orders, Order Line
 * Items, and Order Shipping Lines pull; customers carry their protected customer data (names and emails); orders
 * older than 60 days come back (`read_all_orders`); links between the tables point at records that were pulled;
 * and incremental pulls of those four tables filter by `updated_at`.
 *
 * Requires SHOPIFY_API_TOKEN and SHOPIFY_SHOP_DOMAIN (the `shopify` secret in the whalesync-test-credentials GCP
 * project). Without them the suite skips. Run with the secret loaded:
 *   bash .claude/skills/connector-build-prepare/lib/credential-helpers.sh run shopify -- \
 *     bash -c 'cd server && yarn test:integration -- shopify-connector'
 *
 * Set SHOPIFY_TEST_RECORD_DUMP_DIR to also write each table's spec and records there, for checking them with
 * scratch-git's `enforce_schema` validator (see the Shopify STATE.md).
 */

// Break the circular import chain: connector.ts → display-names.ts → registry →
// every connector → connector.ts (same shim the other live connector tests use).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import fs from 'node:fs';
import path from 'node:path';
import { ALL_ENTITY_TYPES, EntityType } from 'src/remote-service/connectors/library/shopify/graphql/registry';
import { ShopifyConnector } from 'src/remote-service/connectors/library/shopify/shopify-connector';
import { BaseJsonTableSpec, ConnectorFile, PullRecordFilesOptions } from 'src/remote-service/connectors/types';

jest.setTimeout(300_000);

const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_API_TOKEN;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const RECORD_DUMP_DIR = process.env.SHOPIFY_TEST_RECORD_DUMP_DIR;
const describeIfCreds = SHOPIFY_ADMIN_API_ACCESS_TOKEN && SHOPIFY_SHOP_DOMAIN ? describe : describe.skip;

const CUSTOMER_AND_ORDER_ENTITY_TYPES: EntityType[] = [
  'customers',
  'orders',
  'order_line_items',
  'order_shipping_lines',
];

const SIXTY_DAYS_IN_MILLISECONDS = 60 * 24 * 60 * 60 * 1000;

describeIfCreds('Shopify connector (live)', () => {
  let connector: ShopifyConnector;
  const tableSpecByEntityType = new Map<EntityType, BaseJsonTableSpec>();
  const recordsByEntityType = new Map<EntityType, ConnectorFile[]>();
  // One table failing to pull (e.g. a field gated by a scope the token lacks) fails only the tests that use it.
  const pullErrorByEntityType = new Map<EntityType, unknown>();

  function recordsOf(entityType: EntityType): ConnectorFile[] {
    const pullError = pullErrorByEntityType.get(entityType);
    if (pullError) throw pullError;
    const records = recordsByEntityType.get(entityType);
    if (!records) throw new Error(`${entityType} was not pulled`);
    return records;
  }

  function idsOf(entityType: EntityType): Set<unknown> {
    return new Set(recordsOf(entityType).map((record) => record.id));
  }

  function tableSpecOf(entityType: EntityType): BaseJsonTableSpec {
    const tableSpec = tableSpecByEntityType.get(entityType);
    if (!tableSpec) throw new Error(`${entityType} has no table spec`);
    return tableSpec;
  }

  async function pullAllRecordFiles(
    tableSpec: BaseJsonTableSpec,
    options: PullRecordFilesOptions,
  ): Promise<{ records: ConnectorFile[]; newWatermark: Date | undefined }> {
    const records: ConnectorFile[] = [];
    const pullResult = await connector.pullRecordFiles(
      tableSpec,
      async ({ files }) => {
        records.push(...files);
        return Promise.resolve();
      },
      {},
      options,
    );
    return { records, newWatermark: pullResult.newWatermark };
  }

  beforeAll(async () => {
    connector = new ShopifyConnector({
      shopDomain: SHOPIFY_SHOP_DOMAIN ?? '',
      accessToken: SHOPIFY_ADMIN_API_ACCESS_TOKEN ?? '',
    });

    for (const entityType of ALL_ENTITY_TYPES) {
      const tableSpec = await connector.fetchJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
      tableSpecByEntityType.set(entityType, tableSpec);
      try {
        const { records } = await pullAllRecordFiles(tableSpec, {});
        recordsByEntityType.set(entityType, records);
      } catch (pullError) {
        pullErrorByEntityType.set(entityType, pullError);
      }
    }

    if (RECORD_DUMP_DIR) {
      for (const entityType of ALL_ENTITY_TYPES.filter((entityType) => recordsByEntityType.has(entityType))) {
        const tableDumpDir = path.join(RECORD_DUMP_DIR, entityType);
        fs.mkdirSync(tableDumpDir, { recursive: true });
        fs.writeFileSync(path.join(tableDumpDir, 'table-spec.json'), JSON.stringify(tableSpecOf(entityType)));
        recordsOf(entityType).forEach((record, recordIndex) =>
          fs.writeFileSync(path.join(tableDumpDir, `record-${recordIndex}.json`), JSON.stringify(record)),
        );
      }
    }
  });

  it('connects', async () => {
    await expect(connector.testConnection()).resolves.toBeUndefined();
  });

  it('lists Customers, Orders, Order Line Items, and Order Shipping Lines', async () => {
    const listedEntityTypes = (await connector.listTables()).map((table) => table.id.wsId);
    expect(listedEntityTypes).toEqual(expect.arrayContaining(CUSTOMER_AND_ORDER_ENTITY_TYPES));
  });

  it.each(ALL_ENTITY_TYPES)('%s pulls records that each carry a string id, with no duplicates', (entityType) => {
    const records = recordsOf(entityType);
    for (const record of records) expect(typeof record.id).toBe('string');
    expect(idsOf(entityType).size).toBe(records.length);
  });

  it.each(ALL_ENTITY_TYPES)('%s builds a default view', (entityType) => {
    expect(connector.buildDefaultView(tableSpecOf(entityType))).toBeDefined();
  });

  it('pulls customers with their protected customer data: names and email addresses', () => {
    const customers = recordsOf('customers');
    expect(customers.length).toBeGreaterThan(0);
    const customersWithNameAndEmail = customers.filter((customer) => {
      const defaultEmailAddress = customer.defaultEmailAddress as { emailAddress?: string | null } | null | undefined;
      return typeof customer.firstName === 'string' && typeof defaultEmailAddress?.emailAddress === 'string';
    });
    expect(customersWithNameAndEmail.length).toBeGreaterThan(0);
  });

  it('pulls orders older than 60 days, which only read_all_orders returns', () => {
    const orders = recordsOf('orders');
    expect(orders.length).toBeGreaterThan(0);
    const sixtyDaysAgo = Date.now() - SIXTY_DAYS_IN_MILLISECONDS;
    const ordersCreatedMoreThanSixtyDaysAgo = orders.filter(
      (order) => typeof order.createdAt === 'string' && Date.parse(order.createdAt) < sixtyDaysAgo,
    );
    expect(ordersCreatedMoreThanSixtyDaysAgo.length).toBeGreaterThan(0);
  });

  it('links each order that has a customer to a pulled customer', () => {
    const customerIds = idsOf('customers');
    const ordersWithCustomer = recordsOf('orders').filter((order) => order.customer);
    expect(ordersWithCustomer.length).toBeGreaterThan(0);
    for (const order of ordersWithCustomer) {
      expect(customerIds.has((order.customer as { id?: unknown }).id)).toBe(true);
    }
  });

  it("links each customer's last order, which exports as a link to Orders, to a pulled order", () => {
    const orderIds = idsOf('orders');
    const customersWithLastOrder = recordsOf('customers').filter((customer) => customer.lastOrder);
    expect(customersWithLastOrder.length).toBeGreaterThan(0);
    for (const customer of customersWithLastOrder) {
      expect(orderIds.has((customer.lastOrder as { id?: unknown }).id)).toBe(true);
    }
  });

  it.each(['order_line_items', 'order_shipping_lines'] as EntityType[])(
    '%s each point at a pulled order',
    (entityType) => {
      const orderIds = idsOf('orders');
      for (const childRecord of recordsOf(entityType)) expect(orderIds.has(childRecord.orderId)).toBe(true);
    },
  );

  it('pulls line items for the orders', () => {
    expect(recordsOf('order_line_items').length).toBeGreaterThan(0);
  });

  describe('incremental pull', () => {
    it.each(CUSTOMER_AND_ORDER_ENTITY_TYPES)(
      '%s returns nothing changed since a watermark in the future, and a new watermark',
      async (entityType) => {
        const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const pullStartedAt = Date.now();
        const { records, newWatermark } = await pullAllRecordFiles(tableSpecOf(entityType), {
          pullMode: 'incremental',
          since: oneDayFromNow,
        });
        expect(records).toEqual([]);
        expect(newWatermark).toBeInstanceOf(Date);
        expect(newWatermark?.getTime()).toBeGreaterThanOrEqual(pullStartedAt);
      },
    );

    it.each(CUSTOMER_AND_ORDER_ENTITY_TYPES)(
      '%s returns every record changed since a watermark before the store existed',
      async (entityType) => {
        const { records } = await pullAllRecordFiles(tableSpecOf(entityType), {
          pullMode: 'incremental',
          since: new Date('2000-01-01T00:00:00Z'),
        });
        expect(new Set(records.map((record) => record.id))).toEqual(idsOf(entityType));
      },
    );
  });
});
