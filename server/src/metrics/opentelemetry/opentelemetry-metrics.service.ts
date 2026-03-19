import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from '../custom-metrics';
import { CustomMetricsService } from '../custom-metrics-service';
import { CustomMetricDimension, CustomMetricDimensionValue } from '../types';
import { OpenTelemetryMetric } from './opentelemetry-metric-collector';

const METRIC_NAMESPACE = 'scratch';
const ENABLE_OTEL_LOGGING_IN_DEV = false;
const PROMETHEUS_PORT = 9464;
const OTLP_EXPORT_INTERVAL_MS = 30000;

/**
 * Logger for aggregating and posting numerical metrics using OpenTelemetry.
 * Metrics are collected and exported periodically via the configured exporter.
 */
@Injectable()
export class OpenTelemetryMetricsService implements CustomMetricsService, OnApplicationShutdown {
  private readonly metrics = new Map<CustomMetric, OpenTelemetryMetric>();
  private readonly meterProvider: MeterProvider;
  private readonly loggingEnabled: boolean;
  private readonly environment: string;

  constructor(scratchConfigService: ScratchConfigService) {
    this.environment = scratchConfigService.getScratchEnvironment();
    this.loggingEnabled = scratchConfigService.getRunningInCloud() || ENABLE_OTEL_LOGGING_IN_DEV;

    const resource = defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: scratchConfigService.getFriendlyServiceName(),
        [ATTR_SERVICE_VERSION]: scratchConfigService.getBuildVersion(),
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: this.environment,
      }),
    );

    const prometheusExporter = new PrometheusExporter({ port: PROMETHEUS_PORT }, () => {
      WSLogger.info({
        source: 'OpenTelemetryMetricsService',
        message: `Prometheus metrics available at http://localhost:${PROMETHEUS_PORT}/metrics`,
      });
    });

    // Configure endpoint via OTEL_EXPORTER_OTLP_ENDPOINT environment variable
    // or it defaults to http://localhost:4318/v1/metrics
    const otlpExporter = new OTLPMetricExporter({});

    const otlpReader = new PeriodicExportingMetricReader({
      exporter: otlpExporter,
      exportIntervalMillis: OTLP_EXPORT_INTERVAL_MS,
    });

    this.meterProvider = new MeterProvider({
      resource,
      readers: [prometheusExporter, otlpReader],
    });

    WSLogger.info({
      source: 'OpenTelemetryMetricsService',
      message: `Initialized with Prometheus (port ${PROMETHEUS_PORT}) and OTLP exporters for environment: ${this.environment}`,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    WSLogger.debug({ source: 'OpenTelemetryMetricsService', message: 'onApplicationShutdown flushing' });
    await this.forceFlush();
    await this.meterProvider.shutdown();
    WSLogger.debug({ source: 'OpenTelemetryMetricsService', message: 'onApplicationShutdown done' });
  }

  logValue(metric: CustomMetric, value: number, dimension?: CustomMetricDimensionValue): void {
    let collector = this.metrics.get(metric);
    if (!collector) {
      collector = new OpenTelemetryMetric(metric, this.meterProvider.getMeter(METRIC_NAMESPACE));
      this.metrics.set(metric, collector);
    }
    collector.addValue(value, dimension);
  }

  async withLoggedExecTime<T>(metric: CustomMetric, closure: () => Promise<T>): Promise<T> {
    return this.withLoggedExecTimeInternal(metric, undefined, closure);
  }

  async withLoggedExecTimeForConnector<T>(
    metric: CustomMetric,
    connectorType: string,
    closure: () => Promise<T>,
  ): Promise<T> {
    return this.withLoggedExecTimeInternal(
      metric,
      { name: CustomMetricDimension.CONNECTOR_TYPE, value: connectorType },
      closure,
    );
  }

  private async withLoggedExecTimeInternal<T>(
    metric: CustomMetric,
    dimension: CustomMetricDimensionValue | undefined,
    closure: () => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    const result = await closure();
    this.logValue(metric, Date.now() - startTime, dimension);
    return result;
  }

  async forceFlush(): Promise<void> {
    if (!this.loggingEnabled) {
      return;
    }

    try {
      await this.meterProvider.forceFlush();
    } catch (err) {
      WSLogger.error({
        source: 'OpenTelemetryMetricsService',
        message: 'Failed to flush metrics',
        error: `Error: ${String(err)}`,
      });
    }
  }
}
