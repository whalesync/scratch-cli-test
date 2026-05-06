import { CONNECTOR_DATA_TYPE, FOREIGN_KEY_OPTIONS, MAX_LENGTH, READONLY_FLAG } from '../../../json-schema';
import { EntityId } from '../../../types';
import { type InformationSchemaColumn, type PostgresForeignKey } from '../../pg-common';
import { SupabaseConnector } from '../supabase-connector';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Supabase'),
}));

const mockFindAllColumnsInTable = jest.fn();
const mockFindPrimaryColumnCandidates = jest.fn();
const mockFindAllForeignKeysInTable = jest.fn();
const mockDispose = jest.fn();

jest.mock('../../pg-common/knex-pg-client', () => {
  return {
    KnexPGClient: jest.fn().mockImplementation(() => ({
      findAllColumnsInTable: mockFindAllColumnsInTable,
      findPrimaryColumnCandidates: mockFindPrimaryColumnCandidates,
      findAllForeignKeysInTable: mockFindAllForeignKeysInTable,
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
    expect(properties.short_code[MAX_LENGTH]).toBe(11);
    expect(properties.fixed_code[MAX_LENGTH]).toBe(5);
    expect(properties.id[MAX_LENGTH]).toBeUndefined();
  });

  it('omits x-scratch-max-length for unbounded text columns', async () => {
    const spec = await fetchSchema([
      buildColumn({ column_name: 'id', data_type: 'integer', udt_name: 'int4' }),
      buildColumn({ column_name: 'body', data_type: 'text', udt_name: 'text' }),
    ]);

    const properties = spec.schema.properties as Record<string, Record<string | symbol, unknown>>;
    expect(properties.body[MAX_LENGTH]).toBeUndefined();
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
    expect(properties.nickname[MAX_LENGTH]).toBe(30);
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
    expect(properties.id[CONNECTOR_DATA_TYPE]).toBe('numeric');
    expect(properties.title[CONNECTOR_DATA_TYPE]).toBe('text');
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
    expect(properties.id[READONLY_FLAG]).toBe(true);
    expect(properties.computed[READONLY_FLAG]).toBe(true);
    expect(properties.name[READONLY_FLAG]).toBeUndefined();
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
    expect(properties.author_id[FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'authors' });
    expect(properties.category_id[FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'taxonomy.categories' });
    expect(properties.id[FOREIGN_KEY_OPTIONS]).toBeUndefined();
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
    expect(tag[MAX_LENGTH]).toBe(8);
    expect(tag[READONLY_FLAG]).toBe(true);
    expect(spec.schema.required).not.toContain('tag');
  });
});
