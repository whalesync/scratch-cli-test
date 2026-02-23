/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbJob } from '@prisma/client';
import { createJobId } from '@spinner/shared-types';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { Progress } from 'src/types/progress';
import { DbService } from '../db/db.service';
import { DbJobStatus, dbJobToJobEntity, JobEntity } from './entities/job.entity';

@Injectable()
export class JobService {
  private redis: IORedis | null = null;

  constructor(
    private readonly db: DbService,
    private readonly configService: ScratchConfigService,
  ) {}

  private getRedis(): IORedis {
    if (!this.redis) {
      this.redis = new IORedis({
        host: this.configService.getRedisHost(),
        port: this.configService.getRedisPort(),
        password: this.configService.getRedisPassword(),
        maxRetriesPerRequest: null,
      });
    }
    return this.redis;
  }

  async createJob(params: {
    userId: string;
    type: string;
    data: Record<string, unknown>;
    bullJobId?: string;
    workbookId?: string;
    dataFolderId?: string;
  }): Promise<DbJob> {
    const job = await this.db.client.dbJob.create({
      data: {
        id: createJobId(),
        userId: params.userId,
        workbookId: params.workbookId,
        dataFolderId: params.dataFolderId,
        type: params.type,
        data: params.data as any,
        bullJobId: params.bullJobId,
        status: 'created',
      },
    });
    return job;
  }

  async updateJobProgress(id: string, progress: Progress): Promise<void> {
    await this.db.client.dbJob.update({
      where: { id },
      data: { progress },
    });
  }

  async updateJobStatus(params: {
    id: string;
    status: DbJobStatus;
    result?: Record<string, unknown>;
    error?: string;
    processedOn?: Date;
    finishedOn?: Date;
    progress?: Progress;
  }): Promise<DbJob> {
    const job = await this.db.client.dbJob.update({
      where: { id: params.id },
      data: {
        status: params.status,
        error: params.error,
        processedOn: params.processedOn,
        finishedOn: params.finishedOn,
        progress: params.progress,
      },
    });

    return job;
  }

  async getJobsByUserId(userId: string, limit = 50, offset = 0, workbookId?: string): Promise<DbJob[]> {
    const jobs = await this.db.client.dbJob.findMany({
      where: {
        userId,
        ...(workbookId && { workbookId }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return jobs;
  }

  async getAllJobs(
    limit = 50,
    offset = 0,
    filter?: { statuses?: DbJobStatus[]; userId?: string },
  ): Promise<{ jobs: DbJob[]; total: number }> {
    const where = {
      ...(filter?.statuses?.length && { status: { in: filter.statuses } }),
      ...(filter?.userId && { userId: filter.userId }),
    };

    const [jobs, total] = await this.db.client.$transaction([
      this.db.client.dbJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.db.client.dbJob.count({ where }),
    ]);

    return { jobs, total };
  }

  async getJobById(id: string): Promise<DbJob | null> {
    const job = await this.db.client.dbJob.findUnique({
      where: { id },
    });

    return job;
  }

  async getActiveJobsByWorkbookId(workbookId: string): Promise<JobEntity[]> {
    const dbJobs = await this.db.client.dbJob.findMany({
      where: {
        workbookId,
        status: { in: ['created', 'active'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (dbJobs.length === 0) return [];

    const bullJobIds = dbJobs.map((j) => j.bullJobId).filter((id): id is string => id != null);

    if (bullJobIds.length === 0) return dbJobs.map((j) => dbJobToJobEntity(j));

    const queue = new (await import('bullmq')).Queue('worker-queue', {
      connection: this.getRedis(),
    });

    const bullJobs = await Promise.all(bullJobIds.map((id) => queue.getJob(id)));
    const bullJobMap = new Map<string, (typeof bullJobs)[number]>();
    for (const job of bullJobs) {
      if (job?.id) bullJobMap.set(job.id, job);
    }

    const results: JobEntity[] = await Promise.all(
      dbJobs.map(async (dbJob) => {
        const bullJob = dbJob.bullJobId ? bullJobMap.get(dbJob.bullJobId) : undefined;

        if (!bullJob) return dbJobToJobEntity(dbJob);

        const state = await bullJob.getState();
        const progress = bullJob.progress as Progress;
        return {
          dbJobId: dbJob.id,
          bullJobId: dbJob.bullJobId,
          dataFolderId: dbJob.dataFolderId,
          type: dbJob.type,
          state,
          publicProgress:
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-member-access
            progress?.publicProgress || (bullJob.data as any).initialPublicProgress || undefined,
          processedOn: bullJob.processedOn ? new Date(bullJob.processedOn) : null,
          finishedOn: bullJob.finishedOn ? new Date(bullJob.finishedOn) : null,
          failedReason: bullJob.failedReason,
        };
      }),
    );

    await queue.close();
    return results;
  }

  async getJobByBullJobId(bullJobId: string): Promise<DbJob | null> {
    const job = await this.db.client.dbJob.findFirst({
      where: { bullJobId },
    });

    return job;
  }

  /**
   * @deprecated - use the bulk version instead
   */
  async getJobProgress(jobId: string): Promise<JobEntity> {
    // Get the job from the queue
    const queue = new (await import('bullmq')).Queue('worker-queue', {
      connection: this.getRedis(),
    });

    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job with id ${jobId} not found`);
    }

    const state = await job.getState();
    const progress = job.progress as Progress;

    return {
      bullJobId: job.id as string,
      dbJobId: job.id as string,
      type: job.name,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-member-access
      publicProgress: progress?.publicProgress || (job.data as any).initialPublicProgress || undefined,
      state: state,
      processedOn: job.processedOn ? new Date(job.processedOn) : null,
      finishedOn: job.finishedOn ? new Date(job.finishedOn) : null,
      failedReason: job.failedReason,
    };
  }

  async getJobsProgress(bullJobIds: string[]): Promise<JobEntity[]> {
    if (bullJobIds.length === 0) return [];

    const dbJobs = await this.db.client.dbJob.findMany({
      where: { bullJobId: { in: bullJobIds } },
    });

    return dbJobs.map((dbJob) => dbJobToJobEntity(dbJob));
  }

  async getJobRaw(jobId: string): Promise<any> {
    const queue = new (await import('bullmq')).Queue('worker-queue', {
      connection: this.getRedis(),
    });

    const job = await queue.getJob(jobId);
    await queue.close();

    if (job) {
      return job.asJSON();
    }

    // BullMQ job may have been cleaned up — fall back to DbJob.
    // Note: the shape differs from JobJson (e.g. `data` is an object here, not a JSON string;
    // `progress` is an object, not a number/object; timestamps are ISO strings, not epoch ms).
    const dbJob = await this.getJobByBullJobId(jobId);
    if (!dbJob) {
      throw new NotFoundException(`Job with id ${jobId} not found`);
    }

    return dbJob;
  }

  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    // Get the job from the queue to verify it exists
    const queue = new (await import('bullmq')).Queue('worker-queue', {
      connection: this.getRedis(),
    });

    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job with id ${jobId} not found`);
    }

    const state = await job.getState();

    // Check if job is already completed or failed
    if (state === 'completed' || state === 'failed') {
      return {
        success: false,
        message: `Job ${jobId} is already ${state}`,
      };
    }

    // Send cancellation message to the job-specific channel
    const channelName = `job-cancel:${jobId}`;
    await this.getRedis().publish(channelName, JSON.stringify({ action: 'cancel', jobId }));

    return {
      success: true,
      message: `Cancellation signal sent for job ${jobId}`,
    };
  }
}
