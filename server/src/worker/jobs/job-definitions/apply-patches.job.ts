import { JobType, type WorkbookId } from '@spinner/shared-types';
import { ApplyPatchesService } from 'src/publish-plan/apply-patches.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress ────────────────────────────────────────────────────────

export type ApplyPatchesPublicProgress = {
  status: 'running' | 'completed' | 'failed';
  uploadId: string;
  patchCount: number;
  processedCount: number;
  pipelineId?: string;
  publishJobId?: string;
};

// ── Job Definition ─────────────────────────────────────────────────────────

export type ApplyPatchesJobDefinition = JobDefinitionBuilder<
  typeof JobType.ApplyPatches,
  {
    workbookId: WorkbookId;
    userId: string;
    organizationId: string;
    connectorAccountId: string;
    /** Opaque ID identifying the patch payload uploaded to GCS by `/upload-patch/init`. */
    uploadId: string;
    /** Optional client-known main HEAD at the time of upload. Best-effort staleness signal. */
    baseHead?: string;
  },
  ApplyPatchesPublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {},
  void
>;

// ── Handler ────────────────────────────────────────────────────────────────

export class ApplyPatchesJobHandler implements JobHandlerBuilder<ApplyPatchesJobDefinition> {
  constructor(private readonly applyPatchesService: ApplyPatchesService) {}

  async run(params: {
    jobId: string;
    data: ApplyPatchesJobDefinition['data'];
    progress: Progress<ApplyPatchesJobDefinition['publicProgress'], ApplyPatchesJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<ApplyPatchesJobDefinition['publicProgress'], ApplyPatchesJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;
    let latestProgress: Omit<ApplyPatchesPublicProgress, 'status'> = {
      uploadId: data.uploadId,
      patchCount: 0,
      processedCount: 0,
    };

    WSLogger.info({
      source: 'ApplyPatchesJobHandler',
      message: 'Starting apply-patches job',
      workbookId: data.workbookId,
      jobId,
      data: { uploadId: data.uploadId, connectorAccountId: data.connectorAccountId },
    });

    await checkpoint({
      publicProgress: { status: 'running', ...latestProgress },
      jobProgress: {},
      connectorProgress: {},
    });

    try {
      const onProgress = async (next: Omit<ApplyPatchesPublicProgress, 'status'>) => {
        latestProgress = next;
        await checkpoint({
          publicProgress: { status: 'running', ...next },
          jobProgress: {},
          connectorProgress: {},
        });
      };

      const result = await this.applyPatchesService.applyAndPublish({
        workbookId: data.workbookId,
        userId: data.userId,
        organizationId: data.organizationId,
        connectorAccountId: data.connectorAccountId,
        uploadId: data.uploadId,
        onProgress,
      });

      latestProgress = {
        uploadId: data.uploadId,
        patchCount: result.patchCount,
        processedCount: result.patchCount,
        ...(result.pipelineId ? { pipelineId: result.pipelineId } : {}),
        ...(result.publishJobId ? { publishJobId: result.publishJobId } : {}),
      };

      await checkpoint({
        publicProgress: { status: 'completed', ...latestProgress },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'ApplyPatchesJobHandler',
        message: 'Apply-patches job completed',
        workbookId: data.workbookId,
        jobId,
        data: {
          uploadId: data.uploadId,
          patchCount: result.patchCount,
          pipelineId: result.pipelineId,
          publishJobId: result.publishJobId,
        },
      });
    } catch (err) {
      await checkpoint({
        publicProgress: { status: 'failed', ...latestProgress },
        jobProgress: {},
        connectorProgress: {},
      });
      throw err;
    }
  }
}
