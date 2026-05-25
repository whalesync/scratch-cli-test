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
  let mockResolveConnectionRepoPath: jest.Mock;
  let mockCommitFilesToBranch: jest.Mock;
  let mockRebaseDirty: jest.Mock;
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

    mockResolveConnectionRepoPath = jest.fn().mockResolvedValue(RESOLVED_REPO_ID);
    mockCommitFilesToBranch = jest.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] });
    mockRebaseDirty = jest.fn().mockResolvedValue(undefined);
    mockScratchGitService = {
      resolveConnectionRepoPath: mockResolveConnectionRepoPath,
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
      commitFilesToBranch: mockCommitFilesToBranch,
      rebaseDirty: mockRebaseDirty,
    } as unknown as jest.Mocked<ScratchGitService>;

    mockFileIndexService = {
      getRecordIds: jest.fn(),
      getFilenamesByRecordIds: jest.fn(),
      listFilenamesForFolder: jest.fn().mockResolvedValue([]),
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

  const RESOLVED_REPO_ID = 'org_123/wkb_123/coa_123';

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

  describe('resolved repo ID usage', () => {
    const TABLE_SPEC = {
      idColumnRemoteId: 'remoteId',
      schema: { remoteId: { type: 'string' }, name: { type: 'string' } },
      columns: [],
      tableRemoteId: 'tbl_1',
    };

    function setupHappyPath() {
      const dataFolder = createMockDataFolder();
      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockScratchGitService.readSchemaFromGit as jest.Mock).mockResolvedValue(TABLE_SPEC);
      mockCommitFilesToBranch.mockResolvedValue({
        created: ['test-folder/file1.json'],
        updated: [],
        unchanged: [],
      });
      (mockFileIndexService.getRecordIds as jest.Mock).mockResolvedValue(
        new Map([['test-folder/file1.json', 'rec_1']]),
      );
      (mockFileIndexService.getFilenamesByRecordIds as jest.Mock).mockResolvedValue(new Map());
      (mockFileIndexService.upsertBatch as jest.Mock).mockResolvedValue(undefined);
      (mockFileReferenceService.updateRefsForFiles as jest.Mock).mockResolvedValue(undefined);
      (mockAssetExtractorService.extractAssets as jest.Mock).mockReturnValue([]);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue({
        id: 'coa_123',
        credentials: {},
      });
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue({
        pullRecordFilesByIds: jest
          .fn()
          .mockImplementation(
            async (_spec: unknown, _ids: unknown, callback: (params: { files: unknown[] }) => Promise<void>) => {
              await callback({ files: [{ remoteId: 'rec_1', name: 'Test' }] });
            },
          ),
        getSuggestedRecordFileNames: jest.fn().mockReturnValue(['file1.json']),
      });
    }

    it('should pass resolved repoId to commitFilesToBranch, not raw connectorAccountId', async () => {
      setupHappyPath();
      const params = createMockParams();

      await handler.run(params);

      expect(mockResolveConnectionRepoPath).toHaveBeenCalledWith('coa_123');
      expect(mockCommitFilesToBranch).toHaveBeenCalledWith(
        RESOLVED_REPO_ID,
        'main',
        expect.any(Array),
        expect.any(String),
      );
      // Must NOT be called with the raw connector account ID
      expect(mockCommitFilesToBranch).not.toHaveBeenCalledWith(
        'coa_123',
        expect.any(String),
        expect.any(Array),
        expect.any(String),
      );
    });

    it('should pass resolved repoId to rebaseDirty, not raw connectorAccountId', async () => {
      setupHappyPath();
      const params = createMockParams();

      await handler.run(params);

      expect(mockRebaseDirty).toHaveBeenCalledWith(RESOLVED_REPO_ID);
      expect(mockRebaseDirty).not.toHaveBeenCalledWith('coa_123');
    });
  });
});
