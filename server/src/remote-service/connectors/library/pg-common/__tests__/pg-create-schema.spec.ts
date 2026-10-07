import { type CreateFieldSpec, type CreateFieldType } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import {
  applyVerbatimIdentifierQuoting,
  encodeColumnIdentifierDotsForKnex,
  escapeKnexColumnIdentifierSpecialCharacters,
} from '../knex-column-identifier-dot-encoding';
import {
  buildAddColumnsQuery,
  buildCreateTableQuery,
  foldNameToPostgresSchemaIdentifier,
  foreignKeyConstraintNameWithinPostgresIdentifierLimit,
  isInsufficientPrivilegeError,
  pickUnusedPostgresSchemaName,
  POSTGRES_MAX_IDENTIFIER_LENGTH,
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

  // Knex's `.primary()` named the constraint "<table>_pkey"; for a table name at the 63-byte limit Postgres
  // truncated that to the table's own name, colliding with the table (42P07). Postgres now names it.
  it('declares the primary key on the id column, leaving its constraint name to Postgres', () => {
    const sql = createTableSql([field('name', { kind: 'text' })]);
    expect(sql).toContain('"id" uuid primary key not null default gen_random_uuid()');
    expect(sql).not.toContain('_pkey');
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
      ['number decimal w/ precision', { kind: 'number', format: 'decimal', precision: 2 }, '"value" numeric(10,2)'],
      ['number decimal no precision', { kind: 'number', format: 'decimal' }, '"value" numeric'],
      ['number percent', { kind: 'number', format: 'percent' }, '"value" numeric'],
      ['date', { kind: 'date' }, '"value" date'],
      ['date w/ time', { kind: 'date', includesTime: true }, '"value" timestamptz'],
      ['currency default scale', { kind: 'currency', currencyCode: 'USD' }, '"value" decimal(12, 4)'],
      ['currency precision 2', { kind: 'currency', currencyCode: 'USD', precision: 2 }, '"value" decimal(10, 2)'],
      // DEV-11903: structured values keep their shape.
      ['json', { kind: 'json' }, '"value" jsonb'],
      ['text list', { kind: 'text', isArray: true }, '"value" text[]'],
      ['boolean list', { kind: 'boolean', isArray: true }, '"value" boolean[]'],
      ['integer list', { kind: 'number', format: 'integer', isArray: true }, '"value" integer[]'],
      ['number list', { kind: 'number', isArray: true }, '"value" double precision[]'],
      ['decimal list', { kind: 'number', format: 'decimal', precision: 2, isArray: true }, '"value" numeric(10,2)[]'],
    ])('maps %s', (_label, fieldType, expectedColumn) => {
      expect(createTableSql([field('value', fieldType)])).toContain(expectedColumn);
    });
  });

  // DEV-11903: a same-type-system source column is recreated with its exact native type.
  describe('native Postgres column type', () => {
    it.each<[string, string]>([
      ['integer', '"value" integer'],
      ['bigint', '"value" bigint'],
      ['text[]', '"value" text[]'],
      ['numeric(10,2)', '"value" numeric(10,2)'],
      ['character varying(50)', '"value" character varying(50)'],
      ['timestamp(3) with time zone', '"value" timestamp(3) with time zone'],
      ['jsonb', '"value" jsonb'],
      ['uuid', '"value" uuid'],
    ])('creates %s verbatim instead of the logical type', (nativeType, expectedColumn) => {
      const sql = createTableSql([
        field('value', { kind: 'text' }, { nativeFieldType: { typeSystem: 'postgres', type: nativeType } }),
      ]);
      expect(sql).toContain(expectedColumn);
      expect(sql).not.toContain('"value" text,');
    });

    it('applies NOT NULL to a native-typed column only when required', () => {
      const sql = createTableSql([
        field(
          'value',
          { kind: 'number' },
          { nativeFieldType: { typeSystem: 'postgres', type: 'integer' }, required: true },
        ),
      ]);
      expect(sql).toContain('"value" integer not null');
    });

    it.each(['bytea', 'interval', 'public.mood', 'text); drop table users; --', 'jsonb[]', '"char"'])(
      'refuses to create non-recreatable / unsafe type %s, failing the field with a reason',
      (nativeType) => {
        const skipped = new Map<string, string>();
        const sql = createTableSql(
          [
            field('value', { kind: 'text' }, { nativeFieldType: { typeSystem: 'postgres', type: nativeType } }),
            field('other', { kind: 'text' }),
          ],
          new Map(),
          skipped,
        );
        expect(skipped.get('value')).toContain("can't create");
        expect(sql).not.toContain('"value"');
        expect(sql).not.toContain('drop table');
        expect(sql).toContain('"other" text');
      },
    );

    it('ignores a native type from another type system and creates the logical type', () => {
      const sql = createTableSql([
        field('value', { kind: 'text' }, { nativeFieldType: { typeSystem: 'mysql', type: 'mediumtext' } }),
      ]);
      expect(sql).toContain('"value" text');
      expect(sql).not.toContain('mediumtext');
    });

    it('never lets a native type override a foreign key (its type comes from the referenced primary key)', () => {
      const sql = createTableSql(
        [
          field(
            'owner_id',
            { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'users'] } },
            { nativeFieldType: { typeSystem: 'postgres', type: 'text' } },
          ),
        ],
        new Map([
          [
            'owner_id',
            { kind: 'resolved', targetTableQualified: 'public.users', targetPkColumn: 'id', targetPkType: 'uuid' },
          ],
        ]),
      );
      expect(sql).toContain('"owner_id" uuid');
      expect(sql).toContain('references "public"."users"');
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

    // Knex names each FK "<table>_<column>_foreign"; Postgres truncated those past 63 bytes, so two FKs on a
    // table named at the limit truncated to the same name and the second ADD CONSTRAINT failed (42710).
    it('gives each FK on a table named at the 63-byte limit a distinct constraint name that fits', () => {
      const tableNameAtIdentifierLimit = 'This is a long table name that…5 characters to break postgres';
      const ownerAndReviewerFks: ForeignKeyResolutions = new Map(
        ['Owner', 'Reviewer'].map((columnName) => [
          columnName,
          { kind: 'resolved', targetTableQualified: 'public.users', targetPkColumn: 'id', targetPkType: 'uuid' },
        ]),
      );
      const statements = buildCreateTableQuery(
        queryBuilder,
        'public',
        tableNameAtIdentifierLimit,
        ['Owner', 'Reviewer'].map((columnName) =>
          field(columnName, { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'users'] } }),
        ),
        ownerAndReviewerFks,
      )
        .toSQL()
        .map((statement) => statement.sql);

      const constraintNames = statements.flatMap((sql) =>
        [...sql.matchAll(/add constraint "([^"]+)"/g)].map((m) => m[1]),
      );
      expect(constraintNames).toHaveLength(2);
      expect(new Set(constraintNames).size).toBe(2);
      for (const constraintName of constraintNames) {
        expect(Buffer.byteLength(constraintName, 'utf8')).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_LENGTH);
      }
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
  it('supports all 13 logical field kinds, with no mandatory primary field and 63-char name limits', () => {
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
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).toHaveLength(13);
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.primaryField).toBeNull();
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.maxTableNameLength).toBe(63);
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.maxFieldNameLength).toBe(63);
    // Postgres's 63 is a byte limit: a character-counted elided name (its `…` is 3 bytes) would overflow it.
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.nameLengthUnit).toBe('utf8Bytes');
  });

  it('declares the postgres native type system and list columns of text/number/boolean (DEV-11903)', () => {
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).toContain('json');
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.nativeTypeSystem).toBe('postgres');
    expect(POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedArrayElementKinds).toEqual(['text', 'number', 'boolean']);
  });
});

