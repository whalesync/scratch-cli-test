import { CustomMetric } from './custom-metrics';
import { CustomMetricDimensionValue } from './types';

/**
 * Identifier for injecting the interface.
 * Always inject as:
 * `@Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService`
 *
 * Interesting trick, see https://stackoverflow.com/a/70088972
 */
export const CustomMetricsService = Symbol('CustomMetricsService');

/**
 * Logger for aggregating and posting custom numerical metrics.
 * Metrics are collected and flushed to the server periodically.
 */
export interface CustomMetricsService {
  logValue(metric: CustomMetric, value: number, dimension?: CustomMetricDimensionValue): void;

  /** Runs the `closure` and logs its latency to the specified metric. */
  withLoggedExecTime<T>(metric: CustomMetric, closure: () => Promise<T>): Promise<T>;

  withLoggedExecTimeForConnector<T>(metric: CustomMetric, connectorType: string, closure: () => Promise<T>): Promise<T>;
}
