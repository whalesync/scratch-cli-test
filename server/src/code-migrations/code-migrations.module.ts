import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module';
import { CredentialEncryptionModule } from '../credential-encryption/credential-encryption.module';
import { DbModule } from '../db/db.module';
import { OAuthModule } from '../oauth/oauth.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkbookRepoService } from '../workbook/workbook-repo.service';
import { CodeMigrationsController } from './code-migrations.controller';

@Module({
  imports: [DbModule, ScratchGitModule, CredentialEncryptionModule, OAuthModule, AuditLogModule],
  controllers: [CodeMigrationsController],
  providers: [WorkbookRepoService],
})
export class CodeMigrationsModule {}
