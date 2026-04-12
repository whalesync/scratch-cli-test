/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { AssetExtractorService } from '../../../../asset/asset-extractor.service';
import { AssetIndexService } from '../../../../asset/asset-index.service';
import { PostHogService } from '../../../../posthog/posthog.service';
import { FileIndexService } from '../../../../publish-plan/file-index.service';
import { FileReferenceService } from '../../../../publish-plan/file-reference.service';
import { ConnectorAccountService } from '../../../../remote-service/connector-account/connector-account.service';
import { connectorRegistry } from '../../../../remote-service/connectors/connector-registry';
import { ConnectorsService } from '../../../../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile } from '../../../../remote-service/connectors/types';
import { ScratchGitService } from '../../../../scratch-git/scratch-git.service';
import { JsonSafeObject } from '../../../../utils/objects';
import { WorkbookEventService } from '../../../../workbook/workbook-event.service';
import {
  getMaxConcurrency,
  PullLinkedFolderFilesV2JobHandler,
  runWithConcurrency,
} from '../pull-linked-folder-files-v2.job';

type PullCallback = (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>;

describe('PullLinkedFolderFilesV2JobHandler', () => {
  let handler: PullLinkedFolderFilesV2JobHandler;
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

  const defaultTableSpec: BaseJsonTableSpec = {
    idColumnRemoteId: 'id',
    slugFieldPath: 'slug',
    titleColumnRemoteId: ['title'],
    id: { remoteId: ['tbl_abc'], wsId: 'tbl_abc' },
    slug: 'example',
    name: 'Example',
    schema: Type.Object({}),
  };

  const createMockDataFolder = (overrides?: Partial<Record<string, unknown>>) => ({
    id: 'dfld_123' as DataFolderId,
    workbookId: 'wkb_123' as WorkbookId,
    name: 'Products',
    path: '/Products',
    connectorService: 'airtable',
    connectorAccountId: 'coa_123',
    connectorAccount: { displayName: 'Test Connection' },
    tableId: ['tbl_abc'],
    filter: null as string | null,
    options: null as unknown as Record<string, unknown>,
    ...overrides,
  });

  const createMockConnectorAccount = () => ({
    id: 'coa_123',
    service: 'airtable',
    credentials: { apiKey: 'test-key' },
  });

  const createMockConnector = (tableSpecOverrides?: Partial<BaseJsonTableSpec>) => ({
    fetchJsonTableSpec: jest.fn().mockResolvedValue({ ...defaultTableSpec, ...tableSpecOverrides }),
    pullRecordFiles: jest.fn(),
    getSuggestedRecordFileNames: jest.fn().mockImplementation((records: ConnectorFile[]) =>
      records.map((r) => {
        const slug = r['slug'] as string | undefined;
        return slug && slug.trim() ? slug : undefined;
      }),
    ),
    extractAssets: jest.fn(),
    extractConnectorErrorDetails: jest.fn().mockReturnValue({
      userFriendlyMessage: 'An error occurred',
      description: 'Test error',
    }),
  });

  const createMockParams = (overrides?: Partial<Record<string, unknown>>) => ({
    jobId: 'test-job-id',
    data: {
      workbookId: 'wkb_123' as WorkbookId,
      dataFolderIds: ['dfld_123' as DataFolderId],
      userId: 'usr_123',
      organizationId: 'org_123',
    },
    progress: {
      publicProgress: {
        totalFiles: 0,
        folderCount: 1,
        connectionName: 'Test Connection',
        folderId: 'dfld_123',
        folderName: 'Products',
        connector: 'airtable',
        filter: null,
        status: 'pending' as const,
        createdPaths: [],
        updatedPaths: [],
        deletedPaths: [],
        createdCount: 0,
        updatedCount: 0,
        deletedCount: 0,
      },
      jobProgress: {},
      connectorProgress: {},
    },
    abortSignal: new AbortController().signal,
    checkpoint: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(() => {
    mockPrisma = {
      dataFolder: {
        findMany: jest.fn().mockResolvedValue([createMockDataFolder()]),
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
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('org/wkb/coa'),
      initRepo: jest.fn().mockResolvedValue(undefined),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
      stageFiles: jest.fn().mockResolvedValue(undefined),
      readStagedFiles: jest.fn(),
      commitStagedFiles: jest.fn(),
      cleanupStaging: jest.fn().mockResolvedValue(undefined),
      listRepoFiles: jest.fn().mockResolvedValue([]),
      rebaseDirty: jest.fn().mockResolvedValue(undefined),
      buildIndex: jest.fn().mockResolvedValue({ count: 0 }),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      deleteFilesFromBranch: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScratchGitService>;

    mockFileIndexService = {
      getFilenamesByRecordIds: jest.fn().mockResolvedValue(new Map()),
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileIndexService>;

    mockFileReferenceService = {
      updateRefsForFiles: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileReferenceService>;

    mockAssetExtractorService = {
      extractAssets: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<AssetExtractorService>;

    mockAssetIndexService = {
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AssetIndexService>;

    mockPostHogService = {
      trackPullCompleted: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    handler = new PullLinkedFolderFilesV2JobHandler(
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

  // ---------------------------------------------------------------------------
  // getMaxConcurrency
  // ---------------------------------------------------------------------------

  describe('getMaxConcurrency', () => {
    it('should use rate limiter spec when available', () => {
      jest.spyOn(connectorRegistry, 'get').mockReturnValue({
        rateLimiterSpec: { points: 10, duration: 2 },
      } as ReturnType<typeof connectorRegistry.get>);

      // Math.ceil(10/2) = 5, Math.min(8, 5) = 5
      expect(getMaxConcurrency('airtable', 8)).toBe(5);
    });

    it('should fall back to default concurrency (3) when no rate limiter spec', () => {
      jest.spyOn(connectorRegistry, 'get').mockReturnValue({
        rateLimiterSpec: undefined,
      } as ReturnType<typeof connectorRegistry.get>);

      // Math.min(10, 3) = 3
      expect(getMaxConcurrency('unknown-service', 10)).toBe(3);
    });

    it('should cap at folder count when it is less than the rate', () => {
      jest.spyOn(connectorRegistry, 'get').mockReturnValue({
        rateLimiterSpec: { points: 100, duration: 1 },
      } as ReturnType<typeof connectorRegistry.get>);

      // Math.ceil(100/1) = 100, Math.min(2, 100) = 2
      expect(getMaxConcurrency('airtable', 2)).toBe(2);
    });

    it('should cap at default when folder count is less than default and no spec', () => {
      jest.spyOn(connectorRegistry, 'get').mockReturnValue(undefined);

      // No spec -> Math.min(1, 3) = 1
      expect(getMaxConcurrency('airtable', 1)).toBe(1);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------------------------
  // runWithConcurrency
  // ---------------------------------------------------------------------------

  describe('runWithConcurrency', () => {
    it('should run all items', async () => {
      const results: number[] = [];
      await runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
        results.push(item);
        await Promise.resolve();
      });
      expect(results).toEqual([1, 2, 3, 4]);
    });

    it('should respect the concurrency limit', async () => {
      let activeConcurrency = 0;
      let maxObserved = 0;

      await runWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
        activeConcurrency++;
        maxObserved = Math.max(maxObserved, activeConcurrency);
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeConcurrency--;
      });

      expect(maxObserved).toBeLessThanOrEqual(2);
      expect(maxObserved).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty items array', async () => {
      const fn = jest.fn();
      await runWithConcurrency([], 3, fn);
      expect(fn).not.toHaveBeenCalled();
    });

    it('should continue processing when one item throws', async () => {
      const processed: number[] = [];
      await runWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('fail');
        processed.push(item);
        await Promise.resolve();
      });
      // Items 1 and 3 should still be processed
      expect(processed).toContain(1);
      expect(processed).toContain(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: Phase 1 path stripping & Phase 2 path re-prefixing
  // ---------------------------------------------------------------------------

  describe('run', () => {
    const setupStandardMocks = () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Default: no rate limiter spec
      jest.spyOn(connectorRegistry, 'get').mockReturnValue(undefined);

      return { dataFolder, connectorAccount, mockConnector, params };
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    describe('Phase 1 path stripping', () => {
      it('should strip folder prefix from staged file paths', async () => {
        const { mockConnector, params } = setupStandardMocks();

        // Simulate connector pulling files — built files will have paths like "Products/file.json"
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec1', slug: 'test-product', title: 'Test Product' }],
            connectorProgress: {},
          });
        });

        // Phase 2: readStagedFiles returns empty so we skip processing
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], total: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        // Verify stageFiles was called with paths that have the folder prefix stripped
        expect(mockScratchGitService.stageFiles).toHaveBeenCalledWith(
          'test-job-id',
          'Products',
          expect.arrayContaining([
            expect.objectContaining({
              path: 'test-product.json', // NOT "Products/test-product.json"
            }),
          ]),
        );
      });
    });

    describe('Phase 2 path re-prefixing', () => {
      it('should re-prefix paths when reading staged files for index updates', async () => {
        const { mockConnector, params } = setupStandardMocks();

        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec1', slug: 'test-product', title: 'Test Product' }],
            connectorProgress: {},
          });
        });

        // Phase 2: readStagedFiles returns file with relative path (no folder prefix)
        (mockScratchGitService.readStagedFiles as jest.Mock)
          .mockResolvedValueOnce({
            files: [
              {
                path: 'test-product.json',
                content: JSON.stringify({ id: 'rec1', slug: 'test-product', title: 'Test Product' }),
              },
            ],
            total: 1,
          })
          .mockResolvedValueOnce({ files: [], total: 0 });

        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          created: ['Products/test-product.json'],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        // Verify fileIndexService.upsertBatch received the re-prefixed path
        expect(mockFileIndexService.upsertBatch).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              folderPath: 'Products',
              filename: 'test-product.json',
              recordId: 'rec1',
            }),
          ]),
        );
      });
    });

    describe('cleanup always runs', () => {
      it('should call cleanupStaging even when Phase 1 succeeds', async () => {
        const { mockConnector, params } = setupStandardMocks();

        mockConnector.pullRecordFiles.mockResolvedValue(undefined);

        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], total: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        expect(mockScratchGitService.cleanupStaging).toHaveBeenCalledWith('test-job-id');
      });

      it('should call cleanupStaging and continue when Phase 2 folder fails', async () => {
        const { mockConnector, params } = setupStandardMocks();

        mockConnector.pullRecordFiles.mockResolvedValue(undefined);

        // Make readStagedFiles return data, but commitStagedFiles throw
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], total: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockRejectedValue(new Error('commit failed'));

        // Phase 2 no longer re-throws — the error is caught per-folder and run() completes
        await handler.run(params);

        expect(mockScratchGitService.cleanupStaging).toHaveBeenCalledWith('test-job-id');
      });

      it('should call cleanupStaging even when Phase 1 fetch throws', async () => {
        const { mockConnector, params } = setupStandardMocks();

        // Phase 1 fetch fails for the folder — but the error is caught per-folder,
        // so run() won't throw. The folder is marked as 'failed' and skipped in Phase 2.
        mockConnector.pullRecordFiles.mockRejectedValue(new Error('API rate limit'));

        // Phase 2 won't process the failed folder, but readStagedFiles still won't be called
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], total: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        expect(mockScratchGitService.cleanupStaging).toHaveBeenCalledWith('test-job-id');
      });
    });

    describe('rebase and GC run once', () => {
      it('should call rebaseDirty and runGitGc exactly once for multiple folders', async () => {
        const folder1 = createMockDataFolder({ id: 'dfld_1' as DataFolderId, name: 'Products', path: '/Products' });
        const folder2 = createMockDataFolder({ id: 'dfld_2' as DataFolderId, name: 'Orders', path: '/Orders' });

        const connectorAccount = createMockConnectorAccount();
        const mockConnector = createMockConnector();

        const params = createMockParams({
          data: {
            workbookId: 'wkb_123' as WorkbookId,
            dataFolderIds: ['dfld_1' as DataFolderId, 'dfld_2' as DataFolderId],
            userId: 'usr_123',
            organizationId: 'org_123',
          },
        });

        (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([
          { id: 'dfld_1', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test Connection' } },
          { id: 'dfld_2', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test Connection' } },
        ]);

        (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValueOnce(folder1).mockResolvedValueOnce(folder2);
        (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(folder1);
        (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
        (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);
        jest.spyOn(connectorRegistry, 'get').mockReturnValue(undefined);

        mockConnector.pullRecordFiles.mockResolvedValue(undefined);

        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], total: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        // rebaseDirty and runGitGc should be called exactly once, not per folder
        expect(mockScratchGitService.rebaseDirty).toHaveBeenCalledTimes(1);
        expect(mockScratchGitService.runGitGc).toHaveBeenCalledTimes(1);
        expect(mockScratchGitService.buildIndex).toHaveBeenCalledTimes(1);
      });
    });

    describe('Phase 1 failure cleanup', () => {
      it('should clear lock, send job-failed event, and report failure when Phase 1 fetch throws', async () => {
        const { mockConnector, params } = setupStandardMocks();

        // Phase 1 fetch fails
        mockConnector.pullRecordFiles.mockRejectedValue(new Error('API rate limit'));

        // Phase 2 won't process the failed folder
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], total: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        // Bug 1: lock should be cleared
        expect(mockPrisma.dataFolder.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'dfld_123' },
            data: { lock: null },
          }),
        );

        // Bug 2: job-failed event should be sent
        expect(mockWorkbookEventService.sendWorkbookEvent).toHaveBeenCalledWith(
          'wkb_123',
          expect.objectContaining({
            type: 'job-failed',
            data: expect.objectContaining({
              entityId: 'dfld_123',
              message: 'Pull failed for data folder',
            }),
          }),
        );

        // Bug 3: PostHog should report failure, not success
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          'usr_123',
          expect.objectContaining({
            result: 'failure',
          }),
        );
      });
    });

    describe('partial failure resilience', () => {
      it('should process succeeding folders and clean up failing folders independently', async () => {
        const folder1 = createMockDataFolder({ id: 'dfld_1' as DataFolderId, name: 'Products', path: '/Products' });
        const folder2 = createMockDataFolder({ id: 'dfld_2' as DataFolderId, name: 'Orders', path: '/Orders' });

        const connectorAccount = createMockConnectorAccount();
        const mockConnector = createMockConnector();

        const params = createMockParams({
          data: {
            workbookId: 'wkb_123' as WorkbookId,
            dataFolderIds: ['dfld_1' as DataFolderId, 'dfld_2' as DataFolderId],
            userId: 'usr_123',
            organizationId: 'org_123',
          },
        });

        (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([
          { id: 'dfld_1', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test Connection' } },
          { id: 'dfld_2', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test Connection' } },
        ]);

        (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValueOnce(folder1).mockResolvedValueOnce(folder2);
        (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(folder1);
        (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
        (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);
        jest.spyOn(connectorRegistry, 'get').mockReturnValue(undefined);

        // Folder 1 fails in Phase 1, folder 2 succeeds
        let callCount = 0;
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('API rate limit');
          }
          await callback({
            files: [{ id: 'rec1', slug: 'order-1', title: 'Order 1' }],
            connectorProgress: {},
          });
        });

        (mockScratchGitService.readStagedFiles as jest.Mock)
          .mockResolvedValueOnce({
            files: [
              {
                path: 'order-1.json',
                content: JSON.stringify({ id: 'rec1', slug: 'order-1', title: 'Order 1' }),
              },
            ],
            total: 1,
          })
          .mockResolvedValueOnce({ files: [], total: 0 });

        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          created: ['Orders/order-1.json'],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        // Failing folder should have lock cleared and job-failed event sent
        expect(mockWorkbookEventService.sendWorkbookEvent).toHaveBeenCalledWith(
          'wkb_123',
          expect.objectContaining({
            type: 'job-failed',
            data: expect.objectContaining({
              entityId: 'dfld_1',
            }),
          }),
        );

        // Succeeding folder should have been committed normally
        expect(mockScratchGitService.commitStagedFiles).toHaveBeenCalledWith(
          'test-job-id',
          'org/wkb/coa',
          'main',
          'Orders',
          expect.stringContaining('Orders'),
        );

        // Succeeding folder should have job-completed event
        expect(mockWorkbookEventService.sendWorkbookEvent).toHaveBeenCalledWith(
          'wkb_123',
          expect.objectContaining({
            type: 'job-completed',
            data: expect.objectContaining({
              entityId: 'dfld_2',
            }),
          }),
        );

        // Job-level should report failure (because one folder failed)
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          'usr_123',
          expect.objectContaining({
            result: 'failure',
            filesCreated: 1,
          }),
        );
      });
    });

    describe('progress tracking', () => {
      it('should accumulate created and updated counts across folders', async () => {
        const folder1 = createMockDataFolder({ id: 'dfld_1' as DataFolderId, name: 'Products', path: '/Products' });
        const folder2 = createMockDataFolder({ id: 'dfld_2' as DataFolderId, name: 'Orders', path: '/Orders' });

        const connectorAccount = createMockConnectorAccount();
        const mockConnector = createMockConnector();

        const params = createMockParams({
          data: {
            workbookId: 'wkb_123' as WorkbookId,
            dataFolderIds: ['dfld_1' as DataFolderId, 'dfld_2' as DataFolderId],
            userId: 'usr_123',
            organizationId: 'org_123',
          },
        });

        (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([
          { id: 'dfld_1', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test Connection' } },
          { id: 'dfld_2', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test Connection' } },
        ]);

        (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValueOnce(folder1).mockResolvedValueOnce(folder2);
        (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(folder1);
        (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
        (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);
        jest.spyOn(connectorRegistry, 'get').mockReturnValue(undefined);

        mockConnector.pullRecordFiles.mockResolvedValue(undefined);
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], total: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock)
          .mockResolvedValueOnce({
            created: ['Products/a.json'],
            updated: ['Products/b.json'],
            unchanged: [],
          })
          .mockResolvedValueOnce({
            created: ['Orders/c.json'],
            updated: [],
            unchanged: [],
          });

        await handler.run(params);

        // PostHog should receive accumulated stats
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          'usr_123',
          expect.objectContaining({
            filesCreated: 2,
            filesUpdated: 1,
            filesDeleted: 0,
          }),
        );
      });
    });
  });
});
