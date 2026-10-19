import { CREATE_FIELD_KINDS, type CreateFieldSpec, type CreateFieldType } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import {
  buildAddMySqlColumnQuery,
  buildAddMySqlForeignKeyColumnStatement,
  buildCreateMySqlTableQuery,
  buildMySqlForeignKeyColumnTypeDefinition,
  buildMySqlForeignKeyConstraintName,
  findMySqlIdentifierProblem,
  isMySqlDuplicateTableError,
  MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME,
  MYSQL_MAX_FIELDS_PER_CREATED_TABLE,
  MYSQL_MAX_IDENTIFIER_LENGTH,
  MYSQL_SCHEMA_CREATION_CAPABILITIES,
  mySqlSchemaCreationErrorMessage,
  resolveMySqlColumnDefinitionForCreateField,
  type ResolvedMySqlForeignKey,
} from '../mysql-create-schema';
import { applyMySqlVerbatimIdentifierQuoting } from '../mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from '../mysql-knex-dialect-client';
import { type MySqlTableReference } from '../mysql-types';

// Connection-less knex with exactly the production identifier hooks: compiles SQL, never loads the driver.
const connectionlessMySqlKnex: Knex = knex({ client: ScratchMySql2KnexDialectClient });
applyMySqlVerbatimIdentifierQuoting(connectionlessMySqlKnex);

afterAll(async () => {
  await connectionlessMySqlKnex.destroy();
});

const widgetsTable: MySqlTableReference = { databaseName: 'shop', tableName: 'widgets' };

function field(name: string, fieldType: CreateFieldType, extra: Partial<CreateFieldSpec> = {}): CreateFieldSpec {
  return { name, fieldType, ...extra };
}

function compileSchemaBuilder(schemaBuilder: Knex.SchemaBuilder): { sql: string; bindings: readonly unknown[] }[] {
  return schemaBuilder.toSQL().map((compiledStatement) => ({
    sql: compiledStatement.sql,
    bindings: compiledStatement.bindings,
  }));
}

function createTableSql(
  fields: CreateFieldSpec[],
  skipReasonByFieldName = new Map<string, string>(),
  table: MySqlTableReference = widgetsTable,
): string {
  const compiledStatements = compileSchemaBuilder(
    buildCreateMySqlTableQuery(connectionlessMySqlKnex, table, fields, skipReasonByFieldName),
  );
  expect(compiledStatements).toHaveLength(1);
  expect(compiledStatements[0].bindings).toEqual([]);
  return compiledStatements[0].sql;
}

const resolvedForeignKeyToCompanies: ResolvedMySqlForeignKey = {
  kind: 'resolved',
  targetTable: { databaseName: 'shop', tableName: 'companies' },
  targetColumnName: 'id',
  foreignKeyColumnTypeDefinition: 'bigint unsigned',
};

describe('MYSQL_SCHEMA_CREATION_CAPABILITIES', () => {
  it('declares every kind but multiSelect, 64-character names, a 180-field cap and the reserved id', () => {
    expect(MYSQL_SCHEMA_CREATION_CAPABILITIES).toEqual({
      supportedFieldKinds: CREATE_FIELD_KINDS.filter((fieldKind) => fieldKind !== 'multiSelect'),
      primaryField: null,
      maxTableNameLength: 64,
      maxFieldNameLength: 64,
      maxFieldsPerTable: 180,
      reservedFieldNames: ['id'],
      supportsManyToManyForeignKeys: false,
      requiresUniqueTableNames: true,
      nativeTypeSystem: 'mysql',
    });
    expect(MYSQL_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds).not.toContain('multiSelect');
    expect(MYSQL_SCHEMA_CREATION_CAPABILITIES).not.toHaveProperty('supportedArrayElementKinds');
    expect(MYSQL_MAX_IDENTIFIER_LENGTH).toBe(64);
    expect(MYSQL_MAX_FIELDS_PER_CREATED_TABLE).toBe(180);
    expect(MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME).toBe('id');
  });
});

