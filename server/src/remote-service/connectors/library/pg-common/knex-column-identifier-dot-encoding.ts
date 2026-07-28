/**
 * Preserve a literal `.` inside a Postgres *column* identifier across knex's
 * identifier formatter (DEV-11063).
 *
 * Knex splits any identifier on `.` into a schema/table/column qualification
 * chain: it turns the string `"Dealroom.co URL"` into `"Dealroom"."co URL"`,
 * corrupting a legitimate column name that simply contains a dot (e.g.
 * Affinity's "Dealroom.co URL" field). We must store and address that column
 * verbatim — Connector Prime Directive — so the emitted DDL/DML has to say
 * `"Dealroom.co URL"` as a single quoted identifier.
 *
 * There is no config hook to disable the split: it happens in knex's
 * module-level `wrapString`, reached from many code paths (the schema builder's
 * column compiler, query `columnize`, `knex.ref`, `orderBy`) BEFORE the
 * per-identifier `wrapIdentifier` hook runs — so overriding a single client
 * method (as we do for `" as "` via `client.alias`) cannot catch every path.
 *
 * Instead we intercept at the one choke point every path funnels through,
 * `client.wrapIdentifier`, which runs once per already-split segment. The
 * caller {@link encodeColumnIdentifierDotsForKnex encodes} each literal `.` in a
 * column identifier to a sentinel that `wrapString` won't split on, and the
 * global hook installed by `applyVerbatimIdentifierQuoting`
 * ({@link decodeColumnIdentifierSentinelDots decodes} it back to a `.` before
 * quoting). Because the encoded name is dot-free, knex treats it as one
 * identifier; the hook restores the dot inside the quotes.
 *
 * This is applied ONLY to column identifiers. Schema/table qualification
 * (`"${schema}"."${table}"`, a foreign key's target table) is passed with real
 * dots and never encoded, so it still splits into the correct multi-part
 * reference.
 */

/**
 * Sentinel standing in for a literal `.` inside a column identifier while it
 * passes through knex's identifier splitter. The NUL character (U+0000) can
 * never appear in a real Postgres identifier — Postgres identifiers are C
 * strings, so they cannot contain a NUL byte — so it can never collide with an
 * actual column name we might be preserving verbatim.
 */
const COLUMN_IDENTIFIER_LITERAL_DOT_SENTINEL = '\u0000';

/**
 * Replace every literal `.` in a column identifier with the sentinel so knex's
 * identifier formatter does not mis-split the column name into a qualification
 * chain. Call this on any column name handed to the knex query/schema builder
 * (never on a schema/table reference). Reversed by
 * {@link decodeColumnIdentifierSentinelDots} inside the `wrapIdentifier` hook.
 */
export function encodeColumnIdentifierDotsForKnex(columnIdentifier: string): string {
  return columnIdentifier.split('.').join(COLUMN_IDENTIFIER_LITERAL_DOT_SENTINEL);
}

/**
 * Restore the sentinel back to a literal `.`. Installed as knex's
 * `wrapIdentifier` hook (before the default quoting) so the final identifier is
 * a single correctly-quoted name (`"Dealroom.co URL"`). A no-op for any
 * identifier that was never encoded (schema/table names, plain columns), so it
 * is safe to apply globally to every identifier knex wraps.
 */
export function decodeColumnIdentifierSentinelDots(identifier: string): string {
  return identifier.split(COLUMN_IDENTIFIER_LITERAL_DOT_SENTINEL).join('.');
}
