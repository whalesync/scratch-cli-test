import { Module } from '@nestjs/common';
import { OAuthModule } from '../../oauth/oauth.module';
import { RateLimiterModule } from '../../rate-limiter/rate-limiter.module';
import { ConnectorsMetadataController } from './connectors-metadata.controller';
import { ConnectorsService } from './connectors.service';

@Module({
  imports: [OAuthModule, RateLimiterModule],
  controllers: [ConnectorsMetadataController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
