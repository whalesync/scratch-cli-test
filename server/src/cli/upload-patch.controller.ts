import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  createPlainId,
  UploadPatchCommitDto,
  UploadPatchCommitResponseDto,
  UploadPatchInitDto,
  UploadPatchInitResponseDto,
  WorkbookId,
} from '@spinner/shared-types';
import { ObjectStorageService } from 'src/asset/object-storage.service';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { gcsKeyForPatchUpload } from 'src/publish-plan/apply-patches.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { userToActor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';

const PRESIGNED_PUT_TTL_SECONDS = 60 * 60; // 1 hour — well under the 24h cap noted in the plan

/**
 * Two-step upload-then-commit flow for publishing record changes from the
 * desktop / CLI. The CLI:
 *   1. POSTs `/upload-patch/init` to receive an opaque uploadId + presigned
 *      GCS URL.
 *   2. PUTs the patch payload directly to GCS using the URL.
 *   3. POSTs `/upload-patch/commit` to enqueue the ApplyPatches worker, which
 *      applies the RFC 7396 patches to the dirty branch as one commit and then
 *      triggers the existing publish-v2 plan-job + run-job pipeline.
 *
 * Patches are validated server-side in the worker (defense-in-depth — the CLI
 * may pre-validate paths for UX but the server is the gate).
 */
@Controller('cli/v1/workbooks/:id/upload-patch')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class UploadPatchController {
  constructor(
    private readonly workbookService: WorkbookService,
    private readonly objectStorageService: ObjectStorageService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly auditLogService: AuditLogService,
    private readonly configService: ScratchConfigService,
  ) {}

  @Post('init')
  async init(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: UploadPatchInitDto,
  ): Promise<UploadPatchInitResponseDto> {
    const actor = userToActor(req.user);
    const workbookId = id as WorkbookId;
    // Init is a mutation prerequisite — block on pending workbooks.
    await this.workbookService.assertWritableWorkbook(actor, workbookId);

    if (!body.connectorAccountId) {
      throw new BadRequestException('connectorAccountId is required');
    }
    if (!this.objectStorageService.isPatchUploadConfigured()) {
      throw new ServiceUnavailableException(
        'Publish-patch uploads are not enabled on this server (GCS_PATCH_UPLOAD_BUCKET unset). Contact your administrator.',
      );
    }

    const uploadId = createPlainId();
    const key = gcsKeyForPatchUpload(uploadId);
    const presignedUrl = await this.objectStorageService.signPutUrlForPatchUpload(key, PRESIGNED_PUT_TTL_SECONDS);

    WSLogger.info({
      source: 'UploadPatchController.init',
      message: 'Issued presigned upload URL',
      workbookId,
      userId: actor.userId,
      data: { uploadId, connectorAccountId: body.connectorAccountId },
    });

    return { uploadId, presignedUrl, expiresInSeconds: PRESIGNED_PUT_TTL_SECONDS };
  }

  @Post('commit')
  async commit(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: UploadPatchCommitDto,
  ): Promise<UploadPatchCommitResponseDto> {
    const actor = userToActor(req.user);
    const workbookId = id as WorkbookId;
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

    if (!body.uploadId) throw new BadRequestException('uploadId is required');
    if (!body.connectorAccountId) throw new BadRequestException('connectorAccountId is required');

    const job = await this.bullEnqueuerService.enqueueApplyPatchesJob(
      workbookId,
      actor.userId,
      body.connectorAccountId,
      body.uploadId,
      body.baseHead,
    );

    // Audit log: every CLI-initiated mutation lands one row (server/CLAUDE.md).
    // patchCount + byteSize are unknown at this point (patches still in GCS);
    // the ApplyPatches worker emits a richer log when it streams the payload.
    await this.auditLogService.logEvent({
      actor,
      eventType: 'publish',
      message: `Submitted upload-patch publish for ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'upload_patch.commit',
        workbookId,
        connectorAccountId: body.connectorAccountId,
        uploadId: body.uploadId,
        baseHead: body.baseHead ?? null,
      },
    });

    // Staleness check is best-effort. The scratch-git service does not yet
    // expose a branch-head lookup; until it does, we accept baseHead and
    // surface no warning. CEO §3 explicitly allows soft semantics here.
    const stalenessWarning = this.detectStaleness(body.baseHead);

    return {
      jobId: job.id ? String(job.id) : null,
      ...(stalenessWarning ? { stalenessWarning } : {}),
    };
  }

  /**
   * Best-effort staleness signal — see CEO §3. Returns undefined until
   * scratch-git exposes a branch-head lookup; eng follow-up.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private detectStaleness(_baseHead: string | undefined): { newHead: string } | undefined {
    if (!this.configService) return undefined;
    return undefined;
  }
}
