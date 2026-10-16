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
import { type Knex } from 'knex';

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
 * Delimiter around the hex code point of one leading/trailing whitespace character
 * in a column identifier while it passes through knex's identifier formatter.
 * U+0002 (STX) is a C0 control character that, like the `" as "` sentinel, does
 * not occur in the human-authored field names these connectors handle, and it is
 * not whitespace — so `String.prototype.trim` keeps it.
 */
const COLUMN_IDENTIFIER_EDGE_WHITESPACE_SENTINEL = String.fromCharCode(2);

const COLUMN_IDENTIFIER_ENCODED_EDGE_WHITESPACE_PATTERN = new RegExp(
  `${COLUMN_IDENTIFIER_EDGE_WHITESPACE_SENTINEL}([0-9a-f]+)${COLUMN_IDENTIFIER_EDGE_WHITESPACE_SENTINEL}`,
  'g',
);

/**
 * Preserve leading/trailing whitespace in a column identifier across knex's
 * identifier formatter, which `trim()`s every identifier before quoting it — a
 * HubSpot label "Lead Source " was created as the column `"Lead Source"`, so the
 * bulk UPDATE (raw SQL, quoted verbatim) failed with "column does not exist" and
 * pulls returned a key that matched no schema field. Each edge whitespace
 * character (JS `\s`, the same set `trim()` removes, including a non-breaking
 * space) becomes `<sentinel><hex code point><sentinel>`, which `trim()` keeps.
 * Interior whitespace is untouched. Reversed by
 * {@link decodeColumnIdentifierEdgeWhitespaceSentinels} inside the
 * `wrapIdentifier` hook.
 */
export function encodeColumnIdentifierEdgeWhitespaceForKnex(columnIdentifier: string): string {
  return columnIdentifier.replace(/^\s+|\s+$/g, (edgeWhitespaceRun) =>
    Array.from(edgeWhitespaceRun)
      .map(
        (whitespaceCharacter) =>
          `${COLUMN_IDENTIFIER_EDGE_WHITESPACE_SENTINEL}${(whitespaceCharacter.codePointAt(0) ?? 0).toString(16)}${COLUMN_IDENTIFIER_EDGE_WHITESPACE_SENTINEL}`,
      )
      .join(''),
  );
}

/** Restore each encoded edge whitespace character; a no-op for any identifier that was never encoded. */
export function decodeColumnIdentifierEdgeWhitespaceSentinels(identifier: string): string {
  return identifier.replace(COLUMN_IDENTIFIER_ENCODED_EDGE_WHITESPACE_PATTERN, (_encoded, hexCodePoint: string) =>
    String.fromCodePoint(parseInt(hexCodePoint, 16)),
  );
}

/**
 * Neutralize every knex identifier hazard a column NAME can trip in one call — a
 * literal `.` (qualification chain, DEV-11063), a `" as "` alias split
 * (DEV-11170), and leading/trailing whitespace (`trim()`) — so the name is
 * emitted as one verbatim, correctly-cased quoted identifier. Use at every
 * column-identifier site handed to the knex query/schema builder (never on a
 * `schema.table` reference). Reversed by {@link decodeColumnIdentifierForKnex} in
 * the `wrapIdentifier` hook.
 */
export function encodeColumnIdentifierForKnex(columnIdentifier: string): string {
  return encodeColumnIdentifierEdgeWhitespaceForKnex(
    encodeColumnIdentifierAsSeparatorForKnex(encodeColumnIdentifierDotsForKnex(columnIdentifier)),
  );
}

/**
 * Reverse {@link encodeColumnIdentifierForKnex}: restore the literal `.`, the
 * spaces around a `" as "` separator, and leading/trailing whitespace. Installed
 * as knex's `wrapIdentifier` hook by `applyVerbatimIdentifierQuoting`.
 */
export function decodeColumnIdentifierForKnex(identifier: string): string {
  return decodeColumnIdentifierEdgeWhitespaceSentinels(
    decodeColumnIdentifierAsSeparatorSentinel(decodeColumnIdentifierSentinelDots(identifier)),
  );
}

/**
 * Double-quote a Postgres identifier verbatim (inner `"` doubled). Replaces knex's
 * Postgres `wrapIdentifierImpl`, which reads the first `[<digits>]` in an
 * identifier as an array subscript and drops everything after it: a HubSpot label
 * "Tier [1] score" compiled to `"Tier "[1]`, a syntax error that failed the WHOLE
 * `CREATE TABLE`. No knex instance these hooks are installed on addresses an array
 * element through an identifier, so the subscript parsing is never wanted. The
 * bare `*` (select-all / `returning('*')`) still goes through knex's own
 * implementation, which leaves it unquoted.
 */
