import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { ConnectorAccountModule } from 'src/remote-service/connector-account/connector-account.module';
import { ConnectorsModule } from 'src/remote-service/connectors/connectors.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { SchemaBuilderController } from './schema-builder.controller';
import { SchemaBuilderService } from './schema-builder.service';

@Module({
  imports: [
    // WorkbookModule exports WorkbookService + DataFolderService (used for
    // permissions, source-schema reads, and materializeLocally).
    WorkbookModule,
    ConnectorsModule,
    ConnectorAccountModule,
    DbModule,
    AuditLogModule,
    RateLimiterModule,
    ScratchConfigModule,
    MetricsModule,
  ],
  controllers: [SchemaBuilderController],
  providers: [SchemaBuilderService],
  exports: [SchemaBuilderService],
})
export class SchemaBuilderModule {}
