// Types used by connectors and DTOs

/** ID for a table or column. It contains both our internal postgres ID and whatever path info the connector needs. */
export type EntityId = {
  /**
   * The id for whalesync to use for this table.
   * This must be a valid and easy to use identifier in postgres.
   * It should be human readable and friendly.
   * Consider putting the
   */
  wsId: string;

  /**
   * The id for the table in the connector.
   * It is an array so the connector can use it as a path.
   */
  remoteId: string[];
};

/** Types of columns we support. Add more if needed. */
export enum PostgresColumnType {
  TEXT = 'text',
  TEXT_ARRAY = 'text[]',
  NUMERIC = 'numeric',
  NUMERIC_ARRAY = 'numeric[]',
  BOOLEAN = 'boolean',
  BOOLEAN_ARRAY = 'boolean[]',
  JSONB = 'jsonb',
  TIMESTAMP = 'timestamp',
}
