/**
 * The two record reads a pull runs: one OFFSET page of a table, and the rows for a batch of ids.
 *
 * Both take a knex instance (the per-operation client's `knex`, or a transaction) built with
 * `applyMySqlVerbatimIdentifierQuoting`, and encode EVERY identifier segment themselves — database, table and each
 * column — so names containing `.`, ` as `, `?` or backticks reach MySQL verbatim (inside a transaction too, where
 * knex's alias hook isn't installed). Values are decoded by the connection's `typeCast`
 * (mysql-row-value-decoder.ts); rows are returned exactly as the driver produced them.
 *
 * The query builders are exported separately so unit specs can assert the SQL on a connection-less knex. Assert on
 * `toSQL()`, not `toString()`: knex's `toString()` substitutes `?` even inside backtick-quoted identifiers, while
 * mysql2's own formatter (which runs at execution) skips them.
 */
import { type Knex } from 'knex';
import { validateMySqlWhereFilter } from './mysql-filter-validator';
import { encodeMySqlIdentifierForKnex, qualifiedMySqlTableReferenceForKnex } from './mysql-identifier-quoting';
import { type MySqlModifiedSinceLowerBound } from './mysql-incremental';
import { type MySqlTableReference } from './mysql-types';

/** A primary-key value ready to bind: see `toBindableMySqlPrimaryKeyValue` in mysql-id-binding.ts. */
export type MySqlPrimaryKeyBindingValue = string | number | bigint | Buffer;

export interface MySqlTableRowsPageRequest {
  readonly table: MySqlTableReference;
  /** Explicit column list (`listSelectableColumnNames`); never `*`. The id column is added when missing. */
  readonly selectedColumnNames: readonly string[];
  readonly idColumnName: string;
  readonly pageSize: number;
  readonly pageOffset: number;
  /** The folder's WHERE filter. Validated again here; a blank filter means no filter. */
  readonly whereFilter?: string;
  /** Incremental pulls only: keep rows whose column is strictly after the bound. */
  readonly modifiedSince?: MySqlModifiedSinceLowerBound;
}

export interface MySqlTableRowsByIdsRequest {
  readonly table: MySqlTableReference;
  /** Explicit column list (`listSelectableColumnNames`); never `*`. The id column is added when missing. */
  readonly selectedColumnNames: readonly string[];
  readonly idColumnName: string;
  /** Already converted for binding (BigInt for integer keys, Buffer for binary keys); unmatchable ids removed. */
  readonly idBindingValues: readonly MySqlPrimaryKeyBindingValue[];
}

/**
 * The encoded select list: the requested columns plus the id column when the caller left it out (every pulled
 * record must carry its id). An empty list is a programming error — knex would silently turn `select([])` into
 * `select *`.
 */
function encodeSelectedColumnNamesIncludingId(selectedColumnNames: readonly string[], idColumnName: string): string[] {
  if (selectedColumnNames.length === 0) {
    throw new Error('A MySQL record read needs an explicit, non-empty column list');
  }
  const selectedColumnNamesIncludingId = selectedColumnNames.includes(idColumnName)
    ? selectedColumnNames
    : [...selectedColumnNames, idColumnName];
  return selectedColumnNamesIncludingId.map(encodeMySqlIdentifierForKnex);
}

function assertValidPageWindow(pageSize: number, pageOffset: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error(`MySQL read page size must be a positive integer, got ${pageSize}`);
  }
  if (!Number.isSafeInteger(pageOffset) || pageOffset < 0) {
    throw new Error(`MySQL read page offset must be a non-negative integer, got ${pageOffset}`);
  }
}

/**
 * `SELECT <columns> FROM <db>.<table> [WHERE (<filter>) [AND <modified-at> > ?]] ORDER BY <id> ASC LIMIT ? OFFSET ?`.
 *
 * - The filter goes inside a grouped `where` so knex parenthesizes it: `a = 1 OR b = 2` must not let the OR escape
 *   the incremental predicate (the Postgres connector's bare `whereRaw` has that bug).
 * - The modified-since column goes through `knex.ref` (a quoted identifier) and the bound is a bound value.
 * - knex omits `OFFSET ?` for offset 0.
 *
 * @throws {MySqlClientError} with problem `InvalidFilter` for a filter the validator rejects.
 */
