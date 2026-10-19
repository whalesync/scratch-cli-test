/**
 * Unit tests for the MySQL record writes, without a database.
 *
 * The knex instance is REAL (the connector's mysql2 dialect + verbatim identifier quoting), so every assertion
 * below is on the SQL and bindings knex actually compiles, and results go through knex's own MySQL response
 * handling (`insert` → `[insertId]`, `update` → affectedRows, `raw` → `[rows, fields]`). Only the driver boundary
 * is scripted: a dialect subclass whose `_query` records each statement (and whether it ran on a transaction
 * client) and answers it from the test's script. Overrides live on the subclass prototype because knex builds a
 * transaction's client with `Object.create(client.constructor.prototype)`.
 */
import { ConnectorErrorCode } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import { WSLogger } from 'src/logger';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import { applyMySqlVerbatimIdentifierQuoting } from '../mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from '../mysql-knex-dialect-client';
import {
  assertMySqlTableAcceptsCreates,
  assertMySqlTableAcceptsWrites,
  buildMySqlDeleteByPrimaryKeyStatement,
  deleteRecordsByPrimaryKey,
  insertRecordsReturningPersistedRows,
  MYSQL_TABLE_WRITE_PRECONDITIONS_SQL,
  readMySqlInsertIdText,
  updateRecordsByPrimaryKeyReturningPersistedRows,
  type MySqlRecordWriteTarget,
} from '../mysql-record-writes';

interface ExecutedMySqlStatement {
  sql: string;
  bindings: unknown[];
  /** knex's query method: `select` / `insert` / `update` / `raw`; undefined for BEGIN / COMMIT / ROLLBACK. */
  method: string | undefined;
  ranOnTransactionClient: boolean;
}

/** What mysql2 hands knex: `[rows, fields]` for a SELECT, `[ResultSetHeader, undefined]` for DML. */
type MySqlDriverResponse = [unknown, unknown];

const executedStatements: ExecutedMySqlStatement[] = [];
let answerStatement: (statement: ExecutedMySqlStatement) => MySqlDriverResponse = () => {
  throw new Error('no statement script installed');
};

const fakeDriverConnection = { threadId: 1 };

