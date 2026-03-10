/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec } from '../../../remote-service/connectors/types';
import { DataFolderPublishingService } from '../../../workbook/data-folder-publishing.service';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { PublishDataFolderJobHandler } from './publish-data-folder.job';

describe('PublishDataFolderJobHandler', () => {
  let handler: PublishDataFolderJobHandler;
  let mockPrisma: jest.Mocked<PrismaClient>;
  let mockConnectorService: jest.Mocked<ConnectorsService>;
  let mockConnectorAccountService: jest.Mocked<ConnectorAccountService>;
  let mockWorkbookEventService: jest.Mocked<WorkbookEventService>;
  let mockDataFolderPublishingService: jest.Mocked<DataFolderPublishingService>;
  let mockBullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let mockScratchGitService: jest.Mocked<ScratchGitService>;

  const WORKBOOK_ID = 'wkb_123' as WorkbookId;

  const defaultTableSpec: BaseJsonTableSpec = {
    idColumnRemoteId: 'id',
    slugColumnRemoteId: 'slug',
    titleColumnRemoteId: ['title'],
    id: { remoteId: ['tbl_abc'], wsId: 'tbl_abc' },
    slug: 'example',
    name: 'Example',
    schema: Type.Object({}),
  };

  const createMockDataFolder = (overrides?: any) => ({
    id: 'dfld_001' as DataFolderId,
    workbookId: WORKBOOK_ID,
    name: 'Folder 1',
    path: '/folder-1',
    connectorService: 'airtable',
    connectorAccountId: 'coa_123',
    connectorAccount: { displayName: 'Test Connection' },
    tableId: ['tbl_abc'],
    filter: null,
    options: null,
    ...overrides,
  });

  const createMockParams = (dataFolderIds: DataFolderId[], overrides?: any) => ({
    jobId: 'test-job-id',
    data: {
      workbookId: WORKBOOK_ID,
      dataFolderIds,
      userId: 'usr_123',
      organizationId: 'org_123',
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
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      workbook: {
        findUnique: jest.fn().mockResolvedValue({ id: WORKBOOK_ID }),
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

    mockDataFolderPublishingService = {
      publishAll: jest.fn(),
    } as unknown as jest.Mocked<DataFolderPublishingService>;

    mockBullEnqueuerService = {
      enqueuePullLinkedFolderFilesJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    mockScratchGitService = {
      resolveRepoId: jest.fn().mockResolvedValue(WORKBOOK_ID),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<ScratchGitService>;

    handler = new PublishDataFolderJobHandler(
      mockPrisma,
      mockConnectorService,
      mockConnectorAccountService,
      mockWorkbookEventService,
      mockDataFolderPublishingService,
      mockBullEnqueuerService,
      mockScratchGitService,
      { trackPublishCompleted: jest.fn() } as any,
    );
  });

  describe('null-schema guard', () => {
    it('should mark folder as failed when schema is not found in git', async () => {
      const folder = createMockDataFolder();
      (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([folder]);
      (mockScratchGitService.readSchemaFromGit as jest.Mock).mockResolvedValue(null);

      const params = createMockParams([folder.id]);
      await handler.run(params);

      // Find the last checkpoint call to inspect final folder state
      const checkpointCalls = params.checkpoint.mock.calls;
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];
      expect(lastCheckpoint.publicProgress.folders[0].status).toBe('failed');
    });

    it('should continue processing remaining folders when one has no schema', async () => {
      const folderNoSchema = createMockDataFolder({ id: 'dfld_001' as DataFolderId, name: 'No Schema' });
      const folderWithSchema = createMockDataFolder({ id: 'dfld_002' as DataFolderId, name: 'Has Schema' });

      (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([folderNoSchema, folderWithSchema]);

      // First folder: no schema; second folder: valid schema
      (mockScratchGitService.readSchemaFromGit as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(defaultTableSpec);

      const mockConnector = {
        extractConnectorErrorDetails: jest.fn().mockReturnValue({
          userFriendlyMessage: 'An error occurred',
          description: 'Test error',
        }),
      };
      const connectorAccount = { id: 'coa_123', service: 'airtable', credentials: {} };
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);
      (mockDataFolderPublishingService.publishAll as jest.Mock).mockResolvedValue({
        createdPaths: [],
        updatedPaths: [],
        deletedPaths: [],
      });
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(folderWithSchema);

      const params = createMockParams([folderNoSchema.id, folderWithSchema.id]);
      await handler.run(params);

      const checkpointCalls = params.checkpoint.mock.calls;
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];
      expect(lastCheckpoint.publicProgress.folders[0].status).toBe('failed');
      expect(lastCheckpoint.publicProgress.folders[1].status).toBe('completed');
    });
  });
});
