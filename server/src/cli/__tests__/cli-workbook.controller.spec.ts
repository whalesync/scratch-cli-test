/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() returns any */
/* eslint-disable @typescript-eslint/unbound-method -- Jest mocks passed to expect().toHaveBeen* */
import { NotFoundException } from '@nestjs/common';
import type { WorkbookId } from '@spinner/shared-types';
import type { Request, Response } from 'express';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import type { RepoId } from 'src/scratch-git/scratch-git.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookRepoService, getWorkbookRepoPath } from 'src/workbook/workbook-repo.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { CliWorkbookController } from '../cli-workbook.controller';

const WORKBOOK_ID = 'wkb_test123' as WorkbookId;
const USER_ID = 'usr_abc';
const ACTOR_ORG_ID = 'org_actor';
const WORKBOOK_ORG_ID = 'org_workbook';
const CONNECTOR_ID = 'ca_conn1';
const GIT_BACKEND_URL = 'http://localhost:3101';

function spyOnProxyToGitBackend() {
  return jest
    .spyOn(
      CliWorkbookController.prototype as unknown as {
        proxyToGitBackend: (targetUrl: string, workbookId: WorkbookId, req: Request, res: Response) => Promise<void>;
      },
      'proxyToGitBackend',
    )
    .mockResolvedValue(undefined);
}

function makeReqWithUser(): RequestWithUser & Request {
  return {
    user: {
      id: USER_ID,
      organizationId: ACTOR_ORG_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      clerkId: 'clerk_1',
      name: 'Test User',
      email: 'test@example.com',
      role: 'USER',
      authType: 'jwt',
      authSource: 'user',
      stripeCustomerId: null,
      refCode: null,
      firstTimeUser: false,
      workspacePermissions: [{ id: 'wsp_1', workbookId: WORKBOOK_ID, role: 'editor' }],
    },
    protocol: 'https',
    get: (header: string) => (header === 'host' ? 'scratch.test' : undefined),
    url: '/cli/v1/workbooks',
    method: 'GET',
    headers: {},
  } as unknown as RequestWithUser & Request;
}

function makeWorkbook(overrides?: Partial<{ version: number; dataFolders: { id: string; name: string }[] }>) {
  return {
    id: WORKBOOK_ID,
    organizationId: WORKBOOK_ORG_ID,
    name: 'Test Workbook',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-06-01'),
    snapshotTables: [{ id: 'st1' }],
    version: overrides?.version ?? 2,
    dataFolders: overrides?.dataFolders ?? [{ id: 'df1', name: 'Posts' }],
    workspacePermissions: [{ id: 'wsp_1', workbookId: WORKBOOK_ID, role: 'editor' }],
  } as unknown as WorkbookCluster.Workbook;
}

