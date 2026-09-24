/**
 * Postgres → Postgres create-schema fidelity (DEV-11903), against the localdev Postgres.
 *
 * Exercises the whole same-type-system path with real catalogs and real DDL:
 *   1. The read side annotates every column with its exact `format_type()` spelling (the catalog join in
 *      `findAllColumnsInTable` runs for real here).
 *   2. The plan generator, given the Postgres destination capabilities, carries each recreatable type as
 *      `nativeFieldType` and keeps the source column names; non-recreatable types (bytea, a user enum) fall
 *      back to their logical mapping.
 *   3. `createTable` creates the destination columns with exactly the source's types.
 *   4. Pulled source records (after the JSON round-trip they get on disk) insert into the destination
 *      unchanged — including `text[]`, `jsonb` objects AND arrays, `numeric`/`bigint` strings, and nulls.
 *
 * Everything lives in a throwaway schema dropped before and after the run.
 *
 * Run via: cd server && yarn test:integration -- postgres-native-column-types
 */
import { X_SCRATCH_NATIVE_COLUMN_TYPE } from '@spinner/shared-types';
import { Pool } from 'pg';
import { POSTGRES_SCHEMA_CREATION_CAPABILITIES } from 'src/remote-service/connectors/library/pg-common/pg-create-schema';
import { buildPgDefaultView } from 'src/remote-service/connectors/library/pg-common/pg-default-view';
import { PostgresConnector } from 'src/remote-service/connectors/library/postgres/postgres-connector';
import type { ConnectorFile } from 'src/remote-service/connectors/types';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { generateCreatePlanFromSources } from 'src/schema-builder/schema-builder-plan-generator';

const SCHEMA = 'scratch_native_types_it';

/** Source column → its `format_type()` spelling, as created below. */
const SOURCE_COLUMN_TYPES: Record<string, string> = {
  id: 'integer',
  request_id_autonumber: 'bigint',
  price: 'numeric(12,2)',
  short_code: 'character varying(50)',
  pharmacies_desired: 'text[]',
  counts: 'integer[]',
  is_active: 'boolean',
  payload: 'jsonb',
  list_payload: 'jsonb',
  created_at: 'timestamp with time zone',
  birthday: 'date',
  external_id: 'uuid',
  file_bytes: 'bytea',
  mood: 'scratch_native_types_it.mood',
};

