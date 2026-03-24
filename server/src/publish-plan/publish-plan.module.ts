import { Module } from '@nestjs/common';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { AssetModule } from '../asset/asset.module';
import { CredentialEncryptionModule } from '../credential-encryption/credential-encryption.module';
import { DbModule } from '../db/db.module';
import { ConnectorsModule } from '../remote-service/connectors/connectors.module';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';

import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { PublishFromGitService } from './publish-from-git.service';
import { PublishPlanBuildService } from './publish-plan-build.service';
import { PublishPlanCrudService } from './publish-plan-crud.service';
import { PublishPlanRunService } from './publish-plan-run.service';
import { PublishPlanController } from './publish-plan.controller';
import { RefCleanerService } from './ref-cleaner.service';
import { RefResolverService } from './ref-resolver.service';
import { SchemaHelperService } from './schema-helper.service';

@Module({
  imports: [
    DbModule,
    MetricsModule,
    RateLimiterModule,
    ScratchGitModule,
    WorkerEnqueuerModule,
    ConnectorsModule,
    CredentialEncryptionModule,
    AssetModule,
    ScratchConfigModule,
  ],
  controllers: [PublishPlanController],
  providers: [
    FileIndexService,
    FileReferenceService,
    PublishFromGitService,
    PublishPlanCrudService,
    PublishPlanBuildService,
    RefResolverService,
    PublishPlanRunService,
    RefCleanerService,
    SchemaHelperService,
  ],
  exports: [
    FileIndexService,
    FileReferenceService,
    PublishFromGitService,
    PublishPlanCrudService,
    PublishPlanBuildService,
    RefResolverService,
    PublishPlanRunService,
    RefCleanerService,
    SchemaHelperService,
  ],
})
export class PublishPlanModule {}