/**
 * Regression tests for DEV-11051: a Postgres column whose real name contains " as " (e.g.
 * Pipedrive's "Marked as done time") must be quoted as ONE identifier, not split by knex's
 * identifier formatter into `"Marked" as "done time"` (which is a SQL syntax error on CREATE and
 * silently corrupts INSERT/SELECT/UPDATE). {@link applyVerbatimIdentifierQuoting} installs the fix
 * the KnexPGClient constructor applies; here we prove it on connection-less SQL strings.
 */
describe('applyVerbatimIdentifierQuoting — column names containing " as "', () => {
  const quotingKnex: Knex = knex({ client: 'pg' });
  applyVerbatimIdentifierQuoting(quotingKnex);

  afterAll(async () => {
    await quotingKnex.destroy();
  });

  it('quotes a CREATE TABLE column name containing " as " as a single identifier', () => {
    const sql = buildCreateTableQuery(
      quotingKnex,
      'pipedrive',
      'Activities',
      [field('Marked as done time', { kind: 'date', includesTime: true })],
      new Map(),
    ).toString();

    expect(sql).toContain('"Marked as done time" timestamptz');
    expect(sql).not.toContain('"Marked" as "done time"');
  });

  it('quotes INSERT / SELECT / UPDATE column names containing " as " verbatim', () => {
    expect(quotingKnex('pipedrive.Activities').insert({ 'Marked as done time': 'x' }).toQuery()).toContain(
      '("Marked as done time")',
    );
    expect(quotingKnex('pipedrive.Activities').select('Marked as done time').toQuery()).toContain(
      'select "Marked as done time"',
    );
    expect(quotingKnex('pipedrive.Activities').update({ 'Marked as done time': 'x' }).toQuery()).toContain(
      'set "Marked as done time" =',
    );
  });

  it('leaves ordinary identifiers (including schema-qualified names) unchanged', () => {
    expect(quotingKnex('pipedrive.Activities').select('Subject').toQuery()).toBe(
      'select "Subject" from "pipedrive"."Activities"',
    );
  });

  // DEV-11170: knex splits " as " case-insensitively but the alias rejoin hardcodes a lowercase
  // separator, so a mixed-case "Certified AS Organic" was emitted as "Certified as Organic" — the
  // destination column diverged from the source name. The sentinel encoding now neutralizes the
  // separator before knex sees it, preserving the exact casing across every path.
  it('preserves a mixed-case " AS " separator verbatim in CREATE TABLE (DEV-11170)', () => {
    const sql = buildCreateTableQuery(
      quotingKnex,
      'pipedrive',
      'Products',
      [field('Certified AS Organic', { kind: 'text' })],
      new Map(),
    ).toString();

    expect(sql).toContain('"Certified AS Organic" text');
    expect(sql).not.toContain('"Certified as Organic"');
  });

  it('preserves a mixed-case " AS " separator verbatim in ALTER TABLE ADD COLUMN (DEV-11170)', () => {
    const sql = buildAddColumnsQuery(
      quotingKnex,
      'pipedrive',
      'Products',
      [field('Certified AS Organic', { kind: 'text' })],
      new Map(),
    ).toString();

    expect(sql).toContain('"Certified AS Organic" text');
    expect(sql).not.toContain('"Certified as Organic"');
  });

  it('encodes a mixed-case " AS " column so INSERT / SELECT / UPDATE quote it verbatim (DEV-11170)', () => {
    // Mirrors the DML path: KnexPGClient escapes column identifiers via
    // escapeKnexColumnIdentifierSpecialCharacters before handing them to knex.
    const encoded = escapeKnexColumnIdentifierSpecialCharacters('Certified AS Organic');
    expect(
      quotingKnex('pipedrive.Products')
        .insert({ [encoded]: 'x' })
        .toQuery(),
    ).toContain('("Certified AS Organic")');
    expect(quotingKnex('pipedrive.Products').select(encoded).toQuery()).toContain('select "Certified AS Organic"');
    expect(
      quotingKnex('pipedrive.Products')
        .update({ [encoded]: 'x' })
        .toQuery(),
    ).toContain('set "Certified AS Organic" =');
  });

  it('keeps read-path WHERE / ORDER BY casing consistent with the created column (DEV-11170)', () => {
    // The primaryId / modifiedSinceColumn read paths escape via escapeKnexColumnIdentifierSpecialCharacters
    // (the same full escaper CREATE/DML use), so a mixed-case " AS " column is addressed with the SAME
    // casing CREATE TABLE used — no case-sensitive "column does not exist" mismatch on re-read.
    const encoded = escapeKnexColumnIdentifierSpecialCharacters('Certified AS Organic');
    expect(quotingKnex('pipedrive.Products').where(encoded, 'x').toQuery()).toContain('where "Certified AS Organic" =');
    expect(quotingKnex('pipedrive.Products').select('*').orderBy(encoded).toQuery()).toContain(
      'order by "Certified AS Organic"',
    );
  });

  it('escapes a "?" placeholder in a read-path column identifier, not as a $n binding (DEV-11170)', () => {
    // Read paths now use the same full escaper as CREATE/DML, so a "?" (knex's positional-binding
    // placeholder) in a primaryId / modifiedSinceColumn is quoted verbatim rather than rewritten to a
    // "$n" reference (which would corrupt the identifier and desync the value bindings).
    const encoded = escapeKnexColumnIdentifierSpecialCharacters('Marked AS Done?');
    const whereSql = quotingKnex('pipedrive.Activities').where(encoded, '>', 'x').toQuery();
    expect(whereSql).toContain('where "Marked AS Done?" >');
    expect(whereSql).not.toContain('Marked AS Done$');
    expect(quotingKnex('pipedrive.Activities').select('*').orderBy(encoded).toQuery()).toContain(
      'order by "Marked AS Done?"',
    );
  });

  it('detects " as " case-insensitively (like knex) while preserving the exact casing (DEV-11170)', () => {
    for (const columnName of ['Marked As Done', 'Marked aS Done', 'Marked AS Done']) {
      const sql = buildCreateTableQuery(
        quotingKnex,
        'pipedrive',
        'Activities',
        [field(columnName, { kind: 'text' })],
        new Map(),
      ).toString();
      expect(sql).toContain(`"${columnName}" text`);
      expect(sql).not.toContain('"Marked" as "Done"');
    }
  });
});

