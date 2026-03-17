import { Module } from '@nestjs/common';
import { RateLimiterModule } from '../../rate-limiter/rate-limiter.module';
import { ConnectorsService } from './connectors.service';

@Module({
  imports: [RateLimiterModule],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
