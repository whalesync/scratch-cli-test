import knex, { type Knex } from 'knex';
import { encodeColumnIdentifierForKnex } from '../../pg-common/knex-column-identifier-dot-encoding';
import {
  applyMySqlVerbatimIdentifierQuoting,
  encodeMySqlColumnKeysForKnex,
  encodeMySqlIdentifierForKnex,
  qualifiedMySqlTableReferenceForKnex,
  rejoinKnexAliasSplitMySqlIdentifier,
} from '../mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from '../mysql-knex-dialect-client';

// Connection-less knex with the production hooks: compiles SQL without loading a connection. Assertions use
// `toSQL()`: knex's own `toString()` substitutes `?` even inside backticks, unlike mysql2's formatter.
const compileOnlyMySqlKnex: Knex = knex({ client: ScratchMySql2KnexDialectClient });
applyMySqlVerbatimIdentifierQuoting(compileOnlyMySqlKnex);

afterAll(async () => {
  await compileOnlyMySqlKnex.destroy();
});

const encode = encodeMySqlIdentifierForKnex;

describe('encodeMySqlIdentifierForKnex', () => {
  it('is the dialect-agnostic pg-common sentinel encoding (no Postgres-only `\\?` escape)', () => {
    for (const identifier of ['a.b', 'Certified AS Organic', 'Featured?', 'pk`tick', 'plain']) {
      expect(encode(identifier)).toBe(encodeColumnIdentifierForKnex(identifier));
    }
    expect(encode('Featured?')).toBe('Featured?');
  });
});

describe('qualifiedMySqlTableReferenceForKnex', () => {
  it('compiles to `database`.`table` even when either name contains "." or " as "', () => {
    const compiledSelect = compileOnlyMySqlKnex(
      qualifiedMySqlTableReferenceForKnex({ databaseName: 'my.db', tableName: 'Deals AS of 2026.v2' }),
    )
      .select(encode('id'))
      .toSQL();
    expect(compiledSelect.sql).toBe('select `id` from `my.db`.`Deals AS of 2026.v2`');
  });

  it('keeps database and table apart when a dot could be read either way', () => {
    const firstTableReference = qualifiedMySqlTableReferenceForKnex({ databaseName: 'a.b', tableName: 'c' });
    const secondTableReference = qualifiedMySqlTableReferenceForKnex({ databaseName: 'a', tableName: 'b.c' });
    expect(compileOnlyMySqlKnex(firstTableReference).select('x').toSQL().sql).toBe('select `x` from `a.b`.`c`');
    expect(compileOnlyMySqlKnex(secondTableReference).select('x').toSQL().sql).toBe('select `x` from `a`.`b.c`');
  });

  it('doubles a backtick inside a database or table name', () => {
    const compiledSelect = compileOnlyMySqlKnex(
      qualifiedMySqlTableReferenceForKnex({ databaseName: 'd`b', tableName: 't`' }),
    )
      .select('x')
      .toSQL();
    expect(compiledSelect.sql).toBe('select `x` from `d``b`.`t```');
  });
});

describe('column identifiers', () => {
  it.each([
    ['a.b', '`a.b`'],
    ['Certified AS Organic', '`Certified AS Organic`'],
    ['Marked as done', '`Marked as done`'],
    ['Featured?', '`Featured?`'],
    ['pk`tick', '`pk``tick`'],
    ['emoji 🚀 name', '`emoji 🚀 name`'],
  ])('%j compiles verbatim as %s', (columnName, expectedQuotedIdentifier) => {
    const compiledSelect = compileOnlyMySqlKnex('t').select(encode(columnName)).toSQL();
    expect(compiledSelect.sql).toBe(`select ${expectedQuotedIdentifier} from \`t\``);
    expect(compiledSelect.sql).not.toContain('"');
    expect(compiledSelect.sql).not.toContain('\\?');
  });

  it('leaves a ? inside a quoted column name out of the bindings', () => {
    const compiledSelect = compileOnlyMySqlKnex('t').select(encode('Featured?')).where(encode('id'), 7).toSQL();
    expect(compiledSelect.sql).toBe('select `Featured?` from `t` where `id` = ?');
    expect(compiledSelect.bindings).toEqual([7]);
  });

  it('quotes a knex.ref and an orderBy column verbatim', () => {
    const compiledSelect = compileOnlyMySqlKnex('t')
      .select(encode('id'))
      .where(compileOnlyMySqlKnex.ref(encode('updated.at')), '>', '2026-01-01 00:00:00.000000')
      .orderBy(encode('Row ID.v2'), 'asc')
      .toSQL();
    expect(compiledSelect.sql).toBe('select `id` from `t` where `updated.at` > ? order by `Row ID.v2` asc');
  });

  it('inlines ?? identifier bindings verbatim in raw SQL', () => {
    const compiledDelete = compileOnlyMySqlKnex
      .raw('DELETE FROM ?? WHERE ?? = ? LIMIT 2', [
        qualifiedMySqlTableReferenceForKnex({ databaseName: 'db', tableName: 'my.table' }),
        encode('pk.col'),
        5n,
      ])
      .toSQL();
    expect(compiledDelete.sql).toBe('DELETE FROM `db`.`my.table` WHERE `pk.col` = ? LIMIT 2');
    expect(compiledDelete.bindings).toEqual([5n]);
  });

  it('keeps names verbatim in schema-builder DDL', () => {
    const compiledCreateTable = compileOnlyMySqlKnex.schema
      .withSchema(encode('my.db'))
      .createTable(encode('Company.io Deals'), (tableBuilder) => {
        tableBuilder.string(encode('Dealroom.co URL'));
        tableBuilder.string(encode('Certified AS Organic'));
      })
      .toSQL();
    expect(compiledCreateTable[0].sql).toBe(
      'create table `my.db`.`Company.io Deals` (`Dealroom.co URL` varchar(255), `Certified AS Organic` varchar(255))',
    );
  });
});

