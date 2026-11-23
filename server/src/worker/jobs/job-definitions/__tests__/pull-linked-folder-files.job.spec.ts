/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { DataFolderId, type PulledRecordWarning, type PullFolderProgress, WorkbookId } from '@spinner/shared-types';
import { AssetExtractorService } from '../../../../asset/asset-extractor.service';
import { AssetIndexService } from '../../../../asset/asset-index.service';
import { ExperimentsService } from '../../../../experiments/experiments.service';
import { WSLogger } from '../../../../logger';
import { PostHogService } from '../../../../posthog/posthog.service';
import { FileIndexService } from '../../../../publish-plan/file-index.service';
import { FileReferenceService } from '../../../../publish-plan/file-reference.service';
import { ConnectorAccountService } from '../../../../remote-service/connector-account/connector-account.service';
import { connectorRegistry } from '../../../../remote-service/connectors/connector-registry';
import { ConnectorsService } from '../../../../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../../remote-service/connectors/types';
import { ScratchGitService } from '../../../../scratch-git/scratch-git.service';
import { JsonSafeObject } from '../../../../utils/objects';
import { DataFolderTableSpecStoreService } from '../../../../workbook/table-spec-store/data-folder-table-spec-store.service';
import { WorkbookEventService } from '../../../../workbook/workbook-event.service';
import { JobCanceledError } from '../../../../worker/job-errors';
import {
  getMaxConcurrency,
  PullLinkedFolderFilesJobHandler,
  runWithConcurrency,
} from '../pull-linked-folder-files.job';
import type { PullSink } from '../pull-sink/pull-sink';

