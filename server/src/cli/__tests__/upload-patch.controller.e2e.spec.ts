/* eslint-disable @typescript-eslint/unbound-method -- supertest assertions on jest.Mock calls */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- app.getHttpServer() vs supertest's App */
/**
 * Controller-level e2e for `/upload-patch`.
 *
 * Sibling of the unit spec at `upload-patch.controller.spec.ts`. The unit spec
 * exercises the controller class directly with hand-mocked dependencies; this
 * file boots a NestJS `TestingModule` + supertest so the request goes through
 * the real HTTP layer: route matching, DTO validation, guards (overridden to
 * pass), serializer, and exception filters.
 *
 * Scope (eng-review follow-up E6):
 *   - AuditLog row written on `/upload-patch/init` and `/upload-patch/commit`
 *     (verified via `auditLogService.logEvent` jest mock — the AuditLogService
 *     is the trust boundary; the Prisma write itself is the service's
 *     responsibility, not the controller's).
 *   - 503 ServiceUnavailable surfaces with the right body when the patch-upload
 *     bucket is unconfigured.
 *   - Staleness pass-through: `stalenessWarning.newHead` survives serialization
 *     when `baseHead` differs and `refuseIfStale` is unset, and the structured
 *     `blocked_stale` body is preserved when `refuseIfStale` is true.
 */
import type { INestApplication } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WorkbookCluster } from 'src/db/cluster-types';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import request from 'supertest';
import { UploadPatchController } from '../upload-patch.controller';

const WORKBOOK_ID = 'wkb_e2e_test' as WorkbookId;
const USER_ID = 'usr_e2e';
const ORG_ID = 'org_e2e';
const CONNECTOR_ID = 'ca_e2e_conn';
const UPLOAD_ID = 'upl_e2e_xyz';
const SERVER_MAIN_SHA = 'a'.repeat(40);
const LOCAL_MAIN_SHA = 'b'.repeat(40);

