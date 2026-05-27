import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { CredentialEncryptionModule } from 'src/credential-encryption/credential-encryption.module';
import { ExperimentsModule } from 'src/experiments/experiments.module';
import { OAuthModule } from 'src/oauth/oauth.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { UserModule } from 'src/users/users.module';
import { WorkbookEventModule } from 'src/workbook/workbook-event.module';
import { DbModule } from '../../db/db.module';
import { PosthogModule } from '../../posthog/posthog.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ConnectorAccountController } from './connector-account.controller';
import { ConnectorAccountService } from './connector-account.service';

@Module({
  imports: [
    DbModule,
    ConnectorsModule,
    OAuthModule,
    PosthogModule,
    AuditLogModule,
    CredentialEncryptionModule,
    UserModule,
    ScratchGitModule,
    WorkbookEventModule,
    ExperimentsModule,
  ],
  controllers: [ConnectorAccountController],
  providers: [ConnectorAccountService],
  exports: [ConnectorAccountService],
})
export class ConnectorAccountModule {}
