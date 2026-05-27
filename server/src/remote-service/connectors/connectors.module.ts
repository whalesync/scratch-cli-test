import { Module } from '@nestjs/common';
import { ScratchConfigModule } from '../../config/scratch-config.module';
import { CredentialEncryptionModule } from '../../credential-encryption/credential-encryption.module';
import { DbModule } from '../../db/db.module';
import { ExperimentsModule } from '../../experiments/experiments.module';
import { OAuthModule } from '../../oauth/oauth.module';
import { RateLimiterModule } from '../../rate-limiter/rate-limiter.module';
import { ConnectorsMetadataController } from './connectors-metadata.controller';
import { ConnectorsService } from './connectors.service';
import { GenericApiController, GenericApiProbeService } from './library/generic-api/generic-api.controller';

@Module({
  imports: [
    OAuthModule,
    RateLimiterModule,
    ScratchConfigModule,
    DbModule,
    CredentialEncryptionModule,
    ExperimentsModule,
  ],
  controllers: [ConnectorsMetadataController, GenericApiController],
  providers: [ConnectorsService, GenericApiProbeService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
