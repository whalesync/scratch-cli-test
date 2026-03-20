import { WSLogger } from 'src/logger';
import { CustomMetric } from './custom-metrics';
import { CustomMetricsService } from './custom-metrics-service';
import { CustomMetricDimensionValue } from './types';

/** In local dev environments, we want to just see the logs in the console. */
export class DevMetricsService implements CustomMetricsService {
  logValue(metric: CustomMetric, value: number, dimension?: CustomMetricDimensionValue): void {
    // Do nothing.
    WSLogger.info({
      source: 'DevMetricsService',
      message: metric,
      value: value,
      dimension: dimension,
    });
  }

  async withLoggedExecTime<T>(metric: CustomMetric, closure: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    const result = await closure();
    const duration = Date.now() - startTime;
    WSLogger.info({
      source: 'DevMetricsService',
      message: metric,
      duration: `${duration} ms`,
    });
    return result;
  }

  async withLoggedExecTimeForConnector<T>(
    metric: CustomMetric,
    connectorType: string,
    closure: () => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    const result = await closure();
    const duration = Date.now() - startTime;
    WSLogger.info({
      source: 'DevMetricsService',
      message: metric,
      connector: connectorType,
      duration: `${duration} ms`,
    });
    return result;
  }
}