/**
 * Regression tests for DEV-11063: a Postgres column whose real name contains a `.` (e.g. Affinity's
 * "Dealroom.co URL") must be quoted as ONE identifier, not split by knex's identifier formatter into
 * `"Dealroom"."co URL"` (which is invalid DDL and breaks INSERT/SELECT/UPDATE). The DDL builder
 * encodes the dot itself; {@link applyVerbatimIdentifierQuoting} installs the `wrapIdentifier` hook
 * that decodes it back before quoting. Schema/table qualification keeps its real dot.
 */
describe('dotted column names (DEV-11063)', () => {
  const quotingKnex: Knex = knex({ client: 'pg' });
  applyVerbatimIdentifierQuoting(quotingKnex);

  afterAll(async () => {
    await quotingKnex.destroy();
  });

  it('quotes a CREATE TABLE column name containing a dot as a single identifier', () => {
    const sql = buildCreateTableQuery(
      quotingKnex,
      'public',
      'Organizations',
      [field('Dealroom.co URL', { kind: 'url' })],
      new Map(),
    ).toString();

    expect(sql).toContain('create table "public"."Organizations"');
    expect(sql).toContain('"Dealroom.co URL" text');
    expect(sql).not.toContain('"Dealroom"."co URL"');
  });

  it('quotes a dotted foreign-key column while keeping the target table qualified', () => {
    const resolvedFk: ForeignKeyResolutions = new Map([
      [
        'company.id',
        { kind: 'resolved', targetTableQualified: 'crm.companies', targetPkColumn: 'id', targetPkType: 'uuid' },
      ],
    ]);
    const sql = buildCreateTableQuery(
      quotingKnex,
      'public',
      'people',
      [field('company.id', { kind: 'foreignKey', target: { existingRemoteTableId: ['crm', 'companies'] } })],
      resolvedFk,
    ).toString();

    expect(sql).toContain('"company.id" uuid');
    expect(sql).toContain('foreign key ("company.id")');
    expect(sql).toContain('references "crm"."companies"');
    expect(sql).not.toContain('"company"."id"');
  });

  it('encodes a dotted column so INSERT / SELECT / UPDATE quote it verbatim', () => {
    const encoded = encodeColumnIdentifierDotsForKnex('Dealroom.co URL');
    expect(
      quotingKnex('public.Organizations')
        .insert({ [encoded]: 'x' })
        .toQuery(),
    ).toContain('("Dealroom.co URL")');
    expect(quotingKnex('public.Organizations').select(encoded).toQuery()).toContain('select "Dealroom.co URL"');
    expect(
      quotingKnex('public.Organizations')
        .update({ [encoded]: 'x' })
        .toQuery(),
    ).toContain('set "Dealroom.co URL" =');
  });

  it('leaves schema-qualified table references splitting on the dot', () => {
    expect(quotingKnex('public.Organizations').select('Subject').toQuery()).toBe(
      'select "Subject" from "public"."Organizations"',
    );
  });
});

