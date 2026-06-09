/* eslint-disable @typescript-eslint/unbound-method -- Jest mocks passed to expect().toHaveBeen* */
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type {
  UploadPatchBlockedDirtyResponseDto,
  UploadPatchBlockedStaleResponseDto,
  UploadPatchCheckFailedResponseDto,
  UploadPatchCommitDto,
  UploadPatchInitDto,
  WorkbookId,
} from '@spinner/shared-types';
import { ObjectStorageService } from 'src/asset/object-storage.service';
import { AuditLogService } from 'src/audit/audit-log.service';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WorkbookCluster } from 'src/db/cluster-types';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { PostHogEventName, PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import type { RepoId } from 'src/scratch-git/scratch-git.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { UploadPatchController } from '../upload-patch.controller';

const WORKBOOK_ID = 'wkb_test123' as WorkbookId;
const USER_ID = 'usr_abc';
const ORG_ID = 'org_test';
const CONNECTOR_ID = 'ca_conn1';
const UPLOAD_ID = 'upl_xyz';
const REPO_ID = `${ORG_ID}/${WORKBOOK_ID}/${CONNECTOR_ID}` as RepoId;
const SERVER_MAIN_SHA = 'a'.repeat(40);
const LOCAL_MAIN_SHA = 'b'.repeat(40);

function makeReq(): RequestWithUser {
  return {
    user: {
      id: USER_ID,
      organizationId: ORG_ID,
      authType: 'jwt',
      authSource: 'user',
    },
  } as unknown as RequestWithUser;
}

function makeWorkbook(): WorkbookCluster.Workbook {
  return {
    id: WORKBOOK_ID,
    name: 'Test Workbook',
    organizationId: ORG_ID,
  } as unknown as WorkbookCluster.Workbook;
}

describe('UploadPatchController', () => {
  let controller: UploadPatchController;
  let workbookService: jest.Mocked<WorkbookService>;
  let objectStorageService: jest.Mocked<ObjectStorageService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let configService: jest.Mocked<ScratchConfigService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let experimentsService: jest.Mocked<ExperimentsService>;
  let posthogService: jest.Mocked<PostHogService>;

  beforeEach(() => {
    workbookService = {
      assertWritableWorkbook: jest.fn().mockResolvedValue(makeWorkbook()),
    } as unknown as jest.Mocked<WorkbookService>;

    objectStorageService = {
      isPatchUploadConfigured: jest.fn().mockReturnValue(true),
      signPutUrlForPatchUpload: jest.fn().mockResolvedValue('https://signed.example/upload'),
    } as unknown as jest.Mocked<ObjectStorageService>;

    bullEnqueuerService = {
      enqueueApplyPatchesJob: jest.fn().mockResolvedValue({ id: 'job_1' }),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    configService = {} as unknown as jest.Mocked<ScratchConfigService>;

    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue(REPO_ID),
      getBranchHead: jest.fn().mockResolvedValue(SERVER_MAIN_SHA),
      getPendingChangeCountVsMain: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<ScratchGitService>;

    // Default: kill switch ON so the dirty-gate suite exercises the gate. The
    // staleness/validation suites pass `refuseIfDirty` falsy, so the gate is
    // skipped for them regardless of this flag.
    experimentsService = {
      getBooleanFlagForOrg: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ExperimentsService>;

    posthogService = {
      captureEvent: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    controller = new UploadPatchController(
      workbookService,
      objectStorageService,
      bullEnqueuerService,
      auditLogService,
      configService,
      scratchGitService,
      experimentsService,
      posthogService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('init', () => {
    it('returns presigned URL when bucket configured', async () => {
      const body: UploadPatchInitDto = { connectorAccountId: CONNECTOR_ID };
      const result = await controller.init(makeReq(), WORKBOOK_ID, body);
      expect(result.uploadId).toMatch(/^[A-Za-z0-9]+$/);
      expect(result.presignedUrl).toBe('https://signed.example/upload');
      expect(result.expiresInSeconds).toBeGreaterThan(0);
    });

    it('writes an audit-log row when issuing a presigned URL', async () => {
      const body: UploadPatchInitDto = { connectorAccountId: CONNECTOR_ID };
      await controller.init(makeReq(), WORKBOOK_ID, body);
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
      const entry = auditLogService.logEvent.mock.calls[0][0];
      expect(entry.eventType).toBe('update');
      expect(entry.entityId).toBe(WORKBOOK_ID);
      expect(entry.organizationId).toBe(ORG_ID);
      expect(entry.context).toMatchObject({
        action: 'upload_patch.init',
        connectorAccountId: CONNECTOR_ID,
      });
    });

    it('throws ServiceUnavailable when bucket unconfigured', async () => {
      objectStorageService.isPatchUploadConfigured.mockReturnValue(false);
      const body: UploadPatchInitDto = { connectorAccountId: CONNECTOR_ID };
      await expect(controller.init(makeReq(), WORKBOOK_ID, body)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('throws BadRequest when connectorAccountId missing', async () => {
      const body: UploadPatchInitDto = {};
      await expect(controller.init(makeReq(), WORKBOOK_ID, body)).rejects.toBeInstanceOf(BadRequestException);
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });
  });

  describe('commit — staleness gate', () => {
    it('applies + populates stalenessWarning when baseHead differs and refuseIfStale is unset', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.jobId).toBe('job_1');
      expect(result.stalenessWarning).toEqual({ newHead: SERVER_MAIN_SHA });
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
    });

    it('applies + omits stalenessWarning when baseHead matches server main', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: SERVER_MAIN_SHA,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.stalenessWarning).toBeUndefined();
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
    });

    it('refuses with ConflictException + structured body when refuseIfStale=true and baseHead differs', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA,
        refuseIfStale: true,
      };
      let caught: unknown;
      try {
        await controller.commit(makeReq(), WORKBOOK_ID, body);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const payload = (caught as ConflictException).getResponse() as UploadPatchBlockedStaleResponseDto;
      expect(payload.status).toBe('blocked_stale');
      expect(payload.baseHead).toBe(LOCAL_MAIN_SHA);
      expect(payload.currentRemoteHead).toBe(SERVER_MAIN_SHA);
      expect(payload.message).toMatch(/main/);
      // No side effects on refusal.
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('applies normally when refuseIfStale=true and baseHead matches', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: SERVER_MAIN_SHA,
        refuseIfStale: true,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.stalenessWarning).toBeUndefined();
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
    });

    it('skips the branch-head lookup when baseHead is omitted', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.jobId).toBe('job_1');
      expect(result.stalenessWarning).toBeUndefined();
      expect(scratchGitService.getBranchHead).not.toHaveBeenCalled();
      expect(scratchGitService.resolveConnectionRepoPath).not.toHaveBeenCalled();
    });

    it('treats a null currentRemoteHead (fresh repo) as not-stale', async () => {
      scratchGitService.getBranchHead.mockResolvedValue(null);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA,
        refuseIfStale: true,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.stalenessWarning).toBeUndefined();
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
    });

    it('translates a missing-repo 404 from the branch-head lookup into a clear ConflictException, not an opaque 500', async () => {
      // scratch-git answers a non-existent repo with a 404 (not `{ sha: null }`),
      // which the client surfaces as ScratchGitNotFoundError. The staleness gate
      // must convert that into an actionable refusal instead of letting it bubble
      // up as a generic HTTP 500. Repro for the upload-patch-commit-500 bug: a
      // Conductor workspace whose scratch-git repo store is empty while the shared
      // DB still references the connection.
      scratchGitService.getBranchHead.mockRejectedValue(
        new ScratchGitNotFoundError(
          `/api/repo/manage/${REPO_ID}/branch-head?branch=main`,
          '{"data":{"error":"File not found"}}',
        ),
      );
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA,
        refuseIfStale: true,
      };
      let caught: unknown;
      try {
        await controller.commit(makeReq(), WORKBOOK_ID, body);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const payload = (caught as ConflictException).getResponse() as { message: string };
      expect(payload.message).toMatch(/No repository exists on the server/);
      // No side effects: the publish is refused before any job/audit row.
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('still propagates non-404 branch-head failures (so "lookup failed" is never treated as "fresh")', async () => {
      scratchGitService.getBranchHead.mockRejectedValue(new Error('scratch-git 500'));
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA,
        refuseIfStale: true,
      };
      await expect(controller.commit(makeReq(), WORKBOOK_ID, body)).rejects.toThrow('scratch-git 500');
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
    });
  });

  describe('commit — dirty gate (DEV-10316)', () => {
    it('refuses with ConflictException + count-only blocked_dirty when refuseIfDirty=true and pending changes exist', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(47);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
      };
      let caught: unknown;
      try {
        await controller.commit(makeReq(), WORKBOOK_ID, body);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const payload = (caught as ConflictException).getResponse() as UploadPatchBlockedDirtyResponseDto;
      expect(payload.status).toBe('blocked_dirty');
      expect(payload.connectorAccountId).toBe(CONNECTOR_ID);
      expect(payload.dirtyCount).toBe(47);
      // Count-only: no per-record breakdown leaks into the payload.
      expect(payload).not.toHaveProperty('paths');
      // No side effects on refusal.
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
      // Gate-fire analytics emitted.
      expect(posthogService.captureEvent).toHaveBeenCalledWith(
        PostHogEventName.DESKTOP_PUBLISH_BLOCKED_DIRTY,
        expect.objectContaining({ userId: USER_ID }),
        { connectorAccountId: CONNECTOR_ID, dirtyCount: 47 },
      );
    });

    it('proceeds to apply when refuseIfDirty=true but the connection is clean', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(0);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.jobId).toBe('job_1');
      expect(scratchGitService.getPendingChangeCountVsMain).toHaveBeenCalledTimes(1);
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
    });

    it('checkOnly=true probes the gate and returns { jobId: null } without enqueueing or auditing', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(0);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
        checkOnly: true,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.jobId).toBeNull();
      expect(scratchGitService.getPendingChangeCountVsMain).toHaveBeenCalledTimes(1);
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('checkOnly=true still refuses a dirty connection (blocks the whole publish before any apply)', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(3);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
        checkOnly: true,
      };
      await expect(controller.commit(makeReq(), WORKBOOK_ID, body)).rejects.toBeInstanceOf(ConflictException);
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
    });

    it('skips the gate entirely on the legacy soft path (refuseIfDirty falsy)', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(99);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.jobId).toBe('job_1');
      expect(scratchGitService.getPendingChangeCountVsMain).not.toHaveBeenCalled();
      expect(experimentsService.getBooleanFlagForOrg).not.toHaveBeenCalled();
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
    });

    it('skips the gate when the kill switch is off (restores legacy behavior)', async () => {
      experimentsService.getBooleanFlagForOrg.mockResolvedValue(false);
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(99);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.jobId).toBe('job_1');
      expect(scratchGitService.getPendingChangeCountVsMain).not.toHaveBeenCalled();
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
    });

    it('fail-closed: a check failure yields a retryable 503 check_failed, no job, no audit', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockRejectedValue(new Error('scratch-git down'));
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
      };
      let caught: unknown;
      try {
        await controller.commit(makeReq(), WORKBOOK_ID, body);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      const payload = (caught as ServiceUnavailableException).getResponse() as UploadPatchCheckFailedResponseDto;
      expect(payload.status).toBe('check_failed');
      expect(payload.connectorAccountId).toBe(CONNECTOR_ID);
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('dirty gate wins over the staleness gate when both would fire', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(5);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA, // stale vs SERVER_MAIN_SHA
        refuseIfStale: true,
        refuseIfDirty: true,
      };
      let caught: unknown;
      try {
        await controller.commit(makeReq(), WORKBOOK_ID, body);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const payload = (caught as ConflictException).getResponse() as { status: string };
      expect(payload.status).toBe('blocked_dirty'); // pending-changes surfaced before staleness
    });

    it('does not block when the vs-main count is 0 (post-pull merge_base lag does not false-trip)', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(0);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
      };
      const result = await controller.commit(makeReq(), WORKBOOK_ID, body);
      expect(result.jobId).toBe('job_1');
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('commit — validation', () => {
    it('throws BadRequest when uploadId missing', async () => {
      const body: UploadPatchCommitDto = { connectorAccountId: CONNECTOR_ID };
      await expect(controller.commit(makeReq(), WORKBOOK_ID, body)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when connectorAccountId missing', async () => {
      const body: UploadPatchCommitDto = { uploadId: UPLOAD_ID };
      await expect(controller.commit(makeReq(), WORKBOOK_ID, body)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
