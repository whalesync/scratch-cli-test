/**
 * Preserve a literal `.` and a `" as "` alias split inside a Postgres *column*
 * identifier across knex's identifier formatter (DEV-11063, DEV-11170).
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
 * The SAME sentinel technique preserves a `" as "` alias split (DEV-11170).
 * knex's `wrapString` finds `" as "` case-insensitively and slices the 4-char
 * separator out before `client.alias` (our other hook) ever sees it, so the
 * alias rejoin can only re-emit a hardcoded lowercase `" as "` — turning a real
 * column `"Certified AS Organic"` into `"Certified as Organic"`.
 * {@link encodeColumnIdentifierAsSeparatorForKnex} replaces just the two flanking
 * spaces of each `" as "` with a second sentinel (leaving the `as` casing
 * untouched) so knex no longer detects an alias, and the same `wrapIdentifier`
 * hook restores them ({@link decodeColumnIdentifierAsSeparatorSentinel}),
 * preserving the exact casing. {@link encodeColumnIdentifierForKnex} neutralizes
 * BOTH hazards at once.
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

/**
 * Sentinel standing in for one of the two SPACES around a `" as "` alias
 * separator while a column identifier passes through knex's identifier splitter
 * (DEV-11170). U+0001 (SOH) is a C0 control character: unlike the dot sentinel's
 * U+0000 — the one byte Postgres actually forbids inside an identifier — it is
 * technically legal in a quoted identifier, but it does not occur in the
 * human-authored field names these connectors handle (a name literally
 * containing U+0001 would be decoded back to a space). It is a distinct code
 * point from the dot sentinel so the two never collide and the `wrapIdentifier`
 * hook can restore each sentinel to its own literal (a `.` vs a space).
 */
const COLUMN_IDENTIFIER_AS_SEPARATOR_SPACE_SENTINEL = String.fromCharCode(1);

/**
 * Neutralize knex's case-insensitive `" as "` alias split inside a column
 * identifier while preserving the separator's ORIGINAL casing (DEV-11170).
 *
 * knex's `wrapString` locates the separator with `value.toLowerCase().indexOf('
 * as ')` and slices the 4-char ` as ` substring out, so by the time the
 * `client.alias` hook runs it holds only the two quoted halves and must rejoin
 * with a hardcoded lowercase ` as ` — `"Certified AS Organic"` becomes
 * `"Certified as Organic"`. We replace only the two flanking SPACES of each
 * ` as ` with the sentinel (the `as`/`AS`/`As` keyword — the middle two chars —
 * is kept verbatim), so knex no longer detects an alias and the `wrapIdentifier`
 * hook restores the spaces around the untouched keyword. The `/ as /gi` match
 * mirrors knex's own detection; a global replace covers the recursive
 * multi-` as ` case, and any pathological overlap simply collapses to one
 * verbatim identifier (the correct outcome). Reversed by
 * {@link decodeColumnIdentifierAsSeparatorSentinel} inside the `wrapIdentifier`
 * hook.
 */
export function encodeColumnIdentifierAsSeparatorForKnex(columnIdentifier: string): string {
  return columnIdentifier.replace(
    / as /gi,
    (spacedAsSeparator) =>
      `${COLUMN_IDENTIFIER_AS_SEPARATOR_SPACE_SENTINEL}${spacedAsSeparator.slice(1, -1)}${COLUMN_IDENTIFIER_AS_SEPARATOR_SPACE_SENTINEL}`,
  );
}

/**
 * Restore the sentinel back to the literal spaces that flanked a `" as "`
 * separator. Installed (composed with the dot decode) as knex's `wrapIdentifier`
 * hook; a no-op for any identifier that was never encoded, so it is safe to
 * apply globally to every identifier knex wraps.
 */
export function decodeColumnIdentifierAsSeparatorSentinel(identifier: string): string {
  return identifier.split(COLUMN_IDENTIFIER_AS_SEPARATOR_SPACE_SENTINEL).join(' ');
}

/**
 * Neutralize BOTH of knex's identifier structural-split hazards in a column name
 * at once — a literal `.` (qualification chain, DEV-11063) and a `" as "` alias
 * split (DEV-11170) — so the name is emitted as one verbatim, correctly-cased
 * quoted identifier. Use at every column-identifier site handed to the knex
 * query/schema builder (never on a `schema.table` reference). Reversed by
 * {@link decodeColumnIdentifierForKnex} in the `wrapIdentifier` hook.
 */
export function encodeColumnIdentifierForKnex(columnIdentifier: string): string {
  return encodeColumnIdentifierAsSeparatorForKnex(encodeColumnIdentifierDotsForKnex(columnIdentifier));
}

/**
 * Reverse {@link encodeColumnIdentifierForKnex}: restore both the literal `.`
 * and the spaces around a `" as "` separator. Installed as knex's
 * `wrapIdentifier` hook by `applyVerbatimIdentifierQuoting`.
 */
export function decodeColumnIdentifierForKnex(identifier: string): string {
  return decodeColumnIdentifierAsSeparatorSentinel(decodeColumnIdentifierSentinelDots(identifier));
}

/**
 * Make a column name safe for ALL of knex's identifier special characters in one
 * call:
 *
 *  - `?` is knex's positional-binding placeholder. It is substituted in the
 *    COMPILED SQL string — schema-builder DDL included — so an unescaped `?`
 *    inside a column identifier is replaced with a `$n` binding reference:
 *    creating a column named `Featured?` actually created `"Featured$1"`,
 *    which then broke created-field resolution at sync-draft save (found by
 *    the SANITY Live Export audit 2026-08-01 — the deployed Studio schema's
 *    authored title "Featured?"). `\?` is knex's documented literal escape,
 *    un-escaped by the formatter after binding interpolation.
 *  - `.` (knex's qualification separator, DEV-11063) and a `" as "` alias split
 *    (DEV-11170) are both sentinel-encoded by
 *    {@link encodeColumnIdentifierForKnex} so the column survives as one
 *    verbatim, correctly-cased identifier.
 *
 * Apply to COLUMN identifiers only, never to a `schema.table` reference.
 */
export function escapeKnexColumnIdentifierSpecialCharacters(columnIdentifier: string): string {
  return encodeColumnIdentifierForKnex(columnIdentifier.replace(/\?/g, '\\?'));
}
