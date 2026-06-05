import { Module } from '@nestjs/common';
import { ScratchAdminGuard } from 'src/auth/scratch-admin.guard';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { UserModule } from 'src/users/users.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WhalesyncInternalService } from './whalesync-internal.service';
import { WhalesyncController } from './whalesync.controller';

/**
 * Internal, admin-only server-to-server endpoints for the Whalesync integration. Composes
 * `UserModule` (shadow-user provisioning + token minting) and `WorkbookModule` (workbook teardown on
 * deprovision), which it can do without a circular dependency because it sits above both. Mounted only
 * on API instances (see `app.module.ts`).
 */
@Module({
  imports: [ScratchConfigModule, UserModule, WorkbookModule],
  controllers: [WhalesyncController],
  providers: [WhalesyncInternalService, ScratchAdminGuard],
})
export class InternalModule {}
