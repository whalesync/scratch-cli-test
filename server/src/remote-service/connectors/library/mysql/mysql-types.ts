/**
 * Shared MySQL connector types: the validated connection settings every module consumes, and the
 * `[database, table]` address of a table.
 */

/**
 * TLS modes, named after MySQL's own `--ssl-mode` values. There is deliberately no `PREFERRED`: mysql2 fails
 * when TLS is requested and the server lacks it, so a silent plaintext fallback can't happen.
 */
export const MYSQL_SSL_MODES = ['DISABLED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const;
export type MySqlSslMode = (typeof MYSQL_SSL_MODES)[number];

/** The TLS mode used when the user doesn't choose one: encrypted, no certificate check (MySQL CLI default). */
export const DEFAULT_MYSQL_SSL_MODE: MySqlSslMode = 'REQUIRED';

export const DEFAULT_MYSQL_PORT = 3306;

/**
 * Validated, normalized connection settings. Built only by the credential normalizer
 * (`mysql-connection-options.ts`) from discrete fields — never from a URL at connect time — and the only input
 * the knex client accepts.
 */
export interface MySqlConnectionOptions {
  /** Hostname or IP literal exactly as the user typed it (IPv6 without brackets). Never a URL. */
  readonly host: string;
  readonly port: number;
  /** Absent = every non-system database the user can see. */
  readonly databaseName?: string;
  readonly username: string;
  /** Empty string when the account has no password (some self-hosted setups). */
  readonly password: string;
  readonly sslMode: MySqlSslMode;
  /** PEM bundle, re-wrapped to 64-character lines. Only meaningful for the VERIFY_* modes. */
  readonly sslCaCertificatePem?: string;
}

/** A table's location. Both parts are the verbatim names MySQL reports (they may contain `.`, spaces, `?`). */
export interface MySqlTableReference {
  readonly databaseName: string;
  readonly tableName: string;
}
