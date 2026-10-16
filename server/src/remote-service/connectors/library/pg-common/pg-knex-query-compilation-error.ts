/**
 * Recognizing errors knex throws while COMPILING a query — before anything is
 * sent to the database.
 *
 * These are plain `Error`s with no Postgres SQLSTATE `code`, so without this a
 * pg connector's `extractConnectorErrorDetails` falls through to the generic
 * fallback and shows the user "<Service> error: Expected 1 bindings, saw 3" —
 * knex internals, blamed on the remote service, for a query that never reached
 * it (e.g. a `?` inside a column name read as a binding placeholder). The
 * message instead states that the SQL query could not be compiled and shows the
 * query when it is known; knex's own text stays in `description` for debugging.
 *
 * The SQL shown is always the statement TEMPLATE — a `?` (or `$n`) where each
 * bound value goes — so it carries schema, table and column names but never a
 * record's values.
 */
import { elideToMaxLength } from 'src/utils/helpers';
import { type ConnectorErrorDetails } from '../../types';

const KNEX_QUERY_COMPILATION_ERROR_MESSAGE_PATTERNS: readonly RegExp[] = [
  // `knex.raw(sql, bindings)`: the `?` placeholder count in the SQL text differs from the bindings length.
  /^Expected \d+ bindings, saw \d+$/,
  // Query builder or `knex.raw`: an `undefined` value was bound into the query.
  /^Undefined binding\(s\) detected /,
];

/**
 * knex's undefined-binding errors end with the compiled statement template
 * (`… when compiling RAW query: <sql>` / `… Undefined column(s): [...] query: <sql>`).
 */
const KNEX_UNDEFINED_BINDING_ERROR_TRAILING_SQL_TEXT_PATTERN = /\bquery: ([\s\S]+)$/;

/**
 * How much of the SQL the user-facing message shows. The full text goes to
 * `additionalContext`; a bulk UPDATE's SET clause names every changed column and
 * can run to thousands of characters, which would swamp a publish error list or a
 * failure email. Middle-elided so both the statement head and its WHERE clause stay.
 */
const MAX_SQL_TEXT_LENGTH_IN_USER_FRIENDLY_MESSAGE = 500;

export function isKnexQueryCompilationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    KNEX_QUERY_COMPILATION_ERROR_MESSAGE_PATTERNS.some((messagePattern) => messagePattern.test(error.message))
  );
}

/**
 * A knex query-compilation error tagged with the SQL text knex was compiling.
 * knex's "Expected 1 bindings, saw 3" names no query, so a raw-SQL call site runs
 * through {@link runKnexRawStatementTaggingCompilationErrorWithSqlText} to make
 * the failing statement visible. Keeps knex's message, so
 * {@link isKnexQueryCompilationError} still recognizes it.
 */
export class KnexQueryCompilationErrorWithSqlText extends Error {
  constructor(
    readonly knexQueryCompilationError: Error,
    readonly sqlText: string,
  ) {
    super(knexQueryCompilationError.message);
    this.name = 'KnexQueryCompilationErrorWithSqlText';
  }
}

/**
 * Run a `knex.raw` statement built from `sqlText`, re-throwing a knex
 * query-compilation failure as a {@link KnexQueryCompilationErrorWithSqlText}
 * carrying that text. Every other error — a Postgres error from the executed
 * statement, a rollback guard — passes through untouched.
 */
export async function runKnexRawStatementTaggingCompilationErrorWithSqlText<TStatementResult>(
  sqlText: string,
  runRawStatement: () => PromiseLike<TStatementResult>,
): Promise<TStatementResult> {
  try {
    return await runRawStatement();
  } catch (error) {
    if (isKnexQueryCompilationError(error) && !(error instanceof KnexQueryCompilationErrorWithSqlText)) {
      throw new KnexQueryCompilationErrorWithSqlText(error, sqlText);
    }
    throw error;
  }
}

function sqlTextOfKnexQueryCompilationError(error: Error): string | undefined {
  if (error instanceof KnexQueryCompilationErrorWithSqlText) {
    return error.sqlText;
  }
  return KNEX_UNDEFINED_BINDING_ERROR_TRAILING_SQL_TEXT_PATTERN.exec(error.message)?.[1];
}

export function knexQueryCompilationErrorDetails(error: Error): ConnectorErrorDetails {
  const sqlText = sqlTextOfKnexQueryCompilationError(error);
  const singleLineSqlText = sqlText?.replace(/\s+/g, ' ').trim();
  const errorWithKnexStack =
    error instanceof KnexQueryCompilationErrorWithSqlText ? error.knexQueryCompilationError : error;
  return {
    userFriendlyMessage: singleLineSqlText
      ? `The SQL query for this change could not be compiled: ${elideToMaxLength(singleLineSqlText, MAX_SQL_TEXT_LENGTH_IN_USER_FRIENDLY_MESSAGE)}`
      : 'The SQL query for this change could not be compiled.',
    description: error.message,
    additionalContext: {
      errorName: errorWithKnexStack.name,
      stack: errorWithKnexStack.stack,
      ...(singleLineSqlText ? { sqlText: singleLineSqlText } : {}),
    },
  };
}
