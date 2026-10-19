/**
 * Record creates, updates and deletes against one MySQL table, with the guards that make them safe.
 *
 * Rules shared by all three operations:
 * - Every statement of one call runs inside ONE `knex.transaction` and uses only `trx`. The client's pool holds a
 *   single connection (`knex-mysql-client.ts`), so touching `knex` itself inside the callback would wait for a
 *   connection the transaction already holds (a 30s acquire timeout, then a failed publish).
 * - Every identifier (database, table, column) is sentinel-encoded (`mysql-identifier-quoting.ts`): knex copies
 *   only `config` into a transaction client, so the instance-level alias fallback is inert inside `trx`.
 * - The first statement is a preflight against `information_schema`: a missing table or a storage engine that
 *   can't roll back (MyISAM, MEMORY, ...) fails the call BEFORE any DML. The multi-row guards below (`LIMIT 2`,
 *   then roll back) and `STRICT_TRANS_TABLES` (which rejects bad values only on transactional tables) are only
 *   sound on InnoDB, and a table's engine can change after it was listed.
 * - Record ids are bound per `mysql-id-binding.ts` (integer keys as BigInt: MySQL converts a string constant
 *   compared with an integer column loosely, so `'12abc'` would hit row 12).
 * - Rows are read back with an explicit column list (never `*`, which drops INVISIBLE columns such as the GIPK
 *   id) inside the same transaction, so trigger / DEFAULT / `ON UPDATE CURRENT_TIMESTAMP` values come back. The
 *   pool's typeCast decodes them exactly like a pull.
 * - A throw rolls the whole batch back. The publish runner then retries the batch one record at a time
 *   (`publish-plan-run.service.ts`), so only the offending record fails.
 */
import { ConnectorErrorCode } from '@spinner/shared-types';
import { type Knex } from 'knex';
import { WSLogger } from 'src/logger';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';
import {
  canonicalMySqlPrimaryKeyText,
  toBindableMySqlPrimaryKeyValue,
  type BindableMySqlPrimaryKeyValue,
  type MySqlPrimaryKeyBindingKind,
} from './mysql-id-binding';
import {
  encodeMySqlColumnKeysForKnex,
  encodeMySqlIdentifierForKnex,
  qualifiedMySqlTableReferenceForKnex,
} from './mysql-identifier-quoting';
import { isStorageEngineSafeForScratchWrites, unsupportedStorageEngineWriteMessage } from './mysql-table-writability';
import { type MySqlTableReference } from './mysql-types';

/** The table a write targets, how its records are addressed, and the columns read back after the write. */
export interface MySqlRecordWriteTarget extends MySqlTableReference {
  primaryKeyColumnName: string;
  primaryKeyBindingKind: MySqlPrimaryKeyBindingKind;
  /** Exactly the columns a pull selects (the id is added when missing). Never `*`. */
  readBackColumnNames: string[];
}

/** One record's UPDATE: which row (its pulled id) and the column values to write (already prepared). */
export interface MySqlRecordUpdateChangeSet {
  recordId: unknown;
  changedColumnValues: Record<string, unknown>;
}

/** An id value in the shape the write statements bind (see `mysql-id-binding.ts`). */
export type BindableMySqlPrimaryKeyValueForWrite = Extract<
  BindableMySqlPrimaryKeyValue,
  { isMatchable: true }
>['bindableValue'];

/**
 * `UPDATE … LIMIT 2` / `DELETE … LIMIT 2`: a record id must address exactly one row. A second matched row proves
 * the id column isn't unique (e.g. a fallback id path on a table whose unique index was dropped), and the
 * transaction is rolled back instead of editing or deleting sibling rows. The limit also bounds the damage the
 * statement itself can do before the rollback.
 */
export const MYSQL_ROWS_MATCHED_BY_ONE_RECORD_ID_LIMIT = 2;

/**
 * The write preflight: the table's storage engine and its AUTO_INCREMENT column (if any), in one round trip. No
 * row = the table doesn't exist (or isn't visible to this user).
 */
