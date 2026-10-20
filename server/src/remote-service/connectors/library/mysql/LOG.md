# MySQL connector — build log

## 2026-09-29 — driver spike (DEV-12035)

Throwaway scripts against the local `server/localdev/docker-compose.mysql.yml` stack (MySQL 8.4.11, MariaDB
11.4.13), mysql2 3.24.5, knex 3.1.0. Results that shaped the implementation:

**Install / packaging**

- Yarn can't hoist mysql2 to the root `node_modules`: it needs `iconv-lite ^0.7.3` while the root resolves
  0.6.3, so mysql2 lives in `server/node_modules`, where knex's stock `require('mysql2')` (from the root) can't
  see it. `mysql-knex-dialect-client.ts` subclasses knex's mysql2 dialect and injects the driver.

**Client-side formatting (sql-escaper 1.5.2)**

- A `?` inside a backtick-quoted identifier or a single-quoted literal is NOT treated as a placeholder, so a
  column named `Featured?` is safe. A `?` inside a double-quoted string or after `#` IS substituted (it
  consumes a limit/offset/watermark binding). The filter validator therefore rejects `?`, `"` and `#`.
- BigInt binds as an unquoted integer literal (`9007199254740993`); Buffer binds as `X'6162'`.
- A plain object binds as `'[object Object]'` and an array as a comma list, so every JSON / object value is
  `JSON.stringify`'d before binding.
- A Date binds as `'2026-01-02 03:04:05.678'` with `timezone: 'Z'`.

**Result decoding (typeCast)**

- Field `type` names: TIMESTAMP, DATETIME, DATE, JSON, BIT, GEOMETRY, BLOB (also TEXT; charset decides),
  VAR_STRING, STRING (CHAR / ENUM / SET / BINARY), LONGLONG, NEWDECIMAL, TINY, TIME, YEAR.
- The typeCast is called for NULL too; `string()` / `buffer()` return null.
- MariaDB's JSON alias arrives as `BLOB` with `extendedFormat: 'json'`. mysql2's own parse of it turns integers
  above 2^53 into strings inside the document, so the decoder parses the raw text itself.
- GEOMETRY bytes carry the 4-byte SRID prefix (`e6100000` for 4326), followed by the WKB.
- `disableEval: true` produces identical results.
- Catalog BIGINT columns (`CHARACTER_MAXIMUM_LENGTH`, ...) arrive as strings under `bigNumberStrings`.
- MariaDB reports `COLUMN_DEFAULT = 'NULL'` (a string) for nullable columns and `int(11)` display widths; its
  EXTRA uses `on update current_timestamp()` (lower case). The JSON alias CHECK constraint is named after the
  column, with clause ``json_valid(`col`)``.

**Writes**

- `insertId` is a number below 2^53 and a string at or above it.
- With FOUND_ROWS, a no-op UPDATE reports `affectedRows = 1` (matched, not changed). `UPDATE … LIMIT 2` and
  `DELETE … LIMIT 2` over 3 matching rows report 2 (the multi-row guard works) on both flavors.
- A hostile session `sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'` followed by our session sql_mode round-trips
  `a'b\c` byte-exact.

**Errors (shapes the mapper keys on)**

| Case                                          | code / errno                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| wrong password                                | ER_ACCESS_DENIED_ERROR 1045 (message contains the client IP — never echoed)                      |
| unknown database as a scoped user             | ER_DBACCESS_DENIED_ERROR 1044                                                                    |
| unknown database as root                      | ER_BAD_DB_ERROR 1049                                                                             |
| SELECT over `max_execution_time` (MySQL)      | ER_QUERY_TIMEOUT 3024                                                                            |
| statement over `max_statement_time` (MariaDB) | errno 1969, **no code**                                                                          |
| unknown session variable                      | ER_UNKNOWN_SYSTEM_VARIABLE 1193 (`max_statement_time` on MySQL, `max_execution_time` on MariaDB) |
| bad integer                                   | ER_TRUNCATED_WRONG_VALUE_FOR_FIELD 1366                                                          |
| duplicate table                               | ER_TABLE_EXISTS_ERROR 1050                                                                       |
| incompatible FK columns                       | MySQL ER_FK_INCOMPATIBLE_COLUMNS 3780; MariaDB ER_CANT_CREATE_TABLE 1005                         |
| row too large                                 | ER_TOO_BIG_ROWSIZE 1118                                                                          |
| VERIFY_CA without the server's CA             | HANDSHAKE_SSL_ERROR (fatal)                                                                      |
| VERIFY_IDENTITY, cert without matching SAN    | HANDSHAKE_SSL_ERROR ("Hostname/IP does not match …")                                             |
| MariaDB ed25519 user                          | AUTH_SWITCH_PLUGIN_ERROR                                                                         |
| closed port                                   | ECONNREFUSED (message contains the IP)                                                           |
| `localhost` closed port                       | AggregateError with code ECONNREFUSED (both address families tried)                              |
| unresolvable host                             | ENOTFOUND                                                                                        |
| unroutable host                               | ETIMEDOUT                                                                                        |

