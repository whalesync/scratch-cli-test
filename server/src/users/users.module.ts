import { Module } from '@nestjs/common';

import { DbModule } from '../db/db.module';

import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ExperimentsModule } from 'src/experiments/experiments.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { PaymentModule } from 'src/payment/payment.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { SlackNotificationModule } from 'src/slack/slack-notification.module';
import { OrganizationsService } from './organizations.service';
import { SubscriptionService } from './subscription.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService, SubscriptionService, OrganizationsService],
  imports: [
    DbModule,
    MetricsModule,
    RateLimiterModule,
    PosthogModule,
    ScratchConfigModule,
    ExperimentsModule,
    PaymentModule,
    SlackNotificationModule,
    AuditLogModule,
  ],
  exports: [UsersService, SubscriptionService],
  controllers: [UsersController],
})
export class UserModule {}
