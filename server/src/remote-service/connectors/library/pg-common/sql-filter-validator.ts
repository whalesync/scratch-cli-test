/**
 * Validation for user-provided SQL WHERE filter expressions.
 * Shared by all Knex-based PG connectors.
 *
 * Allows: column comparisons, AND/OR/NOT, IS NULL, IN (...), BETWEEN, LIKE/ILIKE,
 *         string/number literals, parenthesized grouping, boolean TRUE/FALSE.
 *
 * Rejects: DDL/DML statements, subqueries, dangerous functions, multi-statement injection,
 *          SQL comments, and escape sequences.
 */
import { KnexPGClientError } from './knex-pg-client';

/**
 * SQL keywords that must NEVER appear in a user-provided WHERE filter.
 * Matched as whole words (case-insensitive) to prevent injection attacks.
 */
const DANGEROUS_SQL_KEYWORDS = [
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
  'TABLE',
];

/**
 * Dangerous PostgreSQL functions that could cause side-effects or data exfiltration.
 * Matched case-insensitively followed by an opening parenthesis.
 */
const DANGEROUS_FUNCTIONS = [
  'pg_sleep',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'lo_import',
  'lo_export',
  'lo_unlink',
  'dblink',
  'dblink_exec',
  'dblink_connect',
  'copy_to',
  'copy_from',
  'query_to_xml',
  'query_to_xml_and_xmlschema',
  'query_to_json',
  'currval',
  'nextval',
  'setval',
  'txid_current',
  'set_config',
  'current_setting',
  'pg_advisory_lock',
  'pg_advisory_unlock',
  'pg_advisory_xact_lock',
  'inet_server_addr',
  'inet_server_port',
];

const DANGEROUS_KEYWORDS_PATTERN = new RegExp(`\\b(${DANGEROUS_SQL_KEYWORDS.join('|')})\\b`, 'i');
const DANGEROUS_FUNCTIONS_PATTERN = new RegExp(`\\b(${DANGEROUS_FUNCTIONS.join('|')})\\s*\\(`, 'i');

/**
 * Validate that a user-provided SQL filter expression is safe for use in a WHERE clause.
 *
 * @throws {KnexPGClientError} if the filter contains dangerous SQL constructs.
 */
export function validateWhereFilter(filter: string): void {
  // Block semicolons (multi-statement injection)
  if (filter.includes(';')) {
    throw new KnexPGClientError('Filter contains invalid character: ";"', 'INVALID_FILTER');
  }

  // Block SQL comments
  if (filter.includes('--') || filter.includes('/*')) {
    throw new KnexPGClientError('Filter must not contain SQL comments', 'INVALID_FILTER');
  }

  // Block dollar-quoting (PostgreSQL alternative string syntax that can bypass keyword checks)
  if (filter.includes('$$') || /\$[a-zA-Z_]\w*\$/.test(filter)) {
    throw new KnexPGClientError('Filter must not contain dollar-quoting', 'INVALID_FILTER');
  }

  // Block dangerous SQL keywords
  if (DANGEROUS_KEYWORDS_PATTERN.test(filter)) {
    throw new KnexPGClientError('Filter contains disallowed SQL keyword', 'INVALID_FILTER');
  }

  // Block dangerous functions
  if (DANGEROUS_FUNCTIONS_PATTERN.test(filter)) {
    throw new KnexPGClientError('Filter contains disallowed SQL function', 'INVALID_FILTER');
  }
}
