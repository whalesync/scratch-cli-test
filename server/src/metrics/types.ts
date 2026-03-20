export enum CustomMetricDimension {
  NO_DIMENSION = 'noDimension',
  TABLE_NAME = 'tableName',
  CONNECTOR_TYPE = 'connectorType',
  JOB_TYPE = 'jobType',
  AUTH_SOURCE = 'authSource',
}

/** Value for a dimension. */
export type CustomMetricDimensionValue = { name: CustomMetricDimension; value: string };

/** Units we tag metrics with */
export enum CustomMetricUnit {
  /** Measurement of magnitude in kilobytes */
  KILOBYTES = 'kilobytes',
  /** Measurement of magnitude in time */
  MILLISECONDS = 'milliseconds',
  /** Measurement of magnitude in time with more detailed histogram buckets */
  MILLISECONDS_DETAILED = 'milliseconds_detailed',

  /**
   * Measurement of magnitude of a count.
   * Unlike EVENT_COUNT, this measures how large a value is at a specific point in time.
   * It will be aggregated while keeping track of the size of each data sample, rather than simple summing.
   */
  AGGREGATED_COUNT = 'aggregated_count',

  /**
   * Measurement of magnitude of a count.
   * Unlike EVENT_COUNT, this measures how large a global value is at a specific point in time.
   * It will not be aggregated.
   */
  INSTANTANEOUS_COUNT = 'instantaneous_count',

  /**
   * Measurement of magnitude of an event that comes from a distribution of values.
   * It will be aggregated as a histogram when supported by the metrics implementation.
   */
  MAGNITUDE = 'magnitude',

  /**
   * Measurement of how often something has happened.
   * Unlike INSTANTANEOUS_COUNT, this will be aggregated with sums, rather than stats.
   */
  EVENT_COUNT = 'event_count',
}
