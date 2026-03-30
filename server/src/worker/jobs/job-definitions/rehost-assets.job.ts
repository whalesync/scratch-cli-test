import type { PrismaClient } from '@prisma/client';
import { JobType, type DataFolderId, type WorkbookId } from '@spinner/shared-types';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { AssetDownloadService } from 'src/asset/asset-download.service';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';

/** Maximum number of errors to track in progress */
const MAX_PROGRESS_ERRORS = 100;

export type RehostAssetsPublicProgress = {
  status: 'pending' | 'active' | 'completed' | 'failed';
  dataFolderId: string;
  dataFolderName: string;
  totalAssets: number;
  succeeded: number;
  failed: number;
  failures: Array<{ assetId: string; filename: string | null; error: string }>;
};

export type RehostAssetsJobDefinition = JobDefinitionBuilder<
  typeof JobType.RehostAssets,
  {
    workbookId: WorkbookId;
    dataFolderId: DataFolderId;
    userId: string;
    organizationId: string;
    /** When false, only downloads files to compute contentHash — does not upload to GCS. */
    rehost?: boolean;
    initialPublicProgress?: RehostAssetsPublicProgress;
  },
  RehostAssetsPublicProgress,
  Record<string, never>,
  void
>;

/** Number of assets per checkpoint batch. The download service manages its own concurrency
 *  via byte-budget limiting, so this just controls how often we checkpoint progress. */
const CHECKPOINT_BATCH_SIZE = 100;

export class RehostAssetsJobHandler implements JobHandlerBuilder<RehostAssetsJobDefinition> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly assetDownloadService: AssetDownloadService,
    private readonly workbookEventService: WorkbookEventService,
  ) {}

  async run(params: {
    jobId: string;
    data: RehostAssetsJobDefinition['data'];
    progress: Progress<RehostAssetsJobDefinition['publicProgress'], RehostAssetsJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<RehostAssetsJobDefinition['publicProgress'], RehostAssetsJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint, abortSignal } = params;

    const dataFolder = await this.prisma.dataFolder.findUnique({
      where: { id: data.dataFolderId },
    });

    if (!dataFolder) {
      WSLogger.error({
        source: 'RehostAssetsJob',
        message: `DataFolder not found: ${data.dataFolderId}`,
        jobId,
      });
      return;
    }

    const shouldRehost = data.rehost !== false;
    const assets = await this.prisma.asset.findMany({
      where: {
        dataFolderId: data.dataFolderId,
        workbookId: data.workbookId,
        // In rehost mode: only assets not yet rehosted
        // In hash-only mode: only assets without a content hash
        ...(shouldRehost ? { rehostedUrl: null } : { contentHash: null }),
        url: { not: null }, // Only assets with a source URL
      },
    });

    const publicProgress: RehostAssetsPublicProgress = {
      status: 'active',
      dataFolderId: data.dataFolderId,
      dataFolderName: dataFolder.name,
      totalAssets: assets.length,
      succeeded: 0,
      failed: 0,
      failures: [],
    };

    await checkpoint({ publicProgress, jobProgress: {}, connectorProgress: {} });

    WSLogger.info({
      source: 'RehostAssetsJob',
      message: `Starting rehost for ${assets.length} assets`,
      jobId,
      dataFolderId: data.dataFolderId,
      workbookId: data.workbookId,
    });

    // Process in checkpoint batches — the download service manages concurrency internally
    for (let i = 0; i < assets.length; i += CHECKPOINT_BATCH_SIZE) {
      if (abortSignal.aborted) {
        WSLogger.info({ source: 'RehostAssetsJob', message: 'Job aborted', jobId });
        break;
      }

      const batch = assets.slice(i, i + CHECKPOINT_BATCH_SIZE);
      const results = await this.assetDownloadService.downloadAndRehostBatch(batch, { rehost: shouldRehost });

      for (const result of results) {
        if (result.success) {
          publicProgress.succeeded++;
        } else {
          publicProgress.failed++;
          const asset = batch.find((a) => a.id === result.assetId);
          if (publicProgress.failures.length < MAX_PROGRESS_ERRORS) {
            publicProgress.failures.push({
              assetId: result.assetId,
              filename: asset?.filename ?? null,
              error: result.error ?? 'Unknown error',
            });
          }
        }
      }

      await checkpoint({ publicProgress, jobProgress: {}, connectorProgress: {} });
    }

    publicProgress.status = publicProgress.failed > 0 && publicProgress.succeeded === 0 ? 'failed' : 'completed';
    await checkpoint({ publicProgress, jobProgress: {}, connectorProgress: {} });

    this.workbookEventService.sendWorkbookEvent(data.workbookId, {
      type: 'job-completed',
      data: {
        source: 'job',
        entityId: data.dataFolderId,
        message: `Asset rehost complete: ${publicProgress.succeeded} succeeded, ${publicProgress.failed} failed`,
        jobId,
      },
    });

    WSLogger.info({
      source: 'RehostAssetsJob',
      message: `Rehost complete: ${publicProgress.succeeded} succeeded, ${publicProgress.failed} failed`,
      jobId,
      dataFolderId: data.dataFolderId,
    });
  }
}
