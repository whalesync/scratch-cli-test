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

  // DEV-11101. Airtable auto-creates a reciprocal "mirror" link field on the target
  // table, named after the table pointing at it. Batched into ONE createTable call
  // Airtable does NOT de-duplicate that name, so three links to the same target used
  // to leave three columns on the target ALL identically named — after which every
  // record write to the target failed with `Ambiguous field name: "…"`, unrepairable
  // via the API (no delete-field endpoint, and renaming onto a taken name is refused).
  // The connector now batches only the first link per target and adds the rest one at
  // a time, letting Airtable's own de-duplication produce "X", "X 2", "X 3".
  //
  // This is the case the suite previously had NO coverage for: before this test, the
  // live create-schema suite created no foreign keys at all.
  it('gives every mirror a unique name when several links target one table', async () => {
    const linkFieldType = { kind: 'foreignKey' as const, target: { existingRemoteTableId: createdRemoteTableId } };
    const linkingTableName = `${tableName}_links`;
    const plan: NormalizedCreateTablePlan = {
      remoteParentId: [baseId],
      ref: 'links',
      name: linkingTableName,
      fields: [
        { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
        { name: 'Link One', fieldType: linkFieldType },
        { name: 'Link Two', fieldType: linkFieldType },
        { name: 'Link Three', fieldType: linkFieldType },
      ],
      deferredFkFields: [],
    };

    const result = await connector.createTable(plan);

    expect(result.status).toBe('created');
    for (const field of result.fields) {
      expect(field.status).toBe('created');
      expect(field.remoteFieldId).toBeDefined();
    }

    // Read the TARGET table back: it must carry three distinctly-named mirrors.
    const targetSpec = await connector.fetchJsonTableSpec({ wsId: tableName, remoteId: createdRemoteTableId });
    const targetFieldNames = Object.keys(
      (targetSpec.schema as unknown as { properties: { fields: { properties: Record<string, unknown> } } }).properties
        .fields.properties,
    );
    const mirrorNames = targetFieldNames.filter((name) => name.startsWith(linkingTableName));
    expect(mirrorNames).toHaveLength(3);
    expect(new Set(mirrorNames).size).toBe(3);

    // And the payoff: a name-keyed write to the target is no longer ambiguous.
    const [firstMirrorName] = mirrorNames;
    const created = await connector.createRecords(targetSpec, [
      { fields: { Title: 'DEV-11101 ambiguity check', [firstMirrorName]: [] } },
    ] as never);
    expect(created).toHaveLength(1);
    await connector.deleteRecords(targetSpec, created);
  });
});
