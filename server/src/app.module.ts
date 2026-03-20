import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditLogModule } from './audit/audit-log.module';
import { AuthModule } from './auth/auth.module';
import { BugReportModule } from './bug-report/bug-report.module';
import { ClerkModule } from './clerk/clerk.module';
import { CliModule } from './cli/cli.module';
import { CodeMigrationsModule } from './code-migrations/code-migrations.module';
import { ScratchConfigModule } from './config/scratch-config.module';
import { ScratchConfigService } from './config/scratch-config.service';
import { CronModule } from './cron/cron.module';
import { DbModule } from './db/db.module';
import { DevToolsModule } from './dev-tools/dev-tools.module';
import { DiscoverModule } from './discover/discover.module';
import { ExperimentsModule } from './experiments/experiments.module';
import { HealthModule } from './health/health.module';
import { ApiRequestMetricsInterceptor } from './interceptors/api-request-metrics.interceptor';
import { JobModule } from './job/job.module';
import { McpModule } from './mcp/mcp.module';
import { MetricsModule } from './metrics/metrics.module';
import { JsonBodyMiddleware, RawBodyMiddleware, UrlencodedBodyMiddleware } from './middleware';
import { OAuthModule } from './oauth/oauth.module';
import { PaymentModule } from './payment/payment.module';
import { PosthogModule } from './posthog/posthog.module';
import { PublishPlanModule } from './publish-plan/publish-plan.module';
import { ConnectorAccountModule } from './remote-service/connector-account/connector-account.module';
import { ConnectorsModule } from './remote-service/connectors/connectors.module';
import { ShopifyWebhooksModule } from './remote-service/connectors/library/shopify/controllers/shopify-webhooks.module';
import { ScheduleModule } from './schedule/schedule.module';
import { ScratchGitModule } from './scratch-git/scratch-git.module';
import { SlackNotificationModule } from './slack/slack-notification.module';
import { SyncModule } from './sync/sync.module';
import { UserModule } from './users/users.module';
import { WorkbookModule } from './workbook/workbook.module';
import { WorkerEnqueuerModule } from './worker-enqueuer/worker-enqueuer.module';
import { WorkerModule } from './worker/workers.module';

@Module({
  imports: [
    ScratchConfigModule, // Load first so static environment variables are available
    PosthogModule,
    MetricsModule,
    AuditLogModule,
    ExperimentsModule,
    HealthModule,
    DiscoverModule,
    DbModule,
    UserModule,
    ClerkModule,
    AuthModule,
    CliModule,
    OAuthModule,
    ConnectorAccountModule,
    ConnectorsModule,
    WorkbookModule,
    ScratchGitModule,
    SyncModule,
    PaymentModule,
    SlackNotificationModule,
    WorkerEnqueuerModule,
    JobModule,
    PublishPlanModule,
    ScheduleModule,
    ShopifyWebhooksModule,
    McpModule,
    ...(ScratchConfigService.isAPIService() ? [DevToolsModule, BugReportModule, CodeMigrationsModule] : []),
    ...(ScratchConfigService.isTaskWorkerService() ? [WorkerModule] : []),
    ...(ScratchConfigService.isCronService() ? [CronModule] : []),
  ],
  controllers: [],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ApiRequestMetricsInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    // Ported from Whalesync's app.module.ts
    // Needed to have control over how we parse requests. Technique borrowed from
    // https://stackoverflow.com/questions/54346465/access-raw-body-of-stripe-webhook-in-nest-js
    consumer
      // NOTE! Stripe webhooks require access to the unparsed body to check the signatures. Connector webhooks need the
      // raw body because we have no idea ahead of time what format the body will be in.
      .apply(RawBodyMiddleware)
      .forRoutes(
        { path: '/payment/webhook', method: RequestMethod.POST },
        { path: '/connectors/shopify/webhooks', method: RequestMethod.POST },
      )
      // OAuth token endpoint uses application/x-www-form-urlencoded per the OAuth spec
      .apply(UrlencodedBodyMiddleware)
      .forRoutes({ path: '/mcp-auth/token', method: RequestMethod.POST })
      .apply(JsonBodyMiddleware)
      .exclude(
        // Import suggestions endpoint
        { path: '/workbook/:id/tables/:tableId/import-suggestions', method: RequestMethod.POST },
        // Payment webhook
        { path: '/payment/webhook', method: RequestMethod.POST },
        // Shopify GDPR webhooks
        { path: '/connectors/shopify/webhooks', method: RequestMethod.POST },
        // CLI folder files upload (multipart/form-data)
        { path: '/cli/v1/folders/:id/files', method: RequestMethod.PUT },
        // Git proxy (uses raw body)
        { path: '/cli/v1/workbooks/:id/git/*path', method: RequestMethod.ALL },
        // V2 per-connector git proxy (uses raw body)
        { path: '/cli/v1/workbooks/:id/connectors/:connectorAccountId/git/*path', method: RequestMethod.ALL },
        // MCP OAuth token endpoint (uses urlencoded body)
        { path: '/mcp-auth/token', method: RequestMethod.POST },
      )
      .forRoutes('*');
  }
}
