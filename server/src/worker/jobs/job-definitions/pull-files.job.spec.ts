/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { PrismaClient } from '@prisma/client';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { PullFilesJobHandler } from './pull-files.job';

describe('PullFilesJobHandler', () => {
  let handler: PullFilesJobHandler;
  let mockPrisma: jest.Mocked<PrismaClient>;
  let mockConnectorService: jest.Mocked<ConnectorsService>;
  let mockConnectorAccountService: jest.Mocked<ConnectorAccountService>;
  let mockWorkbookEventService: jest.Mocked<WorkbookEventService>;
  let mockScratchGitService: jest.Mocked<ScratchGitService>;
  let mockFileIndexService: jest.Mocked<any>;
  let mockFileReferenceService: jest.Mocked<any>;
  let mockAssetExtractorService: jest.Mocked<any>;
  let mockAssetIndexService: jest.Mocked<any>;

  const WORKBOOK_ID = 'wkb_123' as WorkbookId;
  const DATA_FOLDER_ID = 'dfld_123' as DataFolderId;

  const createMockDataFolder = (overrides?: any) => ({
    id: DATA_FOLDER_ID,
    workbookId: WORKBOOK_ID,
    name: 'Test Folder',
    path: '/test-folder',
    connectorService: 'airtable',
    connectorAccountId: 'coa_123',
    connectorAccount: { displayName: 'Test Connection' },
    ...overrides,
  });

  const createMockParams = (overrides?: any) => ({
    jobId: 'test-job-id',
    data: {
      workbookId: WORKBOOK_ID,
      dataFolderId: DATA_FOLDER_ID,
      userId: 'usr_123',
      organizationId: 'org_123',
      filePaths: ['/test-folder/file1.json'],
    },
    progress: {
      publicProgress: null,
      jobProgress: {},
      connectorProgress: {},
    },
    abortSignal: new AbortController().signal,
    checkpoint: jest.fn(),
    ...overrides,
  });

  beforeEach(() => {
    mockPrisma = {
      dataFolder: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaClient>;

    mockConnectorService = {
      getConnector: jest.fn(),
    } as unknown as jest.Mocked<ConnectorsService>;

    mockConnectorAccountService = {
      findOneById: jest.fn(),
    } as unknown as jest.Mocked<ConnectorAccountService>;

    mockWorkbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    mockScratchGitService = {
      resolveRepoId: jest.fn().mockResolvedValue(WORKBOOK_ID),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<ScratchGitService>;

    mockFileIndexService = {
      getRecordIds: jest.fn(),
      getFilenamesByRecordIds: jest.fn(),
      upsertBatch: jest.fn(),
    } as any;

    mockFileReferenceService = {
      updateRefsForFiles: jest.fn(),
    } as any;

    mockAssetExtractorService = {
      extractAssets: jest.fn(),
    } as any;

    mockAssetIndexService = {
      upsertBatch: jest.fn(),
    } as any;

    handler = new PullFilesJobHandler(
      mockPrisma,
      mockConnectorService,
      mockConnectorAccountService,
      mockWorkbookEventService,
      mockScratchGitService,
      mockFileIndexService,
      mockFileReferenceService,
      mockAssetExtractorService,
      mockAssetIndexService,
    );
  });

  describe('null-schema guard', () => {
    it('should throw when git schema is not found', async () => {
      const dataFolder = createMockDataFolder();
      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockScratchGitService.readSchemaFromGit as jest.Mock).mockResolvedValue(null);

      const params = createMockParams();

      await expect(handler.run(params)).rejects.toThrow(`Schema not found for DataFolder ${DATA_FOLDER_ID}`);
    });

    it('should throw when readSchemaFromGit throws', async () => {
      const dataFolder = createMockDataFolder();
      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockScratchGitService.readSchemaFromGit as jest.Mock).mockRejectedValue(new Error('git error'));

      const params = createMockParams();

      await expect(handler.run(params)).rejects.toThrow(`Schema not found for DataFolder ${DATA_FOLDER_ID}`);
    });
  });
});