type PullCallback = (params: {
  files: ConnectorFile[];
  connectorProgress?: JsonSafeObject;
  recordWarnings?: PulledRecordWarning[];
}) => Promise<void>;

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
  let mockDataFolderTableSpecStore: jest.Mocked<DataFolderTableSpecStoreService>;

  const defaultTableSpec: BaseJsonTableSpec = {
    idPath: dotPath('id'),
    slugPath: dotPath('slug'),
    titlePath: dotPath('title'),
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
    // The view is now produced by the connector on demand (MR2); default to none.
    buildDefaultView: jest.fn().mockReturnValue(undefined),
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
        folders: [],
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
      findOneByIdUnscoped: jest.fn(),
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
      readRecordIdToFilenameMapForFolder: jest.fn().mockResolvedValue(new Map()),
      upsertBatch: jest.fn().mockResolvedValue(undefined),
      deleteRowsForDeletedFiles: jest.fn().mockResolvedValue(undefined),
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

    mockExperimentsService = {
      isGenericConnectorEnabledForUser: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ExperimentsService>;

    mockDataFolderTableSpecStore = {
      readTableSpec: jest.fn().mockResolvedValue(null),
      readDefaultView: jest.fn().mockResolvedValue(null),
      writeTableSpec: jest.fn().mockResolvedValue('created'),
      writeDefaultView: jest.fn().mockResolvedValue('updated'),
    } as unknown as jest.Mocked<DataFolderTableSpecStoreService>;

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
      mockDataFolderTableSpecStore,
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

    it('should cap at the documented concurrency limit when it is below the rate', () => {
      jest.spyOn(connectorRegistry, 'get').mockReturnValue({
        rateLimiterSpec: { points: 100, duration: 1, maxConcurrency: 4 },
      } as ReturnType<typeof connectorRegistry.get>);

      // Rate allows 100/s, but the service permits only 4 simultaneous requests.
      expect(getMaxConcurrency('some-service', 20)).toBe(4);
    });

    it('should still cap at the rate when it is below the documented concurrency limit', () => {
      jest.spyOn(connectorRegistry, 'get').mockReturnValue({
        rateLimiterSpec: { points: 3, duration: 1, maxConcurrency: 10 },
      } as ReturnType<typeof connectorRegistry.get>);

      // Both ceilings apply independently; the lower one wins.
      expect(getMaxConcurrency('some-service', 20)).toBe(3);
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
      (mockConnectorAccountService.findOneByIdUnscoped as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Default: no rate limiter spec
      jest.spyOn(connectorRegistry, 'get').mockReturnValue(undefined);

      return { dataFolder, connectorAccount, mockConnector, params };
    };

    const createRecordingPullSink = (persistsIncrementalPullBaseline: boolean) => {
      const pagesWritten: ConnectorFile[][] = [];
      const pullSink: PullSink = {
        persistsIncrementalPullBaseline,
        reportsRecordChangeCounts: persistsIncrementalPullBaseline,
        prepareStorageBeforeLoadingFolders: jest.fn().mockResolvedValue(undefined),
        storeFolderTableSpec: jest.fn().mockResolvedValue(undefined),
        storeFolderDefaultView: jest.fn().mockResolvedValue(undefined),
        prepareFolderForIncomingRecordPages: jest.fn().mockResolvedValue(undefined),
        writeConnectorRecordPage: jest.fn((_folder, connectorRecordsInPage: ConnectorFile[]) => {
          pagesWritten.push(connectorRecordsInPage);
          return Promise.resolve();
        }),
        releaseRecordPageWritingStateForFolder: jest.fn(),
        finishFolderAfterAllRecordPagesWritten: jest.fn().mockResolvedValue({
          created: 0,
          updated: 0,
          deleted: 0,
          createdPaths: [],
          updatedPaths: [],
          deletedPaths: [],
        }),
        cleanUpTemporaryStorageAfterPullAttempt: jest.fn().mockResolvedValue(undefined),
        finalizeStorageAfterAllFoldersFinished: jest.fn().mockResolvedValue(undefined),
      };
      return { pullSink, pagesWritten };
    };

    const createHandlerWritingTo = (pullSink: PullSink) =>
      new PullLinkedFolderFilesJobHandler(
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
        mockDataFolderTableSpecStore,
        () => pullSink,
      );

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
      it('seeds usedFileNames from the folder’s index snapshot so a new record can’t clobber an existing one’s prior filename', async () => {
        // Regression for the data-loss bug: a new record whose suggested
        // filename matched another (not-in-this-batch) record's prior filename
        // would claim the bare name and clobber that record at stage time.
        // The fix seeds usedFileNames from the folder's FileIndex snapshot
        // (readRecordIdToFilenameMapForFolder) before any batch runs. This test
        // pins the wiring end-to-end.
        const { mockConnector, params } = setupStandardMocks();

        // Simulate a previously-pulled record already occupying "john-smith.json"
        // that does NOT appear in this pull's batch (the bug condition).
        (mockFileIndexService.readRecordIdToFilenameMapForFolder as jest.Mock).mockResolvedValue(
          new Map([['recOld', 'john-smith.json']]),
        );

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

        expect(mockFileIndexService.readRecordIdToFilenameMapForFolder).toHaveBeenCalledWith('wkb_123', 'Products');

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

      it('keeps a re-pulled record at its indexed filename using the one folder read, with no per-page lookup', async () => {
        const { mockConnector, params } = setupStandardMocks();

        // recExisting was renamed by the user; its suggested slug no longer matches its file.
        (mockFileIndexService.readRecordIdToFilenameMapForFolder as jest.Mock).mockResolvedValue(
          new Map([['recExisting', 'hand-picked-name.json']]),
        );

        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'recExisting', slug: 'jane-doe', title: 'Jane Doe' }],
            connectorProgress: {},
          });
          await callback({ files: [{ id: 'recOther', slug: 'bob', title: 'Bob' }], connectorProgress: {} });
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

        expect(mockFileIndexService.readRecordIdToFilenameMapForFolder).toHaveBeenCalledTimes(1);
        expect(mockFileIndexService.getFilenamesByRecordIds).not.toHaveBeenCalled();
        expect(mockScratchGitService.stageFiles).toHaveBeenCalledWith(
          'test-job-id',
          'Products',
          expect.arrayContaining([expect.objectContaining({ path: 'hand-picked-name.json' })]),
        );
      });
    });

    describe('default view writing', () => {
      it('should store the table spec and the default view when the connector builds one', async () => {
        const defaultView = { name: 'Default', cols: [] };
        const mockConnector = createMockConnector();
        mockConnector.buildDefaultView.mockReturnValue(defaultView);
        const params = createMockParams();
        const dataFolder = createMockDataFolder();
        const connectorAccount = createMockConnectorAccount();

        (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
        (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);
        (mockConnectorAccountService.findOneByIdUnscoped as jest.Mock).mockResolvedValue(connectorAccount);
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

        const tableSpecLocation = { dataFolderId: 'dfld_123', connectorAccountId: 'coa_123', folderPath: '/Products' };
        expect(mockDataFolderTableSpecStore.writeTableSpec).toHaveBeenCalledWith(
          tableSpecLocation,
          expect.objectContaining({ idPath: 'id' }),
          'pull',
        );
        expect(mockDataFolderTableSpecStore.writeDefaultView).toHaveBeenCalledWith(
          tableSpecLocation,
          defaultView,
          'pull',
        );
      });

      it('should not store a default view when the connector builds none', async () => {
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

        expect(mockDataFolderTableSpecStore.writeTableSpec).toHaveBeenCalledTimes(1);
        expect(mockDataFolderTableSpecStore.writeDefaultView).not.toHaveBeenCalled();
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
        (mockConnectorAccountService.findOneByIdUnscoped as jest.Mock).mockResolvedValue(connectorAccount);
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
        (mockConnectorAccountService.findOneByIdUnscoped as jest.Mock).mockResolvedValue(connectorAccount);
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
        (mockConnectorAccountService.findOneByIdUnscoped as jest.Mock).mockResolvedValue(connectorAccount);
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastFullPullAt).toBeInstanceOf(Date);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastIncrementalPullAt).toBeInstanceOf(Date);
        // Prisma.DbNull serializes to a sentinel object; assert deletion intent rather than the literal null.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.incrementalCursor).toBeDefined();
      });

      // (a2) Regression: a folder can carry a watermark with no completed full
      // pull (e.g. migrated/backfilled state). Running incremental there would
      // miss every record older than the watermark, so demote to full even
      // though `lastIncrementalPullAt` is set, and seed both watermarks.
      it('demotes to full when lastFullPullAt is null even though a watermark exists', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: null,
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        // Connector saw 'full' — no completed full pull to use as a baseline yet.
        expect(lastConnectorCallOptions(mockConnector).pullMode).toBe('full');
        // Deletion check ran (full pull) and both watermarks are seeded.
        expect(mockScratchGitService.listRepoFiles).toHaveBeenCalled();
        const updateData = findUpdateMatching((d) => d.lastFullPullAt instanceof Date);
        expect(updateData).not.toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastFullPullAt).toBeInstanceOf(Date);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastIncrementalPullAt).toBeInstanceOf(Date);
      });

      // (b) Happy path: completed full pull + existing watermark → connector called with pullMode/since.
      it('passes pullMode + since to the connector when incremental is supported', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        const previousFullPull = new Date('2026-04-15T00:00:00.000Z');
        const previousWatermark = new Date('2026-05-01T00:00:00.000Z');
        Object.assign(dataFolder, { lastFullPullAt: previousFullPull, lastIncrementalPullAt: previousWatermark });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({ newWatermark: new Date('2026-05-14T12:00:00.000Z') });
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        const callOptions = lastConnectorCallOptions(mockConnector);
        expect(callOptions.pullMode).toBe('incremental');
        expect(callOptions.since).toEqual(previousWatermark);
      });

      // (c) Connector reports no support → forced to full. Baseline is present
      // so the demotion is attributable to the capability check alone.
      it('demotes to full when the connector does not support incremental for this folder', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
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
        const previousFullPull = new Date('2026-04-15T00:00:00.000Z');
        const previousWatermark = new Date('2026-05-01T00:00:00.000Z');
        const reportedWatermark = new Date('2026-05-14T12:00:00.000Z');
        Object.assign(dataFolder, { lastFullPullAt: previousFullPull, lastIncrementalPullAt: previousWatermark });
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastIncrementalPullAt).toEqual(reportedWatermark);
        // No lastFullPullAt write — this was an incremental, not a full.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastFullPullAt).toBeInstanceOf(Date);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastIncrementalPullAt).toBeInstanceOf(Date);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastFullPullAt).toEqual(updateData!.lastIncrementalPullAt);
        // Prisma.DbNull sentinel, not the literal null — just assert "cleared".
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.incrementalCursor).toBeDefined();
      });

      // (f) A pull that kept records degraded clears the incremental watermark, so the next pull is full and
      // fetches those records again — an incremental one would not, and a later sync would use the partial copies.
      it('clears the incremental watermark after an incremental pull that kept records degraded', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
        const previousFullPull = new Date('2026-04-15T00:00:00.000Z');
        Object.assign(dataFolder, {
          lastFullPullAt: previousFullPull,
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec1' }],
            connectorProgress: { page: 'p2' },
            recordWarnings: [{ remoteId: 'rec1', warning: 'Pulled rec1 without its history' }],
          });
          return { newWatermark: new Date('2026-05-14T12:00:00.000Z'), newCursor: { token: 't2' } };
        });
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        const updateData = findUpdateMatching((d) => 'lastIncrementalPullAt' in d);
        expect(updateData).not.toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastIncrementalPullAt).toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.incrementalCursor).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastFullPullAt).toBeUndefined();
      });

      it('clears the incremental watermark before committing degraded copies, so a failed commit still forces a full pull', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
        jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec1' }],
            connectorProgress: {},
            recordWarnings: [{ remoteId: 'rec1', warning: 'Pulled rec1 without its history' }],
          });
          return {};
        });
        const { pullSink } = createRecordingPullSink(true);
        (pullSink.finishFolderAfterAllRecordPagesWritten as jest.Mock).mockRejectedValue(new Error('commit failed'));

        await createHandlerWritingTo(pullSink).run({ ...params, data: { ...params.data, pullMode: 'full' } });

        const folderUpdates = (mockPrisma.dataFolder.update as jest.Mock).mock.calls as Array<
          [{ data: Record<string, unknown> }]
        >;
        expect(folderUpdates.some(([update]) => update.data.lastIncrementalPullAt === null)).toBe(true);
      });

      it('records the full-pull baseline but clears the incremental watermark after a full pull that kept records degraded', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
        Object.assign(dataFolder, { lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z') });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec1' }],
            connectorProgress: {},
            recordWarnings: [{ remoteId: 'rec1', warning: 'Pulled rec1 without its history' }],
          });
          return {};
        });
        stubEmptyPhase2();

        await handler.run({ ...params, data: { ...params.data, pullMode: 'full' } });

        const updateData = findUpdateMatching((d) => d.lastFullPullAt instanceof Date);
        expect(updateData).not.toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(updateData!.lastIncrementalPullAt).toBeNull();
      });

      // (g) Defense in depth (DEV-11015): the stale-file cleanup must delete only leaf FILES.
      // A directory entry (records mis-staged into a nested path) would recursively wipe every
      // file under it while reporting a single deletion — the failure mode that emptied the
      // variants table. It must be skipped, not deleted.
      it('deletes only stale files and skips directory entries during cleanup', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(false); // full pull → deletion runs
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();
        // `main` has a stray directory (mis-staged nested record paths) plus a genuinely stale
        // file. Nothing was pulled this run, so both are absent from `pulledPaths`.
        (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
          { name: 'gid:', path: 'Products/gid:', type: 'directory' },
          { name: 'stale.json', path: 'Products/stale.json', type: 'file' },
        ]);

        await handler.run({ ...params, data: { ...params.data, pullMode: 'full' } });

        expect(mockScratchGitService.deleteFilesFromBranch).toHaveBeenCalledTimes(1);
        // deleteFilesFromBranch(repoId, branch, paths, message) — only the file, never the directory.
        const deleteCalls = (mockScratchGitService.deleteFilesFromBranch as jest.Mock).mock.calls as Array<
          [string, string, string[], string]
        >;
        expect(deleteCalls[0][2]).toEqual(['Products/stale.json']);
      });

      // (h) DEV-11438: a stale file's FileIndex row must go with it. The index seeds the
      // filename-collision set for later pulls and published creates, so a leftover row
      // makes a re-created record come back id-suffixed (`stale-<id>.json`).
      it('removes the FileIndex rows of the stale files it deletes, scoped to the connection', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(false); // full pull → deletion runs
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();
        (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
          { name: 'stale.json', path: 'Products/stale.json', type: 'file' },
          { name: 'also-stale.json', path: 'Products/also-stale.json', type: 'file' },
        ]);

        await handler.run({ ...params, data: { ...params.data, pullMode: 'full' } });

        expect(mockFileIndexService.deleteRowsForDeletedFiles).toHaveBeenCalledTimes(1);
        expect(mockFileIndexService.deleteRowsForDeletedFiles).toHaveBeenCalledWith('wkb_123', 'coa_123', [
          'Products/stale.json',
          'Products/also-stale.json',
        ]);
      });

      it('does not touch the FileIndex when nothing is stale', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(false);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();
        (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);

        await handler.run({ ...params, data: { ...params.data, pullMode: 'full' } });

        expect(mockScratchGitService.deleteFilesFromBranch).not.toHaveBeenCalled();
        expect(mockFileIndexService.deleteRowsForDeletedFiles).not.toHaveBeenCalled();
      });

      it('still reports the git deletion when the FileIndex cleanup fails', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(false);
        mockConnector.pullRecordFiles.mockResolvedValue({});
        stubEmptyPhase2();
        (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
          { name: 'stale.json', path: 'Products/stale.json', type: 'file' },
        ]);
        (mockFileIndexService.deleteRowsForDeletedFiles as jest.Mock).mockRejectedValue(new Error('db down'));

        await handler.run({ ...params, data: { ...params.data, pullMode: 'full' } });

        expect(mockScratchGitService.deleteFilesFromBranch).toHaveBeenCalledTimes(1);
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ result: 'success', filesDeleted: 1 }),
        );
      });
    });

    // The storage seam: with a caller-supplied PullSink the job fetches from the connector and hands
    // every write to the sink — no git, no index rows — and a sink that isn't the incremental baseline
    // gets a full pull that leaves the folder's watermarks untouched.
    describe('with a caller-supplied PullSink', () => {
      it('writes the schema and every page through the sink and never touches git or the file index', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.buildDefaultView.mockReturnValue({ columns: [] });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({ files: [{ id: 'rec1', slug: 'first', title: 'First' }], connectorProgress: {} });
          await callback({ files: [{ id: 'rec2', slug: 'second', title: 'Second' }], connectorProgress: {} });
          return {};
        });
        const { pullSink, pagesWritten } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        expect(pullSink.prepareStorageBeforeLoadingFolders).toHaveBeenCalledTimes(1);
        const tableSpecLocation = { dataFolderId: 'dfld_123', connectorAccountId: 'coa_123', folderPath: '/Products' };
        expect(pullSink.storeFolderTableSpec).toHaveBeenCalledWith(
          tableSpecLocation,
          expect.objectContaining({ idPath: 'id' }),
        );
        expect(pullSink.storeFolderDefaultView).toHaveBeenCalledWith(tableSpecLocation, { columns: [] });
        expect(pagesWritten).toEqual([
          [{ id: 'rec1', slug: 'first', title: 'First' }],
          [{ id: 'rec2', slug: 'second', title: 'Second' }],
        ]);
        expect(pullSink.releaseRecordPageWritingStateForFolder).toHaveBeenCalledTimes(1);
        expect(pullSink.finishFolderAfterAllRecordPagesWritten).toHaveBeenCalledTimes(1);
        expect(pullSink.cleanUpTemporaryStorageAfterPullAttempt).toHaveBeenCalledTimes(1);
        expect(pullSink.finalizeStorageAfterAllFoldersFinished).toHaveBeenCalledTimes(1);
        for (const gitMethod of Object.values(mockScratchGitService)) {
          expect(gitMethod).not.toHaveBeenCalled();
        }
        for (const storedTableSpecMethod of Object.values(mockDataFolderTableSpecStore)) {
          expect(storedTableSpecMethod).not.toHaveBeenCalled();
        }
        expect(mockFileIndexService.readRecordIdToFilenameMapForFolder).not.toHaveBeenCalled();
        expect(mockFileIndexService.upsertBatch).not.toHaveBeenCalled();
      });

      it('reports only the fetched record count when the sink cannot tell new records from unchanged ones', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.buildDefaultView.mockReturnValue({ columns: [] });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({ files: [{ id: 'rec1' }, { id: 'rec2' }], connectorProgress: {} });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const checkpointCalls = params.checkpoint.mock.calls as Array<
          [{ publicProgress: { reportsOnlyFetchedRecordCount?: boolean; totalFiles: number } }]
        >;
        const finalPublicProgress = checkpointCalls[checkpointCalls.length - 1][0].publicProgress;
        expect(finalPublicProgress).toMatchObject({ reportsOnlyFetchedRecordCount: true, totalFiles: 2 });
      });

      it('pulls fully and leaves the watermarks untouched when the sink is not the incremental baseline', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        mockConnector.pullRecordFiles.mockResolvedValue({ newWatermark: new Date('2026-05-14T12:00:00.000Z') });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run({ ...params, data: { ...params.data, pullMode: 'incremental' } });

        const connectorCalls = mockConnector.pullRecordFiles.mock.calls as Array<unknown[]>;
        expect((connectorCalls[0][3] as { pullMode?: string }).pullMode).toBe('full');
        expect(pullSink.finishFolderAfterAllRecordPagesWritten).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ mayRemoveRecordsAbsentFromThisPull: true }),
        );
        const folderUpdates = (mockPrisma.dataFolder.update as jest.Mock).mock.calls as Array<
          [{ data: Record<string, unknown> }]
        >;
        expect(folderUpdates.length).toBeGreaterThan(0);
        for (const [update] of folderUpdates) {
          expect(update.data).not.toHaveProperty('lastFullPullAt');
          expect(update.data).not.toHaveProperty('lastIncrementalPullAt');
          expect(update.data).not.toHaveProperty('incrementalCursor');
        }
      });
    });

    describe("a connector's degraded-record warnings", () => {
      const finalCheckpointedFolderEntry = (checkpoint: jest.Mock): PullFolderProgress => {
        const checkpointCalls = checkpoint.mock.calls as Array<[{ publicProgress: { folders: PullFolderProgress[] } }]>;
        return checkpointCalls[checkpointCalls.length - 1][0].publicProgress.folders[0];
      };

      const recordWarningsFor = (remoteIds: string[]): PulledRecordWarning[] =>
        remoteIds.map((remoteId) => ({ remoteId, warning: `Pulled ${remoteId} without its history` }));

      it('records them on the folder, keeps writing the records, and logs them, without failing the folder', async () => {
        const { mockConnector, params } = setupStandardMocks();
        const warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec1' }, { id: 'rec2' }],
            connectorProgress: { page: 'p2' },
            recordWarnings: recordWarningsFor(['rec2']),
          });
          await callback({ files: [{ id: 'rec3' }], connectorProgress: { page: 'p3' } });
          return {};
        });
        const { pullSink, pagesWritten } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        expect(pagesWritten).toEqual([[{ id: 'rec1' }, { id: 'rec2' }], [{ id: 'rec3' }]]);
        expect(finalCheckpointedFolderEntry(params.checkpoint)).toMatchObject({
          status: 'completed',
          totalFiles: 3,
          warningCount: 1,
          warnings: recordWarningsFor(['rec2']),
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Connector pulled records in a degraded form',
            dataFolderId: 'dfld_123',
            recordWarnings: recordWarningsFor(['rec2']),
          }),
        );
      });

      it('lists every one, up to 100 across the pages of a folder', async () => {
        const { mockConnector, params } = setupStandardMocks();
        jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
        const remoteIdsOfFirstPage = Array.from({ length: 60 }, (_unused, index) => `rec${index}`);
        const remoteIdsOfSecondPage = Array.from({ length: 40 }, (_unused, index) => `rec${60 + index}`);
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: remoteIdsOfFirstPage.map((id) => ({ id })),
            connectorProgress: { page: 'p2' },
            recordWarnings: recordWarningsFor(remoteIdsOfFirstPage),
          });
          await callback({
            files: remoteIdsOfSecondPage.map((id) => ({ id })),
            connectorProgress: { page: 'p3' },
            recordWarnings: recordWarningsFor(remoteIdsOfSecondPage),
          });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const folderEntry = finalCheckpointedFolderEntry(params.checkpoint);
        expect(folderEntry.status).toBe('completed');
        expect(folderEntry.warningCount).toBe(100);
        expect(folderEntry.warnings).toEqual(recordWarningsFor([...remoteIdsOfFirstPage, ...remoteIdsOfSecondPage]));
      });

      it('fails the folder once more than 100 records are degraded, naming the first', async () => {
        const { mockConnector, params } = setupStandardMocks();
        jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
        jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
        const remoteIdsOfFirstPage = Array.from({ length: 100 }, (_unused, index) => `rec${index}`);
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: remoteIdsOfFirstPage.map((id) => ({ id })),
            connectorProgress: { page: 'p2' },
            recordWarnings: recordWarningsFor(remoteIdsOfFirstPage),
          });
          await callback({
            files: [{ id: 'rec100' }],
            connectorProgress: { page: 'p3' },
            recordWarnings: recordWarningsFor(['rec100']),
          });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const folderEntry = finalCheckpointedFolderEntry(params.checkpoint);
        expect(folderEntry.status).toBe('failed');
        expect(folderEntry.error?.message).toBe(
          'More than 100 records in Products could only be partly pulled — too many to leave out of a sync, so ' +
            "this folder's pull failed. The first: Pulled rec0 without its history",
        );
        // The connector's error wording is not involved: this is the job's own verdict.
        expect(mockConnector.extractConnectorErrorDetails).not.toHaveBeenCalled();
      });

      it('leaves a folder with no degraded records free of any warning fields', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({ files: [{ id: 'rec1' }], connectorProgress: { page: 'p2' }, recordWarnings: [] });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const folderEntry = finalCheckpointedFolderEntry(params.checkpoint);
        expect(folderEntry).not.toHaveProperty('warningCount');
        expect(folderEntry).not.toHaveProperty('warnings');
      });
    });

    describe('resuming after a worker restart', () => {
      type CheckpointedPublicProgress = {
        totalFiles: number;
        createdCount: number;
        updatedCount: number;
        deletedCount: number;
        folders: PullFolderProgress[];
      };

      const checkpointedPublicProgressList = (checkpoint: jest.Mock): CheckpointedPublicProgress[] =>
        (checkpoint.mock.calls as Array<[{ publicProgress: CheckpointedPublicProgress }]>).map(
          ([checkpointedProgress]) => checkpointedProgress.publicProgress,
        );

      const previousAttemptFolderEntry = (
        folderEntryOverrides: Partial<PullFolderProgress> & { id: string; name: string },
      ): PullFolderProgress => ({
        connector: 'airtable',
        creates: 0,
        updates: 0,
        deletes: 0,
        totalFiles: 0,
        createdPaths: [],
        updatedPaths: [],
        deletedPaths: [],
        status: 'active',
        ...folderEntryOverrides,
      });

      /** The `progress` BullMQ hands a resumed attempt: the previous attempt's last (path-less) checkpoint. */
      const progressCheckpointedByPreviousAttempt = (previousAttempt: {
        folders: PullFolderProgress[];
        jobProgress: Record<string, unknown>;
      }) => {
        const completedFolderIds = (previousAttempt.jobProgress.completedFolderIds as string[] | undefined) ?? [];
        const completedFolders = previousAttempt.folders.filter((folder) => completedFolderIds.includes(folder.id));
        const freshProgress = createMockParams().progress;
        return {
          ...freshProgress,
          publicProgress: {
            ...freshProgress.publicProgress,
            status: 'active' as const,
            totalFiles: previousAttempt.folders.reduce((sum, folder) => sum + folder.totalFiles, 0),
            createdCount: completedFolders.reduce((sum, folder) => sum + folder.creates, 0),
            updatedCount: completedFolders.reduce((sum, folder) => sum + folder.updates, 0),
            deletedCount: completedFolders.reduce((sum, folder) => sum + folder.deletes, 0),
            folders: previousAttempt.folders,
          },
          jobProgress: previousAttempt.jobProgress,
        };
      };

      it('continues the fetched count from the previous attempt when the fetch resumes from its saved cursor', async () => {
        const { mockConnector } = setupStandardMocks();
        const params = createMockParams({
          progress: progressCheckpointedByPreviousAttempt({
            folders: [previousAttemptFolderEntry({ id: 'dfld_123', name: 'Products', totalFiles: 50 })],
            jobProgress: {
              folderFetchStatus: { dfld_123: 'fetching' },
              folderCursors: { dfld_123: { page: 'p3' } },
            },
          }),
        });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({ files: [{ id: 'rec51' }, { id: 'rec52' }], connectorProgress: { page: 'p4' } });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const connectorCalls = mockConnector.pullRecordFiles.mock.calls as Array<unknown[]>;
        expect(connectorCalls[0][2]).toEqual({ page: 'p3' });
        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        const firstCheckpoint = checkpointedPublicProgress[0];
        expect(firstCheckpoint.totalFiles).toBe(50);
        expect(firstCheckpoint.folders[0].totalFiles).toBe(50);
        const finalCheckpoint = checkpointedPublicProgress[checkpointedPublicProgress.length - 1];
        expect(finalCheckpoint.totalFiles).toBe(52);
        expect(finalCheckpoint.folders[0].totalFiles).toBe(52);
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          'usr_123',
          expect.objectContaining({ totalFilesPulled: 52 }),
        );
      });

      it('starts the count over when the folder has no resumable cursor, since its fetch restarts from the first page', async () => {
        const { mockConnector } = setupStandardMocks();
        const params = createMockParams({
          progress: progressCheckpointedByPreviousAttempt({
            folders: [previousAttemptFolderEntry({ id: 'dfld_123', name: 'Products', totalFiles: 50 })],
            jobProgress: {
              folderFetchStatus: { dfld_123: 'fetching' },
              // A connector that reports no position checkpoints `{}`, which resumes nothing.
              folderCursors: { dfld_123: {} },
            },
          }),
        });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({ files: [{ id: 'rec1' }, { id: 'rec2' }], connectorProgress: {} });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        expect(checkpointedPublicProgress[0].totalFiles).toBe(0);
        const finalCheckpoint = checkpointedPublicProgress[checkpointedPublicProgress.length - 1];
        expect(finalCheckpoint.totalFiles).toBe(2);
        expect(finalCheckpoint.folders[0].totalFiles).toBe(2);
      });

      it('keeps the count of a folder the previous attempt fully fetched, which Phase 1 skips', async () => {
        const { mockConnector } = setupStandardMocks();
        const params = createMockParams({
          progress: progressCheckpointedByPreviousAttempt({
            folders: [previousAttemptFolderEntry({ id: 'dfld_123', name: 'Products', totalFiles: 40 })],
            jobProgress: {
              folderFetchStatus: { dfld_123: 'fetched' },
              folderCursors: { dfld_123: { page: 'last' } },
            },
          }),
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        expect(mockConnector.pullRecordFiles).not.toHaveBeenCalled();
        expect(pullSink.finishFolderAfterAllRecordPagesWritten).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ isResumingFromEarlierAttempt: true }),
        );
        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        const finalCheckpoint = checkpointedPublicProgress[checkpointedPublicProgress.length - 1];
        expect(finalCheckpoint.totalFiles).toBe(40);
        expect(finalCheckpoint.folders[0]).toMatchObject({ totalFiles: 40, status: 'completed' });
      });

      it('restores a folder Phase 2 already completed and adds the resumed folder on top of it', async () => {
        const productsFolder = createMockDataFolder({
          id: 'dfld_1' as DataFolderId,
          name: 'Products',
          path: '/Products',
        });
        const ordersFolder = createMockDataFolder({ id: 'dfld_2' as DataFolderId, name: 'Orders', path: '/Orders' });
        const { mockConnector } = setupStandardMocks();
        (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([
          { ...productsFolder, connectorAccount: { displayName: 'Test Connection' } },
          { ...ordersFolder, connectorAccount: { displayName: 'Test Connection' } },
        ]);
        (mockPrisma.dataFolder.findUnique as jest.Mock)
          .mockResolvedValueOnce(productsFolder)
          .mockResolvedValueOnce(ordersFolder);
        const params = createMockParams({
          data: {
            type: 'pull-linked-folder-files' as const,
            workbookId: 'wkb_123' as WorkbookId,
            dataFolderIds: ['dfld_1' as DataFolderId, 'dfld_2' as DataFolderId],
            userId: 'usr_123',
            organizationId: 'org_123',
          },
          progress: progressCheckpointedByPreviousAttempt({
            folders: [
              previousAttemptFolderEntry({
                id: 'dfld_1',
                name: 'Products',
                totalFiles: 10,
                creates: 3,
                updates: 1,
                status: 'completed',
                mode: 'full',
              }),
              previousAttemptFolderEntry({ id: 'dfld_2', name: 'Orders', totalFiles: 5 }),
            ],
            jobProgress: {
              completedFolderIds: ['dfld_1'],
              folderFetchStatus: { dfld_1: 'fetched', dfld_2: 'fetching' },
              folderCursors: { dfld_1: { page: 'last' }, dfld_2: { page: 'p2' } },
            },
          }),
        });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'ord6' }, { id: 'ord7' }, { id: 'ord8' }, { id: 'ord9' }],
            connectorProgress: { page: 'p3' },
          });
          return {};
        });
        const { pullSink } = createRecordingPullSink(true);
        (pullSink.finishFolderAfterAllRecordPagesWritten as jest.Mock).mockResolvedValue({
          created: 2,
          updated: 0,
          deleted: 0,
          createdPaths: ['Orders/ord8.json', 'Orders/ord9.json'],
          updatedPaths: [],
          deletedPaths: [],
        });

        await createHandlerWritingTo(pullSink).run(params);

        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(1);
        expect(pullSink.finishFolderAfterAllRecordPagesWritten).toHaveBeenCalledTimes(1);
        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        expect(checkpointedPublicProgress[0]).toMatchObject({ totalFiles: 15, createdCount: 3, updatedCount: 1 });
        const finalCheckpoint = checkpointedPublicProgress[checkpointedPublicProgress.length - 1];
        expect(finalCheckpoint).toMatchObject({ totalFiles: 19, createdCount: 5, updatedCount: 1, deletedCount: 0 });
        expect(finalCheckpoint.folders[0]).toMatchObject({
          id: 'dfld_1',
          totalFiles: 10,
          creates: 3,
          updates: 1,
          mode: 'full',
          status: 'completed',
        });
        expect(finalCheckpoint.folders[1]).toMatchObject({
          id: 'dfld_2',
          totalFiles: 9,
          creates: 2,
          status: 'completed',
        });
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          'usr_123',
          expect.objectContaining({ totalFilesPulled: 19, filesCreated: 5, filesUpdated: 1, filesDeleted: 0 }),
        );
      });

      it("keeps the previous attempt's degraded-record warnings when the fetch resumes from its saved cursor", async () => {
        const { mockConnector } = setupStandardMocks();
        const params = createMockParams({
          progress: progressCheckpointedByPreviousAttempt({
            folders: [
              previousAttemptFolderEntry({
                id: 'dfld_123',
                name: 'Products',
                totalFiles: 50,
                warningCount: 1,
                warnings: [{ remoteId: 'rec7', warning: 'Pulled rec7 without its history' }],
              }),
            ],
            jobProgress: {
              folderFetchStatus: { dfld_123: 'fetching' },
              folderCursors: { dfld_123: { page: 'p3' } },
            },
          }),
        });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec51' }],
            connectorProgress: { page: 'p4' },
            recordWarnings: [{ remoteId: 'rec51', warning: 'Pulled rec51 without its history' }],
          });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        expect(checkpointedPublicProgress[0].folders[0]).toMatchObject({ warningCount: 1 });
        const finalCheckpoint = checkpointedPublicProgress[checkpointedPublicProgress.length - 1];
        expect(finalCheckpoint.folders[0]).toMatchObject({
          warningCount: 2,
          warnings: [
            { remoteId: 'rec7', warning: 'Pulled rec7 without its history' },
            { remoteId: 'rec51', warning: 'Pulled rec51 without its history' },
          ],
        });
      });

      it("drops the previous attempt's warnings when the fetch restarts from the first page, which raises them again", async () => {
        const { mockConnector } = setupStandardMocks();
        const params = createMockParams({
          progress: progressCheckpointedByPreviousAttempt({
            folders: [
              previousAttemptFolderEntry({
                id: 'dfld_123',
                name: 'Products',
                totalFiles: 50,
                warningCount: 1,
                warnings: [{ remoteId: 'rec7', warning: 'Pulled rec7 without its history' }],
              }),
            ],
            jobProgress: { folderFetchStatus: { dfld_123: 'fetching' }, folderCursors: { dfld_123: {} } },
          }),
        });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec7' }],
            connectorProgress: {},
            recordWarnings: [{ remoteId: 'rec7', warning: 'Pulled rec7 without its history' }],
          });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        expect(checkpointedPublicProgress[0].folders[0].warningCount).toBeUndefined();
        const finalCheckpoint = checkpointedPublicProgress[checkpointedPublicProgress.length - 1];
        expect(finalCheckpoint.folders[0]).toMatchObject({
          warningCount: 1,
          warnings: [{ remoteId: 'rec7', warning: 'Pulled rec7 without its history' }],
        });
      });

      it('starts every count at zero on a first attempt, where BullMQ hands the job 0 instead of a progress object', async () => {
        const { mockConnector } = setupStandardMocks();
        const params = createMockParams({ progress: 0 });
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({
            files: [{ id: 'rec1' }, { id: 'rec2' }, { id: 'rec3' }],
            connectorProgress: { page: 'p2' },
          });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        expect(checkpointedPublicProgress[0].totalFiles).toBe(0);
        const finalCheckpoint = checkpointedPublicProgress[checkpointedPublicProgress.length - 1];
        expect(finalCheckpoint.totalFiles).toBe(3);
        expect(finalCheckpoint.folders[0].totalFiles).toBe(3);
      });

      it("counts each folder's fetched records page by page, so a checkpoint mid-fetch carries them", async () => {
        const { mockConnector, params } = setupStandardMocks();
        let folderFetchedCountCheckpointedAfterFirstPage: number | undefined;
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          await callback({ files: [{ id: 'rec1' }, { id: 'rec2' }], connectorProgress: { page: 'p2' } });
          const checkpointedSoFar = checkpointedPublicProgressList(params.checkpoint);
          folderFetchedCountCheckpointedAfterFirstPage =
            checkpointedSoFar[checkpointedSoFar.length - 1].folders[0].totalFiles;
          await callback({ files: [{ id: 'rec3' }], connectorProgress: { page: 'p3' } });
          return {};
        });
        const { pullSink } = createRecordingPullSink(false);

        await createHandlerWritingTo(pullSink).run(params);

        expect(folderFetchedCountCheckpointedAfterFirstPage).toBe(2);
        const checkpointedPublicProgress = checkpointedPublicProgressList(params.checkpoint);
        for (const checkpointed of checkpointedPublicProgress) {
          const folderFetchedCountSum = checkpointed.folders.reduce((sum, folder) => sum + folder.totalFiles, 0);
          expect(checkpointed.totalFiles).toBe(folderFetchedCountSum);
        }
        expect(checkpointedPublicProgress[checkpointedPublicProgress.length - 1].folders[0].totalFiles).toBe(3);
      });
    });

    // DEV-12926: one dropped connection 80,200 records into a HubSpot pull failed a Live Export run. A transient
    // failure now retries the fetch from the folder's last checkpointed cursor instead of failing the folder.
    describe('retrying a folder fetch after a transient failure', () => {
      type FinalPublicProgress = {
        totalFiles: number;
        folders: PullFolderProgress[];
        folderErrors?: Record<string, { message: string }>;
      };

      const finalCheckpointedPublicProgress = (checkpoint: jest.Mock): FinalPublicProgress => {
        const checkpointCalls = checkpoint.mock.calls as Array<[{ publicProgress: FinalPublicProgress }]>;
        return checkpointCalls[checkpointCalls.length - 1][0].publicProgress;
      };

      /** What HubSpot's client threw in the failed run: a socket reset, with no HTTP response. */
      const droppedConnection = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

      /** The cursor each connector call was asked to resume from. */
      const connectorCursorsFetchedFrom = (mockConnector: ReturnType<typeof createMockConnector>) =>
        (mockConnector.pullRecordFiles.mock.calls as Array<unknown[]>).map((connectorCall) => connectorCall[2]);

      /** Runs the job to the end, letting every wait before a retry elapse. */
      const runLettingRetryWaitsElapse = async (runningJob: Promise<void>) => {
        const jobOutcome = runningJob.then(
          () => undefined,
          (error: unknown) => error,
        );
        await jest.runAllTimersAsync();
        return jobOutcome;
      };

      let warnSpy: jest.SpyInstance;

      beforeEach(() => {
        jest.useFakeTimers();
        warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
        jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('resumes from the last checkpointed cursor after a dropped connection, writing and counting every record once', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.pullRecordFiles
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec1' }, { id: 'rec2' }], connectorProgress: { page: 'p2' } });
            throw droppedConnection();
          })
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec3' }], connectorProgress: { page: 'p3' } });
            return {};
          });
        const { pullSink, pagesWritten } = createRecordingPullSink(false);

        const jobError = await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(jobError).toBeUndefined();
        expect(connectorCursorsFetchedFrom(mockConnector)).toEqual([{}, { page: 'p2' }]);
        expect(pagesWritten).toEqual([[{ id: 'rec1' }, { id: 'rec2' }], [{ id: 'rec3' }]]);
        // One continuous fetch to the sink: prepared and released once, and finished as a complete pull.
        expect(pullSink.prepareFolderForIncomingRecordPages).toHaveBeenCalledTimes(1);
        expect(pullSink.releaseRecordPageWritingStateForFolder).toHaveBeenCalledTimes(1);
        expect(pullSink.finishFolderAfterAllRecordPagesWritten).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ isResumingFromEarlierAttempt: false }),
        );
        const finalProgress = finalCheckpointedPublicProgress(params.checkpoint);
        expect(finalProgress.totalFiles).toBe(3);
        expect(finalProgress.folders[0]).toMatchObject({ status: 'completed', totalFiles: 3 });
        expect(finalProgress.folderErrors).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Folder fetch failed transiently — retrying from its last checkpointed cursor',
            dataFolderId: 'dfld_123',
            retryNumberOfThisFolderFetch: 1,
            retryDelayMs: 10_000,
            resumesFromCheckpointedCursor: true,
          }),
        );
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          'usr_123',
          expect.objectContaining({ result: 'success', totalFilesPulled: 3 }),
        );
      });

      it('retries a 503 from the service', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.pullRecordFiles
          .mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { statusCode: 503 }))
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec1' }], connectorProgress: { page: 'p2' } });
            return {};
          });
        const { pullSink } = createRecordingPullSink(false);

        await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(2);
        expect(finalCheckpointedPublicProgress(params.checkpoint).folders[0]).toMatchObject({
          status: 'completed',
          totalFiles: 1,
        });
      });

      it('starts over from the first page when the connector checkpoints no cursor, counting the records it fetches again once', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.pullRecordFiles
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec1' }, { id: 'rec2' }], connectorProgress: {} });
            throw droppedConnection();
          })
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec1' }, { id: 'rec2' }], connectorProgress: {} });
            await callback({ files: [{ id: 'rec3' }], connectorProgress: {} });
            return {};
          });
        const { pullSink } = createRecordingPullSink(false);

        await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(connectorCursorsFetchedFrom(mockConnector)).toEqual([{}, {}]);
        const finalProgress = finalCheckpointedPublicProgress(params.checkpoint);
        expect(finalProgress.totalFiles).toBe(3);
        expect(finalProgress.folders[0]).toMatchObject({ status: 'completed', totalFiles: 3 });
      });

      it('reads a cursor whose only key is undefined as no cursor, as a worker restart would', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.pullRecordFiles
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            // HubSpot hands back `{ afterCursor: undefined }` where it can't be resumed from; stored as JSON it is `{}`.
            await callback({ files: [{ id: 'rec1' }], connectorProgress: { afterCursor: undefined } });
            throw droppedConnection();
          })
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec1' }], connectorProgress: { afterCursor: undefined } });
            return {};
          });
        const { pullSink } = createRecordingPullSink(false);

        await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(connectorCursorsFetchedFrom(mockConnector)).toEqual([{}, {}]);
        expect(finalCheckpointedPublicProgress(params.checkpoint).folders[0].totalFiles).toBe(1);
      });

      it('rewinds the degraded-record warnings of the pages it fetches again', async () => {
        const { mockConnector, params } = setupStandardMocks();
        const recordWarningFor = (remoteId: string): PulledRecordWarning => ({
          remoteId,
          warning: `Pulled ${remoteId} without its history`,
        });
        mockConnector.pullRecordFiles
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({
              files: [{ id: 'rec1' }],
              connectorProgress: { page: 'p2' },
              recordWarnings: [recordWarningFor('rec1')],
            });
            // A page whose cursor the connector doesn't report: the retry fetches it again.
            await callback({ files: [{ id: 'rec2' }], recordWarnings: [recordWarningFor('rec2')] });
            throw droppedConnection();
          })
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({
              files: [{ id: 'rec2' }],
              connectorProgress: { page: 'p3' },
              recordWarnings: [recordWarningFor('rec2')],
            });
            return {};
          });
        const { pullSink } = createRecordingPullSink(false);

        await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(connectorCursorsFetchedFrom(mockConnector)).toEqual([{}, { page: 'p2' }]);
        expect(finalCheckpointedPublicProgress(params.checkpoint).folders[0]).toMatchObject({
          status: 'completed',
          totalFiles: 2,
          warningCount: 2,
          warnings: [recordWarningFor('rec1'), recordWarningFor('rec2')],
        });
      });

      it('fails the folder at once when the service rejects the request rather than failing to answer it', async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.pullRecordFiles.mockRejectedValue(Object.assign(new Error('Not Found'), { statusCode: 404 }));
        const { pullSink } = createRecordingPullSink(false);

        await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining('retrying') as unknown }),
        );
        expect(finalCheckpointedPublicProgress(params.checkpoint).folders[0].status).toBe('failed');
      });

      it("gives up after three retries that get no further, failing the folder with the connector's error", async () => {
        const { mockConnector, params } = setupStandardMocks();
        mockConnector.pullRecordFiles.mockRejectedValue(droppedConnection());
        const { pullSink } = createRecordingPullSink(false);

        const jobOutcome = createHandlerWritingTo(pullSink)
          .run(params)
          .then(
            () => undefined,
            (error: unknown) => error,
          );

        // Waits 10s, 30s, then 60s before the three retries.
        await jest.advanceTimersByTimeAsync(9_999);
        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(3);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(4);
        await jest.runAllTimersAsync();

        expect(await jobOutcome).toBeUndefined();
        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(4);
        const finalProgress = finalCheckpointedPublicProgress(params.checkpoint);
        expect(finalProgress.folders[0].status).toBe('failed');
        expect(finalProgress.folderErrors?.dfld_123?.message).toBe('An error occurred');
        expect(mockPostHogService.trackPullCompleted).toHaveBeenCalledWith(
          'usr_123',
          expect.objectContaining({ result: 'failure' }),
        );
      });

      it('starts the retry budget over each time a retry gets further, so a long fetch survives several separate blips', async () => {
        const { mockConnector, params } = setupStandardMocks();
        const pageNumbersThatFailAfterBeingWritten = [1, 2, 3, 4];
        let nextPageNumber = 1;
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          for (;;) {
            const pageNumber = nextPageNumber++;
            await callback({ files: [{ id: `rec${pageNumber}` }], connectorProgress: { page: `p${pageNumber + 1}` } });
            if (pageNumbersThatFailAfterBeingWritten.includes(pageNumber)) {
              throw droppedConnection();
            }
            if (pageNumber === 5) {
              return {};
            }
          }
        });
        const { pullSink } = createRecordingPullSink(false);

        await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(5);
        expect(finalCheckpointedPublicProgress(params.checkpoint).folders[0]).toMatchObject({
          status: 'completed',
          totalFiles: 5,
        });
      });

      it('stops after ten retries in all, even when every retry gets further', async () => {
        const { mockConnector, params } = setupStandardMocks();
        let nextPageNumber = 1;
        mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
          const pageNumber = nextPageNumber++;
          await callback({ files: [{ id: `rec${pageNumber}` }], connectorProgress: { page: `p${pageNumber + 1}` } });
          throw droppedConnection();
        });
        const { pullSink } = createRecordingPullSink(false);

        await runLettingRetryWaitsElapse(createHandlerWritingTo(pullSink).run(params));

        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(11);
        expect(finalCheckpointedPublicProgress(params.checkpoint).folders[0].status).toBe('failed');
      });

      it('cancels the job, without retrying, when the job is canceled during the wait before a retry', async () => {
        const { mockConnector, params } = setupStandardMocks();
        const abortController = new AbortController();
        params.abortSignal = abortController.signal;
        mockConnector.pullRecordFiles.mockRejectedValue(droppedConnection());
        const { pullSink } = createRecordingPullSink(false);

        const jobOutcome = createHandlerWritingTo(pullSink)
          .run(params)
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await jest.advanceTimersByTimeAsync(1_000);
        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(1);

        abortController.abort();

        expect(await jobOutcome).toBeInstanceOf(JobCanceledError);
        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(1);
        expect(pullSink.cleanUpTemporaryStorageAfterPullAttempt).toHaveBeenCalledTimes(1);
      });

      it("stores the job's start as the incremental watermark, not the resumed call's, when a retry resumed from a cursor", async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.supportsIncrementalPull.mockReturnValue(true);
        const jobStartedAtMs = Date.now();
        mockConnector.pullRecordFiles
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec1', slug: 'first' }], connectorProgress: { page: 'p2' } });
            throw droppedConnection();
          })
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            // Like most connectors, this one stamps its watermark when the call starts: after the retry's wait, and
            // after page 1 was read by the call that failed.
            const watermarkStampedAtCallStart = new Date();
            await callback({ files: [{ id: 'rec2', slug: 'second' }], connectorProgress: { page: 'p3' } });
            return { newWatermark: watermarkStampedAtCallStart };
          });
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
          created: [],
          updated: [],
          unchanged: [],
        });

        await runLettingRetryWaitsElapse(handler.run({ ...params, data: { ...params.data, pullMode: 'incremental' } }));

        const folderUpdates = (mockPrisma.dataFolder.update as jest.Mock).mock.calls as Array<
          [{ data: { lastIncrementalPullAt?: Date } }]
        >;
        const watermarkUpdate = folderUpdates.find(([update]) => update.data.lastIncrementalPullAt instanceof Date);
        expect(watermarkUpdate?.[0].data.lastIncrementalPullAt?.getTime()).toBe(jobStartedAtMs);
      });

      it('keeps the records fetched before the failure out of stale-file deletion in the classic git store', async () => {
        const { dataFolder, mockConnector, params } = setupStandardMocks();
        Object.assign(dataFolder, {
          lastFullPullAt: new Date('2026-04-15T00:00:00.000Z'),
          lastIncrementalPullAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        mockConnector.pullRecordFiles
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec1', slug: 'first' }], connectorProgress: { page: 'p2' } });
            throw droppedConnection();
          })
          .mockImplementationOnce(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
            await callback({ files: [{ id: 'rec2', slug: 'second' }], connectorProgress: { page: 'p3' } });
            return {};
          });
        (mockScratchGitService.readStagedFiles as jest.Mock).mockResolvedValue({ files: [], remaining: 0 });
        (mockScratchGitService.commitStagedFiles as jest.Mock).mockResolvedValue({
          committed: 0,
          remaining: 0,
          created: [],
          updated: [],
          unchanged: [],
        });
        (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
          { name: 'first.json', path: 'Products/first.json', type: 'file' },
          { name: 'second.json', path: 'Products/second.json', type: 'file' },
          { name: 'stale.json', path: 'Products/stale.json', type: 'file' },
        ]);

        await runLettingRetryWaitsElapse(handler.run({ ...params, data: { ...params.data, pullMode: 'full' } }));

        expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(2);
        expect(mockScratchGitService.deleteFilesFromBranch).toHaveBeenCalledTimes(1);
        const deleteCalls = (mockScratchGitService.deleteFilesFromBranch as jest.Mock).mock.calls as Array<
          [string, string, string[], string]
        >;
        expect(deleteCalls[0][2]).toEqual(['Products/stale.json']);
      });
    });
  });
});
