/**
 * Validation for the user-provided SQL WHERE filter of a MySQL folder (`options.filter`).
 *
 * The filter is spliced into the page query verbatim as `WHERE (<filter>) AND <watermark> ORDER BY <id> LIMIT ?
 * OFFSET ?` (see mysql-record-reads.ts), so it must stay ONE parenthesized boolean expression that can't reach
 * outside its parentheses, can't comment out the rest of the statement and can't disturb the query's bindings.
 *
 * Why these rules (see LOG.md, the sql-escaper spike):
 * - mysql2 fills `?` placeholders on the CLIENT (sql-escaper). It skips `?` inside single-quoted literals and
 *   backtick-quoted identifiers, but a `?` anywhere else — inside a double-quoted string, after `#`, or unquoted —
 *   would consume our watermark / LIMIT / OFFSET binding. `?` is therefore rejected EVERYWHERE, even inside
 *   quotes, so placeholder safety never depends on how sql-escaper lexes the filter.
 * - sql-escaper doesn't treat `"` as a quote, and a backslash escape (`'it\'s'`) makes its quote tracking disagree
 *   with the server's. Both are rejected everywhere; `'…'` with `''` doubling and backticks with doubled backticks
 *   are then the only quoting forms left, and they lex unambiguously.
 * - `#`, `--` and `/*` start comments in MySQL. A comment would swallow `ORDER BY … LIMIT ? OFFSET ?`, so the pull
 *   loop would re-read every row forever.
 * - Unbalanced parentheses (`1=1) OR (1=1`) would escape the `(…)` the query builder wraps the filter in.
 *
 * Character and keyword rules run on the UNQUOTED SKELETON — the filter with every quoted span replaced by a
 * placeholder — so `email = 'a@b.com'`, `sku = 'A#1'`, `note = 'please update'` and `` `set` = 1 `` are accepted.
 *
 * Known gap (shared with Postgres): a denylist can't block a user-defined stored function called by its bare name
 * (`my_func(x)`) in the connection's default database. Qualified calls (`other_db.my_func(x)`) and quoted-name calls
 * (`` `my_func`(x) ``) are rejected. The follow-up is an allowlist of built-in functions.
 */
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';

export const MYSQL_FILTER_MAX_LENGTH = 4096;

/**
 * The Postgres denylist (`pg-common/sql-filter-validator.ts`) plus MySQL / MariaDB statement keywords. Matched as
 * whole words, case-insensitively, on the unquoted skeleton. `REPLACE` and `INSERT` stay out of the MySQL additions
 * on purpose (`REPLACE(...)` is a string function; `INSERT` is inherited from the Postgres list), and `\bSET\b`
 * doesn't match `FIND_IN_SET` because `_` is a word character.
 */
const MYSQL_FILTER_DENIED_KEYWORDS: readonly string[] = [
  // Postgres list.
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'EXECUTE',
  'COPY',
  'SET',
  'EXPLAIN',
  'VACUUM',
  'REINDEX',
  'COMMENT',
  'LOCK',
  'NOTIFY',
  'LISTEN',
  'UNLISTEN',
  'LOAD',
  'DO',
  'CALL',
  'IMPORT',
  'EXPORT',
  'RAISE',
  'PERFORM',
  'RETURNING',
  'INTO',
  'WITH',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'VALUES',
  // `TABLE t` is a MySQL 8 subquery on its own (`x IN (TABLE secrets)`), no SELECT needed.
  'TABLE',
  // MySQL / MariaDB additions.
  'OUTFILE',
  'DUMPFILE',
  'HANDLER',
  'PREPARE',
  'DEALLOCATE',
  'SHOW',
  'DESCRIBE',
  'ANALYZE',
  'OPTIMIZE',
  'REPAIR',
  'CHECKSUM',
  'FLUSH',
  'RESET',
  'PURGE',
  'KILL',
  'SHUTDOWN',
  'INSTALL',
  'UNINSTALL',
  'RENAME',
  'UNLOCK',
  'PROCEDURE',
  // Callable without parentheses.
  'CURRENT_USER',
];

/** MariaDB sequence expressions: reading a sequence's next value advances it (a write). */
const MARIADB_SEQUENCE_EXPRESSION_PATTERN = /\b(?:NEXT|PREVIOUS)\s+VALUE\s+FOR\b/i;

/**
 * Built-in functions with side effects (sleeping, locks, replication waits, sequences), file access, error-based
 * data exfiltration, or server / session disclosure. Matched as a name followed by `(` (whitespace allowed: stored
 * and loadable functions accept it, and IGNORE_SPACE allows it for built-ins).
 */
const MYSQL_FILTER_DENIED_FUNCTION_NAMES: readonly string[] = [
  'sleep',
  'benchmark',
  'load_file',
  'get_lock',
  'release_lock',
  'release_all_locks',
  'is_free_lock',
  'is_used_lock',
  'master_pos_wait',
  'source_pos_wait',
  'master_gtid_wait',
  'wait_for_executed_gtid_set',
  'wait_until_sql_thread_after_gtids',
  'gtid_subset',
  'gtid_subtract',
  'extractvalue',
  'updatexml',
  'name_const',
  'sys_exec',
  'sys_eval',
  'sys_get',
  'sys_set',
  'connection_id',
  'user',
  'current_user',
  'session_user',
  'system_user',
  'current_role',
  'database',
  'schema',
  'version',
  'last_insert_id',
  'row_count',
  'found_rows',
  'roles_graphml',
  // MariaDB sequences.
  'nextval',
  'setval',
  'lastval',
];