function quotePostgresIdentifierVerbatim(
  identifier: string,
  knexWrapIdentifierImpl: (value: string) => string,
): string {
  if (identifier === '*') {
    return knexWrapIdentifierImpl(identifier);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
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
 *  - `.` (knex's qualification separator, DEV-11063), a `" as "` alias split
 *    (DEV-11170) and leading/trailing whitespace (knex `trim()`s identifiers)
 *    are all sentinel-encoded by {@link encodeColumnIdentifierForKnex} so the
 *    column survives as one verbatim, correctly-cased identifier.
 *
 * Apply to COLUMN identifiers only, never to a `schema.table` reference.
 */
export function escapeKnexColumnIdentifierSpecialCharacters(columnIdentifier: string): string {
  return encodeColumnIdentifierForKnex(columnIdentifier.replace(/\?/g, '\\?'));
}

/**
 * Undo knex's identifier alias-splitting for a column whose real name contains `" as "`.
 *
 * Knex's identifier formatter treats a bare `" as "` inside any identifier as SQL aliasing and
 * rewrites e.g. `"Marked as done time"` into `"Marked" as "done time"` — silently corrupting the
 * column name in CREATE / INSERT / SELECT / UPDATE for any Postgres/Supabase column whose name
 * contains " as " (a legitimate name we must preserve verbatim — Connector Prime Directive). There
 * is no config hook to disable the split: it happens in knex's module-level `wrapString` BEFORE the
 * `wrapIdentifier` hook runs. But knex funnels every such split through `client.alias(first, second)`
 * with both halves already quoted, and no knex instance these hooks are installed on emits an
 * intentional SQL alias through the query builder (the only `... AS ...` they use lives inside
 * `knex.raw` strings, which bypass this path). So overriding `alias` to rejoin the halves into one
 * correctly-quoted identifier is a safe, global fix. Each half is a `wrapIdentifierImpl` result
 * (`"…"` with any inner `"` doubled); we unwrap both, rejoin with " as ", and re-quote.
 *
 * As of DEV-11170 this is the belt-and-suspenders FALLBACK: column identifiers routed through {@link
 * escapeKnexColumnIdentifierSpecialCharacters} / `encodeColumnIdentifierForKnex` are sentinel-encoded
 * so knex never splits them and their exact casing is preserved. This override only fires for an
 * identifier path that bypassed that encoding, where it still yields ONE valid identifier but — since
 * knex has already discarded the separator's casing before `alias` runs — lowercases the " as ".
 * (DEV-11051, DEV-11170)
 */
function rejoinKnexAliasSplitIdentifier(quotedFirstHalf: string, quotedSecondHalf: string): string {
  const unwrapQuotedIdentifier = (quoted: string): string =>
    quoted.replace(/^"/, '').replace(/"$/, '').replace(/""/g, '"');
  const rejoinedIdentifier = `${unwrapQuotedIdentifier(quotedFirstHalf)} as ${unwrapQuotedIdentifier(quotedSecondHalf)}`;
  return `"${rejoinedIdentifier.replace(/"/g, '""')}"`;
}

/**
 * Install the identifier-preserving hooks on a knex instance so a Postgres column name survives
 * verbatim through knex's formatter even when it contains a substring knex would otherwise treat as
 * structure (Connector Prime Directive):
 *
 *  - `.` (DEV-11063) and `" as "` (DEV-11170) — install a `wrapIdentifier` hook that decodes the
 *    sentinels a column name's dots and `" as "` separator-spaces were encoded to ({@link
 *    decodeColumnIdentifierForKnex}) back to their literals before the default quoting, so the
 *    encoded name is emitted as one verbatim, correctly-cased identifier (`"Dealroom.co URL"`,
 *    `"Certified AS Organic"`).
 *  - `" as "` fallback — also override `client.alias` to rejoin any mis-split halves for an
 *    identifier path that bypassed the sentinel encoding ({@link rejoinKnexAliasSplitIdentifier},
 *    DEV-11051); it yields one valid identifier but lowercases the separator.
 *  - leading/trailing whitespace — the same hook decodes the edge-whitespace sentinels knex's
 *    `trim()` would otherwise have stripped ({@link encodeColumnIdentifierEdgeWhitespaceForKnex}).
 *  - `[<digits>]` — the hook quotes the identifier itself ({@link quotePostgresIdentifierVerbatim})
 *    instead of calling knex's Postgres implementation, which reads `[1]` as an array subscript.
 *    This applies to every identifier, table names included.
 *
 * Applied by the `KnexPGClient` constructor, and by the connection-less knex that renders DDL as
 * standalone SQL (`pg-create-schema-standalone-sql.ts`), so both emit identical identifiers. It
 * lives here rather than beside `KnexPGClient` so that renderer doesn't depend on the live client
 * module. `knex.client` is typed `any`; narrow it to just the two hooks we replace.
 */
export function applyVerbatimIdentifierQuoting(knexInstance: Knex): void {
  const knexClientHooks = knexInstance.client as {
    alias: (first: string, second: string) => string;
    config: { wrapIdentifier?: (value: string, origImpl: (value: string) => string) => string };
  };
  knexClientHooks.alias = rejoinKnexAliasSplitIdentifier;
  knexClientHooks.config.wrapIdentifier = (value, origImpl) =>
    quotePostgresIdentifierVerbatim(decodeColumnIdentifierForKnex(value), origImpl);
}