class ScriptedMySqlKnexDialectClient extends ScratchMySql2KnexDialectClient {
  acquireConnection(): Promise<unknown> {
    return Promise.resolve(fakeDriverConnection);
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  _query(
    _connection: unknown,
    queryObject: { sql: string; bindings?: unknown[]; method?: string; response?: MySqlDriverResponse },
  ): Promise<unknown> {
    const executedStatement: ExecutedMySqlStatement = {
      sql: queryObject.sql,
      bindings: queryObject.bindings ?? [],
      method: queryObject.method,
      ranOnTransactionClient: (this as unknown as { transacting?: boolean }).transacting === true,
    };
    executedStatements.push(executedStatement);
    try {
      queryObject.response = answerStatement(executedStatement);
    } catch (driverError) {
      return Promise.reject(driverError instanceof Error ? driverError : new Error(String(driverError)));
    }
    return Promise.resolve(queryObject);
  }
}

function createScriptedKnex(): Knex {
  const scriptedKnex = knex({ client: ScriptedMySqlKnexDialectClient });
  applyMySqlVerbatimIdentifierQuoting(scriptedKnex);
  return scriptedKnex;
}

const TRANSACTION_CONTROL_STATEMENTS = new Set(['BEGIN;', 'COMMIT;', 'ROLLBACK']);

/** A statement script: queues of answers per statement kind, consumed in order. */
interface MySqlStatementScript {
  preconditionRows?: Record<string, unknown>[];
  insertIds?: unknown[];
  selectRowBatches?: Record<string, unknown>[][];
  updateMatchedRowCounts?: number[];
  deleteAffectedRowCounts?: number[];
}

function installStatementScript(script: MySqlStatementScript): void {
  const insertIds = [...(script.insertIds ?? [])];
  const selectRowBatches = [...(script.selectRowBatches ?? [])];
  const updateMatchedRowCounts = [...(script.updateMatchedRowCounts ?? [])];
  const deleteAffectedRowCounts = [...(script.deleteAffectedRowCounts ?? [])];
  const takeNext = <T>(queue: T[], statement: ExecutedMySqlStatement): T => {
    if (queue.length === 0) throw new Error(`unscripted statement: ${statement.sql}`);
    return queue.shift() as T;
  };
  answerStatement = (statement) => {
    if (TRANSACTION_CONTROL_STATEMENTS.has(statement.sql)) return [{ affectedRows: 0 }, undefined];
    if (statement.sql === MYSQL_TABLE_WRITE_PRECONDITIONS_SQL) {
      return [script.preconditionRows ?? [{ storage_engine: 'InnoDB', auto_increment_column_name: 'id' }], []];
    }
    switch (statement.method) {
      case 'insert':
        return [{ insertId: takeNext(insertIds, statement), affectedRows: 1 }, undefined];
      case 'select':
        return [takeNext(selectRowBatches, statement), []];
      case 'update':
        return [{ affectedRows: takeNext(updateMatchedRowCounts, statement) }, undefined];
      case 'raw':
        if (statement.sql.startsWith('DELETE FROM')) {
          return [{ affectedRows: takeNext(deleteAffectedRowCounts, statement) }, undefined];
        }
        throw new Error(`unscripted raw statement: ${statement.sql}`);
      default:
        throw new Error(`unscripted statement: ${statement.sql}`);
    }
  };
}

/** The statements that aren't BEGIN / COMMIT / ROLLBACK. */
function dataStatements(): ExecutedMySqlStatement[] {
  return executedStatements.filter((statement) => !TRANSACTION_CONTROL_STATEMENTS.has(statement.sql));
}

function transactionControlStatements(): string[] {
  return executedStatements
    .filter((statement) => TRANSACTION_CONTROL_STATEMENTS.has(statement.sql))
    .map((statement) => statement.sql);
}

function captureSynchronousThrow(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
}

async function captureRejection(pendingOperation: Promise<unknown>): Promise<unknown> {
  try {
    await pendingOperation;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to reject');
}

const DEALS_TARGET: MySqlRecordWriteTarget = {
  databaseName: 'test_db',
  tableName: 'deals',
  primaryKeyColumnName: 'id',
  primaryKeyBindingKind: 'integer',
  readBackColumnNames: ['id', 'title', 'updated_at'],
};

const PRECONDITION_BINDINGS_FOR_DEALS = ['test_db', 'deals'];

describe('MySQL record writes', () => {
  let scriptedKnex: Knex;

  beforeEach(() => {
    executedStatements.length = 0;
    scriptedKnex = createScriptedKnex();
  });

  afterEach(async () => {
    await scriptedKnex.destroy();
  });

  describe('insertRecordsReturningPersistedRows', () => {
    it('runs preflight, row-by-row inserts without the id, then one read-back — all in one transaction', async () => {
      installStatementScript({
        insertIds: [41, 42],
        selectRowBatches: [
          [
            { id: 42, title: 'second', updated_at: '2026-01-01 00:00:00' },
            { id: 41, title: 'first', updated_at: '2026-01-01 00:00:00' },
          ],
        ],
      });

      const persistedRows = await insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
        { id: 'scratch_pending_publish_1', title: 'first' },
        { title: 'second' },
      ]);

      // Aligned to the input order even though MySQL returned the rows in another order.
      expect(persistedRows).toEqual([
        { id: 41, title: 'first', updated_at: '2026-01-01 00:00:00' },
        { id: 42, title: 'second', updated_at: '2026-01-01 00:00:00' },
      ]);
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'COMMIT;']);
      expect(executedStatements[0].sql).toBe('BEGIN;');
      expect(executedStatements[executedStatements.length - 1].sql).toBe('COMMIT;');
      expect(dataStatements().map(({ sql, bindings }) => ({ sql, bindings }))).toEqual([
        { sql: MYSQL_TABLE_WRITE_PRECONDITIONS_SQL, bindings: PRECONDITION_BINDINGS_FOR_DEALS },
        { sql: 'insert into `test_db`.`deals` (`title`) values (?)', bindings: ['first'] },
        { sql: 'insert into `test_db`.`deals` (`title`) values (?)', bindings: ['second'] },
        {
          sql: 'select `id`, `title`, `updated_at` from `test_db`.`deals` where `id` in (?, ?)',
          bindings: [41n, 42n],
        },
      ]);
      expect(dataStatements().every((statement) => statement.ranOnTransactionClient)).toBe(true);
    });

    it('re-selects an insertId at or above 2^53 (a string from mysql2) as an exact BigInt', async () => {
      installStatementScript({
        insertIds: ['9007199254740993'],
        selectRowBatches: [[{ id: '9007199254740993', title: 'big' }]],
      });

      const persistedRows = await insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{ title: 'big' }]);

      expect(persistedRows).toEqual([{ id: '9007199254740993', title: 'big' }]);
      expect(dataStatements()[2].bindings).toEqual([9007199254740993n]);
    });

    it('keeps verbatim identifiers (dots, ` as `, `?`, backticks) intact inside the transaction', async () => {
      installStatementScript({
        preconditionRows: [{ storage_engine: 'InnoDB', auto_increment_column_name: 'Deal id' }],
        insertIds: [1],
        selectRowBatches: [[{ 'Deal id': 1, 'Featured?': 'yes' }]],
      });
      const verbatimTarget: MySqlRecordWriteTarget = {
        databaseName: 'my.db',
        tableName: 'Company.io Deals',
        primaryKeyColumnName: 'Deal id',
        primaryKeyBindingKind: 'integer',
        readBackColumnNames: ['Featured?', 'Marked as done time', 'a`b'],
      };

      await insertRecordsReturningPersistedRows(scriptedKnex, verbatimTarget, [
        { 'Featured?': 'yes', 'Marked as done time': null, 'a`b': 'x' },
      ]);

      expect(dataStatements()[0].bindings).toEqual(['my.db', 'Company.io Deals']);
      expect(dataStatements()[1].sql).toBe(
        'insert into `my.db`.`Company.io Deals` (`Featured?`, `Marked as done time`, `a``b`) values (?, ?, ?)',
      );
      // The id is appended to the read-back list when the pull's column list lacks it.
      expect(dataStatements()[2].sql).toBe(
        'select `Featured?`, `Marked as done time`, `a``b`, `Deal id` from `my.db`.`Company.io Deals` where `Deal id` in (?)',
      );
    });

    it('inserts an all-default row as `() values ()`', async () => {
      installStatementScript({ insertIds: [7], selectRowBatches: [[{ id: 7 }]] });

      await insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{}]);

      expect(dataStatements()[1].sql).toBe('insert into `test_db`.`deals` () values ()');
    });

    it('accepts an AUTO_INCREMENT column whose name differs from the id only in case', async () => {
      installStatementScript({
        preconditionRows: [{ storage_engine: 'innodb', auto_increment_column_name: 'ID' }],
        insertIds: [3],
        selectRowBatches: [[{ id: 3 }]],
      });

      await expect(insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{}])).resolves.toEqual([{ id: 3 }]);
    });

    it.each([[0], ['0'], ['abc'], [null], [undefined], [2 ** 53 + 2]])(
      'fails with InsertIdMissing and rolls back when insertId is %p',
      async (insertIdFromDriver) => {
        installStatementScript({ insertIds: [insertIdFromDriver] });

        const rejection = await captureRejection(
          insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{ title: 'x' }]),
        );

        expect(rejection).toBeInstanceOf(MySqlClientError);
        expect(rejection).toMatchObject({ problem: MySqlClientProblem.InsertIdMissing });
        expect(transactionControlStatements()).toEqual(['BEGIN;', 'ROLLBACK']);
        expect(dataStatements().some((statement) => statement.method === 'select')).toBe(false);
      },
    );

    it('fails with CreateRequiresAutoIncrementId before any insert when the AUTO_INCREMENT column is not the id', async () => {
      installStatementScript({
        preconditionRows: [{ storage_engine: 'InnoDB', auto_increment_column_name: 'row_number' }],
      });
      const emailKeyedTarget: MySqlRecordWriteTarget = { ...DEALS_TARGET, primaryKeyColumnName: 'email' };

      const rejection = await captureRejection(
        insertRecordsReturningPersistedRows(scriptedKnex, emailKeyedTarget, [{ title: 'x' }]),
      );

      expect(rejection).toMatchObject({
        problem: MySqlClientProblem.CreateRequiresAutoIncrementId,
        userFriendlyMessage:
          'Can\'t create rows in "test_db"."deals": its id column "email" isn\'t generated by MySQL. Use the AUTO_INCREMENT column "row_number" as the folder\'s id field to create rows.',
      });
      expect(dataStatements()).toHaveLength(1);
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'ROLLBACK']);
    });

    it('fails with CreateRequiresAutoIncrementId when the table has no AUTO_INCREMENT column', async () => {
      installStatementScript({ preconditionRows: [{ storage_engine: 'InnoDB', auto_increment_column_name: null }] });

      await expect(
        insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{ title: 'x' }]),
      ).rejects.toMatchObject({ problem: MySqlClientProblem.CreateRequiresAutoIncrementId });
      expect(dataStatements()).toHaveLength(1);
    });

    it('fails with UnsupportedStorageEngine before any DML on a MyISAM table', async () => {
      installStatementScript({ preconditionRows: [{ storage_engine: 'MyISAM', auto_increment_column_name: 'id' }] });

      const rejection = await captureRejection(
        insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{ title: 'x' }]),
      );

      expect(rejection).toMatchObject({
        problem: MySqlClientProblem.UnsupportedStorageEngine,
        userFriendlyMessage:
          'Can\'t write to "test_db"."deals": it uses the MyISAM storage engine, which can\'t roll back a partly-applied write. Convert it to InnoDB to edit it from Scratch.',
      });
      expect(dataStatements()).toHaveLength(1);
    });

    it('fails with TableNotFound when the preflight finds no table', async () => {
      installStatementScript({ preconditionRows: [] });

      await expect(
        insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{ title: 'x' }]),
      ).rejects.toMatchObject({ problem: MySqlClientProblem.TableNotFound });
      expect(dataStatements()).toHaveLength(1);
    });

    it('fails with InsertCountMismatch and rolls back when a new row cannot be read back', async () => {
      installStatementScript({ insertIds: [1, 2], selectRowBatches: [[{ id: 1, title: 'a' }]] });

      await expect(
        insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [{ title: 'a' }, { title: 'b' }]),
      ).rejects.toMatchObject({ problem: MySqlClientProblem.InsertCountMismatch });
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'ROLLBACK']);
    });

    it('runs no statement at all for an empty batch', async () => {
      await expect(insertRecordsReturningPersistedRows(scriptedKnex, DEALS_TARGET, [])).resolves.toEqual([]);
      expect(executedStatements).toHaveLength(0);
    });
  });

  describe('updateRecordsByPrimaryKeyReturningPersistedRows', () => {
    it('runs `UPDATE … WHERE pk = ? LIMIT 2` per record with a BigInt id, then reads the rows back aligned', async () => {
      installStatementScript({
        updateMatchedRowCounts: [1, 1],
        selectRowBatches: [
          [
            { id: '9007199254740993', title: 'b' },
            { id: 12, title: 'a' },
          ],
        ],
      });

      const persistedRows = await updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
        { recordId: '12', changedColumnValues: { title: 'a', id: 999 } },
        { recordId: '9007199254740993', changedColumnValues: { title: 'b' } },
      ]);

      expect(persistedRows).toEqual([
        { id: 12, title: 'a' },
        { id: '9007199254740993', title: 'b' },
      ]);
      expect(dataStatements().map(({ sql, bindings }) => ({ sql, bindings }))).toEqual([
        { sql: MYSQL_TABLE_WRITE_PRECONDITIONS_SQL, bindings: PRECONDITION_BINDINGS_FOR_DEALS },
        // The id in the change set is never written (it addresses the row).
        { sql: 'update `test_db`.`deals` set `title` = ? where `id` = ? limit ?', bindings: ['a', 12n, 2] },
        {
          sql: 'update `test_db`.`deals` set `title` = ? where `id` = ? limit ?',
          bindings: ['b', 9007199254740993n, 2],
        },
        {
          sql: 'select `id`, `title`, `updated_at` from `test_db`.`deals` where `id` in (?, ?)',
          bindings: [12n, 9007199254740993n],
        },
      ]);
      expect(dataStatements().every((statement) => statement.ranOnTransactionClient)).toBe(true);
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'COMMIT;']);
    });

    it('fails with UpdateMatchedMultipleRows and rolls the whole batch back when an id matches two rows', async () => {
      installStatementScript({ updateMatchedRowCounts: [1, 2] });

      const rejection = await captureRejection(
        updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
          { recordId: 1, changedColumnValues: { title: 'a' } },
          { recordId: 2, changedColumnValues: { title: 'b' } },
        ]),
      );

      expect(rejection).toBeInstanceOf(MySqlClientError);
      expect(rejection).toMatchObject({ problem: MySqlClientProblem.UpdateMatchedMultipleRows });
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'ROLLBACK']);
      expect(dataStatements().some((statement) => statement.method === 'select')).toBe(false);
    });

    it('fails with RecordNotFound carrying RemoteRecordNotFound (and rolls back) when a row is gone', async () => {
      installStatementScript({ updateMatchedRowCounts: [1, 0] });

      const rejection = await captureRejection(
        updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
          { recordId: 1, changedColumnValues: { title: 'a' } },
          { recordId: 2, changedColumnValues: { title: 'b' } },
        ]),
      );

      expect(rejection).toMatchObject({
        problem: MySqlClientProblem.RecordNotFound,
        errorCode: ConnectorErrorCode.RemoteRecordNotFound,
        userFriendlyMessage:
          'The row this record points to doesn\'t exist in "test_db"."deals": no row has this "id" any more (it was deleted, or its id changed, in MySQL since the last pull). Nothing in this batch was changed.',
      });
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'ROLLBACK']);
    });

    it("fails with RecordNotFound without sending an UPDATE when the id can't match any row ('12abc')", async () => {
      installStatementScript({});

      const rejection = await captureRejection(
        updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
          { recordId: '12abc', changedColumnValues: { title: 'a' } },
        ]),
      );

      expect(rejection).toMatchObject({
        problem: MySqlClientProblem.RecordNotFound,
        errorCode: ConnectorErrorCode.RemoteRecordNotFound,
      });
      expect((rejection as MySqlClientError).userFriendlyMessage).toContain('isn\'t a valid "id" value');
      expect(dataStatements().some((statement) => statement.method === 'update')).toBe(false);
    });

    it('sends no UPDATE for an empty change set and reads the current row back with the guarded per-row select', async () => {
      installStatementScript({ selectRowBatches: [[{ id: 5, title: 'unchanged' }]] });

      const persistedRows = await updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
        { recordId: 5, changedColumnValues: {} },
      ]);

      expect(persistedRows).toEqual([{ id: 5, title: 'unchanged' }]);
      expect(dataStatements().map(({ sql, bindings }) => ({ sql, bindings }))).toEqual([
        { sql: MYSQL_TABLE_WRITE_PRECONDITIONS_SQL, bindings: PRECONDITION_BINDINGS_FOR_DEALS },
        {
          sql: 'select `id`, `title`, `updated_at` from `test_db`.`deals` where `id` = ? limit ?',
          bindings: [5n, 2],
        },
      ]);
    });

    it('fails with RecordNotFound for an empty change set whose row is gone', async () => {
      installStatementScript({ selectRowBatches: [[]] });

      await expect(
        updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
          { recordId: 5, changedColumnValues: {} },
        ]),
      ).rejects.toMatchObject({
        problem: MySqlClientProblem.RecordNotFound,
        errorCode: ConnectorErrorCode.RemoteRecordNotFound,
      });
    });

    it('fails with UpdateMatchedMultipleRows for an empty change set whose id matches two rows', async () => {
      installStatementScript({ selectRowBatches: [[{ id: 5 }, { id: 5 }]] });

      await expect(
        updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
          { recordId: 5, changedColumnValues: {} },
        ]),
      ).rejects.toMatchObject({ problem: MySqlClientProblem.UpdateMatchedMultipleRows });
    });

    it('falls back to a per-row select for a text id MySQL matched through collation folding (abc → ABC)', async () => {
      const textKeyedTarget: MySqlRecordWriteTarget = {
        databaseName: 'test_db',
        tableName: 'codes',
        primaryKeyColumnName: 'code',
        primaryKeyBindingKind: 'text',
        readBackColumnNames: ['code', 'note'],
      };
      installStatementScript({
        preconditionRows: [{ storage_engine: 'InnoDB', auto_increment_column_name: null }],
        updateMatchedRowCounts: [1],
        selectRowBatches: [[{ code: 'ABC', note: 'folded' }], [{ code: 'ABC', note: 'folded' }]],
      });

      const persistedRows = await updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, textKeyedTarget, [
        { recordId: 'abc', changedColumnValues: { note: 'folded' } },
      ]);

      expect(persistedRows).toEqual([{ code: 'ABC', note: 'folded' }]);
      expect(
        dataStatements()
          .slice(1)
          .map(({ sql, bindings }) => ({ sql, bindings })),
      ).toEqual([
        { sql: 'update `test_db`.`codes` set `note` = ? where `code` = ? limit ?', bindings: ['folded', 'abc', 2] },
        { sql: 'select `code`, `note` from `test_db`.`codes` where `code` in (?)', bindings: ['abc'] },
        { sql: 'select `code`, `note` from `test_db`.`codes` where `code` = ? limit ?', bindings: ['abc', 2] },
      ]);
    });

    it('binds a base64 binary id as the exact bytes and aligns the base64 read-back', async () => {
      const binaryKeyedTarget: MySqlRecordWriteTarget = {
        databaseName: 'test_db',
        tableName: 'devices',
        primaryKeyColumnName: 'uuid_bytes',
        primaryKeyBindingKind: 'base64Binary',
        readBackColumnNames: ['uuid_bytes', 'name'],
      };
      const pulledBase64Id = 'ABEiM0RVZneImaq7zN3u/w==';
      installStatementScript({
        preconditionRows: [{ storage_engine: 'InnoDB', auto_increment_column_name: null }],
        updateMatchedRowCounts: [1],
        selectRowBatches: [[{ uuid_bytes: pulledBase64Id, name: 'renamed' }]],
      });

      const persistedRows = await updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, binaryKeyedTarget, [
        { recordId: pulledBase64Id, changedColumnValues: { name: 'renamed' } },
      ]);

      expect(persistedRows).toEqual([{ uuid_bytes: pulledBase64Id, name: 'renamed' }]);
      expect(dataStatements()[1].bindings).toEqual(['renamed', Buffer.from(pulledBase64Id, 'base64'), 2]);
      expect(dataStatements()).toHaveLength(3);
    });

    it('fails with UnsupportedStorageEngine before any UPDATE on a MyISAM table', async () => {
      installStatementScript({ preconditionRows: [{ storage_engine: 'MyISAM', auto_increment_column_name: 'id' }] });

      await expect(
        updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [
          { recordId: 1, changedColumnValues: { title: 'a' } },
        ]),
      ).rejects.toMatchObject({ problem: MySqlClientProblem.UnsupportedStorageEngine });
      expect(dataStatements()).toHaveLength(1);
    });

    it('runs no statement at all for an empty batch', async () => {
      await expect(updateRecordsByPrimaryKeyReturningPersistedRows(scriptedKnex, DEALS_TARGET, [])).resolves.toEqual(
        [],
      );
      expect(executedStatements).toHaveLength(0);
    });
  });

  describe('deleteRecordsByPrimaryKey', () => {
    it('deletes each id with a raw `DELETE … LIMIT 2` (knex drops .limit() on del) and tolerates gone rows', async () => {
      installStatementScript({ deleteAffectedRowCounts: [1, 0] });

      await expect(deleteRecordsByPrimaryKey(scriptedKnex, DEALS_TARGET, ['12', 9007199254740991])).resolves.toEqual({
        deletedRowCount: 1,
      });

      expect(dataStatements().map(({ sql, bindings, method }) => ({ sql, bindings, method }))).toEqual([
        { sql: MYSQL_TABLE_WRITE_PRECONDITIONS_SQL, bindings: PRECONDITION_BINDINGS_FOR_DEALS, method: 'raw' },
        { sql: 'DELETE FROM `test_db`.`deals` WHERE `id` = ? LIMIT 2', bindings: [12n], method: 'raw' },
        { sql: 'DELETE FROM `test_db`.`deals` WHERE `id` = ? LIMIT 2', bindings: [9007199254740991n], method: 'raw' },
      ]);
      expect(dataStatements().every((statement) => statement.ranOnTransactionClient)).toBe(true);
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'COMMIT;']);
    });

    it('fails with DeleteMatchedMultipleRows and rolls back when an id matches two rows', async () => {
      installStatementScript({ deleteAffectedRowCounts: [1, 2] });

      const rejection = await captureRejection(deleteRecordsByPrimaryKey(scriptedKnex, DEALS_TARGET, [1, 2]));

      expect(rejection).toBeInstanceOf(MySqlClientError);
      expect(rejection).toMatchObject({ problem: MySqlClientProblem.DeleteMatchedMultipleRows });
      expect(transactionControlStatements()).toEqual(['BEGIN;', 'ROLLBACK']);
    });

    it("skips ids that can't match any row (and logs how many) instead of sending them", async () => {
      const warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
      installStatementScript({ deleteAffectedRowCounts: [1] });

      await expect(deleteRecordsByPrimaryKey(scriptedKnex, DEALS_TARGET, ['12abc', 3, null])).resolves.toEqual({
        deletedRowCount: 1,
      });

      expect(dataStatements().filter((statement) => statement.sql.startsWith('DELETE'))).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ unmatchableRecordIdCount: 2 }));
      warnSpy.mockRestore();
    });

    it('fails with UnsupportedStorageEngine before any DELETE on a MyISAM table', async () => {
      installStatementScript({ preconditionRows: [{ storage_engine: 'MyISAM', auto_increment_column_name: 'id' }] });

      await expect(deleteRecordsByPrimaryKey(scriptedKnex, DEALS_TARGET, [1])).rejects.toMatchObject({
        problem: MySqlClientProblem.UnsupportedStorageEngine,
      });
      expect(dataStatements()).toHaveLength(1);
    });

    it('runs no statement at all for an empty batch', async () => {
      await expect(deleteRecordsByPrimaryKey(scriptedKnex, DEALS_TARGET, [])).resolves.toEqual({ deletedRowCount: 0 });
      expect(executedStatements).toHaveLength(0);
    });
  });
});

