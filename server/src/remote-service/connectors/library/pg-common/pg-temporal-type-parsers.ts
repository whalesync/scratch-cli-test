/**
 * Per-connection `node-postgres` type parsers for the Postgres / Supabase connectors (DEV-12576).
 *
 * The driver's default parsers turn `date` (OID 1082) and `timestamp without time zone` (OID 1114), and their
 * arrays, into a JS `Date` built in the Node process's LOCAL time zone. The value we stored therefore depended on
 * the server's `TZ`: a `date` of `1965-07-31` became `"1965-07-31T04:00:00.000Z"` on a New York host, and a naive
 * `timestamp` shifted by the host's UTC offset. Production runs in UTC, which hid it; on every other host (local
 * dev, the Live Export audit harness) the stored value never matched what a source wrote, so Live Exports
 * re-published every date field on every run.
 *
 * - `date` / `date[]` keep the driver's verbatim text (`1965-07-31`, `infinity`, `0044-03-15 BC`): a calendar date
 *   has no instant to render, so storing one would invent a time zone (Connector Prime Directive; same reasoning
 *   as NUMERIC, DEV-10777). `pg-type-mapping.ts` types a scalar `date` column `format: 'date'` (`date[]` is a plain
 *   `string[]`).
 * - `timestamp` / `timestamp[]` (without time zone) parse as UTC wall-clock, so the stored ISO string is the same on
 *   every host and identical to what production (UTC) has always stored. No existing value changes.
 *
 * `timestamp with time zone` carries its own offset and is left to the driver.
 *
 * These parsers go to each connector connection through node-postgres's `types` config and are never registered on
 * the process-global `pg.types`: the server's own Knex (`db.service.ts`) reads Prisma's `timestamp(3)` columns
 * through the same driver and keeps the default parsing.
 */
import { type Knex } from 'knex';
import { types as nodePostgresDefaultTypeParsers } from 'pg';

// Typed `number`, not as literals: the driver's `TypeId` enum has no members for the array OIDs.
const POSTGRES_DATE_TYPE_OID: number = 1082;
const POSTGRES_DATE_ARRAY_TYPE_OID: number = 1182;
const POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID: number = 1114;
const POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_ARRAY_TYPE_OID: number = 1115;
const POSTGRES_TIMESTAMP_WITH_TIME_ZONE_TYPE_OID: number = 1184;
const POSTGRES_TEXT_ARRAY_TYPE_OID: number = 1009;

const POSTGRES_INFINITY_TEXT_PATTERN = /^-?infinity$/;
const POSTGRES_BC_ERA_SUFFIX = ' BC';

type PostgresTextValueParser = (postgresTextValue: string) => unknown;

function keepPostgresTextVerbatim(postgresTextValue: string): string {
  return postgresTextValue;
}

/** A Postgres array literal (`{2026-01-02,NULL}`) → nested arrays of element text, with `NULL` as `null`. */
function parsePostgresArrayLiteralIntoElementText(postgresArrayLiteral: string): unknown {
  const parseTextArray = nodePostgresDefaultTypeParsers.getTypeParser(POSTGRES_TEXT_ARRAY_TYPE_OID, 'text') as (
    postgresArrayLiteral: string,
  ) => unknown;
  return parseTextArray(postgresArrayLiteral);
}

function mapEveryNonNullArrayElement(parsedArrayOrElement: unknown, mapElementText: PostgresTextValueParser): unknown {
  if (Array.isArray(parsedArrayOrElement)) {
    return parsedArrayOrElement.map((nestedArrayOrElement) =>
      mapEveryNonNullArrayElement(nestedArrayOrElement, mapElementText),
    );
  }
  return typeof parsedArrayOrElement === 'string' ? mapElementText(parsedArrayOrElement) : parsedArrayOrElement;
}

/**
 * A naive `timestamp` text (`2026-08-05 04:30:15.123456`, `0044-03-15 12:00:00 BC`) parsed as UTC: it gets a `+00`
 * offset in the position Postgres prints one for `timestamptz` (before a ` BC` suffix) and goes through the driver's
 * own `timestamptz` parser, so BC years and `infinity` keep the driver's existing handling.
 */
export function parseTimestampWithoutTimeZoneAsUtc(timestampText: string): unknown {
  const parseTimestampWithTimeZone = nodePostgresDefaultTypeParsers.getTypeParser(
    POSTGRES_TIMESTAMP_WITH_TIME_ZONE_TYPE_OID,
    'text',
  ) as PostgresTextValueParser;
  if (POSTGRES_INFINITY_TEXT_PATTERN.test(timestampText)) return parseTimestampWithTimeZone(timestampText);
  const timestampTextWithUtcOffset = timestampText.endsWith(POSTGRES_BC_ERA_SUFFIX)
    ? `${timestampText.slice(0, -POSTGRES_BC_ERA_SUFFIX.length)}+00${POSTGRES_BC_ERA_SUFFIX}`
    : `${timestampText}+00`;
  return parseTimestampWithTimeZone(timestampTextWithUtcOffset);
}

const CONNECTOR_TEXT_TYPE_PARSER_OVERRIDES_BY_OID: ReadonlyMap<number, PostgresTextValueParser> = new Map<
  number,
  PostgresTextValueParser
>([
  [POSTGRES_DATE_TYPE_OID, keepPostgresTextVerbatim],
  [POSTGRES_DATE_ARRAY_TYPE_OID, parsePostgresArrayLiteralIntoElementText],
  [POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_TYPE_OID, parseTimestampWithoutTimeZoneAsUtc],
  [
    POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_ARRAY_TYPE_OID,
    (postgresArrayLiteral) =>
      mapEveryNonNullArrayElement(
        parsePostgresArrayLiteralIntoElementText(postgresArrayLiteral),
        parseTimestampWithoutTimeZoneAsUtc,
      ),
  ],
]);

/**
 * The `types` config for every connection a Postgres / Supabase connector opens: the overrides above for text-format
 * results, the driver's defaults for everything else.
 */
export const NODE_POSTGRES_TYPE_PARSERS_FOR_CONNECTOR_CONNECTIONS: Knex.PgCustomTypesConfig = {
  getTypeParser: (oid: number, format: string): unknown => {
    const resultValueFormat = format === 'binary' ? 'binary' : 'text';
    const connectorTextTypeParserOverride =
      resultValueFormat === 'text' ? CONNECTOR_TEXT_TYPE_PARSER_OVERRIDES_BY_OID.get(oid) : undefined;
    const nodePostgresDefaultTypeParser: unknown = nodePostgresDefaultTypeParsers.getTypeParser(oid, resultValueFormat);
    return connectorTextTypeParserOverride ?? nodePostgresDefaultTypeParser;
  },
};
