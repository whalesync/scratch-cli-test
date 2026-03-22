import { PrismaClient } from '@prisma/client';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
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
  let mockFileIndexService: jest.Mocked<FileIndexService>;
  let mockFileReferenceService: jest.Mocked<FileReferenceService>;
  let mockAssetExtractorService: jest.Mocked<AssetExtractorService>;
  let mockAssetIndexService: jest.Mocked<AssetIndexService>;
  let mockPostHogService: jest.Mocked<PostHogService>;

  const WORKBOOK_ID = 'wkb_123' as WorkbookId;
  const DATA_FOLDER_ID = 'dfld_123' as DataFolderId;

  const createMockDataFolder = (overrides?: Partial<Record<string, unknown>>) => ({
    id: DATA_FOLDER_ID,
    workbookId: WORKBOOK_ID,
    name: 'Test Folder',
    path: '/test-folder',
    connectorService: 'airtable',
    connectorAccountId: 'coa_123',
    connectorAccount: { displayName: 'Test Connection' },
    ...overrides,
  });

  const createMockParams = (overrides?: Partial<Record<string, unknown>>) => ({
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
    } as unknown as jest.Mocked<FileIndexService>;

    mockFileReferenceService = {
      updateRefsForFiles: jest.fn(),
    } as unknown as jest.Mocked<FileReferenceService>;

    mockAssetExtractorService = {
      extractAssets: jest.fn(),
    } as unknown as jest.Mocked<AssetExtractorService>;

    mockAssetIndexService = {
      upsertBatch: jest.fn(),
    } as unknown as jest.Mocked<AssetIndexService>;

    mockPostHogService = {
      trackPullCompleted: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

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
      mockPostHogService,
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