/**
 * Families of server-administration functions (component / plugin UDFs) that change replication, keyring, audit,
 * firewall or locking-service state, matched by name prefix. Not in the design's list; added because they are
 * callable from a SELECT and none of them belongs in a row filter.
 */
const MYSQL_FILTER_DENIED_FUNCTION_NAME_PREFIXES: readonly string[] = [
  'asynchronous_connection_failover_',
  'group_replication_',
  'keyring_',
  'audit_log_',
  'mysql_firewall_',
  'set_firewall_',
  'version_tokens_',
  'service_get_',
  'service_release_',
];

const MYSQL_FILTER_DENIED_KEYWORD_PATTERN = new RegExp(`\\b(${MYSQL_FILTER_DENIED_KEYWORDS.join('|')})\\b`, 'i');

const MYSQL_FILTER_DENIED_FUNCTION_CALL_PATTERN = new RegExp(
  `\\b(${[
    ...MYSQL_FILTER_DENIED_FUNCTION_NAMES,
    ...MYSQL_FILTER_DENIED_FUNCTION_NAME_PREFIXES.map((functionNamePrefix) => `${functionNamePrefix}\\w*`),
  ].join('|')})\\s*\\(`,
  'i',
);

/**
 * C0 / C1 control characters and DEL, except tab, line feed and carriage return. They're invisible in the UI, and
 * rejecting them up front also frees U+0002 / U+0003 for the skeleton placeholders below (and keeps the identifier
 * encoder's U+0000 / U+0001 sentinels out of the SQL).
 */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Stands in for a whole `'…'` literal in the unquoted skeleton. */
const QUOTED_TEXT_LITERAL_PLACEHOLDER = '\u0002';
/** Stands in for a whole `` `…` `` identifier in the unquoted skeleton. */
const QUOTED_IDENTIFIER_PLACEHOLDER = '\u0003';

/**
 * A call through a quoted name (`` `sleep`(1) ``, `` `db`.`fn`(1) ``): the name would dodge the function denylist.
 * An identifier followed by `(` is never anything but a call.
 */
const QUOTED_IDENTIFIER_FUNCTION_CALL_PATTERN = new RegExp(`${QUOTED_IDENTIFIER_PLACEHOLDER}\\s*\\(`);

/**
 * A database-qualified call (`other_db.fn(1)`, `` `db`.fn(1) ``): built-in functions are never qualified, so this is
 * always a stored function. A decimal like `1.5 AND (…)` doesn't match: the `(` must follow the name directly.
 */