**TLS / auth**

- mysql2 assigns `ssl.rejectUnauthorized` on the passed object and throws on a frozen one, so every client
  builds a fresh ssl object.
- VERIFY_CA with the server's `ca.pem` (read by root via `LOAD_FILE`, needs `--secure-file-priv=`) connects.
- caching_sha2_password full authentication works over plaintext (RSA key exchange) and over TLS.
  mysql_native_password works with `--mysql-native-password=ON` on 8.4.
- A `stream` factory + TLS (`host` kept as the hostname) + a non-enumerable `password` all work — the seam the
  host guard will use.

**knex**

- The async connection provider (returning `expirationChecker: () => true`) and `afterCreate` run once per
  physical connection, including after an idle reap. An `afterCreate` error surfaces to the caller.
- With `compileSqlOnError: false` the error message keeps `?` placeholders (no values), but `error.sql` still
  carries the interpolated SQL — the mapper never surfaces either.
- `raw` returns `[rows, fields]`.

**DDL**

- MySQL 8.4 creates and fills a table with 190 `MEDIUMTEXT` columns but not 200 (1118), so the created-table
  field cap is 180. MariaDB 11.4 handles 200.
- `ALTER TABLE … ADD COLUMN …, ADD CONSTRAINT … FOREIGN KEY …` is atomic on both flavors: when the FK fails, the
  column is not left behind.
- MySQL 8.4 EXTRA values: `auto_increment`, `VIRTUAL GENERATED`, `STORED GENERATED`, `INVISIBLE`,
  `DEFAULT_GENERATED` (any expression default, incl. `DEFAULT (uuid())`) and
  `DEFAULT_GENERATED on update CURRENT_TIMESTAMP`.
- MySQL 8.4 ROUNDS the fraction written into a precision-0 DATETIME (`…:05.678` → `…:06`, carrying into the next
  day/year); MariaDB 11.4 truncates. MySQL reports precision 0 as plain `datetime`, never `datetime(0)`, so the
  write path truncates to the column's precision itself.

## 2026-09-29 — implementation findings

- MariaDB flags a column as JSON (`extendedFormat: 'json'` in result metadata) for ANY column-level CHECK whose
  top-level AND list contains `json_valid(...)` — not for table-level checks, and not always for the JSON alias
  when a custom CHECK replaced the implicit one. Discovery therefore reads the result metadata
  (`SELECT * … LIMIT 0`) instead of `CHECK_CONSTRAINTS`, so the schema and the row decoder always agree.
- MariaDB 11.4 reports explicit `ROW START` / `ROW END` period columns as `STORED GENERATED`. Tables with an
  explicit `PERIOD FOR SYSTEM_TIME` get the row-end column added to every unique key, so they show as disabled
  (implicit `WITH SYSTEM VERSIONING` tables work).
- A `?` written directly inside backticks in `knex.raw` SQL is still counted as a knex placeholder ("Expected 1
  bindings, saw 2"); identifiers always go through `??` bindings.
- mysql2 throws on a column named `__proto__` / `__defineGetter__` (its row builder refuses prototype keys), so
  such a table can't be pulled.
- VERIFY_IDENTITY with an IP-literal host: mysql2 sends no SNI name and Node checks the certificate against
  `localhost`, so a certificate for the IP fails and one for "localhost" passes. The credential parser rejects
  that combination.

## 2026-10-20 — enabled for all users (DEV-12035)

- `visible: true`, and the interim Cloud Run tripwire (`RUNNING_IN_CLOUD=true` → refuse every connection) is
  removed, so deployed test / production connect. Decided without the database host guard (Postgres / Supabase
  parity) and before a managed-database `/connector-build-execute` pass; both stay in STATE.md's TODOs.
- Port 3306 leaves the VPC flow-log suspicious-egress-port alert in a separate terraform MR.