export const MYSQL_TABLE_WRITE_PRECONDITIONS_SQL = `SELECT t.ENGINE AS storage_engine,
       (SELECT c.COLUMN_NAME FROM information_schema.COLUMNS AS c
         WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
           AND LOWER(c.EXTRA) LIKE '%auto_increment%' LIMIT 1) AS auto_increment_column_name
FROM information_schema.TABLES AS t
WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ?`;

export interface MySqlTableWritePreconditions {
  /** `InnoDB`, `MyISAM`, ...; null for views. */
  storageEngine: string | null;
  autoIncrementColumnName: string | null;
}

function describeMySqlTableForMessages(table: MySqlTableReference): string {
  return `"${table.databaseName}"."${table.tableName}"`;
}

function readNullableCatalogText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return null;
}

/**
 * Interpret the preflight rows: throws TableNotFound (no row) or UnsupportedStorageEngine (engine that can't roll
 * back), otherwise returns the table's preconditions. Pure.
 */
export function assertMySqlTableAcceptsWrites(
  table: MySqlTableReference,
  preconditionRows: readonly Record<string, unknown>[],
): MySqlTableWritePreconditions {
  const preconditionRow = preconditionRows[0];
  if (preconditionRow === undefined) {
    throw new MySqlClientError(
      MySqlClientProblem.TableNotFound,
      `Can't write to ${describeMySqlTableForMessages(table)}: the table doesn't exist in MySQL any more (was it renamed or dropped?).`,
    );
  }
  const tableWritePreconditions: MySqlTableWritePreconditions = {
    storageEngine: readNullableCatalogText(preconditionRow.storage_engine),
    autoIncrementColumnName: readNullableCatalogText(preconditionRow.auto_increment_column_name),
  };
  if (!isStorageEngineSafeForScratchWrites(tableWritePreconditions.storageEngine)) {
    throw new MySqlClientError(
      MySqlClientProblem.UnsupportedStorageEngine,
      unsupportedStorageEngineWriteMessage(table, tableWritePreconditions.storageEngine),
    );
  }
  return tableWritePreconditions;
}

/**
 * Creates need MySQL to generate the id, because MySQL has no `INSERT … RETURNING`: the only way to find the new
 * row again is `insertId`, which reports the AUTO_INCREMENT value. So the id column must BE the AUTO_INCREMENT
 * column (column names are case-insensitive in MySQL). Pure.
 */
export function assertMySqlTableAcceptsCreates(
  target: MySqlRecordWriteTarget,
  tableWritePreconditions: MySqlTableWritePreconditions,
): void {
  const { autoIncrementColumnName } = tableWritePreconditions;
  if (autoIncrementColumnName === null) {
    throw new MySqlClientError(
      MySqlClientProblem.CreateRequiresAutoIncrementId,
      `Can't create rows in ${describeMySqlTableForMessages(target)}: it has no AUTO_INCREMENT id column, so Scratch can't learn the id of a new row. Existing rows can still be updated and deleted.`,
    );
  }
  if (autoIncrementColumnName.toLowerCase() !== target.primaryKeyColumnName.toLowerCase()) {
    throw new MySqlClientError(
      MySqlClientProblem.CreateRequiresAutoIncrementId,
      `Can't create rows in ${describeMySqlTableForMessages(target)}: its id column "${target.primaryKeyColumnName}" isn't generated by MySQL. Use the AUTO_INCREMENT column "${autoIncrementColumnName}" as the folder's id field to create rows.`,
    );
  }
}

const POSITIVE_DECIMAL_INTEGER_TEXT_PATTERN = /^\d+$/;

/**
 * The new row's AUTO_INCREMENT id as decimal text. mysql2 reports `insertId` as a number below 2^53 and as a
 * string at or above it (`supportBigNumbers` + `bigNumberStrings`, LOG.md). `0` means MySQL generated no id (a
 * trigger or an explicit value suppressed it), so the new row can't be found again. Pure.
 */
