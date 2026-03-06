import { Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';
import { WorkbookEventService } from './workbook-event.service';

@Module({
  imports: [RedisModule],
  providers: [WorkbookEventService],
  exports: [WorkbookEventService],
})
export class WorkbookEventModule {}
