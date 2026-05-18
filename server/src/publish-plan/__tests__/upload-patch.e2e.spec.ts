/**
 * Permanent end-to-end smoke test for `/upload-patch` (plan T10).
 *
 * Survives Phase 7 (when the legacy `run-from-git` parity check is deleted)
 * as the integration regression backstop for the new publish flow.
 *
 * Scope intentionally narrowed: this test runs against a REAL PrismaClient
 * (so PublishPlan rows are written to Postgres) but uses in-memory boundary
 * mocks for ScratchGitService, ObjectStorageService, and BullEnqueuerService.
 *
 * That gives us, on every test run:
 *   - The patch path stores its plan in the database the same way the web
 *     publish flow does — exercising real Prisma writes, real foreign keys.
 *   - The applied dirty-branch state matches the patch payload.
 *   - The publish-v2 plan-pipeline job is enqueued with the right shape.
 *
 * What is deliberately NOT covered here, and lives in a follow-up:
 *   - Actually running the publish-v2 plan-job + run-job workers, dispatching
 *     to a real connector, and asserting main advanced + connector state.
 *     That mirrors `server/test/integration/fetch-edit-publish.spec.ts` but
 *     wraps the patch flow — the lift to add it is significant and orthogonal
 *     to the server flow we're shipping in PR 1.
 *   - Controller-level concerns (AuditLog row written by `/upload-patch/commit`,
 *     ServiceUnavailableException when GCS_PATCH_UPLOAD_BUCKET is unset,
 *     staleness warning). Those want supertest + a NestJS TestingModule.
 *
 * Gated on `DATABASE_URL` so `yarn test` stays hermetic — only the
 * integration runner picks this up.
 */
/* eslint-disable @typescript-eslint/require-await */