const QUALIFIED_FUNCTION_CALL_PATTERN = /\.\s*[\p{L}\p{N}_$]+\s*\(/u;

type MySqlFilterQuoteScan =
  | { outcome: 'scanned'; unquotedSkeleton: string }
  | { outcome: 'unterminatedQuote'; openingQuoteCharacter: "'" | '`' };

/**
 * Position of the quote that closes the span opened at `openingQuotePosition`, treating a doubled quote character
 * as an escaped one (`'it''s'`, `` `we``ird` ``) — MySQL's own rule once backslash escapes are ruled out.
 */
function findClosingQuotePosition(
  filter: string,
  openingQuotePosition: number,
  quoteCharacter: "'" | '`',
): number | undefined {
  let scanPosition = openingQuotePosition + 1;
  while (scanPosition < filter.length) {
    if (filter[scanPosition] === quoteCharacter) {
      if (filter[scanPosition + 1] === quoteCharacter) {
        scanPosition += 2;
        continue;
      }
      return scanPosition;
    }
    scanPosition += 1;
  }
  return undefined;
}

/**
 * Replace every quoted span with a space-padded placeholder (so neither side can fuse with its neighbour into a
 * token such as `--`). Must only run after `"` and `\` are ruled out: with those gone, single quotes and backticks
 * delimit spans exactly as the MySQL server lexes them.
 */
function scanMySqlFilterQuotedSpans(filter: string): MySqlFilterQuoteScan {
  let unquotedSkeleton = '';
  let scanPosition = 0;
  while (scanPosition < filter.length) {
    const currentCharacter = filter[scanPosition];
    if (currentCharacter === "'" || currentCharacter === '`') {
      const closingQuotePosition = findClosingQuotePosition(filter, scanPosition, currentCharacter);
      if (closingQuotePosition === undefined) {
        return { outcome: 'unterminatedQuote', openingQuoteCharacter: currentCharacter };
      }
      const spanPlaceholder =
        currentCharacter === "'" ? QUOTED_TEXT_LITERAL_PLACEHOLDER : QUOTED_IDENTIFIER_PLACEHOLDER;
      unquotedSkeleton += ` ${spanPlaceholder} `;
      scanPosition = closingQuotePosition + 1;
      continue;
    }
    unquotedSkeleton += currentCharacter;
    scanPosition += 1;
  }
  return { outcome: 'scanned', unquotedSkeleton };
}

/** Whether every `(` is closed and no `)` closes more than was opened (depth never negative, ends at 0). */
function hasBalancedParentheses(unquotedSkeleton: string): boolean {
  let parenthesisDepth = 0;
  for (const skeletonCharacter of unquotedSkeleton) {
    if (skeletonCharacter === '(') parenthesisDepth += 1;
    if (skeletonCharacter === ')') parenthesisDepth -= 1;
    if (parenthesisDepth < 0) return false;
  }
  return parenthesisDepth === 0;
}

function rejectMySqlFilter(userFriendlyMessage: string): never {
  throw new MySqlClientError(MySqlClientProblem.InvalidFilter, userFriendlyMessage);
}

/**
 * Validate a folder's WHERE filter before it is spliced into a page query. A blank filter is valid and means "no
 * filter" (the query builder skips it). Rules run in a fixed order and the first failing rule's message is shown.
 *
 * @throws {MySqlClientError} with problem `InvalidFilter`.
 */
export function validateMySqlWhereFilter(filter: string): void {
  if (filter.trim() === '') return;

  if (filter.length > MYSQL_FILTER_MAX_LENGTH) {
    rejectMySqlFilter(
      `Filter is too long (${filter.length} characters). Keep it to ${MYSQL_FILTER_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (DISALLOWED_CONTROL_CHARACTER_PATTERN.test(filter)) {
    rejectMySqlFilter('Filter contains an invisible control character. Remove it and try again.');
  }
  if (filter.includes('?')) {
    rejectMySqlFilter(
      'Filter can\'t contain "?", even inside quotes: Scratch uses it for its own query parameters. To match text containing a question mark, use LIKE with the _ wildcard in its place.',
    );
  }
  if (filter.includes('"')) {
    rejectMySqlFilter(
      "Filter can't contain double quotes. Use single quotes for text ('active') and backticks for column names (`my column`).",
    );
  }
  if (filter.includes('\\')) {
    rejectMySqlFilter("Filter can't contain backslashes. To put a single quote inside text, double it: 'it''s'.");
  }

  const quoteScan = scanMySqlFilterQuotedSpans(filter);
  if (quoteScan.outcome === 'unterminatedQuote') {
    rejectMySqlFilter(
      quoteScan.openingQuoteCharacter === "'"
        ? "Filter has text with no closing single quote ('). To put a single quote inside text, double it: 'it''s'."
        : 'Filter has a column name with no closing backtick (`). To put a backtick inside a name, double it.',
    );
  }
  const { unquotedSkeleton } = quoteScan;

  if (unquotedSkeleton.includes(';')) {
    rejectMySqlFilter('Filter can\'t contain ";" outside quotes: it must be a single WHERE condition.');
  }
  if (
    unquotedSkeleton.includes('#') ||
    unquotedSkeleton.includes('--') ||
    unquotedSkeleton.includes('/*') ||
    unquotedSkeleton.includes('*/')
  ) {
    rejectMySqlFilter("Filter can't contain SQL comments (#, --, /* or */) outside quotes.");
  }
  if (unquotedSkeleton.includes('@') || unquotedSkeleton.includes(':=')) {
    rejectMySqlFilter("Filter can't use variables (@name, @@name) or assignments (:=).");
  }
  if (!hasBalancedParentheses(unquotedSkeleton)) {
    rejectMySqlFilter('Filter has unbalanced parentheses: every "(" needs a matching ")".');
  }
  if (QUOTED_IDENTIFIER_FUNCTION_CALL_PATTERN.test(unquotedSkeleton)) {
    rejectMySqlFilter("Filter can't call a function through a quoted name (`name`(...)).");
  }
  if (QUALIFIED_FUNCTION_CALL_PATTERN.test(unquotedSkeleton)) {
    rejectMySqlFilter("Filter can't call a function stored in a database (database.function(...)).");
  }
  if (MARIADB_SEQUENCE_EXPRESSION_PATTERN.test(unquotedSkeleton)) {
    rejectMySqlFilter("Filter can't read a sequence (NEXT VALUE FOR / PREVIOUS VALUE FOR).");
  }
  const deniedKeywordMatch = MYSQL_FILTER_DENIED_KEYWORD_PATTERN.exec(unquotedSkeleton);
  if (deniedKeywordMatch) {
    const deniedKeyword = deniedKeywordMatch[1].toUpperCase();
    rejectMySqlFilter(
      `Filter can't use the SQL keyword ${deniedKeyword}. If it's a column name, wrap it in backticks (\`${deniedKeywordMatch[1]}\`).`,
    );
  }
  const deniedFunctionCallMatch = MYSQL_FILTER_DENIED_FUNCTION_CALL_PATTERN.exec(unquotedSkeleton);
  if (deniedFunctionCallMatch) {
    rejectMySqlFilter(`Filter can't call the function ${deniedFunctionCallMatch[1].toUpperCase()}().`);
  }
}
