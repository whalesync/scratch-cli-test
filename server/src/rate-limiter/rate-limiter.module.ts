import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { RateLimiterFactory } from './rate-limiter-factory.service';

@Module({
  imports: [ScratchConfigModule],
  providers: [RateLimiterFactory],
  exports: [RateLimiterFactory],
})
export class RateLimiterModule {}