export function readMySqlInsertIdText(insertIdFromDriver: unknown, table: MySqlTableReference): string {
  const insertIdText =
    typeof insertIdFromDriver === 'number' && Number.isSafeInteger(insertIdFromDriver)
      ? String(insertIdFromDriver)
      : typeof insertIdFromDriver === 'string'
        ? insertIdFromDriver
        : '';
  if (!POSITIVE_DECIMAL_INTEGER_TEXT_PATTERN.test(insertIdText) || BigInt(insertIdText) === 0n) {
    throw new MySqlClientError(
      MySqlClientProblem.InsertIdMissing,
      `MySQL didn't report the id of the new row in ${describeMySqlTableForMessages(table)}, so Scratch can't read it back. Nothing in this batch was created.`,
    );
  }
  return insertIdText;
}

/**
 * knex's `Value` typing has no `bigint`, but knex passes a BigInt binding through untouched and mysql2 renders it
 * as an unquoted integer literal (LOG.md). This is the one place the id type is widened for knex.
 */
function asKnexBindingValue(bindableValue: BindableMySqlPrimaryKeyValueForWrite): Knex.Value {
  return bindableValue as unknown as Knex.Value;
}

/** The raw DELETE (knex 3.1.0 silently drops `.limit()` on a MySQL `del()`, so the builder can't be used). Pure. */
export function buildMySqlDeleteByPrimaryKeyStatement(
  target: MySqlRecordWriteTarget,
  bindablePrimaryKeyValue: BindableMySqlPrimaryKeyValueForWrite,
): { sql: string; bindings: Knex.RawBinding[] } {
  return {
    sql: `DELETE FROM ?? WHERE ?? = ? LIMIT ${MYSQL_ROWS_MATCHED_BY_ONE_RECORD_ID_LIMIT}`,
    bindings: [
      qualifiedMySqlTableReferenceForKnex(target),
      encodeMySqlIdentifierForKnex(target.primaryKeyColumnName),
      asKnexBindingValue(bindablePrimaryKeyValue),
    ],
  };
}

/** The encoded select list for read-backs: the pull's columns, plus the id when the list lacks it. */
function encodedReadBackColumnNamesIncludingPrimaryKey(target: MySqlRecordWriteTarget): string[] {
  const readBackColumnNames = target.readBackColumnNames.includes(target.primaryKeyColumnName)
    ? target.readBackColumnNames
    : [...target.readBackColumnNames, target.primaryKeyColumnName];
  return readBackColumnNames.map(encodeMySqlIdentifierForKnex);
}

async function readMySqlTableWritePreconditionsInTransaction(
  trx: Knex.Transaction,
  table: MySqlTableReference,
): Promise<MySqlTableWritePreconditions> {
  const [preconditionRows] = (await trx.raw(MYSQL_TABLE_WRITE_PRECONDITIONS_SQL, [
    table.databaseName,
    table.tableName,
  ])) as [Record<string, unknown>[], unknown];
  return assertMySqlTableAcceptsWrites(table, preconditionRows);
}

/**
 * An update whose row doesn't exist. Carries `RemoteRecordNotFound` so the publish runner records it and the Live
 * Export UI offers its "run a full sync" recovery. `idCannotMatchAnyRow` = the id isn't even a valid value of the
 * id column (`'12abc'` for an integer key, non-base64 text for a binary key), so no row can have it.
 */
function recordNotFoundError(
  target: MySqlRecordWriteTarget,
  context: { idCannotMatchAnyRow: boolean },
): MySqlClientError {
  const reason = context.idCannotMatchAnyRow
    ? `this record's id isn't a valid "${target.primaryKeyColumnName}" value, so it can't match any row`
    : `no row has this "${target.primaryKeyColumnName}" any more (it was deleted, or its id changed, in MySQL since the last pull)`;
  return new MySqlClientError(
    MySqlClientProblem.RecordNotFound,
    `The row this record points to doesn't exist in ${describeMySqlTableForMessages(target)}: ${reason}. Nothing in this batch was changed.`,
    { errorCode: ConnectorErrorCode.RemoteRecordNotFound },
  );
}

function updateMatchedMultipleRowsError(target: MySqlRecordWriteTarget): MySqlClientError {
  return new MySqlClientError(
    MySqlClientProblem.UpdateMatchedMultipleRows,
    `Can't update ${describeMySqlTableForMessages(target)}: more than one row has this record's "${target.primaryKeyColumnName}" value, so "${target.primaryKeyColumnName}" doesn't uniquely identify a row. Nothing in this batch was changed. Use a unique column as the folder's id field.`,
  );
}

