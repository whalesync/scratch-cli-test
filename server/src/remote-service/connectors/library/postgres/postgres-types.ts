/**
 * Types for the PostgreSQL connector.
 */

export interface PostgresCredentials {
  connectionString: string;
}

export interface PostgresColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  udt_name: string;
  character_maximum_length: number | null;
  column_default: string | null;
}

/**
 * Mapping from PostgreSQL data types to our internal PostgresColumnType values.
 * Used by the connector to determine how to represent PG columns.
 */
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

export const PG_TIMESTAMP_TYPES = new Set(['timestamp', 'timestamp without time zone', 'timestamp with time zone']);

export const PG_DATE_TYPES = new Set(['date']);

export const PG_JSON_TYPES = new Set(['json', 'jsonb']);

export interface PostgresForeignKey {
  constraint_name: string;
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}
