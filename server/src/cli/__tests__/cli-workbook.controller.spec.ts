/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { NotFoundException } from '@nestjs/common';
import type { WorkbookId } from '@spinner/shared-types';
import type { Request, Response } from 'express';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { CliWorkbookController } from '../cli-workbook.controller';

const WORKBOOK_ID = 'wkb_test123' as WorkbookId;
const USER_ID = 'usr_abc';
const ORG_ID = 'org_xyz';
const CONNECTOR_ID = 'ca_conn1';
const GIT_BACKEND_URL = 'http://localhost:3101';

function makeReqWithUser(): RequestWithUser & Request {
  return {
    user: {
      id: USER_ID,
      organizationId: ORG_ID,
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
    name: 'Test Workbook',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-06-01'),
    snapshotTables: [{ id: 'st1' }],
    version: overrides?.version ?? 2,
    dataFolders: overrides?.dataFolders ?? [{ id: 'df1', name: 'Posts' }],
    workspacePermissions: [{ id: 'wsp_1', workbookId: WORKBOOK_ID, role: 'editor' }],
  } as any;
}

describe('CliWorkbookController', () => {
  let controller: CliWorkbookController;
  let workbookService: jest.Mocked<WorkbookService>;
  let configService: jest.Mocked<ScratchConfigService>;
  let posthogService: jest.Mocked<PostHogService>;
  let dbService: jest.Mocked<DbService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;

  beforeEach(() => {
    workbookService = {
      findOne: jest.fn(),
      findAllForUser: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<WorkbookService>;

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
      resolveRepoId: jest.fn(),
    } as unknown as jest.Mocked<ScratchGitService>;

    controller = new CliWorkbookController(
      workbookService,
      configService,
      posthogService,
      dbService,
      scratchGitService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
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
          repoPath: `${ORG_ID}--${WORKBOOK_ID}--${CONNECTOR_ID}`,
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
          repoPath: `${ORG_ID}--${WORKBOOK_ID}--${CONNECTOR_ID}`,
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

    it('returns 404 JSON when resolveRepoId throws', async () => {
      workbookService.findOne.mockResolvedValue(makeWorkbook({ version: 2 }));
      scratchGitService.resolveRepoId.mockRejectedValue(new Error('not found'));
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
