import { Module } from '@nestjs/common';
import { CredentialEncryptionModule } from '../credential-encryption/credential-encryption.module';
import { DbModule } from '../db/db.module';
import { ConnectorsModule } from '../remote-service/connectors/connectors.module';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';

import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { PublishPlanBuildService } from './publish-plan-build.service';
import { PublishPlanCrudService } from './publish-plan-crud.service';
import { PublishPlanRunService } from './publish-plan-run.service';
import { PublishPlanController } from './publish-plan.controller';
import { RefCleanerService } from './ref-cleaner.service';
import { RefResolverService } from './ref-resolver.service';
import { SchemaHelperService } from './schema-helper.service';

@Module({
  imports: [DbModule, ScratchGitModule, WorkerEnqueuerModule, ConnectorsModule, CredentialEncryptionModule],
  controllers: [PublishPlanController],
  providers: [
    FileIndexService,
    FileReferenceService,
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
    PublishPlanCrudService,
    PublishPlanBuildService,
    RefResolverService,
    PublishPlanRunService,
    RefCleanerService,
    SchemaHelperService,
  ],
})
export class PublishPlanModule {}
