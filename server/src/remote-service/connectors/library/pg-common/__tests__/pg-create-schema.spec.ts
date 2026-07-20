import { type CreateFieldSpec, type CreateFieldType } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import {
  buildAddColumnsQuery,
  buildCreateTableQuery,
  POSTGRES_SCHEMA_CREATION_CAPABILITIES,
  type ForeignKeyResolutions,
} from '../pg-create-schema';

// Connection-less Knex: builds SQL strings without touching a database.
const queryBuilder: Knex = knex({ client: 'pg' });

afterAll(async () => {
  await queryBuilder.destroy();
});

function field(name: string, fieldType: CreateFieldType, extra: Partial<CreateFieldSpec> = {}): CreateFieldSpec {
  return { name, fieldType, ...extra };
}

function createTableSql(
  fields: CreateFieldSpec[],
  fkResolutions: ForeignKeyResolutions = new Map(),
  skipped?: Map<string, string>,
): string {
  return buildCreateTableQuery(queryBuilder, 'public', 'widgets', fields, fkResolutions, skipped)
    .toString()
    .toLowerCase();
}

describe('buildCreateTableQuery', () => {
  it('injects an auto-generated uuid primary key named "id"', () => {
    const sql = createTableSql([field('name', { kind: 'text' })]);
    expect(sql).toContain('create table "public"."widgets"');
    expect(sql).toContain('"id" uuid');
    expect(sql).toContain('gen_random_uuid()');
    expect(sql).toContain('primary key');
  });

  describe('logical field type → PG column', () => {
    it.each<[string, CreateFieldType, string]>([
      ['text', { kind: 'text' }, '"value" text'],
      ['longText', { kind: 'longText' }, '"value" text'],
      ['url', { kind: 'url' }, '"value" text'],
      ['email', { kind: 'email' }, '"value" text'],
      ['phone', { kind: 'phone' }, '"value" text'],
      ['select', { kind: 'select', options: [{ name: 'a' }] }, '"value" text'],
      ['multiSelect', { kind: 'multiSelect', options: [{ name: 'a' }] }, '"value" text[]'],
      ['boolean', { kind: 'boolean' }, '"value" boolean'],
      ['number integer', { kind: 'number', format: 'integer' }, '"value" integer'],
      ['number plain', { kind: 'number', format: 'plain' }, '"value" double precision'],
      ['number unset', { kind: 'number' }, '"value" double precision'],
      ['number decimal w/ precision', { kind: 'number', format: 'decimal', precision: 2 }, '"value" decimal(10, 2)'],
      ['number decimal no precision', { kind: 'number', format: 'decimal' }, '"value" numeric'],
      ['number percent', { kind: 'number', format: 'percent' }, '"value" numeric'],
      ['date', { kind: 'date' }, '"value" date'],
      ['date w/ time', { kind: 'date', includesTime: true }, '"value" timestamptz'],
      ['currency default scale', { kind: 'currency', currencyCode: 'USD' }, '"value" decimal(12, 4)'],
      ['currency precision 2', { kind: 'currency', currencyCode: 'USD', precision: 2 }, '"value" decimal(10, 2)'],
    ])('maps %s', (_label, fieldType, expectedColumn) => {
      expect(createTableSql([field('value', fieldType)])).toContain(expectedColumn);
    });
  });

  it('applies NOT NULL only when the field is required', () => {
    const sql = createTableSql([
      field('required_col', { kind: 'text' }, { required: true }),
      field('optional_col', { kind: 'text' }),
    ]);
    expect(sql).toContain('"required_col" text not null');
    expect(sql).toMatch(/"optional_col" text(?! not null)/);
  });

  describe('foreign keys', () => {
    const resolvedFk: ForeignKeyResolutions = new Map([
      [
        'author_id',
        { kind: 'resolved', targetTableQualified: 'scratch_e2e.users', targetPkColumn: 'id', targetPkType: 'uuid' },
      ],
    ]);

    it('creates a nullable FK column referencing the target PK with ON DELETE SET NULL', () => {
      const sql = createTableSql(
        [field('author_id', { kind: 'foreignKey', target: { existingRemoteTableId: ['scratch_e2e', 'users'] } })],
        resolvedFk,
      );
      expect(sql).toContain('"author_id" uuid');
      expect(sql).toContain('references "scratch_e2e"."users"');
      expect(sql).toContain('on delete set null');
      // FK columns stay nullable so SET NULL is valid.
      expect(sql).not.toContain('"author_id" uuid not null');
    });

    it('emits the exact native type for exotic target PKs (enum / citext / array — DEV-10821)', () => {
      // The resolutions carry `format_type` output, never information_schema's
      // USER-DEFINED/ARRAY placeholders — the column type must land verbatim.
      const exoticFks: ForeignKeyResolutions = new Map([
        [
          'status_ref',
          {
            kind: 'resolved',
            targetTableQualified: 'app.orders',
            targetPkColumn: 'status',
            targetPkType: 'app.order_status',
          },
        ],
        [
          'email_ref',
          { kind: 'resolved', targetTableQualified: 'public.users', targetPkColumn: 'email', targetPkType: 'citext' },
        ],
        [
          'path_ref',
          { kind: 'resolved', targetTableQualified: 'public.nodes', targetPkColumn: 'path', targetPkType: 'integer[]' },
        ],
      ]);
      const sql = createTableSql(
        [
          field('status_ref', { kind: 'foreignKey', target: { existingRemoteTableId: ['app', 'orders'] } }),
          field('email_ref', { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'users'] } }),
          field('path_ref', { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'nodes'] } }),
        ],
        exoticFks,
      );
      expect(sql).toContain('"status_ref" app.order_status');
      expect(sql).toContain('"email_ref" citext');
      expect(sql).toContain('"path_ref" integer[]');
      expect(sql).not.toContain('user-defined');
    });

    it('skips an allowMultiple FK with a reason and emits no column', () => {
      const skipped = new Map<string, string>();
      const sql = createTableSql(
        [
          field('tags', {
            kind: 'foreignKey',
            target: { existingRemoteTableId: ['public', 'tags'] },
            allowMultiple: true,
          }),
        ],
        new Map(),
        skipped,
      );
      expect(sql).not.toContain('"tags"');
      expect(skipped.get('tags')).toMatch(/allowmultiple/i);
    });

    it('skips a FK whose target is unresolvable', () => {
      const skipped = new Map<string, string>();
      const unresolvable: ForeignKeyResolutions = new Map([
        ['orphan_id', { kind: 'unresolvable', reason: 'no primary key to reference' }],
      ]);
      const sql = createTableSql(
        [field('orphan_id', { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'orphans'] } })],
        unresolvable,
        skipped,
      );
      expect(sql).not.toContain('"orphan_id"');
      expect(skipped.get('orphan_id')).toBe('no primary key to reference');
    });
  });

  it('skips a field that collides with the reserved "id" primary key', () => {
    const skipped = new Map<string, string>();
    const sql = createTableSql([field('ID', { kind: 'text' })], new Map(), skipped);
    // Only the injected PK "id" exists; the user's "ID" column was skipped.
    expect(sql).toContain('"id" uuid');
    expect(skipped.get('ID')).toMatch(/reserved/i);
  });
});

