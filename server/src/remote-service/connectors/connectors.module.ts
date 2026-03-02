import { Module } from '@nestjs/common';
import { OAuthModule } from '../../oauth/oauth.module';
import { RateLimiterModule } from '../../rate-limiter/rate-limiter.module';
import { ConnectorsService } from './connectors.service';

@Module({
  imports: [OAuthModule, RateLimiterModule],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
