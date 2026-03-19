import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { CustomMetricsService } from './custom-metrics-service';
import { DevMetricsService } from './dev-metrics.service';
import { OpenTelemetryMetricsService } from './opentelemetry/opentelemetry-metrics.service';
import { StubMetricsService } from './stub-metrics.service';

const CUSTOM_METRICS_SERVICE_PROVIDER = {
  provide: CustomMetricsService,
  inject: [ScratchConfigService],
  useFactory: (configService: ScratchConfigService): CustomMetricsService => {
    const environment = configService.getScratchEnvironment();

    if (environment === 'test') {
      return new StubMetricsService();
    }

    if (configService.getUseOpenTelemetryMetrics()) {
      WSLogger.info({
        source: 'MetricsModule',
        message: 'Using OpenTelemetryMetricsService',
      });
      return new OpenTelemetryMetricsService(configService);
    }

    if (environment === 'development') {
      WSLogger.info({
        source: 'MetricsModule',
        message: 'Development environment detected, using DevMetricsService',
      });
      return new DevMetricsService();
    }

    // Use OpenTelemetry as the default metrics service
    WSLogger.info({
      source: 'MetricsModule',
      message: 'Using OpenTelemetryMetricsService',
    });
    return new OpenTelemetryMetricsService(configService);
  },
};

@Module({
  imports: [ScratchConfigModule],
  providers: [CUSTOM_METRICS_SERVICE_PROVIDER],
  exports: [CustomMetricsService],
})
export class MetricsModule {}
