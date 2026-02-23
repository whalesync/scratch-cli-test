import { Injectable } from '@nestjs/common';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { DbService } from '../db/db.service';

@Injectable()
export class PublishAdminService {
  constructor(
    private readonly db: DbService,
    private readonly bullEnqueuerService: BullEnqueuerService,
  ) {}

  async listPipelines(workbookId: string, connectorAccountId?: string) {
    const pipelines = await this.db.client.publishPlan.findMany({
      where: {
        workbookId,
        connectorAccountId: connectorAccountId || undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        _count: {
          select: { entries: true },
        },
      },
    });

    // Bulk-fetch job records for any pipelines that have an activeJobId
    const activeJobIds = pipelines.map((p) => p.activeJobId).filter((id): id is string => id != null);
    const dbJobMap = new Map<string, { status: string; type: string; progress: unknown }>();
    const bullJobMap = new Map<string, unknown>();

    if (activeJobIds.length > 0) {
      const jobs = await this.db.client.dbJob.findMany({
        where: { bullJobId: { in: activeJobIds } },
        select: { bullJobId: true, status: true, type: true, progress: true },
      });
      for (const job of jobs) {
        if (job.bullJobId) dbJobMap.set(job.bullJobId, { status: job.status, type: job.type, progress: job.progress });
      }

      // Fetch from BullMQ as well
      await Promise.all(
        activeJobIds.map(async (jobId) => {
          try {
            const bullJob = await this.bullEnqueuerService.getJob(jobId);
            if (bullJob) {
              const state = await bullJob.getState();
              bullJobMap.set(jobId, {
                id: bullJob.id,
                name: bullJob.name,
                progress: bullJob.progress,
                data: bullJob.data as unknown,
                state,
                failedReason: bullJob.failedReason,
                stacktrace: bullJob.stacktrace,
              });
            }
          } catch {
            // Ignore if Bull job is not found or other errors occur
          }
        }),
      );
    }

    return pipelines.map((p) => {
      const dbJob = p.activeJobId ? (dbJobMap.get(p.activeJobId) ?? null) : null;
      const bullJob = p.activeJobId
        ? ((bullJobMap.get(p.activeJobId) ?? null) as Record<string, unknown> | null)
        : null;
      return {
        ...p,
        dbJob,
        bullJob,
        // Normalize to always expose `status` — BullMQ uses `state`, DB uses `status`.
        job: bullJob ? { ...bullJob, status: bullJob.state } : dbJob,
      };
    });
  }

  async listFileIndex(workbookId: string) {
    return await this.db.client.fileIndex.findMany({
      where: { workbookId },
      orderBy: [{ folderPath: 'asc' }, { filename: 'asc' }],
    });
  }

  async listRefIndex(workbookId: string) {
    return await this.db.client.fileReference.findMany({
      where: { workbookId },
      orderBy: [{ sourceFilePath: 'asc' }, { targetFolderPath: 'asc' }],
    });
  }

  async listPipelineEntries(pipelineId: string) {
    return await this.db.client.publishPlanEntry.findMany({
      where: { planId: pipelineId },
      orderBy: [{ phase: 'asc' }, { filePath: 'asc' }],
    });
  }

  async deletePipeline(pipelineId: string) {
    return await this.db.client.publishPlan.delete({
      where: { id: pipelineId },
    });
  }
}
