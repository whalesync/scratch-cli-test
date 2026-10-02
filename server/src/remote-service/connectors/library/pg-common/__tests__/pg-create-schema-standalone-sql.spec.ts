import { type CreateFieldSpec, type CreateFieldType } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import { applyVerbatimIdentifierQuoting } from '../knex-column-identifier-dot-encoding';
import { buildCreateTableQuery, type ForeignKeyResolutions } from '../pg-create-schema';
import {
  renderAddColumnsAsStandaloneSqlStatements,
  renderCompiledDdlStatementsAsStandaloneSql,
  renderCreateSchemaIfNotExistsAsStandaloneSqlStatements,
  renderCreateTableAsStandaloneSqlStatements,
  renderGrantDefaultTableDataManipulationPrivilegesInSchemaToRoleAsStandaloneSql,
  renderGrantSchemaUsageToRoleAsStandaloneSql,
  renderGrantTableDataManipulationPrivilegesToRoleAsStandaloneSql,
} from '../pg-create-schema-standalone-sql';

/** The same hooked, connection-less knex `KnexPGClient` builds — the reference the renderer must match. */
const liveClientEquivalentKnex: Knex = knex({ client: 'pg' });
applyVerbatimIdentifierQuoting(liveClientEquivalentKnex);

afterAll(async () => {
  await liveClientEquivalentKnex.destroy();
});

function field(name: string, fieldType: CreateFieldType, extra: Partial<CreateFieldSpec> = {}): CreateFieldSpec {
  return { name, fieldType, ...extra };
}

const AUTHOR_FOREIGN_KEY_RESOLUTIONS: ForeignKeyResolutions = new Map([
  ['author_id', { kind: 'resolved', targetTableQualified: 'public.users', targetPkColumn: 'id', targetPkType: 'uuid' }],
]);

const AUTHOR_FOREIGN_KEY_FIELD = field('author_id', {
  kind: 'foreignKey',
  target: { existingRemoteTableId: ['public', 'users'] },
});

describe('renderCreateTableAsStandaloneSqlStatements', () => {
  it('renders exactly the DDL the live client would run, one string per statement', () => {
    const fields = [
      field('title', { kind: 'text' }, { required: true }),
      field('price', { kind: 'number', format: 'decimal', precision: 2 }),
      field('tags', { kind: 'text', isArray: true }),
      AUTHOR_FOREIGN_KEY_FIELD,
    ];

    const { statements } = renderCreateTableAsStandaloneSqlStatements(
      'public',
      'posts',
      fields,
      AUTHOR_FOREIGN_KEY_RESOLUTIONS,
    );

    expect(statements.join(';\n')).toBe(
      buildCreateTableQuery(
        liveClientEquivalentKnex,
        'public',
        'posts',
        fields,
        AUTHOR_FOREIGN_KEY_RESOLUTIONS,
      ).toString(),
    );
  });

  it('emits each foreign-key constraint as its own statement after the CREATE TABLE', () => {
    const { statements } = renderCreateTableAsStandaloneSqlStatements(
      'public',
      'posts',
      [field('title', { kind: 'text' }), AUTHOR_FOREIGN_KEY_FIELD],
      AUTHOR_FOREIGN_KEY_RESOLUTIONS,
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^create table "public"\."posts" \(/);
    expect(statements[1]).toBe(
      'alter table "public"."posts" add constraint "posts_author_id_foreign" foreign key ("author_id") references "public"."users" ("id") on delete SET NULL',
    );
  });

  it('turns knex\'s "\\?" escape back into a literal "?" in a column name (no "\\?", no "$n" binding)', () => {
    const { statements } = renderCreateTableAsStandaloneSqlStatements(
      'public',
      'posts',
      [field('Featured?', { kind: 'boolean' })],
      new Map(),
    );

    expect(statements[0]).toContain('"Featured?" boolean');
    expect(statements[0]).not.toContain('\\');
    expect(statements[0]).not.toContain('$');
  });

  it('keeps a "?" in a table name verbatim', () => {
    // The live driver numbers this as a "$1" placeholder (a pre-existing quirk of the data-role
    // path); the standalone rendering has no placeholders to number.
    const { statements } = renderCreateTableAsStandaloneSqlStatements(
      'public',
      'Lead?',
      [field('name', { kind: 'text' })],
      new Map(),
    );

    expect(statements[0]).toMatch(/^create table "public"\."Lead\?" \(/);
  });

  it('keeps dotted and " AS " column names as single identifiers, with no sentinel characters left behind', () => {
    const { statements } = renderCreateTableAsStandaloneSqlStatements(
      'public',
      'organizations',
      [field('Dealroom.co URL', { kind: 'url' }), field('Certified AS Organic', { kind: 'text' })],
      new Map(),
    );

    expect(statements[0]).toContain('"Dealroom.co URL" text');
    expect(statements[0]).toContain('"Certified AS Organic" text');
    expect(statements[0]).not.toContain('\u0000');
    expect(statements[0]).not.toContain('\u0001');
  });

  it('reports a field that could not become a column instead of emitting it', () => {
    const { statements, skippedFields } = renderCreateTableAsStandaloneSqlStatements(
      'public',
      'posts',
      [
        field('title', { kind: 'text' }),
        field('tags', {
          kind: 'foreignKey',
          target: { existingRemoteTableId: ['public', 'tags'] },
          allowMultiple: true,
        }),
      ],
      new Map(),
    );

    expect(skippedFields.get('tags')).toMatch(/allowMultiple/);
    expect(statements.join('\n')).not.toContain('"tags"');
    expect(statements[0]).toContain('"title" text');
  });
});

describe('renderAddColumnsAsStandaloneSqlStatements', () => {
  it('renders ALTER TABLE … ADD COLUMN, with a foreign key constraint as a second statement', () => {
    const { statements } = renderAddColumnsAsStandaloneSqlStatements(
      'public',
      'posts',
      [AUTHOR_FOREIGN_KEY_FIELD],
      AUTHOR_FOREIGN_KEY_RESOLUTIONS,
    );

    expect(statements).toEqual([
      'alter table "public"."posts" add column "author_id" uuid null',
      'alter table "public"."posts" add constraint "posts_author_id_foreign" foreign key ("author_id") references "public"."users" ("id") on delete SET NULL',
    ]);
  });

  it('un-escapes a "?" in an added column name', () => {
    const { statements } = renderAddColumnsAsStandaloneSqlStatements(
      'public',
      'posts',
      [field('Sold out?', { kind: 'boolean' })],
      new Map(),
    );

    expect(statements).toEqual(['alter table "public"."posts" add column "Sold out?" boolean']);
  });

  it('returns no statements at all when every field is skipped', () => {
    const { statements, skippedFields } = renderAddColumnsAsStandaloneSqlStatements(
      'public',
      'posts',
      [field('orphan_id', { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'orphans'] } })],
      new Map([['orphan_id', { kind: 'unresolvable', reason: 'no primary key to reference' }]]),
    );

    expect(statements).toEqual([]);
    expect(skippedFields.get('orphan_id')).toBe('no primary key to reference');
  });
});