describe('buildCreateMySqlTableQuery', () => {
  it('injects a bigint unsigned AUTO_INCREMENT primary key and sets InnoDB + utf8mb4 explicitly', () => {
    expect(createTableSql([field('name', { kind: 'text' })])).toBe(
      'create table `shop`.`widgets` (`id` bigint unsigned not null auto_increment primary key, `name` mediumtext null) default character set utf8mb4 engine = InnoDB',
    );
  });

  describe('logical field type → MySQL column', () => {
    it.each<[string, CreateFieldType, string]>([
      ['text', { kind: 'text' }, '`value` mediumtext null'],
      ['url', { kind: 'url' }, '`value` mediumtext null'],
      ['email', { kind: 'email' }, '`value` mediumtext null'],
      ['phone', { kind: 'phone' }, '`value` mediumtext null'],
      ['select', { kind: 'select', options: [{ name: 'a' }] }, '`value` mediumtext null'],
      ['longText', { kind: 'longText' }, '`value` longtext null'],
      ['boolean', { kind: 'boolean' }, '`value` tinyint(1) null'],
      ['number integer', { kind: 'number', format: 'integer' }, '`value` int null'],
      ['number plain', { kind: 'number', format: 'plain' }, '`value` double null'],
      ['number unset', { kind: 'number' }, '`value` double null'],
      ['number percent', { kind: 'number', format: 'percent' }, '`value` double null'],
      [
        'number decimal w/ precision',
        { kind: 'number', format: 'decimal', precision: 2 },
        '`value` decimal(10,2) null',
      ],
      ['number decimal precision 0', { kind: 'number', format: 'decimal', precision: 0 }, '`value` decimal(8,0) null'],
      ['number decimal no precision', { kind: 'number', format: 'decimal' }, '`value` decimal(65,30) null'],
      ['currency default scale', { kind: 'currency', currencyCode: 'USD' }, '`value` decimal(12,4) null'],
      ['currency precision 2', { kind: 'currency', currencyCode: 'EUR', precision: 2 }, '`value` decimal(10,2) null'],
      ['json', { kind: 'json' }, '`value` json null'],
      ['date', { kind: 'date' }, '`value` date null'],
      ['date w/ time', { kind: 'date', includesTime: true }, '`value` datetime(3) null'],
    ])('maps %s', (_label, fieldType, expectedColumnDefinition) => {
      const skipReasonByFieldName = new Map<string, string>();
      expect(createTableSql([field('value', fieldType)], skipReasonByFieldName)).toContain(
        `primary key, ${expectedColumnDefinition})`,
      );
      expect(skipReasonByFieldName.size).toBe(0);
    });
  });

  it('emits NOT NULL for a required field and an explicit NULL otherwise', () => {
    const sql = createTableSql([
      field('Title', { kind: 'text' }, { required: true }),
      field('Notes', { kind: 'longText' }, { required: false }),
      field('Due', { kind: 'date' }),
    ]);
    expect(sql).toContain('`Title` mediumtext not null, `Notes` longtext null, `Due` date null');
  });

  describe('native MySQL types (MySQL → MySQL copies)', () => {
    it('recreates a recreatable native type verbatim, lower-cased, with explicit nullability', () => {
      const sql = createTableSql([
        field(
          'amount',
          { kind: 'number' },
          { nativeFieldType: { typeSystem: 'mysql', type: 'decimal(10,2) unsigned' } },
        ),
        field(
          'code',
          { kind: 'text' },
          { nativeFieldType: { typeSystem: 'mysql', type: 'VARCHAR(36)' }, required: true },
        ),
        field(
          'seen_at',
          { kind: 'date', includesTime: true },
          { nativeFieldType: { typeSystem: 'mysql', type: 'timestamp(3)' } },
        ),
        field('flag', { kind: 'boolean' }, { nativeFieldType: { typeSystem: 'mysql', type: 'tinyint(1)' } }),
        field('year', { kind: 'number' }, { nativeFieldType: { typeSystem: 'mysql', type: 'year' } }),
        field('mariadb_int', { kind: 'number' }, { nativeFieldType: { typeSystem: 'mysql', type: 'int(11)' } }),
      ]);
      expect(sql).toContain(
        '`amount` decimal(10,2) unsigned null, `code` varchar(36) not null, `seen_at` timestamp(3) null, `flag` tinyint(1) null, `year` year null, `mariadb_int` int(11) null',
      );
    });

    it('ignores a native type from another type system and uses the logical kind', () => {
      expect(
        createTableSql([
          field(
            'value',
            { kind: 'number', format: 'integer' },
            { nativeFieldType: { typeSystem: 'postgres', type: 'bigint' } },
          ),
        ]),
      ).toContain('`value` int null');
    });

    it.each([
      "enum('a','b')",
      "set('a')",
      'blob',
      'binary(16)',
      'uuid',
      'int unsigned zerofill',
      'int); drop table users; --',
      'decimal(10,2) default 0',
    ])('skips a field asking for the non-recreatable native type %j instead of interpolating it', (nativeType) => {
      const skipReasonByFieldName = new Map<string, string>();
      const sql = createTableSql(
        [
          field('value', { kind: 'text' }, { nativeFieldType: { typeSystem: 'mysql', type: nativeType } }),
          field('kept', { kind: 'text' }),
        ],
        skipReasonByFieldName,
      );
      expect(sql).not.toContain('`value`');
      expect(sql).not.toContain('drop');
      expect(sql).toContain('`kept` mediumtext null');
      expect(skipReasonByFieldName.get('value')).toContain(`native MySQL type "${nativeType}"`);
    });
  });

  describe('skipped fields', () => {
    it.each([
      ['the reserved id name', field('id', { kind: 'text' }), 'is reserved'],
      ['the reserved id name in another case', field(' ID ', { kind: 'number' }), 'is reserved'],
      ['a multi-select', field('tags', { kind: 'multiSelect', options: [{ name: 'a' }] }), 'MySQL has no list column'],
      ['a text list', field('aliases', { kind: 'text', isArray: true }), 'is a list'],
      ['a number list', field('scores', { kind: 'number', isArray: true }), 'is a list'],
      ['a boolean list', field('flags', { kind: 'boolean', isArray: true }), 'is a list'],
      ['an emoji name', field('Status 🚀', { kind: 'text' }), 'outside the Basic Multilingual Plane'],
      ['a trailing space', field('Status ', { kind: 'text' }), 'ends with a space'],
      ['a 65-character name', field('c'.repeat(65), { kind: 'text' }), 'at most 64'],
      ['a control character', field('a\u0001b', { kind: 'text' }), 'control character'],
      [
        'a foreign key (added by its own ALTER TABLE)',
        field('company', { kind: 'foreignKey', target: { existingRemoteTableId: ['shop', 'companies'] } }),
        'separate step',
      ],
    ])('skips %s and keeps the other columns', (_label, skippedField, expectedReasonFragment) => {
      const skipReasonByFieldName = new Map<string, string>();
      const sql = createTableSql([skippedField, field('kept', { kind: 'text' })], skipReasonByFieldName);
      expect(sql).toBe(
        'create table `shop`.`widgets` (`id` bigint unsigned not null auto_increment primary key, `kept` mediumtext null) default character set utf8mb4 engine = InnoDB',
      );
      expect(skipReasonByFieldName.get(skippedField.name)).toContain(expectedReasonFragment);
    });

    it('accepts a 64-character name', () => {
      const sixtyFourCharacterName = 'c'.repeat(64);
      expect(createTableSql([field(sixtyFourCharacterName, { kind: 'text' })])).toContain(
        `\`${sixtyFourCharacterName}\` mediumtext null`,
      );
    });
  });

  it('emits every identifier segment verbatim: dots, " as ", "?", backticks and non-ASCII', () => {
    const sql = createTableSql(
      [
        field('Dealroom.co URL', { kind: 'url' }),
        field('Featured?', { kind: 'boolean' }),
        field('Marked as done time', { kind: 'date', includesTime: true }),
        field('Certified AS Organic', { kind: 'boolean' }),
        field('a`b', { kind: 'text' }),
        field('Größe', { kind: 'number' }),
      ],
      new Map(),
      { databaseName: 'my.shop', tableName: 'Company.io Deals as of 2026?' },
    );
    expect(sql).toBe(
      'create table `my.shop`.`Company.io Deals as of 2026?` (`id` bigint unsigned not null auto_increment primary key, ' +
        '`Dealroom.co URL` mediumtext null, `Featured?` tinyint(1) null, `Marked as done time` datetime(3) null, ' +
        '`Certified AS Organic` tinyint(1) null, `a``b` mediumtext null, `Größe` double null) ' +
        'default character set utf8mb4 engine = InnoDB',
    );
  });

  it('fills the skip map only when compiled, so it is complete once the query has run', () => {
    const skipReasonByFieldName = new Map<string, string>();
    const createTableQuery = buildCreateMySqlTableQuery(
      connectionlessMySqlKnex,
      widgetsTable,
      [field('id', { kind: 'text' })],
      skipReasonByFieldName,
    );
    createTableQuery.toSQL();
    expect([...skipReasonByFieldName.keys()]).toEqual(['id']);
  });

  it.each([
    ['an emoji table name', { databaseName: 'shop', tableName: 'Deals 🚀' }, 'Basic Multilingual Plane'],
    ['a 65-character table name', { databaseName: 'shop', tableName: 't'.repeat(65) }, 'at most 64'],
    ['a table name with a trailing space', { databaseName: 'shop', tableName: 'Deals ' }, 'ends with a space'],
    ['an empty table name', { databaseName: 'shop', tableName: '  ' }, 'is empty'],
    [
      'a sentinel character in the database name',
      { databaseName: 'sh\u0001op', tableName: 'deals' },
      'control character',
    ],
  ])('refuses %s before any DDL is built', (_label, table, expectedMessageFragment) => {
    let thrownError: unknown;
    try {
      buildCreateMySqlTableQuery(connectionlessMySqlKnex, table, [field('name', { kind: 'text' })], new Map());
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeInstanceOf(MySqlClientError);
    expect((thrownError as MySqlClientError).problem).toBe(MySqlClientProblem.InvalidSchemaCreationRequest);
    expect((thrownError as MySqlClientError).userFriendlyMessage).toContain(expectedMessageFragment);
  });

  it('creates a 180-field table in one statement', () => {
    const oneHundredEightyTextFields = Array.from({ length: MYSQL_MAX_FIELDS_PER_CREATED_TABLE }, (_, fieldIndex) =>
      field(`field_${fieldIndex}`, { kind: 'text' }),
    );
    const sql = createTableSql(oneHundredEightyTextFields);
    expect(sql.match(/ mediumtext null/g)).toHaveLength(180);
  });
});

describe('buildAddMySqlColumnQuery', () => {
  it('adds one column with explicit nullability and verbatim identifiers', () => {
    const skipReasonByFieldName = new Map<string, string>();
    expect(
      compileSchemaBuilder(
        buildAddMySqlColumnQuery(
          connectionlessMySqlKnex,
          { databaseName: 'my.shop', tableName: 'Company.io' },
          field('Marked as done?', { kind: 'number', format: 'decimal', precision: 3 }, { required: true }),
          skipReasonByFieldName,
        ),
      ),
    ).toEqual([
      { sql: 'alter table `my.shop`.`Company.io` add `Marked as done?` decimal(11,3) not null', bindings: [] },
    ]);
    expect(skipReasonByFieldName.size).toBe(0);
  });

  it('does not reserve "id" on an existing table (a real clash surfaces as MySQL 1060)', () => {
    expect(
      compileSchemaBuilder(
        buildAddMySqlColumnQuery(connectionlessMySqlKnex, widgetsTable, field('id', { kind: 'text' }), new Map()),
      ),
    ).toEqual([{ sql: 'alter table `shop`.`widgets` add `id` mediumtext null', bindings: [] }]);
  });

  it('records a skip and adds no column for a field MySQL cannot hold', () => {
    const skipReasonByFieldName = new Map<string, string>();
    const compiledStatements = compileSchemaBuilder(
      buildAddMySqlColumnQuery(
        connectionlessMySqlKnex,
        widgetsTable,
        field('tags', { kind: 'multiSelect', options: [{ name: 'a' }] }),
        skipReasonByFieldName,
      ),
    );
    expect(compiledStatements.map((compiledStatement) => compiledStatement.sql).join(' ')).not.toContain('tags');
    expect(skipReasonByFieldName.get('tags')).toContain('MySQL has no list column');
  });
});

describe('resolveMySqlColumnDefinitionForCreateField', () => {
  it('reserves "id" only when creating a table', () => {
    expect(
      resolveMySqlColumnDefinitionForCreateField(field('id', { kind: 'text' }), { isCreatingTable: true }),
    ).toEqual(expect.objectContaining({ outcome: 'skipped' }));
    expect(
      resolveMySqlColumnDefinitionForCreateField(field('id', { kind: 'text' }), { isCreatingTable: false }),
    ).toEqual({
      outcome: 'column',
      columnTypeSpelling: 'mediumtext',
      isNullable: true,
    });
  });
});

describe('buildAddMySqlForeignKeyColumnStatement', () => {
  const foreignKeyField = field('Company', {
    kind: 'foreignKey',
    target: { existingRemoteTableId: ['shop', 'companies'] },
  });

  it('adds the column and its constraint in ONE statement, nullable, ON DELETE SET NULL', () => {
    const compiledStatement = buildAddMySqlForeignKeyColumnStatement(
      connectionlessMySqlKnex,
      widgetsTable,
      foreignKeyField,
      resolvedForeignKeyToCompanies,
    ).toSQL();
    const constraintName = buildMySqlForeignKeyConstraintName('widgets', 'Company');
    expect(compiledStatement.sql).toBe(
      `ALTER TABLE \`shop\`.\`widgets\` ADD COLUMN \`Company\` bigint unsigned NULL, ADD CONSTRAINT \`${constraintName}\` FOREIGN KEY (\`Company\`) REFERENCES \`shop\`.\`companies\` (\`id\`) ON DELETE SET NULL`,
    );
    expect(compiledStatement.bindings).toEqual([]);
  });

  it('keeps every identifier verbatim and carries the target character set and collation', () => {
    const compiledStatement = buildAddMySqlForeignKeyColumnStatement(
      connectionlessMySqlKnex,
      { databaseName: 'my.shop', tableName: 'Company.io Deals' },
      field(
        'Country as of 2026?',
        { kind: 'foreignKey', target: { existingRemoteTableId: ['legacy.db', 'Countries as `x`'] } },
        { required: true },
      ),
      {
        kind: 'resolved',
        targetTable: { databaseName: 'legacy.db', tableName: 'Countries as `x`' },
        targetColumnName: 'ISO.code?',
        foreignKeyColumnTypeDefinition: 'varchar(2) CHARACTER SET latin1 COLLATE latin1_swedish_ci',
      },
    ).toSQL();
    const constraintName = buildMySqlForeignKeyConstraintName('Company.io Deals', 'Country as of 2026?');
    expect(compiledStatement.sql).toBe(
      'ALTER TABLE `my.shop`.`Company.io Deals` ADD COLUMN `Country as of 2026?` varchar(2) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL, ' +
        `ADD CONSTRAINT \`${constraintName}\` FOREIGN KEY (\`Country as of 2026?\`) ` +
        'REFERENCES `legacy.db`.`Countries as ``x``` (`ISO.code?`) ON DELETE SET NULL',
    );
    expect(compiledStatement.bindings).toEqual([]);
  });

  it.each([
    ['a type definition that is not a recreatable type', 'int); DROP TABLE users; --'],
    ['an injected charset clause', 'varchar(2) CHARACTER SET latin1; DROP TABLE users'],
    ['a TEXT id type', 'text'],
    ['a binary id type', 'binary(16)'],
    ['an upper-cased type', 'BIGINT UNSIGNED'],
    ['an empty type', ''],
  ])('refuses %s instead of interpolating it', (_label, foreignKeyColumnTypeDefinition) => {
    expect(() =>
      buildAddMySqlForeignKeyColumnStatement(connectionlessMySqlKnex, widgetsTable, foreignKeyField, {
        ...resolvedForeignKeyToCompanies,
        foreignKeyColumnTypeDefinition,
      }),
    ).toThrow(MySqlClientError);
  });

  it.each([
    [
      'a multi-valued foreign key',
      field('Company', { kind: 'foreignKey', target: { ref: 'companies' }, allowMultiple: true }),
    ],
    ['a non-foreign-key field', field('Company', { kind: 'text' })],
    ['a field name MySQL cannot use', field('Company 🚀', { kind: 'foreignKey', target: { ref: 'companies' } })],
  ])('refuses %s', (_label, invalidField) => {
    expect(() =>
      buildAddMySqlForeignKeyColumnStatement(
        connectionlessMySqlKnex,
        widgetsTable,
        invalidField,
        resolvedForeignKeyToCompanies,
      ),
    ).toThrow(MySqlClientError);
  });

  it('refuses a target name containing a knex identifier sentinel', () => {
    expect(() =>
      buildAddMySqlForeignKeyColumnStatement(connectionlessMySqlKnex, widgetsTable, foreignKeyField, {
        ...resolvedForeignKeyToCompanies,
        targetTable: { databaseName: 'shop', tableName: 'comp\u0001anies' },
      }),
    ).toThrow(MySqlClientError);
  });
});

describe('buildMySqlForeignKeyColumnTypeDefinition', () => {
  it.each([
    [{ columnType: 'bigint unsigned', characterSetName: null, collationName: null }, 'bigint unsigned'],
    [{ columnType: 'int(11)', characterSetName: null, collationName: null }, 'int(11)'],
    [
      { columnType: 'varchar(36)', characterSetName: 'utf8mb4', collationName: 'utf8mb4_0900_ai_ci' },
      'varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    ],
    [
      { columnType: 'char(2)', characterSetName: 'latin1', collationName: 'latin1_swedish_ci' },
      'char(2) CHARACTER SET latin1 COLLATE latin1_swedish_ci',
    ],
    [{ columnType: 'CHAR(2)', characterSetName: 'latin1', collationName: null }, 'char(2) CHARACTER SET latin1'],
  ])('builds the foreign key column type for %j', (target, expectedDefinition) => {
    expect(buildMySqlForeignKeyColumnTypeDefinition(target)).toEqual({
      foreignKeyColumnTypeDefinition: expectedDefinition,
    });
  });

  it.each([
    [{ columnType: 'text', characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' }, "can't reference"],
    [{ columnType: 'json', characterSetName: null, collationName: null }, "can't reference"],
    [{ columnType: 'longblob', characterSetName: null, collationName: null }, "can't reference"],
    [{ columnType: 'binary(16)', characterSetName: null, collationName: null }, 'encoded text'],
    [{ columnType: 'bit(8)', characterSetName: null, collationName: null }, 'encoded text'],
    [{ columnType: "enum('a','b')", characterSetName: 'utf8mb4', collationName: 'utf8mb4_bin' }, "can't recreate"],
    [{ columnType: 'uuid', characterSetName: null, collationName: null }, "can't recreate"],
    [{ columnType: 'int unsigned zerofill', characterSetName: null, collationName: null }, "can't recreate"],
    [
      { columnType: 'varchar(10)', characterSetName: 'utf8mb4; drop', collationName: 'utf8mb4_bin' },
      'character set or collation',
    ],
    [
      { columnType: 'varchar(10)', characterSetName: 'utf8mb4', collationName: 'Utf8mb4_Bin' },
      'character set or collation',
    ],
  ])('refuses a target column of %j', (target, expectedReasonFragment) => {
    const foreignKeyColumnType = buildMySqlForeignKeyColumnTypeDefinition(target);
    if (!('unreferenceableReason' in foreignKeyColumnType))
      throw new Error('expected the target to be unreferenceable');
    expect(foreignKeyColumnType.unreferenceableReason).toContain(expectedReasonFragment);
  });
});

describe('buildMySqlForeignKeyConstraintName', () => {
  it('is deterministic, readable and at most 64 characters, even for two 64-character names', () => {
    const longTableName = 'T'.repeat(64);
    const longColumnName = 'Column with spaces and punctuation!?'.padEnd(64, 'x');
    const constraintName = buildMySqlForeignKeyConstraintName(longTableName, longColumnName);
    expect(constraintName.length).toBeLessThanOrEqual(64);
    expect(constraintName).toMatch(/^fk_[a-z0-9_]+_[0-9a-f]{8}$/);
    expect(buildMySqlForeignKeyConstraintName(longTableName, longColumnName)).toBe(constraintName);
    expect(buildMySqlForeignKeyConstraintName('deals', 'company_id')).toMatch(/^fk_deals_company_id_[0-9a-f]{8}$/);
  });

  it('is distinct for names that fold to the same readable prefix', () => {
    const constraintNames = new Set([
      buildMySqlForeignKeyConstraintName('Deals', 'Company'),
      buildMySqlForeignKeyConstraintName('deals', 'company'),
      buildMySqlForeignKeyConstraintName('deals', 'Company!'),
      buildMySqlForeignKeyConstraintName('deals.x', 'company'),
      buildMySqlForeignKeyConstraintName('deals', 'x.company'),
      buildMySqlForeignKeyConstraintName('a'.repeat(30), 'company'),
      buildMySqlForeignKeyConstraintName('a'.repeat(31), 'company'),
    ]);
    expect(constraintNames.size).toBe(7);
  });

  it('keeps only [a-z0-9_] in the readable part', () => {
    expect(buildMySqlForeignKeyConstraintName('Größe `x`', '🚀 Stage?')).toMatch(/^fk_gr_e_x_stage_[0-9a-f]{8}$/);
  });
});

describe('findMySqlIdentifierProblem', () => {
  it.each(['name', 'Dealroom.co URL', 'Featured?', 'a`b', 'Größe', ' leading space', 'x'.repeat(64), '日本語'])(
    'accepts %j',
    (identifier) => {
      expect(findMySqlIdentifierProblem(identifier, 'column')).toBeUndefined();
    },
  );

  it.each([
    ['', 'is empty'],
    ['   ', 'is empty'],
    ['x'.repeat(65), 'at most 64'],
    ['é'.repeat(65), '65 characters long'],
    ['tab\tname', 'control character'],
    ['sentinel\u0000name', 'control character'],
    ['Deals 🚀', 'outside the Basic Multilingual Plane'],
    ['trailing ', 'ends with a space'],
  ])('reports a problem for %j', (identifier, expectedProblemFragment) => {
    expect(findMySqlIdentifierProblem(identifier, 'table')).toContain(expectedProblemFragment);
  });

  it('names the role in the message', () => {
    expect(findMySqlIdentifierProblem('', 'table')).toContain('table name');
    expect(findMySqlIdentifierProblem('', 'column')).toContain('field name');
  });
});

describe('isMySqlDuplicateTableError', () => {
  it('recognizes errno 1050 only', () => {
    expect(isMySqlDuplicateTableError({ errno: 1050, code: 'ER_TABLE_EXISTS_ERROR' })).toBe(true);
    expect(isMySqlDuplicateTableError({ errno: 1060 })).toBe(false);
    expect(isMySqlDuplicateTableError({ code: 'ER_TABLE_EXISTS_ERROR' })).toBe(false);
    expect(isMySqlDuplicateTableError(new Error('Table already exists'))).toBe(false);
    expect(isMySqlDuplicateTableError(null)).toBe(false);
  });
});

describe('mySqlSchemaCreationErrorMessage', () => {
  const tableContext = { databaseName: 'shop', tableName: 'widgets' };
  const columnContext = { ...tableContext, columnName: 'Company' };
  const serverMessageWithClientAddress = "command denied to user 'scratch'@'203.0.113.7' for table 'widgets'";

  it.each([
    [1050, tableContext, 'A table named "widgets" already exists in the "shop" database'],
    [1049, tableContext, 'Database "shop" doesn\'t exist'],
    [1044, tableContext, 'isn\'t allowed to create tables in "shop"'],
    [1227, tableContext, 'isn\'t allowed to create tables in "shop"'],
    [1118, tableContext, 'more (or wider) columns than fit in one MySQL row'],
    [1117, tableContext, 'more (or wider) columns than fit in one MySQL row'],
    [1060, columnContext, 'A column named "Company" already exists on "shop"."widgets"'],
    [1060, tableContext, 'map to the same MySQL column name'],
    [1146, columnContext, 'Table "shop"."widgets" doesn\'t exist'],
    [3780, columnContext, 'Couldn\'t create foreign key "Company" on "shop"."widgets"'],
    [1215, columnContext, 'MySQL rejected the reference to the linked table'],
    [6125, columnContext, 'MySQL rejected the reference to the linked table'],
    [1822, columnContext, 'MySQL rejected the reference to the linked table'],
    [1824, columnContext, 'MySQL rejected the reference to the linked table'],
    [1005, columnContext, 'MySQL rejected the reference to the linked table'],
    [1005, tableContext, 'MySQL couldn\'t create "shop"."widgets" (error 1005)'],
    [
      1826,
      columnContext,
      `a constraint named "${buildMySqlForeignKeyConstraintName('widgets', 'Company')}" already exists`,
    ],
    [1205, tableContext, 'Timed out waiting for a lock on "shop"."widgets"'],
    [1290, tableContext, 'read-only (it may be a replica)'],
    [1792, tableContext, 'read-only (it may be a replica)'],
    [1836, tableContext, 'read-only (it may be a replica)'],
    [1059, tableContext, '64-character limit'],
    [1103, tableContext, 'doesn\'t accept "widgets" as a table name'],
    [1166, columnContext, 'doesn\'t accept "Company" as a column name'],
  ])('maps errno %d', (errno, context, expectedMessageFragment) => {
    const message = mySqlSchemaCreationErrorMessage(
      { errno, sqlMessage: `server text with 'scratch'@'203.0.113.7'` },
      context,
    );
    expect(message).toContain(expectedMessageFragment);
    expect(message).not.toContain('203.0.113.7');
  });

  it.each([
    ['CREATE', 'create tables'],
    ['ALTER', 'change tables'],
    ['REFERENCES', 'create foreign keys'],
    ['INDEX', 'create indexes'],
    ['DROP', 'make schema changes'],
  ])('names the denied %s command (1142) from an allowlist, never echoing the server message', (verb, description) => {
    const message = mySqlSchemaCreationErrorMessage(
      { errno: 1142, sqlMessage: `${verb} ${serverMessageWithClientAddress}` },
      tableContext,
    );
    expect(message).toBe(
      `This connection's MySQL user isn't allowed to ${description} in "shop". Grant it CREATE, ALTER and REFERENCES on \`shop\`.*, or choose another database.`,
    );
  });

  it('recognizes a Vitess / PlanetScale foreign-key refusal and leaves other 1105 errors to the general mapping', () => {
    expect(
      mySqlSchemaCreationErrorMessage(
        { errno: 1105, sqlMessage: 'VT10001: foreign key constraints are not allowed' },
        columnContext,
      ),
    ).toBe(
      'Couldn\'t create foreign key "Company" on "shop"."widgets": this MySQL server doesn\'t allow foreign keys.',
    );
    expect(
      mySqlSchemaCreationErrorMessage({ errno: 1105, sqlMessage: 'something else' }, columnContext),
    ).toBeUndefined();
  });

  it('is undefined for errors it does not cover', () => {
    expect(mySqlSchemaCreationErrorMessage({ errno: 1064, sqlMessage: 'syntax' }, tableContext)).toBeUndefined();
    expect(mySqlSchemaCreationErrorMessage({ code: 'ECONNREFUSED' }, tableContext)).toBeUndefined();
    expect(mySqlSchemaCreationErrorMessage(new Error('boom'), tableContext)).toBeUndefined();
    expect(mySqlSchemaCreationErrorMessage(undefined, tableContext)).toBeUndefined();
  });
});
