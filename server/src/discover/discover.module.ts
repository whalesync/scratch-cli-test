import { Module } from '@nestjs/common';
import { DiscoverController } from './discover.controller';

@Module({
  controllers: [DiscoverController],
})
export class DiscoverModule {}
