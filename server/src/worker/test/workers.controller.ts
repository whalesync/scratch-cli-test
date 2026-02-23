import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { BullEnqueuerService } from '../../worker-enqueuer/bull-enqueuer.service';
import { QueueTestService } from './queue-test.service';

@Controller('workers')
@UseInterceptors(ClassSerializerInterceptor)
export class WorkersController {
  constructor(
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly queueTestService: QueueTestService,
  ) {}

  @Get('jobs/:jobId')
  async getJobStatus(@Param('jobId') jobId: string) {
    try {
      const status = await this.queueTestService.getJobStatus(jobId);
      if (!status) {
        throw new HttpException(
          {
            success: false,
            message: 'Job not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }
      return {
        success: true,
        status,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get job status',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('queue/stats')
  async getQueueStats() {
    try {
      const stats = await this.queueTestService.getQueueStats();
      return {
        success: true,
        stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get queue stats',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
