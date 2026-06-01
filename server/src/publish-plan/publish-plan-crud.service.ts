import { Injectable } from '@nestjs/common';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { DbService } from '../db/db.service';

@Injectable()
export class PublishPlanCrudService {
  constructor(
    private readonly db: DbService,
    private readonly bullEnqueuerService: BullEnqueuerService,
  ) {}

  async listPublishPlans(workbookId: string, connectorAccountId?: string) {
    const pipelines = await this.db.client.publishPlan.findMany({
      where: {
        workbookId,
        connectorAccountId: connectorAccountId || undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: 20, // increased for list view just to be safe
      include: {
        _count: {
          select: { operations: true },
        },
        author: {
          select: { id: true, name: true, email: true },
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
      orderBy: [{ sourceFilePath: 'asc' }],
    });
  }

  async listAssetIndex(workbookId: string, dataFolderId?: string) {
    const assets = await this.db.client.asset.findMany({
      where: { workbookId, ...(dataFolderId ? { dataFolderId } : {}) },
      orderBy: [{ service: 'asc' }, { lastSeenAt: 'desc' }],
    });
    return assets.map((a) => ({ ...a, size: a.size != null ? Number(a.size) : null }));
  }

  async listPublishPlanOperations(
    pipelineId: string,
    options?: { page?: number; pageSize?: number; phase?: string; filePath?: string; hasError?: boolean },
  ) {
    const page = options?.page ?? 1;
    const pageSize = Math.min(options?.pageSize ?? 50, 200);
    const skip = (page - 1) * pageSize;

    const where: Record<string, unknown> = { planId: pipelineId };
    if (options?.phase) {
      where.phase = options.phase;
    }
    if (options?.filePath) {
      where.filePath = options.filePath;
    }
    if (options?.hasError) {
      where.error = { not: null };
    }

    const [data, total] = await Promise.all([
      this.db.client.publishPlanOperation.findMany({
        where,
        orderBy: [{ phase: 'asc' }, { filePath: 'asc' }],
        skip,
        take: pageSize,
      }),
      this.db.client.publishPlanOperation.count({ where }),
    ]);

    return { data, total, page, pageSize };
  }

  async deletePublishPlan(pipelineId: string) {
    return await this.db.client.publishPlan.delete({
      where: { id: pipelineId },
    });
  }

  async getPublishPlanById(workbookId: string, planId: string) {
    const p = await this.db.client.publishPlan.findFirst({
      where: { workbookId, id: planId },
      include: {
        _count: { select: { operations: true } },
        connectorAccount: { select: { id: true, displayName: true, service: true } },
        author: { select: { id: true, name: true, email: true } },
      },
    });
    return p;
  }

  /**
   * List records (operations grouped by filePath) for a publish plan.
   * One row per distinct filePath, with the list of phases that touched it.
   * Includes the distinct folders and phases present in the plan (for filter UIs).
   */
  async listPublishPlanRecords(
    pipelineId: string,
    options?: { page?: number; pageSize?: number; dataFolderId?: string; phase?: string; filename?: string },
  ) {
    const page = options?.page ?? 1;
    const pageSize = Math.min(options?.pageSize ?? 50, 200);

    // All operations matching plan + folder filter. Phase filter is applied
    // *after* grouping so that records show their full phase list even when
    // the user filters to records that have a specific phase.
    const baseWhere: Record<string, unknown> = { planId: pipelineId };
    if (options?.dataFolderId) {
      baseWhere.dataFolderId = options.dataFolderId;
    }

    const operations = await this.db.client.publishPlanOperation.findMany({
      where: baseWhere,
      select: { filePath: true, phase: true, status: true, dataFolderId: true, error: true },
      orderBy: { filePath: 'asc' },
    });

    // Group by filePath
    const byPath = new Map<
      string,
      { filePath: string; dataFolderId: string | null; phases: Set<string>; hasError: boolean }
    >();
    for (const op of operations) {
      const key = op.filePath;
      let row = byPath.get(key);
      if (!row) {
        row = { filePath: op.filePath, dataFolderId: op.dataFolderId ?? null, phases: new Set(), hasError: false };
        byPath.set(key, row);
      }
      row.phases.add(op.phase);
      if (op.status === 'failed-batch' || op.error) {
        row.hasError = true;
      }
    }

    let records = Array.from(byPath.values()).map((r) => ({
      filePath: r.filePath,
      dataFolderId: r.dataFolderId,
      phases: Array.from(r.phases).sort(),
      hasError: r.hasError,
    }));

    const phase = options?.phase;
    if (phase) {
      records = records.filter((r) => r.phases.includes(phase));
    }

    if (options?.filename) {
      // Substring match on the filename only (no folder prefix), case-
      // insensitive. The grouped filePath looks like `/folder/.../name.json`.
      const needle = options.filename.toLowerCase();
      records = records.filter((r) => {
        const filename = r.filePath.substring(r.filePath.lastIndexOf('/') + 1).toLowerCase();
        return filename.includes(needle);
      });
    }

    const total = records.length;
    const skip = (page - 1) * pageSize;
    const paged = records.slice(skip, skip + pageSize);

    // Build filter options across the full (unfiltered) operation set for this plan.
    const allOps = await this.db.client.publishPlanOperation.findMany({
      where: { planId: pipelineId },
      select: { dataFolderId: true, phase: true, filePath: true },
    });
    const folderCounts = new Map<string, number>();
    const phaseCounts = new Map<string, number>();
    const allFilePaths = new Set<string>();
    for (const op of allOps) {
      if (op.dataFolderId) folderCounts.set(op.dataFolderId, (folderCounts.get(op.dataFolderId) ?? 0) + 1);
      phaseCounts.set(op.phase, (phaseCounts.get(op.phase) ?? 0) + 1);
      allFilePaths.add(op.filePath);
    }
    const dataFolderIds = Array.from(folderCounts.keys());
    const dataFolders = dataFolderIds.length
      ? await this.db.client.dataFolder.findMany({
          where: { id: { in: dataFolderIds } },
          select: { id: true, path: true },
        })
      : [];

    return {
      data: paged,
      total,
      page,
      pageSize,
      /** Total unique records across the entire plan, ignoring filters. */
      affectedRecords: allFilePaths.size,
      /** Total operations across the entire plan, ignoring filters. */
      totalOperations: allOps.length,
      filters: {
        folders: dataFolders
          .map((f) => ({ id: f.id, path: f.path ?? '', count: folderCounts.get(f.id) ?? 0 }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        phases: Array.from(phaseCounts.entries())
          .map(([phase, count]) => ({ phase, count }))
          .sort((a, b) => a.phase.localeCompare(b.phase)),
      },
    };
  }

  async getPublishPlanByJobId(workbookId: string, jobId: string) {
    const p = await this.db.client.publishPlan.findFirst({
      where: { workbookId, activeJobId: jobId },
      include: {
        _count: { select: { operations: true } },
      },
    });

    if (!p) return null;

    let dbJob = null;
    let bullJob: Record<string, unknown> | null = null;

    const job = await this.db.client.dbJob.findFirst({
      where: { bullJobId: jobId },
      select: { bullJobId: true, status: true, type: true, progress: true },
    });
    if (job) {
      dbJob = { status: job.status, type: job.type, progress: job.progress };
    }

    try {
      const bullQueueJob = await this.bullEnqueuerService.getJob(jobId);
      if (bullQueueJob) {
        const state = await bullQueueJob.getState();
        bullJob = {
          id: bullQueueJob.id,
          name: bullQueueJob.name,
          progress: bullQueueJob.progress,
          data: bullQueueJob.data,
          state,
          failedReason: bullQueueJob.failedReason,
          stacktrace: bullQueueJob.stacktrace,
        };
      }
    } catch {
      // Ignore if not found
    }

    return {
      ...p,
      dbJob,
      bullJob,
      job: bullJob ? { ...bullJob, status: bullJob.state } : dbJob,
    };
  }
}
