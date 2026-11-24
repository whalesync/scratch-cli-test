import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { ConnectionRepoIndexController } from './connection-repo-index.controller';
import { DataFolderTableSpecStoreService } from './data-folder-table-spec-store.service';

/**
 * A leaf module for the folder table-spec store (DEV-12616), so the publish, workbook, sync, worker, and
 * code-migration modules can all depend on it without a cycle (WorkbookModule already imports PublishPlanModule).
 * It also hosts POST /scratch-git/:id/index/build, which sends the stored specs to scratch-git's index build.
 */
@Module({
  imports: [DbModule, ScratchGitModule, ScratchConfigModule, MetricsModule],
  controllers: [ConnectionRepoIndexController],
  providers: [DataFolderTableSpecStoreService],
  exports: [DataFolderTableSpecStoreService],
})
export class DataFolderTableSpecStoreModule {}