/**
 * Insert records one row at a time (each capturing its `insertId`, which is correct under any
 * `innodb_autoinc_lock_mode` / `auto_increment_increment`), then read the new rows back by id. Returns the
 * persisted rows aligned to the input order. `recordsReadyForInsert` must already be prepared
 * (`prepareRecordsForMySqlWrite`); the id key is removed so AUTO_INCREMENT assigns it.
 */
export async function insertRecordsReturningPersistedRows(
  knex: Knex,
  target: MySqlRecordWriteTarget,
  recordsReadyForInsert: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (recordsReadyForInsert.length === 0) return [];
  const qualifiedTableReference = qualifiedMySqlTableReferenceForKnex(target);
  const encodedPrimaryKeyColumnName = encodeMySqlIdentifierForKnex(target.primaryKeyColumnName);

  return knex.transaction(async (trx) => {
    const tableWritePreconditions = await readMySqlTableWritePreconditionsInTransaction(trx, target);
    assertMySqlTableAcceptsCreates(target, tableWritePreconditions);

    const insertIdTextsInInputOrder: string[] = [];
    for (const recordReadyForInsert of recordsReadyForInsert) {
      const recordWithoutPrimaryKey = { ...recordReadyForInsert };
      delete recordWithoutPrimaryKey[target.primaryKeyColumnName];
      const [insertIdFromDriver] = (await trx(qualifiedTableReference).insert(
        encodeMySqlColumnKeysForKnex(recordWithoutPrimaryKey),
      )) as unknown[];
      insertIdTextsInInputOrder.push(readMySqlInsertIdText(insertIdFromDriver, target));
    }

    const insertedRows = (await trx(qualifiedTableReference)
      .select(encodedReadBackColumnNamesIncludingPrimaryKey(target))
      .whereIn(
        encodedPrimaryKeyColumnName,
        insertIdTextsInInputOrder.map((insertIdText) => asKnexBindingValue(BigInt(insertIdText))),
      )) as Record<string, unknown>[];

    // The AUTO_INCREMENT column is an integer, whatever binding kind the spec's annotation implies.
    const insertedRowByCanonicalIdText = new Map<string, Record<string, unknown>>();
    for (const insertedRow of insertedRows) {
      const canonicalIdText = canonicalMySqlPrimaryKeyText(insertedRow[target.primaryKeyColumnName], 'integer');
      if (canonicalIdText !== undefined) insertedRowByCanonicalIdText.set(canonicalIdText, insertedRow);
    }
    const persistedRowsInInputOrder: Record<string, unknown>[] = [];
    for (const insertIdText of insertIdTextsInInputOrder) {
      const insertedRow = insertedRowByCanonicalIdText.get(BigInt(insertIdText).toString());
      if (insertedRow === undefined) {
        throw new MySqlClientError(
          MySqlClientProblem.InsertCountMismatch,
          `Scratch inserted ${insertIdTextsInInputOrder.length} rows into ${describeMySqlTableForMessages(target)} but could read only ${insertedRowByCanonicalIdText.size} of them back by id. Nothing in this batch was created.`,
        );
      }
      persistedRowsInInputOrder.push(insertedRow);
    }
    return persistedRowsInInputOrder;
  });
}

/**
 * Read back one row by the same predicate the UPDATE used (`pk = ?`, so the server's own collation / PAD SPACE
 * folding applies), guarding uniqueness the same way.
 */
