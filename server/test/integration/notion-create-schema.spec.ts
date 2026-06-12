/**
 * Notion create-schema live API integration test (DEV-10382).
 *
 * Exercises the connector's create-schema hooks against the real Notion API:
 *   1. createTable → creates a database (+ initial data source) under a shared
 *      parent page, with one property of every logical field kind (incl. a
 *      relation to the seed "Linked" database), then reads the data source back
 *      and asserts each property's Notion type round-trips.
 *   2. createFields → adds two more properties to that data source.
 *
 * Requires, in server/.env.integration:
 *   - NOTION_API_KEY              — the internal-integration secret
 *   - NOTION_TEST_PARENT_PAGE_ID  — a page shared with the integration, under
 *                                   which new test databases are created
 * See server/test/integration/notion-setup.md (steps 4 + 8). The suite
 * auto-skips when either is missing, so CI stays green until the secret lands.
 *
 * Run via: cd server && yarn test:integration -- notion-create-schema
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { NotionApiClient } from 'src/remote-service/connectors/library/notion/notion-api-client';
import { NotionConnector } from 'src/remote-service/connectors/library/notion/notion-connector';
import {
  type NormalizedCreateFieldsPlan,
  type NormalizedCreateTablePlan,
} from 'src/remote-service/connectors/schema-creation.types';
import { TablePreview } from 'src/remote-service/connectors/types';

// Notion is slower than most APIs (3 req/s integration limit) — generous budget.
jest.setTimeout(120_000);

const API_KEY = process.env.NOTION_API_KEY;
const PARENT_PAGE_ID = process.env.NOTION_TEST_PARENT_PAGE_ID;

/** Seed relation-target database from notion-setup.md (step 4). */
const LINKED_DB_NAME = 'Scratch Integration Test Linked';
const CREATE_PREFIX = 'Spinner Create-Schema';

const describeIfReady = API_KEY && PARENT_PAGE_ID ? describe : describe.skip;

/** Read the property map off a (full) data source response. */
function propertiesOf(dataSource: unknown): Record<string, { type: string } & Record<string, unknown>> {
  return (dataSource as { properties: Record<string, { type: string } & Record<string, unknown>> }).properties;
}

