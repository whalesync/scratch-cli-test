import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DesktopReleaseController } from './desktop-release.controller';
import { DesktopReleaseService } from './desktop-release.service';

@Module({
  imports: [ScratchConfigModule],
  controllers: [DesktopReleaseController],
  providers: [DesktopReleaseService],
})
export class DesktopReleaseModule {}