export function buildSelectTableRowsPageQuery(knex: Knex, request: MySqlTableRowsPageRequest): Knex.QueryBuilder {
  assertValidPageWindow(request.pageSize, request.pageOffset);
  const encodedSelectedColumnNames = encodeSelectedColumnNamesIncludingId(
    request.selectedColumnNames,
    request.idColumnName,
  );

  let pageQuery = knex(qualifiedMySqlTableReferenceForKnex(request.table)).select(encodedSelectedColumnNames);

  const trimmedWhereFilter = request.whereFilter?.trim();
  if (trimmedWhereFilter) {
    // Defense in depth: the connector validates before connecting, but this is the last stop before `whereRaw`.
    validateMySqlWhereFilter(trimmedWhereFilter);
    pageQuery = pageQuery.where((filterGroupBuilder) => {
      filterGroupBuilder.whereRaw(trimmedWhereFilter);
    });
  }

  if (request.modifiedSince) {
    pageQuery = pageQuery.where(
      knex.ref(encodeMySqlIdentifierForKnex(request.modifiedSince.columnName)),
      '>',
      request.modifiedSince.exclusiveLowerBoundUtcLiteral,
    );
  }

  return pageQuery
    .orderBy(encodeMySqlIdentifierForKnex(request.idColumnName), 'asc')
    .limit(request.pageSize)
    .offset(request.pageOffset);
}

/** One page of rows, ordered by id. A page shorter than `pageSize` is the last one. */
export async function selectTableRowsPage(
  knex: Knex,
  request: MySqlTableRowsPageRequest,
): Promise<Record<string, unknown>[]> {
  return (await buildSelectTableRowsPageQuery(knex, request)) as Record<string, unknown>[];
}

/**
 * knex's `Value` binding type predates `bigint`, but knex hands bindings to mysql2 unchanged and mysql2 renders a
 * BigInt as an unquoted integer literal and a Buffer as `X'…'` (verified in the spike, LOG.md). Type-only.
 */
function primaryKeyBindingValuesAsKnexValues(
  idBindingValues: readonly MySqlPrimaryKeyBindingValue[],
): readonly Knex.Value[] {
  return idBindingValues as readonly unknown[] as readonly Knex.Value[];
}

/**
 * `SELECT <columns> FROM <db>.<table> WHERE <id> IN (?, ...)`. Ids are bound with the types
 * `toBindableMySqlPrimaryKeyValue` chose, so an integer key compares as an integer, never via loose text conversion.
 */
export function buildSelectTableRowsByIdsQuery(knex: Knex, request: MySqlTableRowsByIdsRequest): Knex.QueryBuilder {
  const encodedSelectedColumnNames = encodeSelectedColumnNamesIncludingId(
    request.selectedColumnNames,
    request.idColumnName,
  );
  return knex(qualifiedMySqlTableReferenceForKnex(request.table))
    .select(encodedSelectedColumnNames)
    .whereIn(
      encodeMySqlIdentifierForKnex(request.idColumnName),
      primaryKeyBindingValuesAsKnexValues(request.idBindingValues),
    );
}

/**
 * The rows whose id is in `idBindingValues`, in whatever order MySQL returns them. Ids with no row are simply
 * absent (the caller lines rows up with `canonicalMySqlPrimaryKeyText`). No query runs for an empty id list.
 */
export async function selectTableRowsByIds(
  knex: Knex,
  request: MySqlTableRowsByIdsRequest,
): Promise<Record<string, unknown>[]> {
  if (request.idBindingValues.length === 0) return [];
  return (await buildSelectTableRowsByIdsQuery(knex, request)) as Record<string, unknown>[];
}
