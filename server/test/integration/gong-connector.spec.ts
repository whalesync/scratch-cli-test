/**
 * Gong connector live API integration test.
 *
 * Gong is a READ-ONLY connector (the Gong API has no update surface), so this
 * suite covers the read paths — credentials, table discovery, schema builds,
 * pulls (including the empty-result-as-404 quirk), by-id fetches — plus the
 * read-only contract (create/update/delete throw) and error extraction.
 *
 * Requires GONG_ACCESS_KEY + GONG_ACCESS_KEY_SECRET (and optionally
 * GONG_API_BASE_URL, the instance-specific cell URL) in .env.integration.
 * Test account: the Whalesync Gong partner developer instance (see
 * server/src/remote-service/connectors/library/gong/STATE.md).
 *
 * Run via: cd server && yarn test:integration -- gong-connector
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { GongConnector, parseGongTableId } from 'src/remote-service/connectors/library/gong/gong-connector';
import { GongEntityType } from 'src/remote-service/connectors/library/gong/gong-types';
import { ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

// Gong allows 3 req/s; the suite makes ~a dozen calls with retry backoff.
jest.setTimeout(120_000);

const ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const ACCESS_KEY_SECRET = process.env.GONG_ACCESS_KEY_SECRET;
const BASE_URL = process.env.GONG_API_BASE_URL;

const describeIfKey = ACCESS_KEY && ACCESS_KEY_SECRET ? describe : describe.skip;

function createConnector(): GongConnector {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return new GongConnector(ACCESS_KEY!, ACCESS_KEY_SECRET!, BASE_URL);
}

async function pullAllRecords(connector: GongConnector, table: TablePreview): Promise<ConnectorFile[]> {
  const spec = await connector.fetchJsonTableSpec(table.id);
  const pulled_records: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    spec,
    // eslint-disable-next-line @typescript-eslint/require-await
    async ({ files }) => {
      pulled_records.push(...files);
    },
    {},
    { pullMode: 'full' },
  );
  return pulled_records;
}

describeIfKey('Gong connector (live API)', () => {
  let connector: GongConnector;
  let tables: TablePreview[];

  beforeAll(async () => {
    connector = createConnector();
    tables = await connector.listTables();
  });

  it('validates credentials', async () => {
    await expect(connector.testConnection()).resolves.toBeUndefined();
  });

  it('rejects bad credentials', async () => {
    const bad_connector = new GongConnector('WRONGKEY', 'WRONGSECRET', BASE_URL);
    await expect(bad_connector.testConnection()).rejects.toThrow(/invalid gong access key/i);
  });

  it('lists all six entity families, every one flagged fully read-only', () => {
    const entity_types_listed = new Set(tables.map((table) => parseGongTableId(table.id).entityType));
    expect(entity_types_listed).toEqual(
      new Set([
        GongEntityType.CALLS,
        GongEntityType.TRANSCRIPTS,
        GongEntityType.LIBRARY_FOLDERS,
        GongEntityType.SCORECARDS,
        GongEntityType.USERS,
        GongEntityType.WORKSPACES,
      ]),
    );
    for (const table of tables) {
      expect(table.disabledCreates).toBe(true);
      expect(table.disabledUpdates).toBe(true);
      expect(table.disabledDeletes).toBe(true);
    }
  });

  it('builds a schema and default view for every table', async () => {
    for (const table of tables) {
      const spec = await connector.fetchJsonTableSpec(table.id);
      expect(spec.idPath).toBeTruthy();
      expect(Object.keys((spec.schema as { properties?: object }).properties ?? {}).length).toBeGreaterThan(0);
      const view = connector.buildDefaultView(spec);
      expect(view?.cols.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('pulls users (the dev instance always has at least one)', async () => {
    const users_table = tables.find((table) => parseGongTableId(table.id).entityType === GongEntityType.USERS);
    expect(users_table).toBeDefined();
    if (!users_table) return;
    const users = await pullAllRecords(connector, users_table);
    expect(users.length).toBeGreaterThan(0);
    expect(users[0]).toHaveProperty('id');
    expect(users[0]).toHaveProperty('emailAddress');
  });

  it('pulls workspaces and library folders (workspace-scoped table)', async () => {
    const workspaces_table = tables.find(
      (table) => parseGongTableId(table.id).entityType === GongEntityType.WORKSPACES,
    );
    const folders_table = tables.find(
      (table) => parseGongTableId(table.id).entityType === GongEntityType.LIBRARY_FOLDERS,
    );
    expect(workspaces_table).toBeDefined();
    expect(folders_table).toBeDefined();
    if (!workspaces_table || !folders_table) return;

    const workspaces = await pullAllRecords(connector, workspaces_table);
    expect(workspaces.length).toBeGreaterThan(0);

    // A fresh Gong instance ships with default library folders; tolerate zero
    // but assert the shape when present.
    const folders = await pullAllRecords(connector, folders_table);
    for (const folder of folders) {
      expect(folder).toHaveProperty('id');
      expect(folder).toHaveProperty('name');
    }
  });

  it('maps the empty-result 404 quirk to an empty pull (calls table on an unseeded instance)', async () => {
    const calls_table = tables.find((table) => parseGongTableId(table.id).entityType === GongEntityType.CALLS);
    expect(calls_table).toBeDefined();
    if (!calls_table) return;
    // Must resolve (possibly with zero records) — never throw on "No calls found".
    const calls = await pullAllRecords(connector, calls_table);
    expect(Array.isArray(calls)).toBe(true);
  });

  it('pullRecordFilesByIds silently skips ids that do not exist', async () => {
    const users_table = tables.find((table) => parseGongTableId(table.id).entityType === GongEntityType.USERS);
    if (!users_table) return;
    const spec = await connector.fetchJsonTableSpec(users_table.id);
    const fetched: ConnectorFile[] = [];
    await connector.pullRecordFilesByIds(
      spec,
      ['999999999999999999'],
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files }) => {
        fetched.push(...files);
      },
    );
    expect(fetched).toEqual([]);
  });

  it('throws a clear read-only error from every write method', async () => {
    const users_table = tables.find((table) => parseGongTableId(table.id).entityType === GongEntityType.USERS);
    if (!users_table) return;
    const spec = await connector.fetchJsonTableSpec(users_table.id);
    await expect(connector.createRecords(spec, [{}])).rejects.toThrow(/read-only/i);
    await expect(connector.updateRecords(spec, [{}], [{}])).rejects.toThrow(/read-only/i);
    await expect(connector.deleteRecords(spec, [{}])).rejects.toThrow(/read-only/i);
  });

  it('extracts a friendly message from Gong errors', () => {
    const details = connector.extractConnectorErrorDetails(new Error('boom'));
    expect(details.userFriendlyMessage).toBeTruthy();
  });
});
