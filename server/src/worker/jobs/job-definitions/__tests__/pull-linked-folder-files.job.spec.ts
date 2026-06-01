/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { AssetExtractorService } from '../../../../asset/asset-extractor.service';
import { AssetIndexService } from '../../../../asset/asset-index.service';
import { ExperimentsService } from '../../../../experiments/experiments.service';
import { PostHogService } from '../../../../posthog/posthog.service';
import { FileIndexService } from '../../../../publish-plan/file-index.service';
import { FileReferenceService } from '../../../../publish-plan/file-reference.service';
import { ConnectorAccountService } from '../../../../remote-service/connector-account/connector-account.service';
import { connectorRegistry } from '../../../../remote-service/connectors/connector-registry';
import { ConnectorsService } from '../../../../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile, idPath } from '../../../../remote-service/connectors/types';
import { ScratchGitService } from '../../../../scratch-git/scratch-git.service';
import { JsonSafeObject } from '../../../../utils/objects';
import { WorkbookEventService } from '../../../../workbook/workbook-event.service';
import { JobCanceledError } from '../../../../worker/job-errors';
import {
  getMaxConcurrency,
  PullLinkedFolderFilesJobHandler,
  runWithConcurrency,
} from '../pull-linked-folder-files.job';

type PullCallback = (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>;

describe('PullLinkedFolderFilesJobHandler', () => {
  let handler: PullLinkedFolderFilesJobHandler;
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
  let mockExperimentsService: jest.Mocked<ExperimentsService>;

  const defaultTableSpec: BaseJsonTableSpec = {
    idColumnRemoteId: idPath('id'),
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
    supportsIncrementalPull: jest.fn().mockReturnValue(false),
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
      type: 'pull-linked-folder-files' as const,
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
      timestamp: Date.now(),
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
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      stageFiles: jest.fn().mockResolvedValue(undefined),
      readStagedFiles: jest.fn(),
      markStagedFilesProcessed: jest.fn().mockResolvedValue(undefined),
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
      listFilenamesForFolder: jest.fn().mockResolvedValue([]),
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

    // Default: kill switch ON (flag enabled), so existing tests exercising
    // pullMode='incremental' continue to hit the incremental code path.
    mockExperimentsService = {
      getBooleanFlag: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ExperimentsService>;

    handler = new PullLinkedFolderFilesJobHandler(
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
      mockExperimentsService,
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

    it('should propagate JobCanceledError instead of swallowing it', async () => {
      await expect(
        runWithConcurrency([1, 2, 3], 2, async (item) => {
          if (item === 2) throw new JobCanceledError('test-job');
          await Promise.resolve();
        }),
      ).rejects.toThrow(JobCanceledError);
    });

    it('should stop starting new items after JobCanceledError', async () => {
      const processed: number[] = [];
      await expect(
        runWithConcurrency([1, 2, 3, 4, 5], 1, async (item) => {
          if (item === 2) throw new JobCanceledError('test-job');
          processed.push(item);
          await Promise.resolve();
        }),
      ).rejects.toThrow(JobCanceledError);
      // Item 1 runs, item 2 throws, items 3-5 should not start
      expect(processed).toEqual([1]);
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
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
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

    describe('Phase 1 filename dedup seeding', () => {
      it('seeds usedFileNames from listFilenamesForFolder so a new record can’t clobber an existing one’s prior filename', async () => {
        // Regression for the data-loss bug: a new record whose suggested
        // filename matched another (not-in-this-batch) record's prior filename
        // would claim the bare name and clobber that record at stage time.
        // The fix seeds usedFileNames from FileIndexService.listFilenamesForFolder
        // before any batch runs. This test pins the wiring end-to-end.
        const { mockConnector, params } = setupStandardMocks();

        // Simulate a previously-pulled record already occupying "john-smith.json"
        // that does NOT appear in this pull's batch (the bug condition).
        (mockFileIndexService.listFilenamesForFolder as jest.Mock).mockResolvedValue(['john-smith.json']);

        // The new record has the same suggested slug. Without the seed, it
        // would stage to "john-smith.json" and silently overwrite the existing
        // record's file. With the seed, dedup pushes it to the suffixed form.
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'recNew', slug: 'john-smith', title: 'John Smith' }],
            connectorProgress: {},
          });
        });

        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        expect(mockFileIndexService.listFilenamesForFolder).toHaveBeenCalledWith('wkb_123', 'Products');

        expect(mockScratchGitService.stageFiles).toHaveBeenCalledWith(
          'test-job-id',
          'Products',
          expect.arrayContaining([
            expect.objectContaining({
              path: 'john-smith-recNew.json', // NOT "john-smith.json"
            }),
          ]),
        );
      });
    });

    describe('default view writing', () => {
      it('should call writeViewToGit when tableSpec has a defaultView', async () => {
        const defaultView = { name: 'Default', cols: [] };
        const mockConnector = createMockConnector({ defaultView });
        const params = createMockParams();
        const dataFolder = createMockDataFolder();
        const connectorAccount = createMockConnectorAccount();

        (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
        (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);
        (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
        (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);
        jest.spyOn(connectorRegistry, 'get').mockReturnValue(undefined);

        mockConnector.pullRecordFiles.mockResolvedValue(undefined);
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        expect(mockScratchGitService.writeViewToGit).toHaveBeenCalledWith(
          'org/wkb/coa',
          '/Products',
          'default',
          defaultView,
        );
      });

      it('should not call writeViewToGit when tableSpec has no defaultView', async () => {
        const { mockConnector, params } = setupStandardMocks();

        mockConnector.pullRecordFiles.mockResolvedValue(undefined);
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
          created: [],
          updated: [],
          unchanged: [],
        });

        await handler.run(params);

        expect(mockScratchGitService.writeViewToGit).not.toHaveBeenCalled();
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
            remaining: 0,
          })
          .mockResolvedValueOnce({ files: [], remaining: 0 });

        (mockScratchGitService.commitStagedFiles as jest.Mock)
          .mockResolvedValueOnce({
            committed: 1,
            remaining: 0,
            created: ['Products/test-product.json'],
            updated: [],
            unchanged: [],
          })
          .mockResolvedValue({
            committed: 0,
            remaining: 0,
            created: [],
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

        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
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
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
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
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
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
            type: 'pull-linked-folder-files' as const,
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

        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
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
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
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
              message: 'An error occurred',
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
            type: 'pull-linked-folder-files' as const,
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
            remaining: 0,
          })
          .mockResolvedValueOnce({ files: [], remaining: 0 });

        (mockScratchGitService.commitStagedFiles as jest.Mock)
          .mockResolvedValueOnce({
            committed: 1,
            remaining: 0,
            created: ['Orders/order-1.json'],
            updated: [],
            unchanged: [],
          })
          .mockResolvedValue({
            committed: 0,
            remaining: 0,
            created: [],
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
          1000,
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

    describe('cancellation', () => {
      it('should throw JobCanceledError when aborted during Phase 1 fetch', async () => {
        const { mockConnector, params } = setupStandardMocks();

        const abortController = new AbortController();
        params.abortSignal = abortController.signal;

        // Abort during the connector's pullRecordFiles callback
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          abortController.abort();
          await callback({
            files: [{ id: 'rec1', slug: 'test-product', title: 'Test Product' }],
            connectorProgress: {},
          });
        });

        await expect(handler.run(params)).rejects.toThrow(JobCanceledError);

        // Cleanup should still run
        expect(mockScratchGitService.cleanupStaging).toHaveBeenCalledWith('test-job-id');
      });

      it('should throw JobCanceledError when aborted before Phase 2', async () => {
        const { mockConnector, params } = setupStandardMocks();

        const abortController = new AbortController();
        params.abortSignal = abortController.signal;

        // Phase 1 succeeds, then abort before Phase 2
        mockConnector.pullRecordFiles.mockResolvedValue(undefined);

        // Abort when checkpoint is called after Phase 1 completes
        params.checkpoint = jest.fn().mockImplementation(() => {
          abortController.abort();
          return Promise.resolve();
        });

        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
          created: [],
          updated: [],
          unchanged: [],
        });

        await expect(handler.run(params)).rejects.toThrow(JobCanceledError);

        expect(mockScratchGitService.cleanupStaging).toHaveBeenCalledWith('test-job-id');
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
            type: 'pull-linked-folder-files' as const,
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
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock)
          // Folder 1 (Products): first call returns data, second call terminates loop
          .mockResolvedValueOnce({
            committed: 2,
            remaining: 0,
            created: ['Products/a.json'],
            updated: ['Products/b.json'],
            unchanged: [],
          })
          .mockResolvedValueOnce({
            committed: 0,
            remaining: 0,
            created: [],
            updated: [],
            unchanged: [],
          })
          // Folder 2 (Orders): first call returns data, second call terminates loop
          .mockResolvedValueOnce({
            committed: 1,
            remaining: 0,
            created: ['Orders/c.json'],
            updated: [],
            unchanged: [],
          })
          .mockResolvedValue({
            committed: 0,
            remaining: 0,
            created: [],
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

    describe('incremental pulls', () => {
      type DataFolderUpdateData = {
        lock?: null;
        lastFullPullAt?: Date;
        lastIncrementalPullAt?: Date;
        incrementalCursor?: unknown;
      };

      const stubEmptyPhase2 = () => {
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
          created: [],
          updated: [],
          unchanged: [],
        });
      };

      const lastConnectorCallOptions = (
        mockConnector: ReturnType<typeof createMockConnector>,
      ): { pullMode?: string; since?: Date | null; cursor?: unknown } => {
        const calls = mockConnector.pullRecordFiles.mock.calls as Array<unknown[]>;
        const lastCall = calls[calls.length - 1];
        return lastCall[3] as { pullMode?: string; since?: Date | null; cursor?: unknown };
      };

      const findUpdateMatching = (predicate: (data: DataFolderUpdateData) => boolean): DataFolderUpdateData | null => {
        const calls = (mockPrisma.dataFolder.update as jest.Mock).mock.calls as Array<[{ data: DataFolderUpdateData }]>;
        const found = calls.find((c) => predicate(c[0].data));
        return found ? found[0].data : null;
      };

      // (a) Bootstrap: an incremental request against a never-pulled folder
      // runs a full pull and seeds both watermarks, so the *next* run can
      // actually go incremental.
      it('demotes to full on bootstrap when lastIncrementalPullAt is null', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        // Folder has no prior incremental pull.
        Object.assign(dataFolder, { lastIncrementalPullAt: null });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        // Connector saw 'full' — not 'incremental' — because no watermark yet.
        expect(lastConnectorCallOptions(mockConnector).pullMode).toBe('full');
        // Deletion check ran (this is a full pull), and both watermarks are seeded.
        expect(mockScratchGitService.listRepoFiles).toHaveBeenCalled();
        const updateData = findUpdateMatching((d) => d.lastFullPullAt instanceof Date);
        expect(updateData).not.toBeNull();
        expect(updateData!.lastFullPullAt).toBeInstanceOf(Date);
        expect(updateData!.lastIncrementalPullAt).toBeInstanceOf(Date);
        // Prisma.DbNull serializes to a sentinel object; assert deletion intent rather than the literal null.
        expect(updateData!.incrementalCursor).toBeDefined();
      });

      // (b) Happy path: existing watermark → connector called with pullMode/since.
      it('passes pullMode + since to the connector when incremental is supported', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        const previousWatermark = new Date('2026-05-01T00:00:00.000Z');
        Object.assign(dataFolder, { lastIncrementalPullAt: previousWatermark });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({ newWatermark: new Date('2026-05-14T12:00:00.000Z') });
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        const callOptions = lastConnectorCallOptions(mockConnector);
        expect(callOptions.pullMode).toBe('incremental');
        expect(callOptions.since).toEqual(previousWatermark);
      });

      // (c) Connector reports no support → forced to full.
      it('demotes to full when the connector does not support incremental for this folder', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, { lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z') });
        mockConnector.supportsIncrementalPull.mockReturnValue(false);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        expect(lastConnectorCallOptions(mockConnector).pullMode).toBe('full');
        // Deletion check ran (full mode after demotion).
        expect(mockScratchGitService.listRepoFiles).toHaveBeenCalled();
      });

      // (d) Successful incremental run advances lastIncrementalPullAt and does NOT run stale-file deletion.
      it('updates lastIncrementalPullAt and skips deleteStaleFiles on incremental success', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        const previousWatermark = new Date('2026-05-01T00:00:00.000Z');
        const reportedWatermark = new Date('2026-05-14T12:00:00.000Z');
        Object.assign(dataFolder, { lastIncrementalPullAt: previousWatermark });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({ newWatermark: reportedWatermark });
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        // No stale-file deletion on incremental.
        expect(mockScratchGitService.listRepoFiles).not.toHaveBeenCalled();
        expect(mockScratchGitService.deleteFilesFromBranch).not.toHaveBeenCalled();
        // lastIncrementalPullAt advanced to the connector-reported watermark.
        const updateData = findUpdateMatching((d) => d.lastIncrementalPullAt instanceof Date);
        expect(updateData).not.toBeNull();
        expect(updateData!.lastIncrementalPullAt).toEqual(reportedWatermark);
        // No lastFullPullAt write — this was an incremental, not a full.
        expect(updateData!.lastFullPullAt).toBeUndefined();
      });

      // (e) Full run after bootstrap bumps BOTH watermarks.
      it('bumps both lastFullPullAt and lastIncrementalPullAt on a full pull, clearing the cursor', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, { lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z') });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'full' } });

        const updateData = findUpdateMatching((d) => d.lastFullPullAt instanceof Date);
        expect(updateData).not.toBeNull();
        expect(updateData!.lastFullPullAt).toBeInstanceOf(Date);
        expect(updateData!.lastIncrementalPullAt).toBeInstanceOf(Date);
        expect(updateData!.lastFullPullAt).toEqual(updateData!.lastIncrementalPullAt);
        // Prisma.DbNull sentinel, not the literal null — just assert "cleared".
        expect(updateData!.incrementalCursor).toBeDefined();
      });

      // Kill switch: when the INCREMENTAL_POLLING_ENABLED flag is off for the
      // job's user, an incremental request is silently forced to full before
      // any per-folder resolution.
      it('forces full when the INCREMENTAL_POLLING_ENABLED feature flag is off', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, { lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z') });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();
        mockExperimentsService.getBooleanFlag.mockResolvedValue(false);

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        // Connector still saw 'full' — the kill switch short-circuits before
        // the per-folder capability check is even consulted.
        expect(lastConnectorCallOptions(mockConnector).pullMode).toBe('full');
        expect(mockConnector.supportsIncrementalPull).not.toHaveBeenCalled();
      });

      // (f) INCREMENTAL_POLLING_ENABLED feature flag is off → kill switch
      // forces full pull even when the caller requested incremental.
      it('forces full when the INCREMENTAL_POLLING_ENABLED kill switch is off', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, { lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z') });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();

        // Kill switch OFF: flag returns false.
        (mockExperimentsService.getBooleanFlag as jest.Mock).mockResolvedValue(false);

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        expect(lastConnectorCallOptions(mockConnector).pullMode).toBe('full');
        // The capability check never runs when the kill switch already forced full.
        expect(mockConnector.supportsIncrementalPull).not.toHaveBeenCalled();
        // Verify the flag was actually consulted for this userId.
        expect(mockExperimentsService.getBooleanFlag).toHaveBeenCalledWith(
          'INCREMENTAL_POLLING_ENABLED',
          false,
          expect.objectContaining({ id: 'usr_123' }),
        );
      });
    });
  });
});