/**
 * A `?` inside a column name is knex's positional-binding placeholder — unescaped, the compiled
 * DDL replaced it with a `$n` binding reference, so creating a column named "Featured?" actually
 * created `"Featured$1"` and broke created-field resolution at sync-draft save (SANITY Live Export
 * audit 2026-08-01: the deployed Studio schema's authored title "Featured?"). The DDL builder now
 * escapes it via {@link escapeKnexColumnIdentifierSpecialCharacters}, same as the DML side.
 */
describe('column names containing a question mark', () => {
  const quotingKnex: Knex = knex({ client: 'pg' });
  applyVerbatimIdentifierQuoting(quotingKnex);

  afterAll(async () => {
    await quotingKnex.destroy();
  });

  it('quotes a CREATE TABLE column name containing a ? verbatim, not as a binding reference', () => {
    const sql = buildCreateTableQuery(
      quotingKnex,
      'public',
      'post',
      [field('Featured?', { kind: 'boolean' })],
      new Map(),
    ).toString();

    expect(sql).toContain('"Featured?" boolean');
    expect(sql).not.toContain('Featured$');
  });

  it('quotes an ALTER TABLE added column containing a ? verbatim', () => {
    const sql = buildAddColumnsQuery(
      quotingKnex,
      'public',
      'post',
      [field('Sold out?', { kind: 'boolean' })],
      new Map(),
    ).toString();

    expect(sql).toContain('"Sold out?" boolean');
    expect(sql).not.toContain('Sold out$');
  });
});

