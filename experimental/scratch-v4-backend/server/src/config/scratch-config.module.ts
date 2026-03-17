import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScratchConfigService } from './scratch-config.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [ScratchConfigService],
  exports: [ScratchConfigService],
})
export class ScratchConfigModule {}
