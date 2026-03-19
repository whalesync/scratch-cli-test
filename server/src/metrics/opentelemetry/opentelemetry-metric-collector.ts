import { Counter, Gauge, Histogram, Meter } from '@opentelemetry/api';
import { WSLogger } from 'src/logger';
import { CustomMetric, expectedDimensionForMetric, unitForMetric } from '../custom-metrics';
import { CustomMetricDimension, CustomMetricDimensionValue, CustomMetricUnit } from '../types';

const HISTOGRAM_BUCKETS_MILLISECONDS: number[] = [0, 100, 1000, 30000];
const HISTOGRAM_BUCKETS_MILLISECONDS_DETAILED: number[] = [0, 100, 1000, 2000, 3000, 10000, 30000];
const HISTOGRAM_BUCKETS_GENERIC: number[] = [0, 100, 1000, 10000, 100000, 1000000];

/**
 * Wraps OpenTelemetry instruments for a specific metric.
 * Uses different instrument types based on the metric's unit:
 * - EVENT_COUNT / AGGREGATED_COUNT: Counter (monotonically increasing)
 * - INSTANTANEOUS_COUNT: Gauge (current value)
 * - KILOBYTES: Gauge (current size)
 * - MILLISECONDS / MILLISECONDS_DETAILED / MAGNITUDE: Histogram (distribution of values)
 */
export class OpenTelemetryMetric {
  private readonly dimensionName: CustomMetricDimension;
  private readonly unit: CustomMetricUnit;
  private readonly instrument: Counter | Histogram | Gauge;

  constructor(
    private readonly metric: CustomMetric,
    private readonly meter: Meter,
  ) {
    this.dimensionName = expectedDimensionForMetric(metric);
    this.unit = unitForMetric(metric);
    this.instrument = this.createInstrument();
  }

  /** Records a value to be uploaded. Supports a single dimension. */
  addValue(value: number, dimension?: CustomMetricDimensionValue): void {
    const dimensionValue = this.getDimensionValue(dimension);
    const attributes = this.buildAttributes(dimensionValue);

    if (dimension !== undefined && this.dimensionName !== dimension.name) {
      WSLogger.error({
        source: 'OpenTelemetryMetricCollector',
        message: 'Dimension mismatch',
        expected: this.dimensionName,
        received: dimension.name,
      });
    }

    // Record the value using the appropriate instrument method based on type
    if ('add' in this.instrument) {
      // Counter
      this.instrument.add(value, attributes);
    } else {
      // Histogram or Gauge
      this.instrument.record(value, attributes);
    }
  }

  private createInstrument(): Counter | Histogram | Gauge {
    const metricName = this.metric as string;
    const unitString = this.getOtelUnit();

    switch (this.unit) {
      case CustomMetricUnit.EVENT_COUNT:
      case CustomMetricUnit.AGGREGATED_COUNT:
        return this.meter.createCounter(metricName, {
          unit: unitString,
        });

      case CustomMetricUnit.INSTANTANEOUS_COUNT:
        return this.meter.createGauge(metricName, {
          unit: unitString,
        });

      case CustomMetricUnit.MILLISECONDS:
        return this.meter.createHistogram(metricName, {
          unit: unitString,
          advice: {
            explicitBucketBoundaries: HISTOGRAM_BUCKETS_MILLISECONDS,
          },
        });

      case CustomMetricUnit.MILLISECONDS_DETAILED:
        return this.meter.createHistogram(metricName, {
          unit: unitString,
          advice: {
            explicitBucketBoundaries: HISTOGRAM_BUCKETS_MILLISECONDS_DETAILED,
          },
        });

      case CustomMetricUnit.MAGNITUDE:
        return this.meter.createHistogram(metricName, {
          unit: unitString,
          advice: {
            explicitBucketBoundaries: HISTOGRAM_BUCKETS_GENERIC,
          },
        });

      case CustomMetricUnit.KILOBYTES:
        return this.meter.createGauge(metricName, {
          description: 'Current size in kilobytes',
          unit: unitString,
        });
    }
  }

  private getDimensionValue(dimension?: CustomMetricDimensionValue): string {
    return dimension &&
      dimension.value &&
      dimension?.name === this.dimensionName &&
      this.dimensionName !== CustomMetricDimension.NO_DIMENSION
      ? dimension.value
      : 'no_dimension';
  }

  private buildAttributes(dimensionValue: string): Record<string, string> {
    const attributes: Record<string, string> = {};

    if (this.dimensionName !== CustomMetricDimension.NO_DIMENSION && dimensionValue !== 'no_dimension') {
      attributes[this.dimensionName] = dimensionValue;
    }

    return attributes;
  }

  private getOtelUnit(): string {
    switch (this.unit) {
      case CustomMetricUnit.KILOBYTES:
        return 'KB';
      case CustomMetricUnit.MILLISECONDS:
      case CustomMetricUnit.MILLISECONDS_DETAILED:
        return 'ms';
      case CustomMetricUnit.INSTANTANEOUS_COUNT:
      case CustomMetricUnit.MAGNITUDE:
        return '';
      case CustomMetricUnit.AGGREGATED_COUNT:
      case CustomMetricUnit.EVENT_COUNT:
        return '{count}';
    }
  }
}
