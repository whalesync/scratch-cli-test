import { Type } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, PullRecordFilesOptions, idPath } from '../../../types';
import { PG_INCREMENTAL_CLOCK_SKEW_MS, type InformationSchemaColumn, type PostgresForeignKey } from '../../pg-common';
import { SupabaseConnector } from '../supabase-connector';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Supabase'),
}));

const mockFindAllColumnsInTable = jest.fn();
const mockFindPrimaryColumnCandidates = jest.fn();
const mockFindAllForeignKeysInTable = jest.fn();
const mockSelectAll = jest.fn();
const mockDispose = jest.fn();

jest.mock('../../pg-common/knex-pg-client', () => {
  return {
    KnexPGClient: jest.fn().mockImplementation(() => ({
      findAllColumnsInTable: mockFindAllColumnsInTable,
      findPrimaryColumnCandidates: mockFindPrimaryColumnCandidates,
      findAllForeignKeysInTable: mockFindAllForeignKeysInTable,
      selectAll: mockSelectAll,
      dispose: mockDispose,
    })),
    KnexPGClientError: class KnexPGClientError extends Error {
      constructor(
        message: string,
        public readonly code?: string,
      ) {
        super(message);
      }
    },
  };
});

const PROJECT_REF = 'abcdefghijklmnopqrst';
const CONNECTION_STRING = `postgresql://postgres:pw@db.${PROJECT_REF}.supabase.co:5432/postgres`;

function buildColumn(overrides: Partial<InformationSchemaColumn> & { column_name: string }): InformationSchemaColumn {
  return {
    data_type: 'text',
    column_default: null,
    is_updatable: 'YES',
    is_nullable: 'NO',
    domain_name: null,
    udt_name: 'text',
    character_maximum_length: null,
    is_identity: 'NO',
    identity_increment: null,
    identity_cycle: 'NO',
    ...overrides,
  };
}