describe('foreignKeyConstraintNameWithinPostgresIdentifierLimit', () => {
  it("keeps knex's default name when it fits the 63-byte limit", () => {
    expect(foreignKeyConstraintNameWithinPostgresIdentifierLimit('posts', 'author_id')).toBeUndefined();
  });

  it('replaces an over-long default with a deterministic ASCII name that fits', () => {
    const constraintName = foreignKeyConstraintNameWithinPostgresIdentifierLimit(
      'This is a long table name that…5 characters to break postgres',
      'Owner',
    );
    expect(constraintName).toMatch(/^[a-z0-9_]+_[0-9a-f]{10}_foreign$/);
    expect(constraintName?.length).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_LENGTH);
    expect(
      foreignKeyConstraintNameWithinPostgresIdentifierLimit(
        'This is a long table name that…5 characters to break postgres',
        'Owner',
      ),
    ).toBe(constraintName);
  });

  it('keeps two long columns that share a prefix distinct', () => {
    const sharedPrefix = 'a_long_foreign_key_column_name_shared_by_two_columns_';
    expect(foreignKeyConstraintNameWithinPostgresIdentifierLimit('posts', `${sharedPrefix}first`)).not.toBe(
      foreignKeyConstraintNameWithinPostgresIdentifierLimit('posts', `${sharedPrefix}second`),
    );
  });
});

