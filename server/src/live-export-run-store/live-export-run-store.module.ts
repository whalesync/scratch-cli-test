import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbModule } from 'src/db/db.module';
import { ExperimentsModule } from 'src/experiments/experiments.module';
import { createHttpRunStoreClientFromConfig } from './http-run-store-client';
import { LiveExportEngineService } from './live-export-engine.service';
import { LiveExportRunLifecycleService } from './live-export-run-lifecycle.service';
import { RUN_STORE_CLIENT } from './run-store-client.token';

/**
 * The Live Export run-store engine's shared pieces: the client to the run stores on scratch-git, the
 * per-run engine decision, and the run lifecycle hooks. Depends only on DB, config and flags, so routine
 * execution (which must not depend on anything that depends back on routines) can import it; the job
 * handlers build the storage adapters themselves from `RUN_STORE_CLIENT`.
 */
@Module({
  imports: [DbModule, ScratchConfigModule, ExperimentsModule],
  providers: [
    { provide: RUN_STORE_CLIENT, useFactory: createHttpRunStoreClientFromConfig, inject: [ScratchConfigService] },
    LiveExportEngineService,
    LiveExportRunLifecycleService,
  ],
  exports: [RUN_STORE_CLIENT, LiveExportEngineService, LiveExportRunLifecycleService],
})
export class LiveExportRunStoreModule {}
