import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { EmailModule } from 'src/email/email.module';
import { ExperimentsModule } from 'src/experiments/experiments.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { SlackNotificationModule } from 'src/slack/slack-notification.module';
import { StripePaymentController } from './payment.controller';
import { StripePaymentWebhookController } from './payment.webook.controller';
import { PaymentsPublicController } from './payments-public.controller';
import { StripePaymentService } from './stripe-payment.service';

@Module({
  providers: [StripePaymentService],
  imports: [
    ScratchConfigModule,
    DbModule,
    PosthogModule,
    SlackNotificationModule,
    AuditLogModule,
    EmailModule,
    ExperimentsModule,
  ],
  exports: [StripePaymentService], //export this service to use in other modules
  controllers: [StripePaymentController, StripePaymentWebhookController, PaymentsPublicController],
})
export class PaymentModule {}
