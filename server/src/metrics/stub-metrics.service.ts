/* eslint-disable @typescript-eslint/no-unused-vars */
import { CustomMetric } from './custom-metrics';
import { CustomMetricsService } from './custom-metrics-service';
import { CustomMetricDimensionValue } from './types';

/** In test environments, we want to totally bypass the logging. */
export class StubMetricsService implements CustomMetricsService {
  logValue(metric: CustomMetric, value: number, dimension?: CustomMetricDimensionValue): void {
    // Do nothing.
  }

  withLoggedExecTime<T>(metric: CustomMetric, closure: () => Promise<T>): Promise<T> {
    return closure();
  }

  withLoggedExecTimeForConnector<T>(
    metric: CustomMetric,
    connectorType: string,
    closure: () => Promise<T>,
  ): Promise<T> {
    return closure();
  }
}
