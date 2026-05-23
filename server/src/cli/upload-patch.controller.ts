import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  createPlainId,
  UploadPatchBlockedStaleResponseDto,
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
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
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
    private readonly scratchGitService: ScratchGitService,
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
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

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

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Issued patch-upload URL for ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'upload_patch.init',
        workbookId,
        connectorAccountId: body.connectorAccountId,
        uploadId,
      },
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

    // Staleness gate. With `refuseIfStale: true` (D8, default for `files
    // upload` / desktop publish modal), a mismatch between the client's
    // `baseHead` and the server's current `refs/heads/main` aborts the call
    // with HTTP 409 + structured body. Without the flag we fall back to the
    // legacy soft-warning behavior (decision log #4) and apply patches anyway.
    // The check has to run BEFORE `enqueueApplyPatchesJob` + the audit log
    // so a refused call leaves no side effects.
    const currentRemoteHead = body.baseHead ? await this.lookupRemoteHead(body.connectorAccountId) : null;
    const stale = currentRemoteHead !== null && body.baseHead !== currentRemoteHead;

    if (stale && currentRemoteHead !== null && body.refuseIfStale === true) {
      const payload: UploadPatchBlockedStaleResponseDto = {
        status: 'blocked_stale',
        baseHead: body.baseHead,
        currentRemoteHead,
        message:
          'Server `main` has advanced past your local `main`. Run `scratchmd files download` to refresh, then retry.',
      };
      WSLogger.info({
        source: 'UploadPatchController.commit',
        message: 'Refused upload-patch commit due to stale baseHead',
        workbookId,
        userId: actor.userId,
        data: {
          uploadId: body.uploadId,
          connectorAccountId: body.connectorAccountId,
          baseHead: body.baseHead,
          currentRemoteHead,
        },
      });
      throw new ConflictException(payload);
    }

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
        currentRemoteHead,
      },
    });

    const stalenessWarning = stale && currentRemoteHead !== null ? { newHead: currentRemoteHead } : undefined;

    return {
      jobId: job.id ? String(job.id) : null,
      ...(stalenessWarning ? { stalenessWarning } : {}),
    };
  }

  /**
   * Resolve the current `refs/heads/main` SHA for the connection's repo,
   * via the scratch-git service. Returns `null` only when the branch is
   * truly absent (fresh repo, never published) — any other failure mode
   * (network, server error) propagates as the underlying exception so we
   * never silently treat "lookup failed" as "fresh". The configService is
   * kept on the constructor signature so DI graph drift in tests is loud.
   */
  private async lookupRemoteHead(connectorAccountId: string): Promise<string | null> {
    if (!this.configService) {
      throw new Error('ScratchConfigService unavailable — DI graph drift');
    }
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.getBranchHead(repoId, MAIN_BRANCH);
  }
}
