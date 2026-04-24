/**
 * Shared PostgreSQL type definitions for the Knex-based PG client.
 * Ported from Whalesync's postgres-types.ts — kept generic for reuse across connectors.
 */

export interface InformationSchemaColumn {
  column_name: string;
  data_type: string;
  column_default: string | null;
  is_updatable: string;
  is_nullable: string;
  domain_name: string | null;
  udt_name: string;
  character_maximum_length: number | null;
  is_identity: string;
  identity_increment: string | null;
  identity_cycle: string;
}

export interface TableName {
  table_schema: string;
  table_name: string;
  table_type: string;
}

export interface PostgresForeignKey {
  constraint_name: string;
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema?: string;
  foreign_table_name?: string;
  foreign_column_name?: string;
}

export interface PostgresEnumValue {
  enumName: string;
  enumValues: string[];
}

export interface PostgresUserDefinedType {
  type_name: string;
  type_classification: string;
}

export interface InformationSchemaCatalog {
  catalog_name: string;
  schema_name: string;
}

/**
 * Determines if a column has a generated/auto-incrementing default value.
 * Covers serial, gen_random_uuid(), now(), nanoid(), auth.uid(), and IDENTITY columns.
 */
export function isGeneratedColumn(column: InformationSchemaColumn): boolean {
  const d = column.column_default;
  if (d === null) {
    return column.is_identity === 'YES' && column.identity_increment !== null && column.identity_cycle === 'NO';
  }
  return (
    d.includes('nextval') || d.includes('gen') || d.includes('now') || d.includes('nanoid') || d.includes('auth.uid()')
  );
}

/** Standard PostgreSQL system schemas that should be excluded from table discovery. */
export const POSTGRES_SYSTEM_SCHEMAS = ['information_schema', 'pg_catalog', 'pg_toast'];

/** LIKE patterns for additional standard PostgreSQL system schema exclusion (e.g. pg_temp_*). */
export const POSTGRES_SYSTEM_SCHEMA_PATTERNS = ['pg\\_%'];

/** Supabase internal schemas that should be excluded from table discovery. */
export const SUPABASE_SYSTEM_SCHEMAS = [
  'auth',
  'extensions',
  'graphql',
  'information_schema',
  'net',
  'pgaudit',
  'pg_catalog',
  'pg_toast',
  'pgbouncer',
  'pgsodium',
  'pgrst',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'vault',
];

/** LIKE patterns for additional Supabase system schema exclusion. */
export const SUPABASE_SYSTEM_SCHEMA_PATTERNS = ['pg\\_%', 'supabase\\_%'];