describe('buildAddColumnsQuery', () => {
  it('builds ALTER TABLE ADD COLUMN statements', () => {
    const sql = buildAddColumnsQuery(
      queryBuilder,
      'public',
      'widgets',
      [field('note', { kind: 'longText' })],
      new Map(),
    )
      .toString()
      .toLowerCase();
    expect(sql).toContain('alter table "public"."widgets"');
    expect(sql).toContain('add column "note" text');
  });

  it('adds a resolved FK column with ON DELETE SET NULL', () => {
    const fk: ForeignKeyResolutions = new Map([
      [
        'owner_id',
        { kind: 'resolved', targetTableQualified: 'public.users', targetPkColumn: 'id', targetPkType: 'uuid' },
      ],
    ]);
    const sql = buildAddColumnsQuery(
      queryBuilder,
      'public',
      'widgets',
      [field('owner_id', { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'users'] } })],
      fk,
    )
      .toString()
      .toLowerCase();
    expect(sql).toContain('"owner_id" uuid');
    expect(sql).toContain('references "public"."users"');
    expect(sql).toContain('on delete set null');
  });
});

describe('POSTGRES_SCHEMA_CREATION_CAPABILITIES', () => {
  it('supports all 12 logical field kinds, with no mandatory primary field and 63-char name limits', () => {
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).toEqual(
      expect.arrayContaining([
        'text',
        'longText',
        'number',
        'boolean',
        'date',
        'select',
        'multiSelect',
        'url',
        'email',
        'phone',
        'currency',
        'foreignKey',
      ]),
    );
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).toHaveLength(12);
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.primaryField).toBeNull();
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.maxTableNameLength).toBe(63);
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.maxFieldNameLength).toBe(63);
  });
});
