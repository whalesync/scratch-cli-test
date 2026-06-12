/**
 * Airtable create-schema live API integration test (DEV-10379).
 *
 * Creates a real table (and adds a field) via the Airtable Web API, then reads it
 * back. Airtable has NO delete-table API, so this suite does NOT clean up after
 * itself: it names tables with a unique timestamp so reruns never collide, but the
 * tables accumulate. Point AIRTABLE_TEST_BASE_ID at a throwaway base you can trash
 * manually, and use a token with the `schema.bases:write` scope.
 *
 * Requires AIRTABLE_API_KEY + AIRTABLE_TEST_BASE_ID in .env.integration.
 * Run via: cd server && yarn test:integration -- airtable-create-schema
 */

// Break the circular import chain: connector.ts → display-names.ts → all connectors → connector.ts
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { AirtableConnector } from 'src/remote-service/connectors/library/airtable/airtable-connector';
import {
  type NormalizedCreateFieldsPlan,
  type NormalizedCreateTablePlan,
} from 'src/remote-service/connectors/schema-creation.types';

jest.setTimeout(60_000);

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_TEST_BASE_ID;

// Skip unless both a key and a throwaway base are configured (so CI stays green).
const describeIfConfigured = API_KEY && BASE_ID ? describe : describe.skip;

describeIfConfigured('AirtableConnector create-schema — live API', () => {
  // Guaranteed defined inside the gated describe; narrow for the type checker.
  const apiKey = API_KEY as string;
  const baseId = BASE_ID as string;
  const tableName = `scratch_it_${Date.now()}`;

  let connector: AirtableConnector;
  let createdRemoteTableId: string[] = [];

  beforeAll(() => {
    connector = new AirtableConnector(apiKey);
  });

  it('creates a table with representative field kinds', async () => {
    const plan: NormalizedCreateTablePlan = {
      remoteParentId: [baseId],
      ref: 'people',
      name: tableName,
      fields: [
        { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
        { name: 'Age', fieldType: { kind: 'number', format: 'integer' } },
        { name: 'Price', fieldType: { kind: 'currency', currencyCode: 'USD' } },
        { name: 'Due', fieldType: { kind: 'date', includesTime: true } },
        { name: 'Stage', fieldType: { kind: 'select', options: [{ name: 'New' }, { name: 'Done' }] } },
        { name: 'Active', fieldType: { kind: 'boolean' } },
      ],
      deferredFkFields: [],
    };

    const result = await connector.createTable(plan);

    expect(result.status).toBe('created');
    const remoteTableId = result.remoteTableId ?? [];
    expect(remoteTableId).toHaveLength(2);
    expect(remoteTableId[0]).toBe(baseId);
    expect(remoteTableId[1]).toMatch(/^tbl/);
    for (const field of result.fields) {
      expect(field.status).toBe('created');
      expect(field.remoteFieldId).toBeDefined();
    }

    createdRemoteTableId = remoteTableId;
    console.log(`\nAirtable create-schema: created table "${tableName}" (${createdRemoteTableId.join('/')})\n`);
  });

  it('reads the created table back via fetchJsonTableSpec', async () => {
    const spec = await connector.fetchJsonTableSpec({ wsId: tableName, remoteId: createdRemoteTableId });
    const fieldProps = (spec.schema as unknown as { properties: { fields: { properties: Record<string, unknown> } } })
      .properties.fields.properties;
    expect(Object.keys(fieldProps)).toEqual(
      expect.arrayContaining(['Title', 'Age', 'Price', 'Due', 'Stage', 'Active']),
    );
  });

  it('adds a field to the created table', async () => {
    const plan: NormalizedCreateFieldsPlan = {
      remoteTableId: createdRemoteTableId,
      fields: [{ name: 'Notes', fieldType: { kind: 'longText' } }],
    };

    const results = await connector.createFields(plan);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('created');
    expect(results[0].remoteFieldId).toBeDefined();
  });
});
