import { Module } from '@nestjs/common';
import { CredentialEncryptionModule } from '../credential-encryption/credential-encryption.module';
import { DbModule } from '../db/db.module';
import { ConnectorsModule } from '../remote-service/connectors/connectors.module';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';

import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { PublishAdminService } from './publish-admin.service';
import { PublishPipelineController } from './publish-pipeline.controller';
import { PublishPlanService } from './publish-plan.service';
import { PublishRefResolverService } from './publish-ref-resolver.service';
import { PublishRunService } from './publish-run.service';
import { PublishSchemaService } from './publish-schema.service';
import { RefCleanerService } from './ref-cleaner.service';

@Module({
  imports: [DbModule, ScratchGitModule, WorkerEnqueuerModule, ConnectorsModule, CredentialEncryptionModule],
  controllers: [PublishPipelineController],
  providers: [
    FileIndexService,
    FileReferenceService,
    PublishAdminService,
    PublishPlanService,
    PublishRefResolverService,
    PublishRunService,
    RefCleanerService,
    PublishSchemaService,
  ],
  exports: [
    FileIndexService,
    FileReferenceService,
    PublishAdminService,
    PublishPlanService,
    PublishRefResolverService,
    PublishRunService,
    RefCleanerService,
    PublishSchemaService,
  ],
})
export class PublishPipelineModule {}
