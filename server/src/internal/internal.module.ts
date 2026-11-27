import { Module } from '@nestjs/common';
import { ScratchAdminGuard } from 'src/auth/scratch-admin.guard';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { PaymentModule } from 'src/payment/payment.module';
import { UserModule } from 'src/users/users.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WhalesyncInternalService } from './whalesync-internal.service';
import { WhalesyncController } from './whalesync.controller';

/**
 * Internal, admin-only server-to-server endpoints for the Whalesync integration. Composes
 * `UserModule` (shadow-user provisioning + token minting), `WorkbookModule` (workbook teardown on
 * deprovision), and `PaymentModule` (clearing the Whalesync-plan subscription), which it can do without
 * a circular dependency because it sits above them. Mounted only on API instances (see `app.module.ts`).
 */
@Module({
  imports: [ScratchConfigModule, UserModule, WorkbookModule, PaymentModule],
  controllers: [WhalesyncController],
  providers: [WhalesyncInternalService, ScratchAdminGuard],
  // The DEV-13019 teamless shadow user code migration reuses its shadow user delete.
  exports: [WhalesyncInternalService],
})
export class InternalModule {}