describe('buildMySqlDeleteByPrimaryKeyStatement', () => {
  it('compiles to one backtick-quoted DELETE with verbatim identifiers and the id as the only value binding', () => {
    const compileOnlyKnex = knex({ client: ScratchMySql2KnexDialectClient });
    applyMySqlVerbatimIdentifierQuoting(compileOnlyKnex);
    const deleteStatement = buildMySqlDeleteByPrimaryKeyStatement(
      { ...DEALS_TARGET, databaseName: 'my.db', tableName: 'Company.io Deals', primaryKeyColumnName: 'id as x' },
      Buffer.from('ab'),
    );

    const compiledDelete = compileOnlyKnex.raw(deleteStatement.sql, deleteStatement.bindings).toSQL();

    expect(compiledDelete.sql).toBe('DELETE FROM `my.db`.`Company.io Deals` WHERE `id as x` = ? LIMIT 2');
    expect(compiledDelete.bindings).toEqual([Buffer.from('ab')]);
  });
});

describe('assertMySqlTableAcceptsWrites', () => {
  const dealsTable = { databaseName: 'test_db', tableName: 'deals' };

  it('returns the engine and AUTO_INCREMENT column (catalog Buffers decoded as UTF-8)', () => {
    expect(
      assertMySqlTableAcceptsWrites(dealsTable, [
        { storage_engine: Buffer.from('InnoDB'), auto_increment_column_name: 'id' },
      ]),
    ).toEqual({ storageEngine: 'InnoDB', autoIncrementColumnName: 'id' });
  });

  it('treats a NULL engine (a view) as unable to take writes', () => {
    expect(
      captureSynchronousThrow(() =>
        assertMySqlTableAcceptsWrites(dealsTable, [{ storage_engine: null, auto_increment_column_name: null }]),
      ),
    ).toMatchObject({ problem: MySqlClientProblem.UnsupportedStorageEngine });
  });

  it('reports a missing table as TableNotFound', () => {
    expect(() => assertMySqlTableAcceptsWrites(dealsTable, [])).toThrow(
      'Can\'t write to "test_db"."deals": the table doesn\'t exist in MySQL any more (was it renamed or dropped?).',
    );
  });
});

describe('assertMySqlTableAcceptsCreates', () => {
  it('passes when the id column is the AUTO_INCREMENT column', () => {
    expect(() =>
      assertMySqlTableAcceptsCreates(DEALS_TARGET, { storageEngine: 'InnoDB', autoIncrementColumnName: 'id' }),
    ).not.toThrow();
  });
});

describe('readMySqlInsertIdText', () => {
  const dealsTable = { databaseName: 'test_db', tableName: 'deals' };

  it('reads numbers below 2^53 and strings at or above it', () => {
    expect(readMySqlInsertIdText(41, dealsTable)).toBe('41');
    expect(readMySqlInsertIdText('18446744073709551615', dealsTable)).toBe('18446744073709551615');
  });

  it('rejects a zero, negative or non-integer id', () => {
    for (const insertIdFromDriver of [0, '0', '000', -1, '-1', 1.5, '12abc', null, undefined]) {
      expect(captureSynchronousThrow(() => readMySqlInsertIdText(insertIdFromDriver, dealsTable))).toMatchObject({
        problem: MySqlClientProblem.InsertIdMissing,
      });
    }
  });
});
