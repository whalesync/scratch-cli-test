import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CredentialEncryptionModule } from 'src/credential-encryption/credential-encryption.module';
import { DbModule } from 'src/db/db.module';
import { OAuthModule } from 'src/oauth/oauth.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { OAuthInstallController } from './oauth-install.controller';
import { OAuthInstallService } from './oauth-install.service';

/**
 * Marketplace-initiated ("inbound") OAuth install feature. Deliberately a separate
 * module from {@link OAuthModule}: it imports both OAuthModule and WorkbookModule
 * (to mint a workbook on claim), and neither imports this one back — which keeps it
 * clear of the existing workbook → connectors → oauth dependency cycle.
 */
@Module({
  imports: [ConfigModule, DbModule, CredentialEncryptionModule, OAuthModule, WorkbookModule],
  controllers: [OAuthInstallController],
  providers: [OAuthInstallService],
})
export class OAuthInstallModule {}
