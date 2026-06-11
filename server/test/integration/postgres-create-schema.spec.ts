/**
 * Postgres create-schema integration test (real DDL against a live database).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * What this validates that the unit tests don't
 * ═══════════════════════════════════════════════════════════════════════════
 * The pure builder (pg-create-schema.spec.ts) asserts the generated SQL, and the
 * connector spec asserts dispatch with a mocked client. This test runs the real
 * `PostgresConnector.createTable` / `createFields` against the localdev Postgres
 * and proves the end-to-end contract the manual run relies on:
 *
 *   1. createTable maps every non-FK logical kind to a real column and injects an
 *      auto-generated `id` primary key.
 *   2. createTable with a foreignKey builds a real FK constraint (ON DELETE SET
 *      NULL) referencing the target table's primary key.
 *   3. The created tables round-trip through the connector's own read side:
 *      listTables marks them creatable (auto PK detected) and fetchJsonTableSpec
 *      re-exposes the FK annotation.
 *   4. createRecords inserts a row and gets back the auto-generated id.
 *   5. createFields adds a plain column and a self-referential FK.
 *   6. An allowMultiple FK is skipped with a reason; the rest of the table lands.
 *
 * Everything is created in a throwaway schema dropped before and after the run.
 *
 * Run via: cd server && yarn test:integration -- postgres-create-schema
 */
