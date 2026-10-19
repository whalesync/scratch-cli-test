/**
 * Normalized `information_schema` rows the discovery queries (`mysql-catalog-queries.ts`) return. Every name is
 * verbatim; every numeric catalog value is a real number (mysql2 returns catalog BIGINTs as strings under
 * `bigNumberStrings`, so the queries normalize them).
 */

/** Databases that never hold user tables. Compared case-insensitively (TiDB reports `METRICS_SCHEMA`). */
export const MYSQL_SYSTEM_DATABASE_NAMES: readonly string[] = [
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
  'metrics_schema', // TiDB
  '_vt', // Vitess
];

export function isMySqlSystemDatabaseName(databaseName: string): boolean {
  return MYSQL_SYSTEM_DATABASE_NAMES.includes(databaseName.toLowerCase());
}

/** Which databases a discovery query looks at. */
export interface MySqlDiscoveryScope {
  readonly excludedDatabaseNames: readonly string[];
  /** When the connection names a database, discovery is limited to it. */
  readonly onlyDatabaseName?: string;
}

export interface MySqlTableRow {
  readonly databaseName: string;
  readonly tableName: string;
  /** `BASE TABLE`, `VIEW`, MariaDB `SYSTEM VERSIONED`, ... */
  readonly tableType: string;
  /** `InnoDB`, `MyISAM`, ...; null for views. */
  readonly storageEngine: string | null;
}

export interface MySqlCatalogColumn {
  readonly columnName: string;
  /** `information_schema.COLUMNS.DATA_TYPE`, lower-cased (`int`, `varchar`, `longtext`, ...). */
  readonly dataType: string;
  /** `COLUMN_TYPE` verbatim (`int unsigned`, `varchar(255)`, `enum('a','b')`, MariaDB `int(11)`). */
  readonly columnType: string;
  readonly isNullable: boolean;
  /** `COLUMN_DEFAULT`; MariaDB reports the string `'NULL'` for an explicit NULL default and quotes literals. */
  readonly columnDefault: string | null;
  /** `EXTRA` verbatim (`auto_increment`, `VIRTUAL GENERATED`, `DEFAULT_GENERATED on update CURRENT_TIMESTAMP`, ...). */
  readonly extra: string;
  readonly generationExpression: string | null;
  /** Comma list, e.g. `select,insert,update,references`. */
  readonly privileges: string;
  /** `PRI`, `UNI`, `MUL` or ''. */
  readonly columnKey: string;
  readonly characterMaximumLength: number | null;
  readonly numericPrecision: number | null;
  readonly numericScale: number | null;
  readonly datetimePrecision: number | null;
  readonly characterSetName: string | null;
  readonly collationName: string | null;
  readonly ordinalPosition: number;
}

/** A column that carries a single-column (non-functional) unique index — the only safe record address. */
export interface MySqlSingleColumnUniqueIndexColumn {
  readonly indexName: string;
  readonly columnName: string;
  /** `COLUMN_TYPE` of the column. */
  readonly nativeType: string;
  readonly isPrimaryKey: boolean;
  readonly isNullable: boolean;
  readonly isAutoIncrement: boolean;
  readonly ordinalPosition: number;
}

export interface MySqlSingleColumnForeignKey {
  readonly constraintName: string;
  readonly columnName: string;
  readonly referencedDatabaseName: string;
  readonly referencedTableName: string;
  readonly referencedColumnName: string;
}
