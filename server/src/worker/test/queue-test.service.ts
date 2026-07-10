/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ScratchConfigService } from '../../config/scratch-config.service';
import { WorkerPoolService } from '../piscina/worker-pool.service';
import { WORKER_QUEUE_NAME, WORKER_QUEUE_STREAM_OPTIONS } from '../worker-queue.constants';

@Injectable()
export class QueueTestService implements OnModuleDestroy {
  private redis: IORedis | null = null;
  private queue: Queue | null = null;

  constructor(
    private readonly workerPool: WorkerPoolService,
    private readonly config: ScratchConfigService,
  ) {}

  private getRedis(): IORedis {
    if (!this.redis) {
      this.redis = new IORedis({
        host: this.config.getRedisHost(),
        port: this.config.getRedisPort(),
        password: this.config.getRedisPassword(),
        maxRetriesPerRequest: null,
      });
    }
    return this.redis;
  }

  private getQueue(): Queue {
    if (!this.queue) {
      this.queue = new Queue(WORKER_QUEUE_NAME, {
        connection: this.getRedis(),
        streams: WORKER_QUEUE_STREAM_OPTIONS,
        defaultJobOptions: {
          removeOnComplete: 10,
          removeOnFail: 5,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      });
    }
    return this.queue;
  }

  async onModuleDestroy() {
    if (this.queue) {
      await this.queue.close();
    }
    if (this.redis) {
      await this.redis.quit();
    }
  }

  async getJobStatus(jobId: string) {
    const job = await this.getQueue().getJob(jobId);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      state: await job.getState(),
    };
  }

  async getQueueStats() {
    const waiting = await this.getQueue().getWaiting();
    const active = await this.getQueue().getActive();
    const completed = await this.getQueue().getCompleted();
    const failed = await this.getQueue().getFailed();

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
    };
  }
}