describe('Postgres → Postgres create-schema keeps exact column types (DEV-11903)', () => {
  let pool: Pool;
  let connector: PostgresConnector;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/scratchpad?schema=public';
    pool = new Pool({ connectionString: dbUrl });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TYPE ${SCHEMA}.mood AS ENUM ('happy', 'sad')`);
    await pool.query(`
      CREATE TABLE ${SCHEMA}.requests (
        id serial PRIMARY KEY,
        request_id_autonumber bigint,
        price numeric(12,2),
        short_code varchar(50),
        pharmacies_desired text[],
        counts integer[],
        is_active boolean,
        payload jsonb,
        list_payload jsonb,
        created_at timestamptz,
        birthday date,
        external_id uuid,
        file_bytes bytea,
        mood ${SCHEMA}.mood
      )`);
    await pool.query(`
      INSERT INTO ${SCHEMA}.requests
        (request_id_autonumber, price, short_code, pharmacies_desired, counts, is_active, payload, list_payload,
         created_at, birthday, external_id, file_bytes, mood)
      VALUES
        (9007199254740993, 15000.25, 'ABC', ARRAY['New Solutions', 'CPRx'], ARRAY[1, 2, 3], true,
         '{"a": 1, "nested": {"b": [true]}}', '["x", 2]', '2026-01-02T03:04:05Z', '2026-01-02',
         'a177b193-84c7-43ea-8214-a2acfd1b623a', '\\xdeadbeef', 'happy'),
        (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`);
    connector = new PostgresConnector({ connectionString: dbUrl });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('round-trips types, names and values through plan → create → insert', async () => {
    // 1. Read side: exact native types annotated from the real catalog.
    const sourceSpec = await connector.fetchJsonTableSpec({ wsId: 'requests', remoteId: [SCHEMA, 'requests'] });
    const sourceProperties = sourceSpec.schema.properties as Record<string, Record<string, unknown>>;
    for (const [columnName, formatType] of Object.entries(SOURCE_COLUMN_TYPES)) {
      expect(sourceProperties[columnName][X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({
        typeSystem: 'postgres',
        type: formatType,
      });
    }
    expect(sourceProperties.pharmacies_desired[X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({
      isRecreatableVerbatim: true,
    });
    expect(sourceProperties.file_bytes[X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({ isRecreatableVerbatim: false });
    expect(sourceProperties.mood[X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({ isRecreatableVerbatim: false });

    // 2. Plan, exactly as the service derives it (view-driven field selection + destination capabilities).
    const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
      schema: sourceSpec.schema,
      view: buildPgDefaultView(sourceSpec.schema),
      idPath: 'id',
    });
    const { tables } = generateCreatePlanFromSources({
      sources: [
        {
          ref: 'requests',
          dataFolderId: 'requests',
          tableName: 'requests_copy',
          schemaFields,
          viewTypeByPath,
          idFieldPath: 'id',
          remoteTableIds: [`${SCHEMA}.requests`],
          connectorService: 'POSTGRES',
        },
      ],
      destinationConnectorAccountId: 'dest',
      destinationConnectorService: 'POSTGRES',
      destinationReservedFieldNames: POSTGRES_SCHEMA_CREATION_CAPABILITIES.reservedFieldNames,
      destinationFieldTypeSupport: {
        supportedFieldKinds: POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds,
        supportedArrayElementKinds: POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedArrayElementKinds,
        nativeTypeSystem: POSTGRES_SCHEMA_CREATION_CAPABILITIES.nativeTypeSystem,
      },
    });
    const planTable = tables[0];
    // Source column names are kept verbatim (not the view's "Pharmacies Desired").
    expect(planTable.fields.map((planField) => planField.name)).toEqual(
      expect.arrayContaining(['pharmacies_desired', 'request_id_autonumber', 'postgres_source_record_id']),
    );

    // 3. Create the destination table from the plan.
    const createResult = await connector.createTable({
      remoteParentId: [SCHEMA],
      ref: planTable.ref,
      name: planTable.name,
      fields: planTable.fields,
      deferredFkFields: [],
    });
    expect(createResult.status).toBe('created');

    const destinationColumnTypes = await pool.query<{ column_name: string; native_type: string }>(
      `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS native_type
       FROM pg_attribute a
       WHERE a.attrelid = '${SCHEMA}.requests_copy'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    const destinationTypeByColumn = new Map(
      destinationColumnTypes.rows.map((row) => [row.column_name, row.native_type]),
    );
    for (const [columnName, formatType] of Object.entries(SOURCE_COLUMN_TYPES)) {
      if (columnName === 'id') continue; // the destination owns its own id
      if (columnName === 'file_bytes' || columnName === 'mood') {
        // Not recreatable verbatim → the logical fallback.
        expect(destinationTypeByColumn.get(columnName)).toBe('text');
        continue;
      }
      expect(destinationTypeByColumn.get(columnName)).toBe(formatType);
    }

    // 4. Pulled source records (after the on-disk JSON round-trip) insert unchanged.
    const pulledFiles: ConnectorFile[] = [];
    await connector.pullRecordFiles(
      sourceSpec,
      async ({ files }) => {
        pulledFiles.push(...(JSON.parse(JSON.stringify(files)) as ConnectorFile[]));
        return Promise.resolve();
      },
      {},
      {},
    );
    expect(pulledFiles).toHaveLength(2);

    const recreatedColumnNames = Object.keys(SOURCE_COLUMN_TYPES).filter(
      (columnName) => !['id', 'file_bytes', 'mood'].includes(columnName),
    );
    const destinationSpec = await connector.fetchJsonTableSpec({
      wsId: 'requests_copy',
      remoteId: [SCHEMA, 'requests_copy'],
    });
    const destinationFiles = pulledFiles.map((pulledFile) =>
      Object.fromEntries(recreatedColumnNames.map((columnName) => [columnName, pulledFile[columnName]])),
    );
    const insertedRows = await connector.createRecords(destinationSpec, destinationFiles);
    expect(insertedRows).toHaveLength(2);

    const destinationPulledFiles: ConnectorFile[] = [];
    await connector.pullRecordFiles(
      destinationSpec,
      async ({ files }) => {
        destinationPulledFiles.push(...(JSON.parse(JSON.stringify(files)) as ConnectorFile[]));
        return Promise.resolve();
      },
      {},
      {},
    );
    const pickRecreatedColumns = (file: ConnectorFile) =>
      Object.fromEntries(recreatedColumnNames.map((columnName) => [columnName, file[columnName]]));
    const byRequestId = (file: ConnectorFile) => String(file.request_id_autonumber);
    expect(
      destinationPulledFiles.map(pickRecreatedColumns).sort((a, b) => byRequestId(a).localeCompare(byRequestId(b))),
    ).toEqual(pulledFiles.map(pickRecreatedColumns).sort((a, b) => byRequestId(a).localeCompare(byRequestId(b))));
    // Spot-check the shapes that used to break: a text[] list, a jsonb ARRAY, a bigint beyond 2^53, and nulls.
    const fullRow = destinationPulledFiles.find((file) => file.pharmacies_desired !== null);
    expect(fullRow).toMatchObject({
      pharmacies_desired: ['New Solutions', 'CPRx'],
      list_payload: ['x', 2],
      payload: { a: 1, nested: { b: [true] } },
      request_id_autonumber: '9007199254740993',
      price: '15000.25',
    });
    const nullRow = destinationPulledFiles.find((file) => file.pharmacies_desired === null);
    expect(nullRow).toMatchObject({ pharmacies_desired: null, payload: null, counts: null });
  });
});
