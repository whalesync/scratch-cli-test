/**
 * Exact native Postgres column types for create-schema fidelity (DEV-11903).
 *
 * The read side annotates every column with its exact `format_type()` spelling (`integer`, `text[]`,
 * `numeric(10,2)`, `timestamp(3) with time zone`) under `x-scratch-native-column-type`. When a Live Export
 * copies a Postgres/Supabase table into a Postgres/Supabase destination — the same type system — the
 * plan carries that type as `CreateFieldSpec.nativeFieldType` and `pg-create-schema.ts` creates the column
 * with exactly that type instead of the lossy logical approximation (`text[]` → `text`, `integer` →
 * `double precision`, `bigint` → `text`).
 *
 * Only a deliberately small set of types is RECREATABLE: built-in types whose value, as the `pg` driver
 * pulls it into a record file, writes back into a column of the same type unchanged. Everything else —
 * enums/domains/extension types (which may not exist in the destination database) and built-ins whose
 * pulled JS shape doesn't write back as-is (`bytea` arrives as Node's `{ type: 'Buffer', data: [...] }`,
 * `interval` as an object) — keeps the logical mapping. The same predicate guards the create side, because
 * `nativeFieldType.type` reaches `knex.specificType` (raw SQL): a type outside the grammar + allowlist below
 * is refused, never interpolated.
 */
import type { NativeColumnTypeAnnotation } from '@spinner/shared-types';
import type { InformationSchemaColumn } from './knex-pg-types';

/** The native type system shared by every Knex-based Postgres connector (Postgres, Supabase). */
export const POSTGRES_NATIVE_TYPE_SYSTEM = 'postgres';

/**
 * Built-in scalar types (as `format_type()` spells them, with any `(n)` / `(p,s)` modifier removed) whose
 * pulled value round-trips into a column of the same type. Arrays of these are recreatable too, except
 * JSON arrays — see {@link POSTGRES_SCALAR_TYPES_NOT_RECREATABLE_AS_ARRAY_ELEMENTS}.
 */
const RECREATABLE_POSTGRES_SCALAR_TYPE_NAMES: ReadonlySet<string> = new Set([
  'text',
  'character varying',
  'character',
  'uuid',
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'real',
  'double precision',
  'boolean',
  'date',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
  'json',
  'jsonb',
]);

/** `json[]` / `jsonb[]` element values are pulled as parsed JSON and don't write back through a pg array literal. */
const POSTGRES_SCALAR_TYPES_NOT_RECREATABLE_AS_ARRAY_ELEMENTS: ReadonlySet<string> = new Set(['json', 'jsonb']);

/**
 * `format_type()` output for a (possibly array) built-in type: a lowercase base name, an optional numeric
 * modifier (`(50)`, `(10,2)`, `(3)`), an optional time-zone suffix (which follows the modifier for
 * `timestamp(3) with time zone`), and an optional `[]`. Anything else — quoted names (`"char"`),
 * schema-qualified user types (`public.mood`), stray characters — fails to match and is never recreated.
 */
const POSTGRES_FORMAT_TYPE_GRAMMAR =
  /^(?<baseTypeName>[a-z][a-z ]*?)(?:\(\d{1,4}(?:,\d{1,4})?\))?(?<timeZoneSuffix> with(?:out)? time zone)?(?<arraySuffix>\[\])?$/;

/**
 * Whether a destination can create a column of exactly this `format_type()` type and write the source's
 * pulled values into it unchanged. Also the safety gate for interpolating the type into DDL.
 */
export function isRecreatablePostgresNativeColumnType(formatTypeSpelling: string): boolean {
  const match = POSTGRES_FORMAT_TYPE_GRAMMAR.exec(formatTypeSpelling);
  if (!match?.groups) return false;
  const scalarTypeName = `${match.groups.baseTypeName}${match.groups.timeZoneSuffix ?? ''}`;
  if (!RECREATABLE_POSTGRES_SCALAR_TYPE_NAMES.has(scalarTypeName)) return false;
  const isArrayType = match.groups.arraySuffix !== undefined;
  return !(isArrayType && POSTGRES_SCALAR_TYPES_NOT_RECREATABLE_AS_ARRAY_ELEMENTS.has(scalarTypeName));
}

/**
 * The `x-scratch-native-column-type` annotation for a column, or undefined when the catalog query didn't
 * report its native type. A type is recreatable only when its (element) type lives in `pg_catalog` AND
 * passes {@link isRecreatablePostgresNativeColumnType}.
 */
export function postgresNativeColumnTypeAnnotation(
  column: InformationSchemaColumn,
): NativeColumnTypeAnnotation | undefined {
  if (!column.native_type) return undefined;
  return {
    typeSystem: POSTGRES_NATIVE_TYPE_SYSTEM,
    type: column.native_type,
    isRecreatableVerbatim:
      column.native_type_is_built_in === true && isRecreatablePostgresNativeColumnType(column.native_type),
  };
}