describe('pickUnusedPostgresSchemaName', () => {
  it('keeps the base name when no schema uses it', () => {
    expect(pickUnusedPostgresSchemaName('postgresql_export', new Set(['public']))).toBe('postgresql_export');
  });

  it('suffixes the first free number when the base name is taken', () => {
    expect(pickUnusedPostgresSchemaName('postgresql_export', new Set(['postgresql_export']))).toBe(
      'postgresql_export_2',
    );
    expect(
      pickUnusedPostgresSchemaName('postgresql_export', new Set(['postgresql_export', 'postgresql_export_2'])),
    ).toBe('postgresql_export_3');
  });

  it('truncates the base so the suffix survives the 63-byte identifier limit', () => {
    const maxLengthBase = 'a'.repeat(63);
    const unusedSchemaName = pickUnusedPostgresSchemaName(maxLengthBase, new Set([maxLengthBase]));
    expect(unusedSchemaName).toBe(`${'a'.repeat(61)}_2`);
    expect(unusedSchemaName.length).toBe(63);
  });
});

describe('foldNameToPostgresSchemaIdentifier', () => {
  it('folds a human container name into a snake_case identifier', () => {
    expect(foldNameToPostgresSchemaIdentifier('Airtable export', 'fallback')).toBe('airtable_export');
  });

  it('is deterministic, so a retried create converges on the schema the first attempt made', () => {
    expect(foldNameToPostgresSchemaIdentifier('Q3 CRM export', 'fallback')).toBe(
      foldNameToPostgresSchemaIdentifier('Q3 CRM export', 'fallback'),
    );
  });

  it('collapses runs of punctuation and trims the separators off both ends', () => {
    expect(foldNameToPostgresSchemaIdentifier('  --HubSpot & Notion--  ', 'fallback')).toBe('hubspot_notion');
  });

  it('keeps accented letters by stripping their combining marks', () => {
    expect(foldNameToPostgresSchemaIdentifier('Café export', 'fallback')).toBe('cafe_export');
  });

  it('prefixes a leading digit so the identifier is usable unquoted', () => {
    expect(foldNameToPostgresSchemaIdentifier('2026 export', 'fallback')).toBe('s_2026_export');
  });

  it('truncates to the Postgres identifier limit rather than letting Postgres do it silently', () => {
    const folded = foldNameToPostgresSchemaIdentifier('a'.repeat(120), 'fallback');

    expect(folded).toHaveLength(POSTGRES_MAX_IDENTIFIER_LENGTH);
  });

  it('does not leave a trailing separator when the truncation lands on one', () => {
    // 63 chars of 'a' then a space: the cut falls exactly on the separator.
    const folded = foldNameToPostgresSchemaIdentifier(`${'a'.repeat(POSTGRES_MAX_IDENTIFIER_LENGTH)} export`, 'fb');

    expect(folded).toBe('a'.repeat(POSTGRES_MAX_IDENTIFIER_LENGTH));
    expect(folded.endsWith('_')).toBe(false);
  });

  it('falls back when the name has nothing usable in it', () => {
    expect(foldNameToPostgresSchemaIdentifier('...', 'scratch_export')).toBe('scratch_export');
    expect(foldNameToPostgresSchemaIdentifier(undefined, 'scratch_export')).toBe('scratch_export');
  });
});

describe('isInsufficientPrivilegeError', () => {
  it('recognizes a Postgres 42501', () => {
    expect(isInsufficientPrivilegeError(Object.assign(new Error('permission denied'), { code: '42501' }))).toBe(true);
  });

  it('ignores any other error', () => {
    expect(isInsufficientPrivilegeError(Object.assign(new Error('nope'), { code: '42P07' }))).toBe(false);
    expect(isInsufficientPrivilegeError(new Error('nope'))).toBe(false);
    expect(isInsufficientPrivilegeError(null)).toBe(false);
  });
});
