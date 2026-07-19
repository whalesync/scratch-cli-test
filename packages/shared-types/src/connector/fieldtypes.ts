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
  /**
   * Fixed-width numeric family the `pg` driver materializes as a JS number and we store as a
   * number on disk: `integer`, `smallint`, `serial`, `real`, `double precision`, `float`, …
   */
  NUMERIC = 'numeric',
  NUMERIC_ARRAY = 'numeric[]',
  /**
   * Arbitrary-precision numeric family the `pg` driver returns as a precision-preserving STRING —
   * `numeric`/`decimal` and `bigint`/`bigserial` — which we store verbatim as that string rather
   * than coercing to a lossy JS float (Connector Prime Directive; see DEV-10777). Kept distinct
   * from {@link NUMERIC} so the view/validation layer can treat it as a numeric-valued string.
   */
  NUMERIC_STRING = 'numeric_string',
  BOOLEAN = 'boolean',
  BOOLEAN_ARRAY = 'boolean[]',
  JSONB = 'jsonb',
  TIMESTAMP = 'timestamp',
}