describe('encodeMySqlColumnKeysForKnex', () => {
  it('encodes every key and leaves the values untouched', () => {
    const jsonDocumentValue = { nested: { a: 1 } };
    const encodedRecord = encodeMySqlColumnKeysForKnex({ 'a.b': 1, 'Certified AS Organic': jsonDocumentValue });
    expect(Object.keys(encodedRecord)).toEqual([encode('a.b'), encode('Certified AS Organic')]);
    expect(encodedRecord[encode('Certified AS Organic')]).toBe(jsonDocumentValue);
  });

  it('compiles verbatim column names in INSERT and UPDATE', () => {
    const table = qualifiedMySqlTableReferenceForKnex({ databaseName: 'db', tableName: 't' });
    const compiledInsert = compileOnlyMySqlKnex(table)
      .insert(encodeMySqlColumnKeysForKnex({ 'a.b': 1, 'Featured?': 'yes' }))
      .toSQL();
    // knex sorts insert columns by key.
    expect(compiledInsert.sql).toBe('insert into `db`.`t` (`Featured?`, `a.b`) values (?, ?)');
    expect(compiledInsert.bindings).toEqual(['yes', 1]);

    const compiledUpdate = compileOnlyMySqlKnex(table)
      .update(encodeMySqlColumnKeysForKnex({ 'Marked as done': 1 }))
      // knex's `Value` type predates bigint; knex passes the BigInt binding to mysql2 unchanged.
      .where(encode('id'), 9007199254740993n as unknown as number)
      .limit(2)
      .toSQL();
    expect(compiledUpdate.sql).toBe('update `db`.`t` set `Marked as done` = ? where `id` = ? limit ?');
    expect(compiledUpdate.bindings).toEqual([1, 9007199254740993n, 2]);
  });
});

describe('rejoinKnexAliasSplitMySqlIdentifier', () => {
  it('rejoins two backtick-quoted halves into one backtick-quoted identifier', () => {
    expect(rejoinKnexAliasSplitMySqlIdentifier('`Certified`', '`Organic`')).toBe('`Certified as Organic`');
  });

  it('un-doubles and re-doubles embedded backticks', () => {
    expect(rejoinKnexAliasSplitMySqlIdentifier('`a``b`', '`c`')).toBe('`a``b as c`');
  });

  it('is the fallback knex uses for an identifier that skipped the encoding: backticks, never double quotes', () => {
    const compiledSelect = compileOnlyMySqlKnex('t').select('Certified AS Organic').toSQL();
    // The separator's casing is already lost when the fallback runs; the name stays ONE identifier.
    expect(compiledSelect.sql).toBe('select `Certified as Organic` from `t`');
    expect(compiledSelect.sql).not.toContain('"');
  });
});

describe('applyMySqlVerbatimIdentifierQuoting', () => {
  it('installs the decode hook on client.config, the part knex copies into transactions', () => {
    const freshMySqlKnex: Knex = knex({ client: ScratchMySql2KnexDialectClient });
    try {
      const knexClientConfig = (freshMySqlKnex.client as { config: { wrapIdentifier?: unknown } }).config;
      expect(knexClientConfig.wrapIdentifier).toBeUndefined();
      applyMySqlVerbatimIdentifierQuoting(freshMySqlKnex);
      expect(typeof knexClientConfig.wrapIdentifier).toBe('function');
    } finally {
      void freshMySqlKnex.destroy();
    }
  });
});