async function selectOneRowByPrimaryKeyInTransaction(
  trx: Knex.Transaction,
  target: MySqlRecordWriteTarget,
  bindablePrimaryKeyValue: BindableMySqlPrimaryKeyValueForWrite,
): Promise<Record<string, unknown>> {
  const matchingRows = (await trx(qualifiedMySqlTableReferenceForKnex(target))
    .select(encodedReadBackColumnNamesIncludingPrimaryKey(target))
    .where(encodeMySqlIdentifierForKnex(target.primaryKeyColumnName), asKnexBindingValue(bindablePrimaryKeyValue))
    .limit(MYSQL_ROWS_MATCHED_BY_ONE_RECORD_ID_LIMIT)) as Record<string, unknown>[];
  if (matchingRows.length > 1) throw updateMatchedMultipleRowsError(target);
  const [matchingRow] = matchingRows;
  if (matchingRow === undefined) throw recordNotFoundError(target, { idCannotMatchAnyRow: false });
  return matchingRow;
}

/**
 * Update rows by id and return the persisted rows aligned to the input order.
 *
 * - Each change set runs `UPDATE … WHERE pk = ? LIMIT 2`. `affectedRows` counts MATCHED rows (the client sets
 *   FOUND_ROWS, so a no-op update still reports 1). More than one → UpdateMatchedMultipleRows; zero, or an id that
 *   can't match any row (`'12abc'` for an integer key) → RecordNotFound with `RemoteRecordNotFound`. Both roll
 *   the batch back. This deliberately differs from Postgres, which returns the sent file for a vanished row:
 *   "surface failures; never silently succeed", and the code drives the Live Export "run a full sync" recovery.
 * - An empty change set sends no UPDATE; the current row is read back as-is (still RecordNotFound if it's gone).
 * - The read-back runs inside the transaction: one `whereIn` over the updated ids, then a per-row
 *   `WHERE pk = ? LIMIT 2` for ids MySQL matched through collation folding (`abc` vs stored `ABC`, trailing
 *   spaces). Such a row comes back with its stored id spelling.
 */
export async function updateRecordsByPrimaryKeyReturningPersistedRows(
  knex: Knex,
  target: MySqlRecordWriteTarget,
  changeSets: MySqlRecordUpdateChangeSet[],
): Promise<Record<string, unknown>[]> {
  if (changeSets.length === 0) return [];
  const qualifiedTableReference = qualifiedMySqlTableReferenceForKnex(target);
  const encodedPrimaryKeyColumnName = encodeMySqlIdentifierForKnex(target.primaryKeyColumnName);

  return knex.transaction(async (trx) => {
    await readMySqlTableWritePreconditionsInTransaction(trx, target);

    const bindablePrimaryKeyValuesInInputOrder: BindableMySqlPrimaryKeyValueForWrite[] = [];
    const inputIndexesThatRanAnUpdate = new Set<number>();
    for (const [inputIndex, changeSet] of changeSets.entries()) {
      const bindablePrimaryKeyValue = toBindableMySqlPrimaryKeyValue(changeSet.recordId, target.primaryKeyBindingKind);
      if (!bindablePrimaryKeyValue.isMatchable) throw recordNotFoundError(target, { idCannotMatchAnyRow: true });
      bindablePrimaryKeyValuesInInputOrder.push(bindablePrimaryKeyValue.bindableValue);

      // The id addresses the row; it is never rewritten (a changed id would make the read-back miss the row).
      const changedColumnValuesWithoutPrimaryKey = { ...changeSet.changedColumnValues };
      delete changedColumnValuesWithoutPrimaryKey[target.primaryKeyColumnName];
      if (Object.keys(changedColumnValuesWithoutPrimaryKey).length === 0) continue;

      const matchedRowCount = (await trx(qualifiedTableReference)
        .where(encodedPrimaryKeyColumnName, asKnexBindingValue(bindablePrimaryKeyValue.bindableValue))
        .update(encodeMySqlColumnKeysForKnex(changedColumnValuesWithoutPrimaryKey))
        .limit(MYSQL_ROWS_MATCHED_BY_ONE_RECORD_ID_LIMIT)) as unknown as number;
      if (matchedRowCount > 1) throw updateMatchedMultipleRowsError(target);
      if (matchedRowCount === 0) throw recordNotFoundError(target, { idCannotMatchAnyRow: false });
      inputIndexesThatRanAnUpdate.add(inputIndex);
    }

    const updatedRowByCanonicalIdText = new Map<string, Record<string, unknown>>();
    if (inputIndexesThatRanAnUpdate.size > 0) {
      const updatedRows = (await trx(qualifiedTableReference)
        .select(encodedReadBackColumnNamesIncludingPrimaryKey(target))
        .whereIn(
          encodedPrimaryKeyColumnName,
          [...inputIndexesThatRanAnUpdate].map((inputIndex) =>
            asKnexBindingValue(bindablePrimaryKeyValuesInInputOrder[inputIndex]),
          ),
        )) as Record<string, unknown>[];
      for (const updatedRow of updatedRows) {
        const canonicalIdText = canonicalMySqlPrimaryKeyText(
          updatedRow[target.primaryKeyColumnName],
          target.primaryKeyBindingKind,
        );
        if (canonicalIdText !== undefined) updatedRowByCanonicalIdText.set(canonicalIdText, updatedRow);
      }
    }

    const persistedRowsInInputOrder: Record<string, unknown>[] = [];
    for (const [inputIndex, bindablePrimaryKeyValue] of bindablePrimaryKeyValuesInInputOrder.entries()) {
      const canonicalIdText = canonicalMySqlPrimaryKeyText(bindablePrimaryKeyValue, target.primaryKeyBindingKind);
      const updatedRowFoundByExactId =
        inputIndexesThatRanAnUpdate.has(inputIndex) && canonicalIdText !== undefined
          ? updatedRowByCanonicalIdText.get(canonicalIdText)
          : undefined;
      persistedRowsInInputOrder.push(
        updatedRowFoundByExactId ?? (await selectOneRowByPrimaryKeyInTransaction(trx, target, bindablePrimaryKeyValue)),
      );
    }
    return persistedRowsInInputOrder;
  });
}

