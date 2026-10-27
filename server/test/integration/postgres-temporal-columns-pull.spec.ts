/**
 * Postgres `date` / naive `timestamp` columns pull the same on every host (DEV-12576), against the localdev Postgres.
 *
 * The test environment pins the worker to America/Los_Angeles (assigning `process.env.TZ` inside a spec has no effect,
 * and CI runs in UTC, where the bug doesn't show). There, node-postgres's default parsers turned a `date` into local
 * midnight (`1965-07-31` → `1965-07-31T07:00:00.000Z`) and shifted a naive `timestamp` by the UTC offset. Pulled
 * through the connector, a `date` must stay `YYYY-MM-DD` and a naive `timestamp` must read as UTC wall-clock, and the
 * pulled values must write back into the same columns unchanged.
 *
 * Everything lives in a throwaway schema dropped before and after the run.
 *
 * Run via: cd server && yarn test:integration -- postgres-temporal-columns-pull
 *
 * @jest-environment <rootDir>/../jest-environments/node-environment-in-fixed-time-zone.ts
 * @jest-environment-options {"timeZone": "America/Los_Angeles"}
 */
import { Pool } from 'pg';
import { PostgresConnector } from 'src/remote-service/connectors/library/postgres/postgres-connector';
import type { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';
import {
  buildConnectorConnectionStringForLocalPostgresTestDatabase,
  readLocalPostgresTestDatabaseUrl,
} from './postgres-integration-helpers';

const SCHEMA = 'scratch_temporal_columns_it';

describe('Postgres date / naive timestamp columns pull independent of the host time zone (DEV-12576)', () => {
  let pool: Pool;
  let connector: PostgresConnector;

  async function pullAllRecordFiles(tableSpec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
    const pulledFiles: ConnectorFile[] = [];
    await connector.pullRecordFiles(
      tableSpec,
      async ({ files }) => {
        // The on-disk JSON round-trip every pulled record goes through.
        pulledFiles.push(...(JSON.parse(JSON.stringify(files)) as ConnectorFile[]));
        return Promise.resolve();
      },
      {},
      {},
    );
    return pulledFiles.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: readLocalPostgresTestDatabaseUrl() });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`
      CREATE TABLE ${SCHEMA}.events (
        id serial PRIMARY KEY,
        label text,
        due_on date,
        due_dates date[],
        happened_at timestamp,
        happened_ats timestamp[],
        recorded_at timestamptz
      )`);
    await pool.query(`
      INSERT INTO ${SCHEMA}.events (label, due_on, due_dates, happened_at, happened_ats, recorded_at)
      VALUES
        ('a-typical', '1965-07-31', ARRAY['2026-12-31'::date, NULL], '2026-08-05 04:30:15.123456',
         ARRAY['2026-01-02 03:04:05.5'::timestamp], '2026-08-05T04:30:15.987+05:30'),
        ('b-extremes', '0100-01-01', ARRAY[]::date[], '9999-12-31 23:59:59', NULL, NULL),
        ('c-nulls', NULL, NULL, NULL, NULL, NULL)`);
    connector = new PostgresConnector({
      connectionString: buildConnectorConnectionStringForLocalPostgresTestDatabase(),
    });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('types a date column format: date and a timestamp column format: date-time', async () => {
    const tableSpec = await connector.fetchJsonTableSpec({ wsId: 'events', remoteId: [SCHEMA, 'events'] });
    const columnSchemas = tableSpec.schema.properties as Record<string, { anyOf?: { format?: string }[] }>;
    const formatOfNullableColumn = (columnName: string) =>
      columnSchemas[columnName].anyOf?.find((member) => member.format !== undefined)?.format;
    expect(formatOfNullableColumn('due_on')).toBe('date');
    expect(formatOfNullableColumn('happened_at')).toBe('date-time');
    expect(formatOfNullableColumn('recorded_at')).toBe('date-time');
  });

  it('pulls a date as YYYY-MM-DD and a naive timestamp as UTC wall-clock on a non-UTC host', async () => {
    const tableSpec = await connector.fetchJsonTableSpec({ wsId: 'events', remoteId: [SCHEMA, 'events'] });
    const pulledFiles = await pullAllRecordFiles(tableSpec);

    expect(pulledFiles).toHaveLength(3);
    expect(pulledFiles[0]).toMatchObject({
      label: 'a-typical',
      due_on: '1965-07-31',
      due_dates: ['2026-12-31', null],
      happened_at: '2026-08-05T04:30:15.123Z',
      happened_ats: ['2026-01-02T03:04:05.500Z'],
      recorded_at: '2026-08-04T23:00:15.987Z',
    });
    expect(pulledFiles[1]).toMatchObject({
      label: 'b-extremes',
      due_on: '0100-01-01',
      due_dates: [],
      happened_at: '9999-12-31T23:59:59.000Z',
    });
    expect(pulledFiles[2]).toMatchObject({ label: 'c-nulls', due_on: null, due_dates: null, happened_at: null });
  });

  it('writes pulled date and timestamp values back into the same columns unchanged', async () => {
    const tableSpec = await connector.fetchJsonTableSpec({ wsId: 'events', remoteId: [SCHEMA, 'events'] });
    const pulledFiles = await pullAllRecordFiles(tableSpec);
    const typicalRow = pulledFiles[0];

    await connector.createRecords(tableSpec, [
      {
        label: 'd-written-back',
        due_on: typicalRow.due_on,
        due_dates: typicalRow.due_dates,
        happened_at: typicalRow.happened_at,
        happened_ats: typicalRow.happened_ats,
        recorded_at: typicalRow.recorded_at,
      },
    ]);

    const storedAsText = await pool.query<Record<string, string>>(
      `SELECT due_on::text, due_dates::text, happened_at::text, happened_ats::text
       FROM ${SCHEMA}.events WHERE label = 'd-written-back'`,
    );
    expect(storedAsText.rows[0]).toEqual({
      due_on: '1965-07-31',
      due_dates: '{2026-12-31,NULL}',
      happened_at: '2026-08-05 04:30:15.123',
      happened_ats: '{"2026-01-02 03:04:05.5"}',
    });

    const repulledFiles = await pullAllRecordFiles(tableSpec);
    const writtenBackRow = repulledFiles.find((file) => file.label === 'd-written-back');
    expect(writtenBackRow).toMatchObject({
      due_on: typicalRow.due_on,
      due_dates: typicalRow.due_dates,
      happened_at: typicalRow.happened_at,
      happened_ats: typicalRow.happened_ats,
      recorded_at: typicalRow.recorded_at,
    });
  });

  it('leaves the process-global node-postgres parsers alone (the server database keeps Date values)', async () => {
    const result = await pool.query<{ due_on: unknown }>(
      `SELECT due_on FROM ${SCHEMA}.events WHERE label = 'a-typical'`,
    );
    expect(result.rows[0].due_on).toBeInstanceOf(Date);
    // Control: the driver's default local-midnight parse proves the worker really runs in Los Angeles.
    expect((result.rows[0].due_on as Date).toISOString()).toBe('1965-07-31T07:00:00.000Z');
  });
});
