/**
 * Square connector live API integration test.
 *
 * Pulls every table through the real SquareConnector from a Square account, then checks what the seed
 * (`tools/live-export-audit/seeds/square/seed.mjs`) planted: the per-location, per-payout, and full-history walks
 * find every record, links point at records that exist, and a single-record read returns exactly what the list
 * returned. The connector is read-only, so the suite never writes.
 *
 * Requires SQUARE_TEST_ACCESS_TOKEN: a personal access token of a seeded Square account, sandbox or production
 * (the shared sandbox one is the `square` secret in the whalesync-test-credentials GCP project). Without it the
 * suite skips.
 *
 * Set SQUARE_TEST_RECORD_DUMP_DIR to also write each table's spec and records there, for checking them with
 * scratch-git's `enforce_schema` validator (see the Square STATE.md).
 *
 * Run via: cd server && yarn test:integration -- square-connector
 */

// Break the circular import chain: connector.ts → display-names.ts → registry →
// every connector → connector.ts (same shim the other live connector tests use).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import fs from 'node:fs';
import path from 'node:path';
import { SquareApiClient } from 'src/remote-service/connectors/library/square/square-api-client';
import { SquareConnector } from 'src/remote-service/connectors/library/square/square-connector';
import {
  SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE,
  SQUARE_ENTITY_TYPES,
  SquareEntityType,
  SquareEnvironment,
} from 'src/remote-service/connectors/library/square/square-types';
import { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';

jest.setTimeout(300_000);

const ACCESS_TOKEN = process.env.SQUARE_TEST_ACCESS_TOKEN;
const RECORD_DUMP_DIR = process.env.SQUARE_TEST_RECORD_DUMP_DIR;
const describeIfCreds = ACCESS_TOKEN ? describe : describe.skip;

/** The fewest records the seed leaves in each table it can populate. */
const SEEDED_MINIMUM_RECORD_COUNT_BY_ENTITY_TYPE: Partial<Record<SquareEntityType, number>> = {
  locations: 3,
  customers: 30,
  catalog_items: 10,
  orders: 240,
  payments: 204,
  refunds: 12,
  invoices: 6,
  gift_cards: 4,
  gift_card_activities: 10,
  subscriptions: 4,
};

describeIfCreds('Square connector (live)', () => {
  let connector: SquareConnector;
  const tableSpecByEntityType = new Map<SquareEntityType, BaseJsonTableSpec>();
  const recordsByEntityType = new Map<SquareEntityType, ConnectorFile[]>();

  function recordsOf(entityType: SquareEntityType): ConnectorFile[] {
    const records = recordsByEntityType.get(entityType);
    if (!records) throw new Error(`${entityType} was not pulled`);
    return records;
  }

  function idsOf(entityType: SquareEntityType): Set<unknown> {
    return new Set(recordsOf(entityType).map((record) => record.id));
  }

  beforeAll(async () => {
    const accessToken = ACCESS_TOKEN ?? '';
    const environment: SquareEnvironment | null = await SquareApiClient.detectEnvironmentForAccessToken(accessToken);
    if (!environment) throw new Error('Neither Square environment accepts SQUARE_TEST_ACCESS_TOKEN');
    connector = new SquareConnector({ accessToken, environment });

    for (const entityType of SQUARE_ENTITY_TYPES) {
      const tableSpec = await connector.fetchJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
      const records: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        tableSpec,
        async ({ files }) => {
          records.push(...files);
          return Promise.resolve();
        },
        {},
        {},
      );
      tableSpecByEntityType.set(entityType, tableSpec);
      recordsByEntityType.set(entityType, records);
    }

    if (RECORD_DUMP_DIR) {
      for (const entityType of SQUARE_ENTITY_TYPES) {
        const tableDumpDir = path.join(RECORD_DUMP_DIR, entityType);
        fs.mkdirSync(tableDumpDir, { recursive: true });
        fs.writeFileSync(
          path.join(tableDumpDir, 'table-spec.json'),
          JSON.stringify(tableSpecByEntityType.get(entityType)),
        );
        recordsOf(entityType).forEach((record, recordIndex) =>
          fs.writeFileSync(path.join(tableDumpDir, `record-${recordIndex}.json`), JSON.stringify(record)),
        );
      }
    }
  });

  it('connects', async () => {
    await expect(connector.testConnection()).resolves.toBeUndefined();
  });

  it("lists every table as pickable for a personal access token, which has all of Square's permissions", async () => {
    const tables = await connector.listTables();

    expect(tables.map((table) => table.id.wsId)).toEqual(SQUARE_ENTITY_TYPES);
    expect(tables.filter((table) => table.disabled)).toEqual([]);
  });

  it.each(SQUARE_ENTITY_TYPES)('%s pulls records that each carry a string id, with no duplicates', (entityType) => {
    const records = recordsOf(entityType);
    expect(records.length).toBeGreaterThanOrEqual(SEEDED_MINIMUM_RECORD_COUNT_BY_ENTITY_TYPE[entityType] ?? 0);
    for (const record of records) expect(typeof record.id).toBe('string');
    expect(idsOf(entityType).size).toBe(records.length);
  });

  it('pulls the entries of every payout, each pointing at its payout', () => {
    const payoutIds = idsOf('payouts');
    const payoutEntries = recordsOf('payout_entries');
    if (payoutIds.size > 0) expect(payoutEntries.length).toBeGreaterThan(0);
    for (const payoutEntry of payoutEntries) expect(payoutIds.has(payoutEntry.payout_id)).toBe(true);
  });

  it('pulls every kind of gift card activity the seed records, each pointing at a pulled gift card', () => {
    const giftCardIds = idsOf('gift_cards');
    const giftCardActivities = recordsOf('gift_card_activities');
    const activityTypes = new Set(giftCardActivities.map((activity) => activity.type));
    for (const seededActivityType of ['ACTIVATE', 'LOAD', 'REDEEM', 'ADJUST_INCREMENT', 'DEACTIVATE']) {
      expect(activityTypes).toContain(seededActivityType);
    }
    for (const activity of giftCardActivities) expect(giftCardIds.has(activity.gift_card_id)).toBe(true);
  });

  it('pulls subscriptions of every status, each pointing at a pulled customer and location', () => {
    const customerIds = idsOf('customers');
    const locationIds = idsOf('locations');
    const subscriptions = recordsOf('subscriptions');
    expect(new Set(subscriptions.map((subscription) => subscription.status)).size).toBeGreaterThan(1);
    for (const subscription of subscriptions) {
      expect(customerIds.has(subscription.customer_id)).toBe(true);
      expect(locationIds.has(subscription.location_id)).toBe(true);
    }
  });

  it.each(['gift_cards', 'subscriptions'] as const)(
    '%s: a single-record read returns exactly what the list returned',
    async (entityType) => {
      const [listedRecord] = recordsOf(entityType);
      const tableSpec = tableSpecByEntityType.get(entityType);
      if (!listedRecord || !tableSpec) throw new Error(`no ${entityType} to read back`);
      const recordsReadById: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(tableSpec, [String(listedRecord.id)], async ({ files }) => {
        recordsReadById.push(...files);
        return Promise.resolve();
      });

      expect(recordsReadById).toEqual([listedRecord]);
    },
  );

  it.each(['payout_entries', 'gift_card_activities'] as const)(
    "%s: refuses a single-record read, which Square can't do",
    async (entityType) => {
      expect(SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType].retrieveOneRecord).toBeUndefined();
      const tableSpec = tableSpecByEntityType.get(entityType);
      if (!tableSpec) throw new Error(`${entityType} has no spec`);

      await expect(connector.pullRecordFilesByIds(tableSpec, ['any-id'], () => Promise.resolve())).rejects.toThrow(
        "Square can't fetch a single",
      );
    },
  );
});
