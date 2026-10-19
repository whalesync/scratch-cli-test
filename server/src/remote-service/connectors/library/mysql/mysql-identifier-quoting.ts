/**
 * Verbatim identifier handling for knex's MySQL dialect (backtick quoting).
 *
 * MySQL database, table and column names may legitimately contain `.`, ` as `, `?` and backticks (Connector
 * Prime Directive: we never rename them). Knex would otherwise split an identifier on `.` (qualification) and on
 * ` as ` (aliasing) before quoting it. We reuse the dialect-agnostic sentinel encoding from pg-common: every
 * identifier segment is encoded before it reaches the builder and decoded again in knex's `wrapIdentifier` hook,
 * just before knex's own backtick quoting (which doubles embedded backticks).
 *
 * Two pg-common helpers are deliberately NOT used here:
 *  - `escapeKnexColumnIdentifierSpecialCharacters` emits `\?`, which only knex's Postgres dialect un-escapes; on
 *    MySQL it would silently rename `Featured?` to `Featured\?`. A `?` inside a backtick-quoted identifier is safe
 *    on MySQL: mysql2's client-side formatter (sql-escaper) skips backtick-quoted spans (verified in the spike,
 *    see LOG.md).
 *  - `applyVerbatimIdentifierQuoting` re-quotes with `"`, which MySQL (without ANSI_QUOTES) reads as a string
 *    literal.
 */
import { type Knex } from 'knex';
import {
  decodeColumnIdentifierForKnex,
  encodeColumnIdentifierForKnex,
} from '../pg-common/knex-column-identifier-dot-encoding';
import { type MySqlTableReference } from './mysql-types';

/** Encode one identifier segment (database, table or column name) so knex emits it as a single identifier. */
export function encodeMySqlIdentifierForKnex(identifier: string): string {
  return encodeColumnIdentifierForKnex(identifier);
}

/**
 * The knex table reference for `database.table`, with each segment encoded so a `.` inside either name can't be
 * mistaken for the qualifier. Compiles to `` `database`.`table` ``.
 */
export function qualifiedMySqlTableReferenceForKnex(table: MySqlTableReference): string {
  return `${encodeMySqlIdentifierForKnex(table.databaseName)}.${encodeMySqlIdentifierForKnex(table.tableName)}`;
}

/** Encode every key of a record (column names) for `insert` / `update` builders. Values are untouched. */
export function encodeMySqlColumnKeysForKnex(record: Record<string, unknown>): Record<string, unknown> {
  const recordWithEncodedColumnKeys: Record<string, unknown> = {};
  for (const [columnName, value] of Object.entries(record)) {
    recordWithEncodedColumnKeys[encodeMySqlIdentifierForKnex(columnName)] = value;
  }
  return recordWithEncodedColumnKeys;
}

/**
 * Fallback for an identifier path that bypassed the sentinel encoding: knex routes a mis-split `a as b` through
 * `client.alias(first, second)` with both halves already backtick-quoted. Rejoin them into one identifier (the
 * separator's casing is already lost by then, so it comes back lower-case). Note this override does not survive
 * into knex transactions (`makeTxClient` copies only `config`), which is why every identifier must be encoded.
 */
export function rejoinKnexAliasSplitMySqlIdentifier(quotedFirstHalf: string, quotedSecondHalf: string): string {
  const unwrapBacktickQuotedIdentifier = (quoted: string): string =>
    quoted.replace(/^`/, '').replace(/`$/, '').replace(/``/g, '`');
  const rejoinedIdentifier = `${unwrapBacktickQuotedIdentifier(quotedFirstHalf)} as ${unwrapBacktickQuotedIdentifier(quotedSecondHalf)}`;
  return `\`${rejoinedIdentifier.replace(/`/g, '``')}\``;
}

/**
 * Install the verbatim-identifier hooks on a knex instance built with the mysql2 dialect: the `wrapIdentifier`
 * sentinel decode (survives into transactions) plus the backtick alias-rejoin fallback. Exported so unit tests can
 * compile SQL through a connection-less knex with exactly the production behaviour.
 */
export function applyMySqlVerbatimIdentifierQuoting(knexInstance: Knex): void {
  const knexClientHooks = knexInstance.client as {
    alias: (first: string, second: string) => string;
    config: { wrapIdentifier?: (value: string, origImpl: (value: string) => string) => string };
  };
  knexClientHooks.alias = rejoinKnexAliasSplitMySqlIdentifier;
  knexClientHooks.config.wrapIdentifier = (value, origImpl) => origImpl(decodeColumnIdentifierForKnex(value));
}