describeIfReady('NotionConnector — create schema (live API)', () => {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const apiKey = API_KEY!;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const parentPageId = PARENT_PAGE_ID!;

  let connector: NotionConnector;
  let client: NotionApiClient;
  let linkedTable: TablePreview;
  const dataSourcesToTrash: string[] = [];

  beforeAll(async () => {
    connector = new NotionConnector(apiKey);
    client = new NotionApiClient(apiKey);
    const tables = await connector.listTables();
    const found = tables.find((t) => t.displayName === LINKED_DB_NAME);
    if (!found) {
      throw new Error(
        `Relation-target database "${LINKED_DB_NAME}" not found. Run the setup in ` +
          `server/test/integration/notion-setup.md (step 4) and share it with the integration.`,
      );
    }
    linkedTable = found;
  });

  afterAll(async () => {
    // Best-effort cleanup: trash each created data source (and with it the empty
    // database). Leftovers are findable in Notion by the CREATE_PREFIX title.
    await Promise.allSettled(
      dataSourcesToTrash.map((dataSourceId) =>
        client.updateDataSource({ data_source_id: dataSourceId, in_trash: true }),
      ),
    );
  });

  it('creates a database with every logical field kind, then round-trips the property types', async () => {
    const plan: NormalizedCreateTablePlan = {
      ref: 'tbl',
      name: `${CREATE_PREFIX} ${Date.now()}`,
      remoteParentId: [parentPageId],
      deferredFkFields: [],
      fields: [
        { name: 'Name', fieldType: { kind: 'text' }, isPrimary: true },
        { name: 'Notes', fieldType: { kind: 'longText' } },
        { name: 'Count', fieldType: { kind: 'number', format: 'integer' } },
        { name: 'Ratio', fieldType: { kind: 'number', format: 'percent' } },
        { name: 'Price', fieldType: { kind: 'currency', currencyCode: 'USD' } },
        { name: 'Done', fieldType: { kind: 'boolean' } },
        { name: 'Due', fieldType: { kind: 'date' } },
        {
          name: 'Priority',
          fieldType: {
            kind: 'select',
            options: [
              { name: 'Low', color: 'green' },
              { name: 'High', color: 'red' },
            ],
          },
        },
        { name: 'Tags', fieldType: { kind: 'multiSelect', options: [{ name: 'a' }, { name: 'b' }] } },
        { name: 'Link', fieldType: { kind: 'url' } },
        { name: 'Owner Email', fieldType: { kind: 'email' } },
        { name: 'Phone', fieldType: { kind: 'phone' } },
        {
          name: 'Linked',
          fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: linkedTable.id.remoteId } },
        },
      ],
    };

    const result = await connector.createTable(plan);
    if (result.remoteTableId) {
      dataSourcesToTrash.push(result.remoteTableId[1]);
    }

    expect(result.status).toBe('created');
    expect(result.remoteTableId).toHaveLength(2);
    expect(result.fields.every((f) => f.status === 'created')).toBe(true);

    // ── Round-trip: read the data source back and assert each Notion type ──
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dataSourceId = result.remoteTableId![1];
    const dataSource = await client.retrieveDataSource({ data_source_id: dataSourceId });
    const props = propertiesOf(dataSource);

    expect(props['Name'].type).toBe('title');
    expect(props['Notes'].type).toBe('rich_text');
    expect(props['Count'].type).toBe('number');
    expect(props['Ratio'].type).toBe('number');
    expect(props['Price'].type).toBe('number');
    expect(props['Done'].type).toBe('checkbox');
    expect(props['Due'].type).toBe('date');
    expect(props['Priority'].type).toBe('select');
    expect(props['Tags'].type).toBe('multi_select');
    expect(props['Link'].type).toBe('url');
    expect(props['Owner Email'].type).toBe('email');
    expect(props['Phone'].type).toBe('phone_number');
    expect(props['Linked'].type).toBe('relation');
    expect((props['Linked'].relation as { data_source_id: string }).data_source_id).toBe(linkedTable.id.remoteId[1]);
  });

  it('fails with a clear message when no parent page id is supplied', async () => {
    const result = await connector.createTable({
      ref: 'orphan',
      name: `${CREATE_PREFIX} orphan ${Date.now()}`,
      deferredFkFields: [],
      fields: [{ name: 'Name', fieldType: { kind: 'text' }, isPrimary: true }],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/parent page/i);
  });

  it('adds new fields to an existing data source via createFields', async () => {
    const created = await connector.createTable({
      ref: 'tbl2',
      name: `${CREATE_PREFIX} fields ${Date.now()}`,
      remoteParentId: [parentPageId],
      deferredFkFields: [],
      fields: [{ name: 'Name', fieldType: { kind: 'text' }, isPrimary: true }],
    });
    expect(created.status).toBe('created');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const remoteTableId = created.remoteTableId!;
    dataSourcesToTrash.push(remoteTableId[1]);

    const plan: NormalizedCreateFieldsPlan = {
      remoteTableId,
      fields: [
        { name: 'Extra', fieldType: { kind: 'text' } },
        { name: 'Score', fieldType: { kind: 'number' } },
      ],
    };
    const fieldResults = await connector.createFields(plan);
    expect(fieldResults.map((r) => r.status)).toEqual(['created', 'created']);

    const dataSource = await client.retrieveDataSource({ data_source_id: remoteTableId[1] });
    const props = propertiesOf(dataSource);
    expect(props['Extra'].type).toBe('rich_text');
    expect(props['Score'].type).toBe('number');
  });
});
