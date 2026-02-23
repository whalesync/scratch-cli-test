import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

@Injectable()
export class PublishAdminService {
  constructor(private readonly db: DbService) {}

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
    const jobMap = new Map<string, { status: string; type: string; progress: unknown }>();

    if (activeJobIds.length > 0) {
      const jobs = await this.db.client.dbJob.findMany({
        where: { bullJobId: { in: activeJobIds } },
        select: { bullJobId: true, status: true, type: true, progress: true },
      });
      for (const job of jobs) {
        if (job.bullJobId) jobMap.set(job.bullJobId, { status: job.status, type: job.type, progress: job.progress });
      }
    }

    return pipelines.map((p) => ({
      ...p,
      job: p.activeJobId ? (jobMap.get(p.activeJobId) ?? null) : null,
    }));
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