describe('UploadPatchController (controller-level e2e)', () => {
  let app: INestApplication;
  let auditLogService: jest.Mocked<AuditLogService>;
  let objectStorageService: jest.Mocked<ObjectStorageService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let experimentsService: jest.Mocked<ExperimentsService>;
  let posthogService: jest.Mocked<PostHogService>;

  beforeEach(async () => {
    const workbookService = {
      assertWritableWorkbook: jest.fn().mockResolvedValue({
        id: WORKBOOK_ID,
        name: 'E2E Workbook',
        organizationId: ORG_ID,
      } as unknown as WorkbookCluster.Workbook),
    };

    objectStorageService = {
      isPatchUploadConfigured: jest.fn().mockReturnValue(true),
      signPutUrlForPatchUpload: jest.fn().mockResolvedValue('https://signed.example/upload'),
    } as unknown as jest.Mocked<ObjectStorageService>;

    bullEnqueuerService = {
      enqueueApplyPatchesJob: jest.fn().mockResolvedValue({ id: 'job_e2e_1' }),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue(`${ORG_ID}/${WORKBOOK_ID}/${CONNECTOR_ID}`),
      getBranchHead: jest.fn().mockResolvedValue(SERVER_MAIN_SHA),
      getPendingChangeCountVsMain: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<ScratchGitService>;

    experimentsService = {
      getBooleanFlagForOrg: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ExperimentsService>;

    posthogService = {
      captureEvent: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    const moduleBuilder = Test.createTestingModule({
      controllers: [UploadPatchController],
      providers: [
        { provide: WorkbookService, useValue: workbookService },
        { provide: ObjectStorageService, useValue: objectStorageService },
        { provide: BullEnqueuerService, useValue: bullEnqueuerService },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: ScratchConfigService, useValue: {} },
        { provide: ScratchGitService, useValue: scratchGitService },
        { provide: ExperimentsService, useValue: experimentsService },
        { provide: PostHogService, useValue: posthogService },
      ],
    })
      .overrideGuard(ScratchAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<RequestWithUser>();
          req.user = {
            id: USER_ID,
            organizationId: ORG_ID,
            authType: 'api-token',
            authSource: 'cli',
          } as unknown as RequestWithUser['user'];
          return true;
        },
      })
      .overrideGuard(ApiRateLimitGuard)
      .useValue({ canActivate: () => true });

    const moduleRef: TestingModule = await moduleBuilder.compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  describe('POST /cli/v1/workbooks/:id/upload-patch/init', () => {
    it('returns 200 with the presigned URL and writes an audit row', async () => {
      const body: UploadPatchInitDto = { connectorAccountId: CONNECTOR_ID };
      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/init`)
        .send(body)
        .expect(201);

      expect(res.body.uploadId).toMatch(/^[A-Za-z0-9]+$/);
      expect(res.body.presignedUrl).toBe('https://signed.example/upload');
      expect(res.body.expiresInSeconds).toBeGreaterThan(0);

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

    it('returns 503 with the configuration-failure message when bucket is unset', async () => {
      objectStorageService.isPatchUploadConfigured.mockReturnValue(false);
      const body: UploadPatchInitDto = { connectorAccountId: CONNECTOR_ID };

      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/init`)
        .send(body)
        .expect(503);

      expect(res.body.statusCode).toBe(503);
      expect(res.body.message).toMatch(/GCS_PATCH_UPLOAD_BUCKET/);
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('returns 400 when connectorAccountId missing and writes no audit row', async () => {
      await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/init`)
        .send({})
        .expect(400);

      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });
  });

  describe('POST /cli/v1/workbooks/:id/upload-patch/commit', () => {
    it('returns 201 + populates stalenessWarning when baseHead differs and refuseIfStale is unset', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA,
      };

      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/commit`)
        .send(body)
        .expect(201);

      expect(res.body.jobId).toBe('job_e2e_1');
      expect(res.body.stalenessWarning).toEqual({ newHead: SERVER_MAIN_SHA });
      expect(bullEnqueuerService.enqueueApplyPatchesJob).toHaveBeenCalledTimes(1);
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
      const entry = auditLogService.logEvent.mock.calls[0][0];
      expect(entry.eventType).toBe('publish');
      expect(entry.context).toMatchObject({
        action: 'upload_patch.commit',
        connectorAccountId: CONNECTOR_ID,
        uploadId: UPLOAD_ID,
      });
    });

    it('returns 409 with structured blocked_stale body when refuseIfStale=true and baseHead differs', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: LOCAL_MAIN_SHA,
        refuseIfStale: true,
      };

      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/commit`)
        .send(body)
        .expect(409);

      const payload = res.body as UploadPatchBlockedStaleResponseDto;
      expect(payload.status).toBe('blocked_stale');
      expect(payload.baseHead).toBe(LOCAL_MAIN_SHA);
      expect(payload.currentRemoteHead).toBe(SERVER_MAIN_SHA);
      expect(payload.message).toMatch(/main/);

      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('returns 201 + no stalenessWarning when baseHead matches server main', async () => {
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        baseHead: SERVER_MAIN_SHA,
      };

      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/commit`)
        .send(body)
        .expect(201);

      expect(res.body.jobId).toBe('job_e2e_1');
      expect(res.body.stalenessWarning).toBeUndefined();
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
    });

    it('returns 409 with structured count-only blocked_dirty body when refuseIfDirty=true and the connection is dirty', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(47);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
      };

      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/commit`)
        .send(body)
        .expect(409);

      const payload = res.body as UploadPatchBlockedDirtyResponseDto;
      expect(payload.status).toBe('blocked_dirty');
      expect(payload.connectorAccountId).toBe(CONNECTOR_ID);
      expect(payload.dirtyCount).toBe(47);

      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('returns 503 with a retryable check_failed body when the dirty check itself fails (fail-closed)', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockRejectedValue(new Error('scratch-git down'));
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
      };

      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/commit`)
        .send(body)
        .expect(503);

      const payload = res.body as UploadPatchCheckFailedResponseDto;
      expect(payload.status).toBe('check_failed');
      expect(payload.connectorAccountId).toBe(CONNECTOR_ID);

      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('returns 201 + jobId:null for a checkOnly probe on a clean connection (no job, no audit)', async () => {
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(0);
      const body: UploadPatchCommitDto = {
        uploadId: UPLOAD_ID,
        connectorAccountId: CONNECTOR_ID,
        refuseIfDirty: true,
        checkOnly: true,
      };

      const res = await request(app.getHttpServer())
        .post(`/cli/v1/workbooks/${WORKBOOK_ID}/upload-patch/commit`)
        .send(body)
        .expect(201);

      expect(res.body.jobId).toBeNull();
      expect(bullEnqueuerService.enqueueApplyPatchesJob).not.toHaveBeenCalled();
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
    });
  });
});
