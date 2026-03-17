import { Injectable } from '@nestjs/common';
import { Progress } from 'src/types/progress';
import { DbService } from '../db/db.service';
import { DbJob, DbJobStatus, JobEntity, dbJobToJobEntity } from './entities/job.entity';

@Injectable()
export class JobService {
  constructor(private readonly db: DbService) {}

  async createJob(params: {
    userId: string;
    type: string;
    data: Record<string, unknown>;
    bullJobId?: string;
    workbookId?: string;
    connectorAccountId?: string;
    progress?: Progress;
  }): Promise<DbJob> {
    const job = await this.db.client.job.create({
      data: {
        id: `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        userId: params.userId,
        workbookId: params.workbookId,
        connectorAccountId: params.connectorAccountId,
        type: params.type,
        data: params.data as object,
        bullJobId: params.bullJobId,
        progress: params.progress ?? undefined,
        status: 'created',
      },
    });
    return job as DbJob;
  }

  async updateJobProgressAndCheckCancel(id: string, progress: Progress): Promise<boolean> {
    const job = await this.db.client.job.update({
      where: { id },
      data: { progress },
      select: { cancelRequestedAt: true },
    });
    return job.cancelRequestedAt != null;
  }

  async updateJobStatus(params: {
    id: string;
    status: DbJobStatus;
    error?: string;
    processedOn?: Date;
    finishedOn?: Date;
    progress?: Progress;
  }): Promise<DbJob> {
    const job = await this.db.client.job.update({
      where: { id: params.id },
      data: {
        status: params.status,
        error: params.error,
        processedOn: params.processedOn,
        finishedOn: params.finishedOn,
        progress: params.progress,
      },
    });
    return job as DbJob;
  }

  async getJobByBullJobId(bullJobId: string): Promise<DbJob | null> {
    const job = await this.db.client.job.findFirst({ where: { bullJobId } });
    return job as DbJob | null;
  }

  async getJobById(id: string): Promise<JobEntity | null> {
    const job = await this.db.client.job.findUnique({ where: { id } });
    if (!job) return null;
    return dbJobToJobEntity(job as DbJob);
  }
}
