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
  UploadPatchBlockedDirtyResponseDto,
  UploadPatchBlockedStaleResponseDto,
  UploadPatchCheckFailedResponseDto,
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
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { PostHogEventName, PostHogService } from 'src/posthog/posthog.service';
import { gcsKeyForPatchUpload } from 'src/publish-plan/apply-patches.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
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
    private readonly experimentsService: ExperimentsService,
    private readonly posthogService: PostHogService,
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
    const connectorAccountId = body.connectorAccountId;

    // DEV-10316 dirty gate. With `refuseIfDirty: true` (sent by updated desktop
    // / `scratchmd files upload`) and the org kill switch enabled, refuse the
    // commit when this connection's `dirty` branch already holds unpublished
    // record changes versus live `refs/heads/main`. That keeps the desktop/CLI
    // from piling its approved edits onto a staging area that isn't already
    // clean — the path by which the web sync's staged changes got swept into a
    // desktop publish. The gate measures against live `main` (not the
    // `merge_base` tag) so a routine pull doesn't false-positive (decision #6),
    // and runs BEFORE the staleness gate (decision #5), the job enqueue, and
    // the audit log, so a refusal — or a `checkOnly` probe — leaves zero side
    // effects.
    //
    // Two DISTINCT failure modes, deliberately asymmetric:
    //   - The kill-switch flag read degrades the gate to OFF (publish proceeds).
    //     PostHog is a separate concern from the data path; we don't block
    //     publishes on an analytics-service outage. This `&&` short-circuits.
    //   - The git check ITSELF failing fails CLOSED with a retryable 503
    //     (decision #7) — see the try/catch below. Never an unguarded upload.
    if (
      body.refuseIfDirty === true &&
      (await this.experimentsService.getBooleanFlagForOrg(
        SystemFeatureFlag.DESKTOP_DIRTY_GATE_ENABLED,
        false,
        workbook.organizationId,
      ))
    ) {
      let pendingCount: number;
      try {
        const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
        pendingCount = await this.scratchGitService.getPendingChangeCountVsMain(repoId);
      } catch (err) {
        // Fail closed (decision #7): if the check itself can't run (git service
        // down or busy) hold the publish with a distinct retryable error rather
        // than risk an unguarded upload. No job, no audit log.
        WSLogger.warn({
          source: 'UploadPatchController.commit',
          message: 'Dirty gate check failed — holding publish (fail-closed)',
          workbookId,
          userId: actor.userId,
          data: { connectorAccountId },
          error: err,
        });
        const payload: UploadPatchCheckFailedResponseDto = {
          status: 'check_failed',
          connectorAccountId,
          message: "Couldn't verify the server's state. Try again.",
        };
        throw new ServiceUnavailableException(payload);
      }

      if (pendingCount > 0) {
        const payload: UploadPatchBlockedDirtyResponseDto = {
          status: 'blocked_dirty',
          connectorAccountId,
          dirtyCount: pendingCount,
          message:
            'This connection has unpublished changes on the server. Publish or discard them on the web, then retry.',
        };
        WSLogger.info({
          source: 'UploadPatchController.commit',
          message: 'Refused upload-patch commit due to pending server changes',
          workbookId,
          userId: actor.userId,
          data: { connectorAccountId, dirtyCount: pendingCount },
        });
        this.posthogService.captureEvent(PostHogEventName.DESKTOP_PUBLISH_BLOCKED_DIRTY, actor, {
          connectorAccountId,
          dirtyCount: pendingCount,
        });
        throw new ConflictException(payload);
      }
    }

    // Two-pass probe (decision #3). The CLI's first pass runs the gates for
    // every connection without applying; only if every connection is clean does
    // it run the real apply pass. Return success WITHOUT enqueueing the
    // ApplyPatches job or writing an audit log so a clean probe leaves zero side
    // effects. (Staleness is enforced on the apply pass / next attempt —
    // pending-changes is surfaced first, decision #5.)
    if (body.checkOnly === true) {
      return { jobId: null };
    }

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
   * via the scratch-git service. Returns `null` only when the `main` branch is
   * absent *on an existing repo* (repo created but never published) — scratch-git
   * answers that with `{ sha: null }`, not a 404.
   *
   * A 404 is different: it means the connection has no repository on this
   * scratch-git instance at all (never initialized/pulled here — e.g. a fresh
   * dev/Conductor workspace whose repo store is empty while the shared DB still
   * references the connection). Publishing cannot proceed in that state — the
   * ApplyPatches worker would hit the same missing repo when it commits to
   * `dirty` — so we fail fast at the boundary with an actionable 409 instead of
   * letting the raw `ScratchGitNotFoundError` surface as an opaque HTTP 500.
   * Any other failure mode (network, scratch-git 5xx) still propagates so we
   * never silently treat "lookup failed" as "fresh". The configService is kept
   * on the constructor signature so DI graph drift in tests is loud.
   */
  private async lookupRemoteHead(connectorAccountId: string): Promise<string | null> {
    if (!this.configService) {
      throw new Error('ScratchConfigService unavailable — DI graph drift');
    }
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    try {
      return await this.scratchGitService.getBranchHead(repoId, MAIN_BRANCH);
    } catch (err) {
      if (err instanceof ScratchGitNotFoundError) {
        throw new ConflictException(
          `No repository exists on the server for this connection (${repoId}). It has not been ` +
            `pulled or initialized on this server, so there is nothing to publish onto. Pull the ` +
            `connection on this server before publishing.`,
        );
      }
      throw err;
    }
  }
}
