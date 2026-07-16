/**
 * PostgreSQL data type → TypeBox schema mapping.
 * Shared by all Knex-based PG connectors.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import { PostgresColumnType } from '@spinner/shared-types';
import { dotPath, type DotPath } from '../../types';
import type { InformationSchemaColumn } from './knex-pg-types';

export const PG_NUMERIC_TYPES = new Set([
  'integer',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'numeric',
  'decimal',
  'real',
  'double precision',
  'float',
  'float4',
  'float8',
  'int2',
  'int4',
  'int8',
]);

export const PG_BOOLEAN_TYPES = new Set(['boolean', 'bool']);

export const PG_TEXT_TYPES = new Set(['text', 'varchar', 'char', 'character varying', 'character', 'uuid', 'citext']);

/**
 * Column names that make a good record title, by convention. The first text-typed
 * column (in table-column order) whose name matches one of these is used as the title.
 */
export const TITLE_COLUMN_CANDIDATES = ['name', 'title', 'display_name', 'label'];

/**
 * Pick the dot-path of the column to use as a record's title, following the
 * shared SQL convention: the first text-typed column whose name is one of
 * `TITLE_COLUMN_CANDIDATES`. Returns `undefined` when the table has no such column.
 */
export function pickTitleColumnPath(columns: InformationSchemaColumn[]): DotPath | undefined {
  for (const col of columns) {
    if (TITLE_COLUMN_CANDIDATES.includes(col.column_name) && PG_TEXT_TYPES.has(col.udt_name)) {
      return dotPath(col.column_name);
    }
  }
  return undefined;
}

export const PG_TIMESTAMP_TYPES = new Set([
  'timestamp',
  'timestamp without time zone',
  'timestamp with time zone',
  'timestamptz',
]);

export const PG_DATE_TYPES = new Set(['date']);

export const PG_JSON_TYPES = new Set(['json', 'jsonb']);

/** Map a scalar PostgreSQL type name to a TypeBox schema and PostgresColumnType. */
export function mapScalarPgType(typeName: string): { schema: TSchema; pgType: PostgresColumnType } {
  const t = typeName.toLowerCase();
  if (PG_NUMERIC_TYPES.has(t)) return { schema: Type.Number(), pgType: PostgresColumnType.NUMERIC };
  if (PG_BOOLEAN_TYPES.has(t)) return { schema: Type.Boolean(), pgType: PostgresColumnType.BOOLEAN };
  if (PG_TEXT_TYPES.has(t)) return { schema: Type.String(), pgType: PostgresColumnType.TEXT };
  if (PG_TIMESTAMP_TYPES.has(t))
    return { schema: Type.String({ format: 'date-time' }), pgType: PostgresColumnType.TIMESTAMP };
  // A Postgres `date` column is typed `format: 'date-time'`, not `'date'`, because the
  // `node-postgres` driver parses the `date` OID (1082) into a JS `Date`, which serializes to a
  // full RFC 3339 date-time on disk (e.g. `"1944-11-19T00:00:00.000Z"`) rather than `YYYY-MM-DD`.
  // The stored value is therefore always a date-time, so `format: 'date'` would never match it and
  // floods otherwise-verbatim records with false-positive format errors (DEV-10453). Display is
  // unaffected: both date and timestamp columns share `pgType: TIMESTAMP`, which the view renders
  // as a `date` column regardless of this format.
  if (PG_DATE_TYPES.has(t))
    return { schema: Type.String({ format: 'date-time' }), pgType: PostgresColumnType.TIMESTAMP };
  if (PG_JSON_TYPES.has(t)) return { schema: Type.Unknown(), pgType: PostgresColumnType.JSONB };
  return { schema: Type.Unknown(), pgType: PostgresColumnType.TEXT };
}

/** Map a PostgreSQL data type (handling array types) to a TypeBox schema and PostgresColumnType. */
export function mapPgType(
  dataType: string,
  udtName: string,
  isNullable: boolean,
): { schema: TSchema; pgType: PostgresColumnType } {
  let schema: TSchema;
  let pgType: PostgresColumnType;

  if (dataType === 'ARRAY' || udtName.startsWith('_')) {
    const elementUdtName = udtName.startsWith('_') ? udtName.slice(1) : udtName;
    const elementMapping = mapScalarPgType(elementUdtName);
    if (elementMapping.pgType === PostgresColumnType.NUMERIC) {
      schema = Type.Array(Type.Number());
      pgType = PostgresColumnType.NUMERIC_ARRAY;
    } else if (elementMapping.pgType === PostgresColumnType.BOOLEAN) {
      schema = Type.Array(Type.Boolean());
      pgType = PostgresColumnType.BOOLEAN_ARRAY;
    } else {
      schema = Type.Array(Type.String());
      pgType = PostgresColumnType.TEXT_ARRAY;
    }
  } else {
    const mapping = mapScalarPgType(udtName.length > 0 ? udtName : dataType);
    schema = mapping.schema;
    pgType = mapping.pgType;
  }

  if (isNullable) {
    schema = Type.Union([schema, Type.Null()]);
  }

  return { schema, pgType };
}