import { PrismaClient } from '@prisma/client';
import {
  AuthType,
  createConnectorAccountId,
  createDataFolderId,
  createWorkbookId,
  DataFolderId,
  UploadPatchPayload,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { Service as ConnectorService } from 'src/remote-service/connectors/service-constants';
import { Readable } from 'stream';
import { ApplyPatchesService } from '../apply-patches.service';
import { PublishPlanBuildService } from '../publish-plan-build.service';

const describeIfIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describeIfIntegration('/upload-patch end-to-end (real Prisma, mocked git/GCS/Bull)', () => {
  let prisma: PrismaClient;
  let orgId: string;
  let userId: string;
  let workbookId: WorkbookId;
  let connectorAccountId: string;
  let companiesFolderId: DataFolderId;
  let postsFolderId: DataFolderId;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const ts = Date.now();

    // Order matters — clean child rows first, then parents.
    if (workbookId) {
      await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
      await prisma.publishPlan.deleteMany({ where: { workbookId } });
      await prisma.fileReference.deleteMany({ where: { workbookId } });
      await prisma.fileIndex.deleteMany({ where: { workbookId } });
      await prisma.dataFolder.deleteMany({ where: { workbookId } });
      await prisma.connectorAccount.deleteMany({ where: { workbookId } });
      await prisma.workbook.delete({ where: { id: workbookId } }).catch(() => {});
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});

    const org = await prisma.organization.create({
      data: { id: `org_up_${ts}`, name: 'UploadPatch E2E Org', clerkId: `clerk_up_${ts}` },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: { id: `user_up_${ts}`, email: `upload-patch-${ts}@example.com`, organizationId: org.id },
    });
    userId = user.id;

    workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: workbookId, name: 'UploadPatch E2E Workbook', userId: user.id, organizationId: org.id },
    });

    connectorAccountId = createConnectorAccountId();
    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        // Service value doesn't matter — we never dispatch to a real connector here.
        service: ConnectorService.POSTGRES,
        displayName: 'UploadPatch E2E Connector',
        authType: AuthType.USER_PROVIDED_PARAMS,
        // hasDiffs() resolves the repo path via scratch-git — we mock the service,
        // but the controller-side call to resolveConnectionRepoPath needs the row
        // to have a repoPath set or it 400s.
        repoPath: `${org.id}/${workbookId}/${connectorAccountId}`,
        encryptedCredentials: {},
      },
    });

    companiesFolderId = createDataFolderId();
    postsFolderId = createDataFolderId();
    await prisma.dataFolder.createMany({
      data: [
        {
          id: companiesFolderId,
          workbookId,
          connectorAccountId,
          name: 'Companies',
          path: '/Companies',
        },
        {
          id: postsFolderId,
          workbookId,
          connectorAccountId,
          name: 'Posts',
          path: '/Posts',
        },
      ],
    });
  });

  /**
   * Build an ApplyPatchesService wired to:
   *   - REAL DbService → REAL prisma → REAL PublishPlanBuildService writes.
   *   - In-memory ScratchGitService mock (dirty branch state tracked in a Map).
   *   - ObjectStorageService mock that streams a fixed payload.
   *   - BullEnqueuerService mock that captures plan-pipeline-job calls.
   */
  function buildHarness(payload: UploadPatchPayload, opts?: { hasDiffs?: boolean }) {
    const hasDiffs = opts?.hasDiffs ?? true;
    const dirty = new Map<string, string>();

    const scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue(`${orgId}/${workbookId}/${connectorAccountId}`),
      getRepoFile: jest.fn((_repo: string, _branch: string, path: string) =>
        Promise.resolve(dirty.has(path) ? { content: dirty.get(path) as string } : null),
      ),
      commitFilesToBranch: jest.fn((_repo: string, _branch: string, files: { path: string; content: string }[]) => {
        for (const f of files) dirty.set(f.path, f.content);
        return Promise.resolve();
      }),
      deleteFilesFromBranch: jest.fn((_repo: string, _branch: string, paths: string[]) => {
        for (const p of paths) dirty.delete(p);
        return Promise.resolve();
      }),
      // PublishPlanBuildService.hasDiffs() calls this. Return one synthetic diff
      // entry per touched path so the diff check passes; the actual plan-build
      // we don't run in this test.
      getRepoStatus: jest.fn(() =>
        Promise.resolve(hasDiffs ? [{ path: 'Companies/rec1.json', status: 'modified' }] : []),
      ),
    };

    const objectStorageService = {
      streamObjectFromPatchUpload: jest.fn(() => Readable.from([Buffer.from(JSON.stringify(payload))])),
    };

    const planJobCalls: Array<{ pipelineId: string; runAfterPlan: boolean; connectorAccountId: string }> = [];
    const bullEnqueuerService = {
      enqueuePlanPipelineJob: jest.fn(
        async (
          _wb: unknown,
          _actor: unknown,
          pipelineId: string,
          ca: string,
          runAfterPlan: boolean,
        ): Promise<{ id: string }> => {
          planJobCalls.push({ pipelineId, runAfterPlan, connectorAccountId: ca });
          return { id: `job_${pipelineId}` };
        },
      ),
    };

    const dbService = { client: prisma } as unknown as DbService;

    // PublishPlanBuildService has many constructor deps. We only call hasDiffs,
    // createPipeline, and setActiveJob, which only touch DbService and
    // ScratchGitService — so the rest can be null/undefined.
    const publishPlanBuildService = new PublishPlanBuildService(
      dbService,
      scratchGitService as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    const service = new ApplyPatchesService(
      dbService,
      scratchGitService as never,
      objectStorageService as never,
      publishPlanBuildService,
      bullEnqueuerService as never,
    );

    return { service, dirty, planJobCalls, mocks: { scratchGitService, objectStorageService, bullEnqueuerService } };
  }

  it('applies patches to dirty and creates a PublishPlan row in Postgres', async () => {
    const { service, dirty, planJobCalls } = buildHarness({
      patches: [
        { path: 'Companies/rec1.json', patch: { id: 'rec1', name: 'Acme' } },
        { path: 'Posts/rec_new.json', patch: { id: 'rec_new', title: 'Hi' } },
      ],
    });

    const result = await service.applyAndPublish({
      workbookId,
      userId,
      organizationId: orgId,
      connectorAccountId,
      uploadId: 'up_e2e_apply',
    });

    // Dirty branch reflects both patches.
    expect(JSON.parse(dirty.get('Companies/rec1.json') ?? '')).toEqual({ id: 'rec1', name: 'Acme' });
    expect(JSON.parse(dirty.get('Posts/rec_new.json') ?? '')).toEqual({ id: 'rec_new', title: 'Hi' });

    // A real PublishPlan row exists in Postgres, tied to this workbook + user + CA.
    expect(result.pipelineId).not.toBeNull();
    const plan = await prisma.publishPlan.findUnique({ where: { id: result.pipelineId as string } });
    expect(plan).not.toBeNull();
    expect(plan?.workbookId).toBe(workbookId);
    expect(plan?.userId).toBe(userId);
    expect(plan?.connectorAccountId).toBe(connectorAccountId);
    expect(plan?.activeJobId).toBe(result.publishJobId);

    // The publish-v2 plan-pipeline job was enqueued with runAfterPlan=true.
    expect(planJobCalls).toHaveLength(1);
    expect(planJobCalls[0].runAfterPlan).toBe(true);
    expect(planJobCalls[0].connectorAccountId).toBe(connectorAccountId);
  });

  it('rejects a batch with any traversal path and writes nothing to Postgres or dirty', async () => {
    const { service, dirty, planJobCalls } = buildHarness({
      patches: [
        { path: 'Companies/rec1.json', patch: { id: 'rec1', name: 'Acme' } },
        { path: '../etc/passwd', patch: { evil: true } },
      ],
    });

    await expect(
      service.applyAndPublish({
        workbookId,
        userId,
        organizationId: orgId,
        connectorAccountId,
        uploadId: 'up_e2e_traversal',
      }),
    ).rejects.toThrow(/traversal/i);

    expect(dirty.size).toBe(0);
    expect(planJobCalls).toHaveLength(0);
    const planCount = await prisma.publishPlan.count({ where: { workbookId } });
    expect(planCount).toBe(0);
  });

  it('skips publish-pipeline enqueue when the patch produces no diff vs main', async () => {
    const { service, planJobCalls } = buildHarness(
      { patches: [{ path: 'Companies/rec1.json', patch: { id: 'rec1', name: 'Same' } }] },
      { hasDiffs: false },
    );

    const result = await service.applyAndPublish({
      workbookId,
      userId,
      organizationId: orgId,
      connectorAccountId,
      uploadId: 'up_e2e_nodiff',
    });

    expect(result.pipelineId).toBeNull();
    expect(planJobCalls).toHaveLength(0);
    const planCount = await prisma.publishPlan.count({ where: { workbookId } });
    expect(planCount).toBe(0);
  });

  // Controller-level scenarios — AuditLog row, staleness warning, 503 when bucket
  // unconfigured — want supertest + a NestJS TestingModule. Tracked as eng
  // follow-up; intentionally NOT it.todo here to avoid the "test exists but
  // doesn't run" anti-pattern.
});
