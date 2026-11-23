import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { DataFolderTableSpecStoreService } from './data-folder-table-spec-store.service';

/**
 * A leaf module for the folder table-spec store (DEV-12616), so the publish, workbook, sync, worker, and
 * code-migration modules can all depend on it without a cycle (WorkbookModule already imports PublishPlanModule).
 */
@Module({
  imports: [DbModule, ScratchGitModule, ScratchConfigModule, MetricsModule],
  providers: [DataFolderTableSpecStoreService],
  exports: [DataFolderTableSpecStoreService],
})
export class DataFolderTableSpecStoreModule {}