describe('renderCompiledDdlStatementsAsStandaloneSql', () => {
  it('refuses a statement that carries bindings rather than send an unfilled placeholder', () => {
    expect(() =>
      renderCompiledDdlStatementsAsStandaloneSql([{ sql: 'comment on table "t" is ?', bindings: ['x'] }]),
    ).toThrow(/binding/);
  });
});

describe('schema and grant statements', () => {
  const DATA_ROLE = 'whalesync_svc_abc123';

  it('renders CREATE SCHEMA IF NOT EXISTS', () => {
    expect(renderCreateSchemaIfNotExistsAsStandaloneSqlStatements('airtable_export')).toEqual([
      'create schema if not exists "airtable_export"',
    ]);
  });

  it('grants a table only the four data-manipulation privileges', () => {
    expect(renderGrantTableDataManipulationPrivilegesToRoleAsStandaloneSql('public', 'users', DATA_ROLE)).toBe(
      'grant select, insert, update, delete on table "public"."users" to "whalesync_svc_abc123"',
    );
  });

  it('grants USAGE on a schema', () => {
    expect(renderGrantSchemaUsageToRoleAsStandaloneSql('airtable_export', DATA_ROLE)).toBe(
      'grant usage on schema "airtable_export" to "whalesync_svc_abc123"',
    );
  });

  it('grants the same four privileges by default on tables created in a schema from now on', () => {
    expect(
      renderGrantDefaultTableDataManipulationPrivilegesInSchemaToRoleAsStandaloneSql('airtable_export', DATA_ROLE),
    ).toBe(
      'alter default privileges in schema "airtable_export" grant select, insert, update, delete on tables to "whalesync_svc_abc123"',
    );
  });

  it.each(['we"ird', 'Lead?', 'semi;colon'])(
    'names the same table in the grant as in the CREATE TABLE (%s)',
    (tableName) => {
      const [createTableStatement] = renderCreateTableAsStandaloneSqlStatements(
        'public',
        tableName,
        [field('name', { kind: 'text' })],
        new Map(),
      ).statements;
      const grantStatement = renderGrantTableDataManipulationPrivilegesToRoleAsStandaloneSql(
        'public',
        tableName,
        DATA_ROLE,
      );

      const createdTableReference = /^create table (.+) \("id" uuid/.exec(createTableStatement)?.[1];
      const grantedTableReference =
        /^grant select, insert, update, delete on table (.+) to "whalesync_svc_abc123"$/.exec(grantStatement)?.[1];
      expect(createdTableReference).toBeDefined();
      expect(grantedTableReference).toBe(createdTableReference);
    },
  );
});
