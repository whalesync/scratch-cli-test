import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DbJob, Prisma } from '@prisma/client';
import { createJobId, JobType, RunId, WorkbookId } from '@spinner/shared-types';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { Progress } from 'src/types/progress';
import { RunContext } from 'src/worker/jobs/base-types';
import { DbService } from '../db/db.service';
import { hasWorkspacePermissions } from '../users/permissions';
import { Actor } from '../users/types';
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
    syncId?: string;
    progress?: Progress;
    runId?: RunId;
    runContext?: RunContext;
  }): Promise<DbJob> {
    const job = await this.db.client.dbJob.create({
      data: {
        id: createJobId(),
        userId: params.userId,
        workbookId: params.workbookId,
        dataFolderId: params.dataFolderId,
        syncId: params.syncId,
        type: params.type,
        data: params.data as Prisma.InputJsonValue,
        bullJobId: params.bullJobId,
        progress: params.progress ?? undefined,
        status: 'created',
        runId: params.runId,
        runContext: params.runContext ?? undefined,
      },
    });
    return job;
  }

  /**
   * Update progress and return whether cancellation has been requested.
   * This combines the progress write with the cancellation check in a single DB round-trip.
   */
  async updateJobProgressAndCheckCancel(id: string, progress: Progress): Promise<boolean> {
    const job = await this.db.client.dbJob.update({
      where: { id },
      data: { progress },
      select: { cancelRequestedAt: true },
    });
    return job.cancelRequestedAt != null;
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
    // Never overwrite a 'canceled' status — the user's cancellation takes priority over
    // any in-flight worker status update (e.g., the worker finishing before the abort signal fires).
    const result = await this.db.client.dbJob.updateMany({
      where: { id: params.id, status: { not: 'canceled' } },
      data: {
        status: params.status,
        error: params.error,
        processedOn: params.processedOn,
        finishedOn: params.finishedOn,
        progress: params.progress,
      },
    });

    // If the row was already canceled, return the current state without overwriting
    if (result.count === 0) {
      const existing = await this.db.client.dbJob.findUniqueOrThrow({ where: { id: params.id } });
      return existing;
    }

    return this.db.client.dbJob.findUniqueOrThrow({ where: { id: params.id } });
  }

  /**
   * Map grouped job type names (used by the client) to the actual DB type values.
   */
  private static readonly JOB_TYPE_MAP: Record<string, { in: string[] } | { contains: string }> = {
    sync: { contains: 'sync' },
    publish: { in: [JobType.Publish] },
    pull: { in: [JobType.RefreshRecords, JobType.PullLinkedFolderFiles] },
    rehost: { in: [JobType.RehostAssets] },
  };

  async getJobsByUserId(
    userId: string,
    limit = 50,
    offset = 0,
    workbookId?: string,
    filter?: { type?: string; syncId?: string; dataFolderId?: string },
  ): Promise<DbJob[]> {
    const typeFilter = filter?.type ? JobService.JOB_TYPE_MAP[filter.type] : undefined;

    const jobs = await this.db.client.dbJob.findMany({
      where: {
        userId,
        ...(workbookId && { workbookId }),
        ...(typeFilter && { type: typeFilter }),
        ...(filter?.syncId && { syncId: filter.syncId }),
        ...(filter?.dataFolderId && { dataFolderId: filter.dataFolderId }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return jobs;
  }

  /** Jobs for a workbook (all users). Caller must enforce workspace access. */
  async getJobsForWorkbook(
    workbookId: string,
    limit = 50,
    offset = 0,
    filter?: { type?: string; syncId?: string; dataFolderId?: string },
  ): Promise<DbJob[]> {
    const typeFilter = filter?.type ? JobService.JOB_TYPE_MAP[filter.type] : undefined;

    const jobs = await this.db.client.dbJob.findMany({
      where: {
        workbookId,
        ...(typeFilter && { type: typeFilter }),
        ...(filter?.syncId && { syncId: filter.syncId }),
        ...(filter?.dataFolderId && { dataFolderId: filter.dataFolderId }),
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

    const queue = new Queue('worker-queue', {
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
        const jobData = bullJob.data as Record<string, unknown>;
        return {
          dbJobId: dbJob.id,
          bullJobId: dbJob.bullJobId,
          dataFolderId: dbJob.dataFolderId,
          type: dbJob.type,
          state,
          publicProgress: progress?.publicProgress || jobData.initialPublicProgress || undefined,
          processedOn: bullJob.processedOn ? new Date(bullJob.processedOn) : null,
          finishedOn: bullJob.finishedOn ? new Date(bullJob.finishedOn) : null,
          failedReason: bullJob.failedReason,
        };
      }),
    );

    await queue.close();
    return results;
  }

  async getJobsByRunId(runId: RunId): Promise<DbJob[]> {
    return this.db.client.dbJob.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
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
    const queue = new Queue('worker-queue', {
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
      publicProgress:
        progress?.publicProgress || (job.data as Record<string, unknown>).initialPublicProgress || undefined,
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

  async getJobRaw(jobId: string): Promise<unknown> {
    const queue = new Queue('worker-queue', {
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

  private verifyJobAccess(dbJob: DbJob, actor: Actor): void {
    if (actor.isAdmin) return;
    if (!dbJob.workbookId) return;

    if (hasWorkspacePermissions(actor, dbJob.workbookId as WorkbookId)) {
      return;
    }

    throw new ForbiddenException('You do not have access to this job');
  }

  async cancelJob(jobId: string, actor: Actor): Promise<{ success: boolean; message: string }> {
    // Load the job from the database and verify the actor has access
    const dbJob = await this.db.client.dbJob.findFirst({
      where: { bullJobId: jobId },
    });

    if (!dbJob) {
      throw new NotFoundException(`Job with id ${jobId} not found`);
    }

    this.verifyJobAccess(dbJob, actor);

    // If the DB already shows the job as terminal, no need to cancel
    if (['completed', 'failed', 'canceled'].includes(dbJob.status)) {
      return {
        success: false,
        message: `Job ${jobId} is already ${dbJob.status}`,
      };
    }

    // Mark the job as canceled in Postgres immediately so the UI reflects it right away.
    // Also set cancelRequestedAt so checkpoint() can detect it if the worker is still running.
    const now = new Date();
    await this.db.client.dbJob.update({
      where: { id: dbJob.id },
      data: { status: 'canceled', cancelRequestedAt: now, finishedOn: now, error: 'Canceled by user' },
    });

    // Try to also send the fast-path pub/sub signal for immediate in-memory abort
    const queue = new Queue('worker-queue', {
      connection: this.getRedis(),
    });
    const job = await queue.getJob(jobId);
    await queue.close();

    if (!job) {
      return {
        success: true,
        message: `Job ${jobId} has been canceled`,
      };
    }

    const state = await job.getState();

    if (state === 'completed' || state === 'failed') {
      // Sync DB status to match BullMQ's terminal state instead
      await this.db.client.dbJob.update({
        where: { id: dbJob.id },
        data: { status: state, finishedOn: now },
      });
      return {
        success: false,
        message: `Job ${jobId} is already ${state}`,
      };
    }

    // Send cancellation message for immediate abort (fast path)
    const channelName = `job-cancel:${jobId}`;
    await this.getRedis().publish(channelName, JSON.stringify({ action: 'cancel', jobId }));

    return {
      success: true,
      message: `Job ${jobId} has been canceled`,
    };
  }
}