describe('SupabaseConnector.fetchJsonTableSpec', () => {
  const id: EntityId = { wsId: 'records', remoteId: [PROJECT_REF, 'public', 'records'] };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDispose.mockResolvedValue(undefined);
    mockFindAllForeignKeysInTable.mockResolvedValue([]);
    mockFindPrimaryColumnCandidates.mockResolvedValue(['id']);
  });

  async function fetchSchema(columns: InformationSchemaColumn[], foreignKeys: PostgresForeignKey[] = []) {
    mockFindAllColumnsInTable.mockResolvedValue(columns);
    mockFindAllForeignKeysInTable.mockResolvedValue(foreignKeys);
    const connector = new SupabaseConnector({ connectionString: CONNECTION_STRING });
    return connector.fetchJsonTableSpec(id);
  }

  it('annotates VARCHAR(n) fields with x-scratch-max-length', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({
        column_name: 'short_code',
        data_type: 'character varying',
        udt_name: 'varchar',
        character_maximum_length: 11,
      }),
      buildColumn({
        column_name: 'fixed_code',
        data_type: 'character',
        udt_name: 'bpchar',
        character_maximum_length: 5,
      }),
    ]);

    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.short_code[X_SCRATCH_MAX_LENGTH]).toBe(11);
    expect(properties.fixed_code[X_SCRATCH_MAX_LENGTH]).toBe(5);
    expect(properties.id[X_SCRATCH_MAX_LENGTH]).toBeUndefined();
  });

  it('omits x-scratch-max-length for unbounded text columns', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({ column_name: 'body', data_type: 'text', udt_name: 'text' }),
    ]);

    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.body[X_SCRATCH_MAX_LENGTH]).toBeUndefined();
  });

  it('preserves max length on nullable columns (Optional wrapper)', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({
        column_name: 'nickname',
        data_type: 'character varying',
        udt_name: 'varchar',
        is_nullable: 'YES',
        character_maximum_length: 30,
      }),
    ]);

    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.nickname[X_SCRATCH_MAX_LENGTH]).toBe(30);
    expect(spec.schema.required).not.toContain('nickname');
  });

  it('annotates connector data type, primary key, and required fields', async () => {
    const spec = await fetchSchema([
      buildColumn({
        column_name: 'id',
        data_type: 'integer',
        udt_name: 'int4',
        column_default: "nextval('records_id_seq'::regclass)",
      }),
      buildColumn({ column_name: 'title', data_type: 'text', udt_name: 'text' }),
      buildColumn({ column_name: 'count', data_type: 'integer', udt_name: 'int4', is_nullable: 'YES' }),
    ]);

    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.id[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('numeric');
    expect(properties.title[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('text');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.schema.required).toEqual(['title']);
    expect(spec.schema.$id).toBe('supabase/public.records');
    expect(spec.schema.title).toBe('records');
    expect(spec.basePath).toEqual(['public']);
  });

  it('marks generated and non-updatable columns as readonly', async () => {
    const spec = await fetchSchema([
      buildColumn({
        column_name: 'id',
        data_type: 'integer',
        udt_name: 'int4',
        column_default: 'gen_random_uuid()',
      }),
      buildColumn({
        column_name: 'computed',
        data_type: 'integer',
        udt_name: 'int4',
        is_updatable: 'NO',
      }),
      buildColumn({ column_name: 'name', data_type: 'text', udt_name: 'text' }),
    ]);

    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.id[X_SCRATCH_READONLY]).toBe(true);
    expect(properties.computed[X_SCRATCH_READONLY]).toBe(true);
    expect(properties.name[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('annotates foreign keys with the linked table id', async () => {
    const spec = await fetchSchema(
      [
        buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
        buildColumn({ column_name: 'author_id', data_type: 'integer', udt_name: 'int4' }),
        buildColumn({ column_name: 'category_id', data_type: 'integer', udt_name: 'int4' }),
      ],
      [
        {
          constraint_name: 'fk_author',
          table_schema: 'public',
          table_name: 'records',
          column_name: 'author_id',
          foreign_table_schema: 'public',
          foreign_table_name: 'authors',
          foreign_column_name: 'id',
        },
        {
          constraint_name: 'fk_category',
          table_schema: 'public',
          table_name: 'records',
          column_name: 'category_id',
          foreign_table_schema: 'taxonomy',
          foreign_table_name: 'categories',
          foreign_column_name: 'id',
        },
      ],
    );

    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.author_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'authors' });
    expect(properties.category_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'taxonomy.categories' });
    expect(properties.id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
  });

  it('falls back to "id" when no primary key candidates are returned', async () => {
    mockFindPrimaryColumnCandidates.mockResolvedValue([]);
    const spec = await fetchSchema([buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' })]);
    expect(spec.idColumnRemoteId).toBe('id');
  });

  it('prefers an auto-generated PK when multiple PK candidates are present', async () => {
    mockFindPrimaryColumnCandidates.mockResolvedValue(['tenant_id', 'id']);
    const spec = await fetchSchema([
      buildColumn({ column_name: 'tenant_id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({
        column_name: 'id',
        data_type: 'integer',
        udt_name: 'int4',
        column_default: 'gen_random_uuid()',
      }),
    ]);
    expect(spec.idColumnRemoteId).toBe('id');
  });

  it('maps array columns to typed array schemas', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({ column_name: 'tags', data_type: 'ARRAY', udt_name: '_text' }),
    ]);

    const tags = (spec.schema.properties as Record<string, Record<string, unknown>>).tags;
    expect(tags.type).toBe('array');
    expect((tags.items as Record<string, unknown>).type).toBe('string');
  });

  it('combines max-length, readonly, and optional on a single column', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({
        column_name: 'tag',
        data_type: 'character varying',
        udt_name: 'varchar',
        is_nullable: 'YES',
        is_updatable: 'NO',
        character_maximum_length: 8,
      }),
    ]);

    const tag = (spec.schema.properties as Record<string, Record<string | symbol, unknown>>).tag;
    expect(tag[X_SCRATCH_MAX_LENGTH]).toBe(8);
    expect(tag[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.required).not.toContain('tag');
  });
});

function buildIncrementalTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'records', remoteId: [PROJECT_REF, 'public', 'records'] },
    slug: 'records',
    name: 'records',
    schema: Type.Object({
      id: Type.Number(),
      name: Type.String(),
      updated_at: Type.String(),
    }),
    idColumnRemoteId: idPath('id'),
  };
}

type SelectAllArgs = [
  schema: string,
  tableName: string,
  columns: string[] | undefined,
  primaryId: string,
  limit: number,
  offset: number,
  filter?: string,
  modifiedSinceColumn?: string,
  modifiedSinceDatetime?: Date,
];

function selectAllCall(index = 0): SelectAllArgs {
  return mockSelectAll.mock.calls[index] as SelectAllArgs;
}

describe('SupabaseConnector incremental pulls', () => {
  let connector: SupabaseConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDispose.mockResolvedValue(undefined);
    mockSelectAll.mockResolvedValue([]); // empty page → loop exits after one call
    connector = new SupabaseConnector({ connectionString: CONNECTION_STRING });
  });

  describe('supportsIncrementalPull', () => {
    it('returns false when modifiedAtField is unset', () => {
      expect(connector.supportsIncrementalPull({}, buildIncrementalTableSpec())).toBe(false);
    });

    it('returns true when modifiedAtField is set (no SQL auto-detection)', () => {
      expect(connector.supportsIncrementalPull({ modifiedAtField: 'updated_at' }, buildIncrementalTableSpec())).toBe(
        true,
      );
    });
  });

  describe('pullRecordFiles', () => {
    const callback = jest.fn().mockResolvedValue(undefined);

    it('runs a full pull (no modified-since args) and returns {} when pullMode is not incremental', async () => {
      const result = await connector.pullRecordFiles(buildIncrementalTableSpec(), callback, {}, { pullMode: 'full' });

      expect(result).toEqual({});
      const [, , , , , , , modifiedSinceColumn, modifiedSinceDatetime] = selectAllCall();
      expect(modifiedSinceColumn).toBeUndefined();
      expect(modifiedSinceDatetime).toBeUndefined();
    });

    it('demotes to full when pullMode is incremental but modifiedAtField is unset', async () => {
      const since = new Date('2026-05-01T00:00:00.000Z');
      const options: PullRecordFilesOptions = { pullMode: 'incremental', since };

      const result = await connector.pullRecordFiles(buildIncrementalTableSpec(), callback, {}, options);

      expect(result).toEqual({});
      const [, , , , , , , modifiedSinceColumn] = selectAllCall();
      expect(modifiedSinceColumn).toBeUndefined();
    });

    it('passes the column + clock-skew-adjusted datetime and returns a newWatermark', async () => {
      const since = new Date('2026-05-01T12:00:00.000Z');
      const options: PullRecordFilesOptions = { pullMode: 'incremental', since, modifiedAtField: 'updated_at' };

      const before = Date.now();
      const result = await connector.pullRecordFiles(buildIncrementalTableSpec(), callback, {}, options);
      const after = Date.now();

      const [schema, tableName, , , , , filter, modifiedSinceColumn, modifiedSinceDatetime] = selectAllCall();
      expect(schema).toBe('public');
      expect(tableName).toBe('records');
      expect(filter).toBeUndefined();
      expect(modifiedSinceColumn).toBe('updated_at');
      expect((modifiedSinceDatetime as Date).getTime()).toBe(since.getTime() - PG_INCREMENTAL_CLOCK_SKEW_MS);

      expect(result.newWatermark).toBeInstanceOf(Date);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    });

    it('throws before querying when modifiedAtField is not a column on the table', async () => {
      const since = new Date('2026-05-01T12:00:00.000Z');
      const options: PullRecordFilesOptions = { pullMode: 'incremental', since, modifiedAtField: 'does_not_exist' };

      await expect(connector.pullRecordFiles(buildIncrementalTableSpec(), callback, {}, options)).rejects.toThrow(
        /does not exist/,
      );
      expect(mockSelectAll).not.toHaveBeenCalled();
    });
  });
});