describe('CliWorkbookController', () => {
  let controller: CliWorkbookController;
  let workbookService: jest.Mocked<WorkbookService>;
  let configService: jest.Mocked<ScratchConfigService>;
  let posthogService: jest.Mocked<PostHogService>;
  let dbService: jest.Mocked<DbService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let workbookRepoService: jest.Mocked<WorkbookRepoService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;

  beforeEach(() => {
    workbookService = {
      findOne: jest.fn(),
      findAllForUser: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      requestDeletion: jest.fn(),
      assertReadableWorkbook: jest.fn(),
      assertWritableWorkbook: jest.fn(),
    } as unknown as jest.Mocked<WorkbookService>;

    // Have the read/write assertions delegate to `findOne` so existing tests can keep
    // controlling controller behavior via `workbookService.findOne.mockResolvedValue(...)`.
    // Mirrors the real WorkbookService impl (NotFound on missing, plus pending-delete on writes).
    workbookService.assertReadableWorkbook.mockImplementation(async (actor, id) => {
      const wb = await workbookService.findOne(id, actor);
      if (!wb) throw new NotFoundException('Workbook not found');
      return wb;
    });
    workbookService.assertWritableWorkbook.mockImplementation(async (actor, id) => {
      const wb = await workbookService.findOne(id, actor);
      if (!wb || wb.isPendingDelete) throw new NotFoundException('Workbook not found');
      return wb;
    });

    configService = {
      getScratchGitBackendUrl: jest.fn().mockReturnValue(GIT_BACKEND_URL),
    } as unknown as jest.Mocked<ScratchConfigService>;

    posthogService = {
      trackCliListWorkbooks: jest.fn(),
      trackCliGitOperation: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    dbService = {
      client: {
        connectorAccount: { findMany: jest.fn() },
      },
    } as unknown as jest.Mocked<DbService>;

    scratchGitService = {
      discardChanges: jest.fn(),
      resolveConnectionRepoPath: jest.fn(),
    } as unknown as jest.Mocked<ScratchGitService>;

    workbookRepoService = {
      initWorkbookRepo: jest.fn(),
      pushSyncs: jest.fn(),
    } as unknown as jest.Mocked<WorkbookRepoService>;

    bullEnqueuerService = {
      enqueuePublishFromGitJob: jest.fn(),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    controller = new CliWorkbookController(
      workbookService,
      configService,
      posthogService,
      dbService,
      scratchGitService,
      workbookRepoService,
      bullEnqueuerService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // getWorkbook
  // ---------------------------------------------------------------------------
  describe('getWorkbook', () => {
    it('returns workbook with connectorAccounts', async () => {
      const workbook = makeWorkbook();
      workbookService.findOne.mockResolvedValue(workbook);
      (dbService.client.connectorAccount.findMany as jest.Mock).mockResolvedValue([
        {
          id: CONNECTOR_ID,
          displayName: 'My Airtable',
          service: 'airtable',
          repoPath: `${ACTOR_ORG_ID}--${WORKBOOK_ID}--${CONNECTOR_ID}`,
          dataFolders: [{ id: 'df2', name: 'Table1' }],
        },
      ]);

      const result = await controller.getWorkbook(makeReqWithUser(), WORKBOOK_ID);

      expect(result.version).toBe(2);
      expect(result.connectorAccounts).toEqual([
        {
          id: CONNECTOR_ID,
          displayName: 'My Airtable',
          service: 'airtable',
          repoPath: `${ACTOR_ORG_ID}--${WORKBOOK_ID}--${CONNECTOR_ID}`,
          gitUrl: `https://scratch.test/cli/v1/workbooks/${WORKBOOK_ID}/connectors/${CONNECTOR_ID}/git`,
          dataFolders: [{ id: 'df2', name: 'Table1' }],
        },
      ]);
    });

    it('returns workbook with empty connectorAccounts when none exist', async () => {
      const workbook = makeWorkbook();
      workbookService.findOne.mockResolvedValue(workbook);
      (dbService.client.connectorAccount.findMany as jest.Mock).mockResolvedValue([]);

      const result = await controller.getWorkbook(makeReqWithUser(), WORKBOOK_ID);

      expect(result.version).toBe(2);
      expect(result.connectorAccounts).toEqual([]);
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(controller.getWorkbook(makeReqWithUser(), WORKBOOK_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // connectorGitProxy
  // ---------------------------------------------------------------------------
  describe('connectorGitProxy', () => {
    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);
      const mockStatus = jest.fn().mockReturnThis();
      const mockJson = jest.fn();
      const res = { status: mockStatus, json: mockJson } as unknown as Response;

      await expect(controller.connectorGitProxy(makeReqWithUser(), WORKBOOK_ID, CONNECTOR_ID, res)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns 404 JSON when resolveConnectionRepoPath throws', async () => {
      workbookService.findOne.mockResolvedValue(makeWorkbook({ version: 2 }));
      scratchGitService.resolveConnectionRepoPath.mockRejectedValue(new Error('not found'));
      const mockJson = jest.fn();
      const mockStatus = jest.fn().mockReturnValue({ json: mockJson });
      const res = { status: mockStatus, json: mockJson } as unknown as Response;

      await controller.connectorGitProxy(makeReqWithUser(), WORKBOOK_ID, CONNECTOR_ID, res);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 404,
          message: expect.stringContaining(CONNECTOR_ID),
        }),
      );
    });

    it('proxies to git backend with correct target URL on success', async () => {
      const repoId = `${ACTOR_ORG_ID}--${WORKBOOK_ID}--${CONNECTOR_ID}` as RepoId;
      workbookService.findOne.mockResolvedValue(makeWorkbook());
      scratchGitService.resolveConnectionRepoPath.mockResolvedValue(repoId);

      const req = {
        ...makeReqWithUser(),
        url: `/cli/v1/workbooks/${WORKBOOK_ID}/connectors/${CONNECTOR_ID}/git/info/refs?service=git-upload-pack`,
        method: 'GET',
      } as RequestWithUser & Request;
      const res = {} as Response;

      const proxySpy = spyOnProxyToGitBackend();

      await controller.connectorGitProxy(req, WORKBOOK_ID, CONNECTOR_ID, res);

      expect(proxySpy).toHaveBeenCalledWith(
        `${GIT_BACKEND_URL}/${repoId}.git/info/refs?service=git-upload-pack`,
        WORKBOOK_ID,
        req,
        res,
      );
    });

    it('strips only the connector git prefix from the URL path', async () => {
      const repoId = 'some/repo/id' as RepoId;
      workbookService.findOne.mockResolvedValue(makeWorkbook());
      scratchGitService.resolveConnectionRepoPath.mockResolvedValue(repoId);

      const req = {
        ...makeReqWithUser(),
        url: `/cli/v1/workbooks/${WORKBOOK_ID}/connectors/${CONNECTOR_ID}/git/git-receive-pack`,
        method: 'POST',
      } as RequestWithUser & Request;
      const res = {} as Response;

      const proxySpy = spyOnProxyToGitBackend();

      await controller.connectorGitProxy(req, WORKBOOK_ID, CONNECTOR_ID, res);

      expect(proxySpy).toHaveBeenCalledWith(`${GIT_BACKEND_URL}/${repoId}.git/git-receive-pack`, WORKBOOK_ID, req, res);
    });

    it('tracks posthog git operation event', async () => {
      workbookService.findOne.mockResolvedValue(makeWorkbook());
      scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo/id/x' as RepoId);

      const req = {
        ...makeReqWithUser(),
        url: `/cli/v1/workbooks/${WORKBOOK_ID}/connectors/${CONNECTOR_ID}/git/info/refs`,
        method: 'GET',
      } as RequestWithUser & Request;
      const res = {} as Response;

      spyOnProxyToGitBackend();

      await controller.connectorGitProxy(req, WORKBOOK_ID, CONNECTOR_ID, res);

      expect(posthogService.trackCliGitOperation).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID }),
        WORKBOOK_ID,
        { method: 'GET' },
      );
    });

    it('resolves repo path using the connector account ID', async () => {
      workbookService.findOne.mockResolvedValue(makeWorkbook());
      scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo/id/y' as RepoId);

      const req = {
        ...makeReqWithUser(),
        url: `/cli/v1/workbooks/${WORKBOOK_ID}/connectors/${CONNECTOR_ID}/git/HEAD`,
        method: 'GET',
      } as RequestWithUser & Request;
      const res = {} as Response;

      spyOnProxyToGitBackend();

      await controller.connectorGitProxy(req, WORKBOOK_ID, CONNECTOR_ID, res);

      expect(scratchGitService.resolveConnectionRepoPath).toHaveBeenCalledWith(CONNECTOR_ID);
    });
  });

  describe('discardRemoteDirtyChanges', () => {
    it('proxies the path discard to scratch git for the resolved repo', async () => {
      const repoId = `${ACTOR_ORG_ID}--${WORKBOOK_ID}--${CONNECTOR_ID}` as RepoId;
      workbookService.findOne.mockResolvedValue(makeWorkbook());
      scratchGitService.resolveConnectionRepoPath.mockResolvedValue(repoId);

      await controller.discardRemoteDirtyChanges(makeReqWithUser(), WORKBOOK_ID, CONNECTOR_ID, {
        path: 'posts/created.json',
      });

      expect(scratchGitService.resolveConnectionRepoPath).toHaveBeenCalledWith(CONNECTOR_ID);
      expect(scratchGitService.discardChanges).toHaveBeenCalledWith(repoId, 'posts/created.json');
    });
  });

  describe('workbook config repo endpoints', () => {
    it('initWorkbookRepo uses workbook organization id', async () => {
      workbookService.findOne.mockResolvedValue(makeWorkbook());

      await controller.initWorkbookRepo(makeReqWithUser(), WORKBOOK_ID);

      expect(workbookRepoService.initWorkbookRepo.mock.calls).toContainEqual([WORKBOOK_ORG_ID, WORKBOOK_ID]);
    });

    it('pushSyncsToGit uses workbook organization id', async () => {
      workbookService.findOne.mockResolvedValue(makeWorkbook());
      workbookRepoService.pushSyncs.mockResolvedValue({ count: 2 });

      const result = await controller.pushSyncsToGit(makeReqWithUser(), WORKBOOK_ID);

      expect(result).toEqual({ count: 2 });
      expect(workbookRepoService.pushSyncs.mock.calls).toContainEqual([
        WORKBOOK_ORG_ID,
        WORKBOOK_ID,
        expect.objectContaining({ organizationId: ACTOR_ORG_ID, userId: USER_ID }),
      ]);
    });

    it('configGitProxy uses workbook organization id for the target repo', async () => {
      const req = {
        ...makeReqWithUser(),
        url: `/cli/v1/workbooks/${WORKBOOK_ID}/config/git/info/refs?service=git-upload-pack`,
      } as RequestWithUser & Request;
      const res = {} as Response;

      workbookService.findOne.mockResolvedValue(makeWorkbook());
      const proxySpy = spyOnProxyToGitBackend();

      await controller.configGitProxy(req, WORKBOOK_ID, res);

      expect(proxySpy).toHaveBeenCalledWith(
        `${GIT_BACKEND_URL}/${getWorkbookRepoPath(WORKBOOK_ORG_ID, WORKBOOK_ID)}.git/info/refs?service=git-upload-pack`,
        WORKBOOK_ID,
        req,
        res,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listWorkbooks
  // ---------------------------------------------------------------------------
  describe('listWorkbooks', () => {
    it('returns workbooks list', async () => {
      const wb1 = makeWorkbook();
      const wb2 = makeWorkbook();
      workbookService.findAllForUser.mockResolvedValue([wb1, wb2]);

      const result = await controller.listWorkbooks(makeReqWithUser(), {});

      expect(result.workbooks).toHaveLength(2);
      expect(result.workbooks![0].id).toBe(WORKBOOK_ID);
      expect(result.workbooks![1].id).toBe(WORKBOOK_ID);
    });
  });
});
