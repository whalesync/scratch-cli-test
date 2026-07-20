import { Type } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_READONLY,
  type CreateFieldSpec,
} from '@spinner/shared-types';
import { type NormalizedCreateFieldsPlan, type NormalizedCreateTablePlan } from '../../../schema-creation.types';
import { BaseJsonTableSpec, EntityId, PullRecordFilesOptions, dotPath } from '../../../types';
import { PG_INCREMENTAL_CLOCK_SKEW_MS, type InformationSchemaColumn, type PostgresForeignKey } from '../../pg-common';
import { SupabaseConnector } from '../supabase-connector';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Supabase'),
}));

const mockFindAllColumnsInTable = jest.fn();
const mockFindPrimaryColumnCandidates = jest.fn();
const mockFindAllForeignKeysInTable = jest.fn();
const mockFindSingleColumnUniqueIndexColumns = jest.fn();
const mockSelectAll = jest.fn();
const mockFindAllSchemas = jest.fn();
const mockCreateTable = jest.fn();
const mockAddColumns = jest.fn();
const mockFindTableUniquelyAddressableColumn = jest.fn();
const mockDispose = jest.fn();

jest.mock('../../pg-common/knex-pg-client', () => {
  return {
    KnexPGClient: jest.fn().mockImplementation(() => ({
      findAllColumnsInTable: mockFindAllColumnsInTable,
      findPrimaryColumnCandidates: mockFindPrimaryColumnCandidates,
      findAllForeignKeysInTable: mockFindAllForeignKeysInTable,
      findSingleColumnUniqueIndexColumns: mockFindSingleColumnUniqueIndexColumns,
      selectAll: mockSelectAll,
      findAllSchemas: mockFindAllSchemas,
      createTable: mockCreateTable,
      addColumns: mockAddColumns,
      findTableUniquelyAddressableColumn: mockFindTableUniquelyAddressableColumn,
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
    // Default: no single-column unique index reported, exercising the legacy
    // PK-candidate fallback most tests were written against.
    mockFindSingleColumnUniqueIndexColumns.mockResolvedValue([]);
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
    expect(spec.idPath).toBe('id');
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

  it('sets titlePath to the first text-typed candidate column', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({ column_name: 'name', data_type: 'character varying', udt_name: 'varchar' }),
    ]);

    expect(spec.titlePath).toEqual('name');
  });

  it('leaves titlePath undefined when no candidate title column exists', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({ column_name: 'body', data_type: 'text', udt_name: 'text' }),
    ]);

    expect(spec.titlePath).toBeUndefined();
  });

  it('falls back to "id" when no primary key candidates are returned', async () => {
    mockFindPrimaryColumnCandidates.mockResolvedValue([]);
    const spec = await fetchSchema([buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' })]);
    expect(spec.idPath).toBe('id');
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
    expect(spec.idPath).toBe('id');
  });

  it('uses the single-column primary key reported by the unique-index introspection as idPath', async () => {
    mockFindPrimaryColumnCandidates.mockResolvedValue(['id']);
    mockFindSingleColumnUniqueIndexColumns.mockResolvedValue([
      { column_name: 'id', native_type: 'uuid', is_primary_key: true },
      { column_name: 'email', native_type: 'citext', is_primary_key: false },
    ]);
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', udt_name: 'uuid', data_type: 'uuid' }),
      buildColumn({ column_name: 'email' }),
    ]);
    expect(spec.idPath).toBe('id');
  });

  it('does NOT collapse a composite PK — idPath falls to a genuinely unique single column instead (DEV-10802)', async () => {
    // Junction-style table: PK (order_id, product_id), plus a unique line_number.
    mockFindPrimaryColumnCandidates.mockResolvedValue(['order_id', 'product_id']);
    mockFindSingleColumnUniqueIndexColumns.mockResolvedValue([
      { column_name: 'line_number', native_type: 'integer', is_primary_key: false },
    ]);
    const spec = await fetchSchema([
      buildColumn({ column_name: 'order_id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({ column_name: 'product_id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({ column_name: 'line_number', data_type: 'integer', udt_name: 'int4' }),
    ]);
    expect(spec.idPath).toBe('line_number');
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
    idPath: dotPath('id'),
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

const OTHER_PROJECT_REF = 'zyxwvutsrqponmlkjihg';
const OTHER_CONNECTION_STRING = `postgresql://postgres:pw@db.${OTHER_PROJECT_REF}.supabase.co:5432/postgres`;

function textField(name: string, extra: Partial<CreateFieldSpec> = {}): CreateFieldSpec {
  return { name, fieldType: { kind: 'text' }, ...extra };
}

type DdlCallArgs = [schema: string, tableName: string, fields: unknown[], fkResolutions: Map<string, unknown>];

function createTableCall(index = 0): DdlCallArgs {
  return mockCreateTable.mock.calls[index] as DdlCallArgs;
}

function addColumnsCall(index = 0): DdlCallArgs {
  return mockAddColumns.mock.calls[index] as DdlCallArgs;
}

describe('SupabaseConnector.listCreateDestinations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDispose.mockResolvedValue(undefined);
  });

  it('returns "<projectRef>/<schema>" destinations for a connection-string project', async () => {
    mockFindAllSchemas.mockResolvedValue([
      { catalog_name: 'postgres', schema_name: 'public' },
      { catalog_name: 'postgres', schema_name: 'analytics' },
      { catalog_name: 'postgres', schema_name: 'auth' },
      { catalog_name: 'postgres', schema_name: 'storage' },
      { catalog_name: 'postgres', schema_name: 'pg_catalog' },
      { catalog_name: 'postgres', schema_name: 'pg_temp_1' },
      { catalog_name: 'postgres', schema_name: 'supabase_migrations' },
    ]);
    const connector = new SupabaseConnector({ connectionString: CONNECTION_STRING });

    const destinations = await connector.listCreateDestinations();

    expect(destinations).toEqual([
      { id: `${PROJECT_REF}/public`, name: 'public' },
      { id: `${PROJECT_REF}/analytics`, name: 'analytics' },
    ]);
  });

  it('lists (project, schema) destinations across every OAuth project with human labels', async () => {
    mockFindAllSchemas
      .mockResolvedValueOnce([
        { catalog_name: 'postgres', schema_name: 'public' },
        { catalog_name: 'postgres', schema_name: 'auth' },
      ])
      .mockResolvedValueOnce([{ catalog_name: 'postgres', schema_name: 'public' }]);
    const connector = new SupabaseConnector({
      projects: [
        { projectRef: PROJECT_REF, projectName: 'Prod', connectionString: CONNECTION_STRING },
        { projectRef: OTHER_PROJECT_REF, projectName: 'Staging', connectionString: OTHER_CONNECTION_STRING },
      ],
    });

    const destinations = await connector.listCreateDestinations();

    expect(destinations).toEqual([
      { id: `${PROJECT_REF}/public`, name: 'Prod / public' },
      { id: `${OTHER_PROJECT_REF}/public`, name: 'Staging / public' },
    ]);
  });
});

describe('SupabaseConnector schema creation', () => {
  let connector: SupabaseConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDispose.mockResolvedValue(undefined);
    connector = new SupabaseConnector({ connectionString: CONNECTION_STRING });
  });

  it('declares schema-creation support and reuses the shared pg capabilities', () => {
    expect(connector.supportsSchemaCreation()).toBe(true);

    const capabilities = connector.getSchemaCreationCapabilities();
    expect(capabilities.supportedFieldKinds).toHaveLength(12);
    expect(capabilities.primaryField).toBeNull();
    expect(capabilities.maxTableNameLength).toBe(63);
    expect(capabilities.maxFieldNameLength).toBe(63);
  });

  describe('createTable', () => {
    it('creates a table in [projectRef, schema] and returns a 3-part remoteTableId', async () => {
      mockCreateTable.mockResolvedValue({ skippedFields: new Map() });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [PROJECT_REF, 'public'],
        ref: 't1',
        name: 'users',
        fields: [textField('name'), textField('email')],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(mockCreateTable).toHaveBeenCalledTimes(1);
      const [schema, tableName, fields] = createTableCall();
      expect(schema).toBe('public');
      expect(tableName).toBe('users');
      expect(fields).toHaveLength(2);
      expect(result).toMatchObject({
        ref: 't1',
        name: 'users',
        status: 'created',
        remoteTableId: [PROJECT_REF, 'public', 'users'],
      });
      expect(result.fields).toEqual([
        { name: 'name', status: 'created', remoteFieldId: 'name' },
        { name: 'email', status: 'created', remoteFieldId: 'email' },
      ]);
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });

    it('defaults the schema to public when the parent names only a project', async () => {
      mockCreateTable.mockResolvedValue({ skippedFields: new Map() });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [PROJECT_REF],
        ref: 't1',
        name: 'users',
        fields: [textField('name')],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(createTableCall()[0]).toBe('public');
      expect(result.remoteTableId).toEqual([PROJECT_REF, 'public', 'users']);
    });

    it('accepts the unsplit "<projectRef>/<schema>" destination id in a single remoteParentId segment (Live Export)', async () => {
      mockCreateTable.mockResolvedValue({ skippedFields: new Map() });
      // The Live Export flow forwards the CreateDestination id whole, so the whole
      // "ref/schema" string lands in remoteParentId[0] instead of being split.
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [`${PROJECT_REF}/analytics`],
        ref: 't1',
        name: 'users',
        fields: [textField('name')],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(createTableCall()[0]).toBe('analytics');
      expect(result.status).toBe('created');
      expect(result.remoteTableId).toEqual([PROJECT_REF, 'analytics', 'users']);
    });

    it('resolves an OAuth project from an unsplit destination id (regression: "Unknown Supabase project: <ref>/<schema>")', async () => {
      mockCreateTable.mockResolvedValue({ skippedFields: new Map() });
      const oauthConnector = new SupabaseConnector({
        projects: [{ projectRef: PROJECT_REF, projectName: 'Prod', connectionString: CONNECTION_STRING }],
      });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [`${PROJECT_REF}/public`],
        ref: 't1',
        name: 'users',
        fields: [textField('name')],
        deferredFkFields: [],
      };

      const result = await oauthConnector.createTable(plan);

      expect(result.status).toBe('created');
      expect(result.remoteTableId).toEqual([PROJECT_REF, 'public', 'users']);
    });

    it('fails (no throw) when no project is given in the parent', async () => {
      const plan: NormalizedCreateTablePlan = {
        ref: 't1',
        name: 'users',
        fields: [textField('name')],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(mockCreateTable).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/project/i);
      expect(result.fields).toEqual([{ name: 'name', status: 'failed' }]);
    });

    it('introspects a same-project foreign-key target primary key', async () => {
      mockFindTableUniquelyAddressableColumn.mockResolvedValue({ column: 'id', nativeType: 'uuid' });
      mockCreateTable.mockResolvedValue({ skippedFields: new Map() });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [PROJECT_REF, 'public'],
        ref: 'posts',
        name: 'posts',
        fields: [
          textField('title'),
          {
            name: 'author_id',
            fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: [PROJECT_REF, 'public', 'users'] } },
          },
        ],
        deferredFkFields: [],
      };

      await connector.createTable(plan);

      expect(mockFindTableUniquelyAddressableColumn).toHaveBeenCalledWith('public', 'users');
      const foreignKeyResolutions = createTableCall()[3];
      expect(foreignKeyResolutions.get('author_id')).toEqual({
        kind: 'resolved',
        targetTableQualified: 'public.users',
        targetPkColumn: 'id',
        targetPkType: 'uuid',
      });
    });

    it('flags a cross-project foreign-key target as unresolvable', async () => {
      mockCreateTable.mockResolvedValue({ skippedFields: new Map() });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [PROJECT_REF, 'public'],
        ref: 'posts',
        name: 'posts',
        fields: [
          {
            name: 'author_id',
            fieldType: {
              kind: 'foreignKey',
              target: { existingRemoteTableId: [OTHER_PROJECT_REF, 'public', 'users'] },
            },
          },
        ],
        deferredFkFields: [],
      };

      await connector.createTable(plan);

      expect(mockFindTableUniquelyAddressableColumn).not.toHaveBeenCalled();
      const foreignKeyResolutions = createTableCall()[3] as Map<string, { kind: string; reason: string }>;
      expect(foreignKeyResolutions.get('author_id')?.kind).toBe('unresolvable');
      expect(foreignKeyResolutions.get('author_id')?.reason).toMatch(/different Supabase project/i);
    });

    it('marks the table partial and surfaces skipped field reasons', async () => {
      mockCreateTable.mockResolvedValue({ skippedFields: new Map([['tags', 'allowMultiple not supported']]) });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [PROJECT_REF, 'public'],
        ref: 't1',
        name: 'users',
        fields: [textField('name'), textField('tags')],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(result.status).toBe('partial');
      expect(result.fields).toContainEqual({ name: 'name', status: 'created', remoteFieldId: 'name' });
      expect(result.fields).toContainEqual({ name: 'tags', status: 'skipped', error: 'allowMultiple not supported' });
    });

    it('returns a failed result (no throw) when the DDL errors', async () => {
      mockCreateTable.mockRejectedValue(Object.assign(new Error('relation already exists'), { code: '42P07' }));
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: [PROJECT_REF, 'public'],
        ref: 't1',
        name: 'users',
        fields: [textField('name')],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect(result.fields).toEqual([{ name: 'name', status: 'failed' }]);
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('createFields', () => {
    it('adds each field with a separate client call against [schema, table] from the 3-part id', async () => {
      mockAddColumns.mockResolvedValue({ skippedFields: new Map() });
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: [PROJECT_REF, 'public', 'users'],
        fields: [textField('bio'), textField('nickname')],
      };

      const results = await connector.createFields(plan);

      expect(mockAddColumns).toHaveBeenCalledTimes(2);
      expect(addColumnsCall()[0]).toBe('public');
      expect(addColumnsCall()[1]).toBe('users');
      expect(results).toEqual([
        { name: 'bio', status: 'created', remoteFieldId: 'bio' },
        { name: 'nickname', status: 'created', remoteFieldId: 'nickname' },
      ]);
    });

    it('isolates a per-field failure from the rest', async () => {
      mockAddColumns
        .mockResolvedValueOnce({ skippedFields: new Map() })
        .mockRejectedValueOnce(Object.assign(new Error('duplicate column'), { code: '42701' }));
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: [PROJECT_REF, 'public', 'users'],
        fields: [textField('ok'), textField('dupe')],
      };

      const results = await connector.createFields(plan);

      expect(results[0]).toEqual({ name: 'ok', status: 'created', remoteFieldId: 'ok' });
      expect(results[1].status).toBe('failed');
      expect(results[1].error).toBeDefined();
    });
  });
});
