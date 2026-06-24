import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkbookProvisioningService } from './workbook-provisioning.service';

/**
 * Tiny module exposing {@link WorkbookProvisioningService}, the shared "create a workbook (DB row +
 * config repo) atomically" primitive. It depends only on Db + ScratchGit, so both `WorkbookModule`
 * and `UserModule` can import it without creating a circular module dependency.
 */
@Module({
  imports: [DbModule, ScratchGitModule],
  providers: [WorkbookProvisioningService],
  exports: [WorkbookProvisioningService],
})
export class WorkbookProvisioningModule {}