/**
 * Delete rows by id, one `DELETE … WHERE pk = ? LIMIT 2` per id. Two matched rows → DeleteMatchedMultipleRows
 * (the batch rolls back, nothing is deleted). Zero is tolerated: the row is already gone, which is the outcome
 * the user asked for. Ids that can't match any row (`'12abc'` for an integer key) are skipped.
 */
export async function deleteRecordsByPrimaryKey(
  knex: Knex,
  target: MySqlRecordWriteTarget,
  recordIds: unknown[],
): Promise<{ deletedRowCount: number }> {
  if (recordIds.length === 0) return { deletedRowCount: 0 };

  return knex.transaction(async (trx) => {
    await readMySqlTableWritePreconditionsInTransaction(trx, target);

    let deletedRowCount = 0;
    let unmatchableRecordIdCount = 0;
    for (const recordId of recordIds) {
      const bindablePrimaryKeyValue = toBindableMySqlPrimaryKeyValue(recordId, target.primaryKeyBindingKind);
      if (!bindablePrimaryKeyValue.isMatchable) {
        unmatchableRecordIdCount += 1;
        continue;
      }
      const deleteStatement = buildMySqlDeleteByPrimaryKeyStatement(target, bindablePrimaryKeyValue.bindableValue);
      const [deleteResultHeader] = (await trx.raw(deleteStatement.sql, deleteStatement.bindings)) as [
        { affectedRows?: unknown },
        unknown,
      ];
      const deletedRowCountForRecordId = Number(deleteResultHeader?.affectedRows ?? 0);
      if (deletedRowCountForRecordId > 1) {
        throw new MySqlClientError(
          MySqlClientProblem.DeleteMatchedMultipleRows,
          `Can't delete from ${describeMySqlTableForMessages(target)}: more than one row has this record's "${target.primaryKeyColumnName}" value, so "${target.primaryKeyColumnName}" doesn't uniquely identify a row. Nothing in this batch was deleted. Use a unique column as the folder's id field.`,
        );
      }
      deletedRowCount += deletedRowCountForRecordId;
    }

    if (unmatchableRecordIdCount > 0) {
      WSLogger.warn({
        source: 'MySqlRecordWrites.deleteRecordsByPrimaryKey',
        message: 'Skipped record ids that cannot match any row of the id column (already absent from MySQL)',
        unmatchableRecordIdCount,
        primaryKeyBindingKind: target.primaryKeyBindingKind,
      });
    }
    return { deletedRowCount };
  });
}