import { X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { Pool } from 'pg';
import { PostgresConnector } from 'src/remote-service/connectors/library/postgres/postgres-connector';

const SCHEMA = 'scratch_create_schema_it';

describe('Postgres create-schema — real DDL round-trip', () => {
  let pool: Pool;
  let connector: PostgresConnector;

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/scratchpad?schema=public';
    pool = new Pool({ connectionString: dbUrl });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    connector = new PostgresConnector({ connectionString: dbUrl });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('creates a table with every non-FK field kind and an auto-generated id PK', async () => {
    const result = await connector.createTable({
      remoteParentId: [SCHEMA],
      ref: 'users',
      name: 'users',
      fields: [
        { name: 'name', fieldType: { kind: 'text' } },
        { name: 'email', fieldType: { kind: 'email' } },
        { name: 'age', fieldType: { kind: 'number', format: 'integer' } },
        { name: 'score', fieldType: { kind: 'number', format: 'plain' } },
        { name: 'price', fieldType: { kind: 'currency', currencyCode: 'USD' } },
        { name: 'is_active', fieldType: { kind: 'boolean' } },
        { name: 'signed_up', fieldType: { kind: 'date', includesTime: true } },
        { name: 'birthday', fieldType: { kind: 'date' } },
        { name: 'plan', fieldType: { kind: 'select', options: [{ name: 'free' }, { name: 'pro' }] } },
        { name: 'tags', fieldType: { kind: 'multiSelect', options: [{ name: 'a' }] } },
        { name: 'website', fieldType: { kind: 'url' } },
      ],
      deferredFkFields: [],
    });

    expect(result.status).toBe('created');
    expect(result.remoteTableId).toEqual([SCHEMA, 'users']);
    expect(result.fields.every((field) => field.status === 'created')).toBe(true);

    const columns = await pool.query<{ column_name: string; data_type: string; column_default: string | null }>(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users'`,
      [SCHEMA],
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
    // Auto PK is an auto-generated uuid (gen_random_uuid), which the read side detects as creatable.
    expect(byName.get('id')?.data_type).toBe('uuid');
    expect(byName.get('id')?.column_default).toContain('gen_random_uuid');
    expect(byName.get('tags')?.data_type).toBe('ARRAY');
    expect(byName.get('signed_up')?.data_type).toBe('timestamp with time zone');
    expect(byName.get('birthday')?.data_type).toBe('date');
    expect(byName.get('score')?.data_type).toBe('double precision');
  });

  it('creates a second table with a real foreign key (ON DELETE SET NULL) to the first', async () => {
    const result = await connector.createTable({
      remoteParentId: [SCHEMA],
      ref: 'posts',
      name: 'posts',
      fields: [
        { name: 'title', fieldType: { kind: 'text' }, required: true },
        { name: 'body', fieldType: { kind: 'longText' } },
        { name: 'amount', fieldType: { kind: 'currency', currencyCode: 'USD', precision: 2 } },
        { name: 'author_id', fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: [SCHEMA, 'users'] } } },
      ],
      deferredFkFields: [],
    });

    expect(result.status).toBe('created');
    expect(result.fields.find((field) => field.name === 'author_id')?.status).toBe('created');

    const foreignKey = await pool.query<{ confdeltype: string }>(
      `SELECT con.confdeltype
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE con.contype = 'f' AND nsp.nspname = $1 AND rel.relname = 'posts'`,
      [SCHEMA],
    );
    expect(foreignKey.rows).toHaveLength(1);
    expect(foreignKey.rows[0].confdeltype).toBe('n'); // 'n' = ON DELETE SET NULL
  });

  it('round-trips the created tables through the connector read side', async () => {
    const tables = await connector.listTables();
    const users = tables.find((table) => table.id.remoteId[0] === SCHEMA && table.id.remoteId[1] === 'users');
    const posts = tables.find((table) => table.id.remoteId[0] === SCHEMA && table.id.remoteId[1] === 'posts');

    // An auto-generated PK means the table is NOT disabled for reads or creates.
    expect(users?.disabled).toBeUndefined();
    expect(users?.disabledCreates).toBeUndefined();
    expect(posts?.disabled).toBeUndefined();
    expect(posts?.disabledCreates).toBeUndefined();

    const spec = await connector.fetchJsonTableSpec({ wsId: 'posts', remoteId: [SCHEMA, 'posts'] });
    expect(spec.idColumnRemoteId).toBe('id');
    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.author_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: `${SCHEMA}.users` });
  });

  it('inserts a record and returns the auto-generated id', async () => {
    const spec = await connector.fetchJsonTableSpec({ wsId: 'users', remoteId: [SCHEMA, 'users'] });
    const created = await connector.createRecords(spec, [
      { name: 'Ada', email: 'ada@example.com', age: 36, is_active: true },
    ]);

    expect(created).toHaveLength(1);
    expect(typeof created[0].id).toBe('string');
    expect(String(created[0].id)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created[0].name).toBe('Ada');

    const rows = await pool.query<{ id: number; name: string; email: string }>(
      `SELECT id, name, email FROM ${SCHEMA}.users`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].name).toBe('Ada');
  });

  it('adds a plain column and a self-referential foreign key via createFields', async () => {
    const results = await connector.createFields({
      remoteTableId: [SCHEMA, 'users'],
      fields: [
        { name: 'nickname', fieldType: { kind: 'text' } },
        { name: 'manager_id', fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: [SCHEMA, 'users'] } } },
      ],
    });

    expect(results).toEqual([
      { name: 'nickname', status: 'created', remoteFieldId: 'nickname' },
      { name: 'manager_id', status: 'created', remoteFieldId: 'manager_id' },
    ]);

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'`,
      [SCHEMA],
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('nickname');
    expect(names).toContain('manager_id');
  });

  it('skips an allowMultiple foreign key but still creates the rest of the table', async () => {
    const result = await connector.createTable({
      remoteParentId: [SCHEMA],
      ref: 'tagging',
      name: 'tagging',
      fields: [
        { name: 'label', fieldType: { kind: 'text' } },
        {
          name: 'user_ids',
          fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: [SCHEMA, 'users'] }, allowMultiple: true },
        },
      ],
      deferredFkFields: [],
    });

    expect(result.status).toBe('partial');
    expect(result.fields.find((field) => field.name === 'user_ids')?.status).toBe('skipped');

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tagging'`,
      [SCHEMA],
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toEqual(expect.arrayContaining(['id', 'label']));
    expect(names).not.toContain('user_ids');
  });
});
