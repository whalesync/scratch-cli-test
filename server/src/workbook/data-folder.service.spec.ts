/* eslint-disable @typescript-eslint/unbound-method */
import type { TSchema } from '@sinclair/typebox';
import type { DataFolderId, WorkbookId, WorkspacePermissionId } from '@spinner/shared-types';
import type { AuditLogService } from 'src/audit/audit-log.service';
import type { ScratchConfigService } from 'src/config/scratch-config.service';
import type { DbService } from 'src/db/db.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import type { FileIndexService } from 'src/publish-plan/file-index.service';
import type { FileReferenceService } from 'src/publish-plan/file-reference.service';
import type { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import type { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor, WorkspacePermissionRole } from 'src/users/types';
import type { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import type { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, dotPath } from '../remote-service/connectors/types';
import { DataFolderService } from './data-folder.service';
import type { FilesService } from './files.service';
import type { WorkbookEventService } from './workbook-event.service';
import type { WorkbookService } from './workbook.service';

describe('DataFolderService.buildConnectorFolderPath', () => {
  let service: DataFolderService;

  beforeEach(() => {
    // buildConnectorFolderPath is a pure function that doesn't use any injected dependencies
    service = Object.create(DataFolderService.prototype) as DataFolderService;
  });

  const makeTableSpec = (overrides: Partial<BaseJsonTableSpec> = {}): BaseJsonTableSpec => ({
    id: { wsId: 'table-1', remoteId: ['table-1'] },
    slug: 'table-slug',
    name: 'My Table',
    schema: {} as TSchema,
    idPath: dotPath('id'),
    ...overrides,
  });

  it('should build path from table name (no connection prefix)', () => {
    const result = service.buildConnectorFolderPath('My Airtable', makeTableSpec({ name: 'Products' }));
    expect(result).toBe('/Products');
  });

  it('should include basePath segments before table name', () => {
    const result = service.buildConnectorFolderPath(
      'My Airtable',
      makeTableSpec({ name: 'Products', basePath: ['Base One'] }),
    );
    expect(result).toBe('/Base One/Products');
  });

  it('should include multiple basePath segments', () => {
    const result = service.buildConnectorFolderPath(
      'Webflow',
      makeTableSpec({ name: 'Blog Posts', basePath: ['My Site', 'CMS'] }),
    );
    expect(result).toBe('/My Site/CMS/Blog Posts');
  });

  it('should prepend parentFolderPath when provided', () => {
    const result = service.buildConnectorFolderPath('My Airtable', makeTableSpec({ name: 'Products' }), '/Parent');
    expect(result).toBe('/Parent/Products');
  });

  it('should handle parentFolderPath with basePath', () => {
    const result = service.buildConnectorFolderPath(
      'My Airtable',
      makeTableSpec({ name: 'Products', basePath: ['Base One'] }),
      '/Parent/Sub',
    );
    expect(result).toBe('/Parent/Sub/Base One/Products');
  });

  it('should replace slashes with spaces in table name', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Products/Items' }));
    expect(result).toBe('/Products Items');
  });

  it('should replace slashes with spaces in basePath segments', () => {
    const result = service.buildConnectorFolderPath(
      'Airtable',
      makeTableSpec({ name: 'Table', basePath: ['Base/One'] }),
    );
    expect(result).toBe('/Base One/Table');
  });

  it('should replace asterisks and question marks with spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'What*is*this?' }));
    expect(result).toBe('/What is this');
  });

  it('should replace double quotes with spaces and collapse consecutive spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'The "Best" Table' }));
    expect(result).toBe('/The Best Table');
  });

  it('should replace angle brackets and pipes with spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: '<Input|Output>' }));
    expect(result).toBe('/Input Output');
  });

  it('should convert tabs to spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Tab\there' }));
    expect(result).toBe('/Tab here');
  });

  it('should collapse multiple consecutive spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Too   many    spaces' }));
    expect(result).toBe('/Too many spaces');
  });

  it('should trim leading and trailing whitespace from segments', () => {
    const result = service.buildConnectorFolderPath('  Airtable  ', makeTableSpec({ name: '  Products  ' }));
    expect(result).toBe('/Products');
  });

  it('should trim trailing dots but preserve leading dots', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: '..hidden.' }));
    expect(result).toBe('/..hidden');
  });

  it('should filter out falsy basePath entries', () => {
    const result = service.buildConnectorFolderPath(
      'Airtable',
      makeTableSpec({ name: 'Table', basePath: ['Base', '', 'Sub'] }),
    );
    expect(result).toBe('/Base/Sub/Table');
  });

  it('should handle empty basePath array', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Table', basePath: [] }));
    expect(result).toBe('/Table');
  });

  it('should handle undefined basePath', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Table', basePath: undefined }));
    expect(result).toBe('/Table');
  });
});

type EnsureUniquePathFn = (
  workbookId: WorkbookId,
  connectorAccountId: string,
  path: string,
  dataFolderId: DataFolderId,
) => Promise<string>;

describe('DataFolderService.ensureUniquePath', () => {
  const WORKBOOK_ID = 'wkb_test' as WorkbookId;
  const CONNECTOR_A = 'coa_airtable';
  const CONNECTOR_B = 'coa_webflow';
  const PATH_PAGES = '/Pages';
  const NEW_FOLDER_ID = 'df_abcdefghijklmnopqrstuvwxyz' as DataFolderId;

  let service: DataFolderService;
  let mockDb: jest.Mocked<DbService>;

  beforeEach(() => {
    mockDb = {
      client: {
        dataFolder: {
          findFirst: jest.fn(),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    const stub = {} as unknown;
    service = new DataFolderService(
      stub as WorkbookService,
      mockDb,
      stub as ConnectorAccountService,
      stub as ConnectorsService,
      stub as ScratchConfigService,
      stub as BullEnqueuerService,
      stub as AuditLogService,
      stub as PostHogService,
      stub as ScratchGitService,
      stub as FilesService,
      stub as WorkbookEventService,
      stub as FileIndexService,
      stub as FileReferenceService,
    );
  });

  const callEnsureUniquePath = (args: {
    workbookId?: WorkbookId;
    connectorAccountId?: string;
    path?: string;
    dataFolderId?: DataFolderId;
  }) => {
    const fn = (service as unknown as { ensureUniquePath: EnsureUniquePathFn }).ensureUniquePath.bind(service);
    return fn(
      args.workbookId ?? WORKBOOK_ID,
      args.connectorAccountId ?? CONNECTOR_A,
      args.path ?? PATH_PAGES,
      args.dataFolderId ?? NEW_FOLDER_ID,
    );
  };

  it('returns the path unchanged when no folder exists for the same workbook, connector, and path', async () => {
    (mockDb.client.dataFolder.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await callEnsureUniquePath({});

    expect(result).toBe(PATH_PAGES);
    expect(mockDb.client.dataFolder.findFirst).toHaveBeenCalledWith({
      where: { workbookId: WORKBOOK_ID, connectorAccountId: CONNECTOR_A, path: PATH_PAGES },
      select: { id: true },
    });
  });

  it('appends a suffix when the path is already taken for the same workbook and connector', async () => {
    (mockDb.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({ id: 'df_existing' });

    const result = await callEnsureUniquePath({});

    expect(result).toBe(`${PATH_PAGES}-vwxyz`);
    expect(mockDb.client.dataFolder.findFirst).toHaveBeenCalledWith({
      where: { workbookId: WORKBOOK_ID, connectorAccountId: CONNECTOR_A, path: PATH_PAGES },
      select: { id: true },
    });
  });

  it('scopes the lookup to connectorAccountId so another connector does not force a suffix', async () => {
    (mockDb.client.dataFolder.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await callEnsureUniquePath({ connectorAccountId: CONNECTOR_B });

    expect(result).toBe(PATH_PAGES);
    expect(mockDb.client.dataFolder.findFirst).toHaveBeenCalledWith({
      where: { workbookId: WORKBOOK_ID, connectorAccountId: CONNECTOR_B, path: PATH_PAGES },
      select: { id: true },
    });
  });
});

describe('DataFolderService dotfile filtering', () => {
  const WORKBOOK_ID = 'wkb_test' as WorkbookId;
  const FOLDER_ID = 'df_test' as DataFolderId;
  const ACTOR: Actor = { userId: 'usr_test', organizationId: 'org_test', authSource: 'user' };

  let service: DataFolderService;
  let mockDb: jest.Mocked<DbService>;
  let mockScratchGitService: jest.Mocked<ScratchGitService>;

  beforeEach(() => {
    const now = new Date();
    mockDb = {
      client: {
        dataFolder: {
          findUnique: jest.fn().mockResolvedValue({
            id: FOLDER_ID,
            path: '/my-folder',
            workbookId: WORKBOOK_ID,
            name: 'my-folder',
            connectorAccountId: null,
            connectorAccount: null,
            connectorService: null,
            schema: null,
            filter: null,
            lock: null,
            version: 1,
            tableId: [],
            options: null,
            createdAt: now,
            updatedAt: now,
          }),
        },
        workbook: {
          findFirst: jest.fn().mockResolvedValue({ id: WORKBOOK_ID, organizationId: 'org_test' }),
        },
        schedule: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    mockScratchGitService = {
      getRepoFilesPaginated: jest.fn(),
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('resolved-repo-id'),
      resolveRepoPathForFolder: jest.fn().mockResolvedValue('resolved-repo-id'),
    } as unknown as jest.Mocked<ScratchGitService>;

    // Create service with only the dependencies these methods use
    const stub = {} as unknown;
    service = new DataFolderService(
      {
        findOne: jest.fn().mockResolvedValue({ id: WORKBOOK_ID }),
        assertReadableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID }),
        assertWritableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID }),
      } as unknown as WorkbookService,
      mockDb,
      stub as ConnectorAccountService,
      stub as ConnectorsService,
      stub as ScratchConfigService,
      stub as BullEnqueuerService,
      stub as AuditLogService,
      stub as PostHogService,
      mockScratchGitService,
      stub as FilesService,
      stub as WorkbookEventService,
      stub as FileIndexService,
      stub as FileReferenceService,
    );
  });

  describe('getAllFileContentsByFolderId', () => {
    it('should exclude dotfiles like .schema.json', async () => {
      mockScratchGitService.getRepoFilesPaginated.mockResolvedValue({
        files: [
          { name: 'record-1.json', content: '{"id":"1"}' },
          { name: '.schema.json', content: '{"type":"object"}' },
          { name: 'record-2.json', content: '{"id":"2"}' },
        ],
        nextCursor: undefined,
      });

      const result = await service.getAllFileContentsByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR);

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.path)).toEqual(['my-folder/record-1.json', 'my-folder/record-2.json']);
    });

    it('should exclude all dotfiles, not just .schema.json', async () => {
      mockScratchGitService.getRepoFilesPaginated.mockResolvedValue({
        files: [
          { name: 'record-1.json', content: '{"id":"1"}' },
          { name: '.hidden-config', content: '{}' },
          { name: '.gitkeep', content: '' },
        ],
        nextCursor: undefined,
      });

      const result = await service.getAllFileContentsByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('my-folder/record-1.json');
    });
  });

  describe('getFileContentsByFolderIdPaginated', () => {
    it('should exclude dotfiles like .schema.json', async () => {
      mockScratchGitService.getRepoFilesPaginated.mockResolvedValue({
        files: [
          { name: 'record-1.json', content: '{"id":"1"}' },
          { name: '.schema.json', content: '{"type":"object"}' },
          { name: 'record-2.json', content: '{"id":"2"}' },
        ],
        nextCursor: 'cursor-abc',
      });

      const result = await service.getFileContentsByFolderIdPaginated(WORKBOOK_ID, FOLDER_ID, ACTOR);

      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.path)).toEqual(['my-folder/record-1.json', 'my-folder/record-2.json']);
      expect(result.nextCursor).toBe('cursor-abc');
    });
  });
});

/* eslint-disable @typescript-eslint/unbound-method */
describe('DataFolderService.deleteFolder', () => {
  const WORKBOOK_ID = 'wkb_test' as WorkbookId;
  const FOLDER_ID = 'dfd_test' as DataFolderId;
  const ORG_ID = 'org_test';
  const CONNECTOR_ACCOUNT_ID = 'coa_test';
  const RESOLVED_REPO_ID = 'org_test/wkb_test/coa_test';
  const ACTOR: Actor = {
    userId: 'usr_test',
    organizationId: ORG_ID,
    workspacePermissions: [
      { id: 'perm_test' as WorkspacePermissionId, workbookId: WORKBOOK_ID, role: 'editor' as WorkspacePermissionRole },
    ],
  };

  let service: DataFolderService;
  let mockDb: jest.Mocked<DbService>;
  let mockScratchGitService: jest.Mocked<ScratchGitService>;
  let mockWorkbookService: jest.Mocked<WorkbookService>;
  let mockWorkbookEventService: jest.Mocked<WorkbookEventService>;
  let mockPosthogService: jest.Mocked<PostHogService>;
  let mockAuditLogService: jest.Mocked<AuditLogService>;
  let mockFileIndexService: jest.Mocked<FileIndexService>;
  let mockFileReferenceService: jest.Mocked<FileReferenceService>;

  const now = new Date();

  const makeDataFolder = (overrides: Record<string, unknown> = {}) => ({
    id: FOLDER_ID,
    path: '/Companies',
    workbookId: WORKBOOK_ID,
    name: 'Companies',
    connectorAccountId: CONNECTOR_ACCOUNT_ID,
    connectorAccount: null,
    connectorService: null,
    schema: null,
    filter: null,
    lock: null,
    version: 1,
    tableId: [],
    options: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  beforeEach(() => {
    mockDb = {
      client: {
        dataFolder: {
          findUnique: jest.fn().mockResolvedValue(makeDataFolder()),
          delete: jest.fn().mockResolvedValue(undefined),
        },
        schedule: {
          deleteMany: jest.fn().mockResolvedValue(undefined),
        },
        syncMatchKeys: {
          deleteMany: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    mockScratchGitService = {
      removeDataFolder: jest.fn().mockResolvedValue(undefined),
      resolveConnectionRepoPath: jest.fn().mockResolvedValue(RESOLVED_REPO_ID),
      resolveRepoPathForFolder: jest.fn().mockResolvedValue(RESOLVED_REPO_ID),
    } as unknown as jest.Mocked<ScratchGitService>;

    mockWorkbookService = {
      findOne: jest.fn().mockResolvedValue({ id: WORKBOOK_ID, name: 'Test Workbook', organizationId: ORG_ID }),
      assertReadableWorkbook: jest
        .fn()
        .mockResolvedValue({ id: WORKBOOK_ID, name: 'Test Workbook', organizationId: ORG_ID }),
      assertWritableWorkbook: jest
        .fn()
        .mockResolvedValue({ id: WORKBOOK_ID, name: 'Test Workbook', organizationId: ORG_ID }),
    } as unknown as jest.Mocked<WorkbookService>;

    mockWorkbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    mockPosthogService = {
      trackRemoveDataFolder: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    mockAuditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    mockFileIndexService = {
      removeAll: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileIndexService>;

    mockFileReferenceService = {
      deleteForFolder: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileReferenceService>;

    const stub = {} as unknown;
    service = new DataFolderService(
      mockWorkbookService,
      mockDb,
      stub as ConnectorAccountService,
      stub as ConnectorsService,
      stub as ScratchConfigService,
      stub as BullEnqueuerService,
      mockAuditLogService,
      mockPosthogService,
      mockScratchGitService,
      stub as FilesService,
      mockWorkbookEventService,
      mockFileIndexService,
      mockFileReferenceService,
    );
  });

  it('should resolve the connector repo when folder has connectorAccountId', async () => {
    await service.deleteFolder(FOLDER_ID, ACTOR);

    // Folder-aware resolution (connector account + workbook) → connector repo.
    expect(mockScratchGitService.resolveRepoPathForFolder).toHaveBeenCalledWith(CONNECTOR_ACCOUNT_ID, WORKBOOK_ID);
    expect(mockScratchGitService.removeDataFolder).toHaveBeenCalledWith(RESOLVED_REPO_ID, '/Companies');
  });

  it('should resolve the scratch repo when folder has no connectorAccountId (DEV-10424)', async () => {
    (mockDb.client.dataFolder.findUnique as jest.Mock).mockResolvedValue(makeDataFolder({ connectorAccountId: null }));

    await service.deleteFolder(FOLDER_ID, ACTOR);

    // Previously this fell back to the bare workbookId (the deleteFolder:522 bug); now it resolves the
    // per-workbook scratch repo and removes the folder from the correct repo.
    expect(mockScratchGitService.resolveRepoPathForFolder).toHaveBeenCalledWith(null, WORKBOOK_ID);
    expect(mockScratchGitService.removeDataFolder).toHaveBeenCalledWith(RESOLVED_REPO_ID, '/Companies');
  });

  it('should gracefully handle ScratchGitNotFoundError (folder never pulled)', async () => {
    (mockScratchGitService.removeDataFolder as jest.Mock).mockRejectedValue(
      new ScratchGitNotFoundError('/api/repo/write/test/data-folder', 'File not found'),
    );

    await service.deleteFolder(FOLDER_ID, ACTOR);

    // Should still delete from DB despite git 404
    expect(mockDb.client.dataFolder.delete).toHaveBeenCalledWith({ where: { id: FOLDER_ID } });
  });

  it('should rethrow non-ScratchGitNotFoundError errors', async () => {
    (mockScratchGitService.removeDataFolder as jest.Mock).mockRejectedValue(new Error('Connection refused'));

    await expect(service.deleteFolder(FOLDER_ID, ACTOR)).rejects.toThrow('Connection refused');

    // Should NOT delete from DB when git fails with unexpected error
    expect(mockDb.client.dataFolder.delete).not.toHaveBeenCalled();
  });

  it('should skip git deletion when folder has no path', async () => {
    (mockDb.client.dataFolder.findUnique as jest.Mock).mockResolvedValue(makeDataFolder({ path: null }));

    await service.deleteFolder(FOLDER_ID, ACTOR);

    expect(mockScratchGitService.removeDataFolder).not.toHaveBeenCalled();
    expect(mockDb.client.dataFolder.delete).toHaveBeenCalled();
  });

  it('should delete schedules and DB record after git cleanup', async () => {
    await service.deleteFolder(FOLDER_ID, ACTOR);

    expect(mockDb.client.schedule.deleteMany).toHaveBeenCalledWith({
      where: { entityId: FOLDER_ID, action: { in: ['PULL', 'PUBLISH'] } },
    });
    expect(mockDb.client.dataFolder.delete).toHaveBeenCalledWith({ where: { id: FOLDER_ID } });
  });

  it('should clean up FileIndex, FileReference, and SyncMatchKeys rows that lack FK cascade', async () => {
    await service.deleteFolder(FOLDER_ID, ACTOR);

    // FileIndex.folderPath and FileReference.sourceFilePath are stored without a leading slash,
    // so the cleanup must pass the path without one to match.
    expect(mockFileIndexService.removeAll).toHaveBeenCalledWith(WORKBOOK_ID, 'Companies');
    expect(mockFileReferenceService.deleteForFolder).toHaveBeenCalledWith(WORKBOOK_ID, 'Companies');
    expect(mockDb.client.syncMatchKeys.deleteMany).toHaveBeenCalledWith({ where: { dataFolderId: FOLDER_ID } });
  });

  it('should skip path-keyed cleanup when folder has no path', async () => {
    (mockDb.client.dataFolder.findUnique as jest.Mock).mockResolvedValue(makeDataFolder({ path: null }));

    await service.deleteFolder(FOLDER_ID, ACTOR);

    expect(mockFileIndexService.removeAll).not.toHaveBeenCalled();
    expect(mockFileReferenceService.deleteForFolder).not.toHaveBeenCalled();
    expect(mockDb.client.syncMatchKeys.deleteMany).toHaveBeenCalledWith({ where: { dataFolderId: FOLDER_ID } });
  });
});

/* eslint-disable @typescript-eslint/unbound-method */
describe('DataFolderService.refreshSchemasForConnection', () => {
  const WORKBOOK_ID = 'wkb_test' as WorkbookId;
  const ORG_ID = 'org_test';
  const CONNECTOR_ACCOUNT_ID = 'coa_test';
  const ACTOR: Actor = { userId: 'usr_test', organizationId: ORG_ID, authSource: 'user' };

  const FOLDER_A = 'df_aaaaaaaaaaaaaaaaaaaaaaaaaa' as DataFolderId;
  const FOLDER_B = 'df_bbbbbbbbbbbbbbbbbbbbbbbbbb' as DataFolderId;
  const FOLDER_C = 'df_cccccccccccccccccccccccccc' as DataFolderId;

  let service: DataFolderService;
  let mockDb: jest.Mocked<DbService>;
  let mockConnectorAccountService: jest.Mocked<ConnectorAccountService>;
  let mockWorkbookService: jest.Mocked<WorkbookService>;
  let mockPosthogService: jest.Mocked<PostHogService>;
  let mockAuditLogService: jest.Mocked<AuditLogService>;

  const okSpec = {} as BaseJsonTableSpec;

  beforeEach(() => {
    mockDb = {
      client: {
        dataFolder: {
          findMany: jest.fn().mockResolvedValue([
            { id: FOLDER_A, name: 'Companies' },
            { id: FOLDER_B, name: 'Contacts' },
            { id: FOLDER_C, name: 'Deals' },
          ]),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    mockConnectorAccountService = {
      findOneById: jest.fn().mockResolvedValue({
        id: CONNECTOR_ACCOUNT_ID,
        workbookId: WORKBOOK_ID,
        displayName: 'My Airtable',
        service: 'Airtable',
      }),
    } as unknown as jest.Mocked<ConnectorAccountService>;

    mockWorkbookService = {
      assertWritableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID, organizationId: ORG_ID }),
    } as unknown as jest.Mocked<WorkbookService>;

    mockPosthogService = {
      trackRefreshConnectionSchemas: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    mockAuditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    const stub = {} as unknown;
    service = new DataFolderService(
      mockWorkbookService,
      mockDb,
      mockConnectorAccountService,
      stub as ConnectorsService,
      stub as ScratchConfigService,
      stub as BullEnqueuerService,
      mockAuditLogService,
      mockPosthogService,
      stub as ScratchGitService,
      stub as FilesService,
      stub as WorkbookEventService,
      stub as FileIndexService,
      stub as FileReferenceService,
    );
  });

  it('refreshes every folder in the connection and reports all successes', async () => {
    const fetchSchemaSpecSpy = jest.spyOn(service, 'fetchSchemaSpec').mockResolvedValue(okSpec);

    const result = await service.refreshSchemasForConnection(CONNECTOR_ACCOUNT_ID, ACTOR);

    expect(mockDb.client.dataFolder.findMany).toHaveBeenCalledWith({
      where: { connectorAccountId: CONNECTOR_ACCOUNT_ID },
      orderBy: { path: 'asc' },
    });
    expect(fetchSchemaSpecSpy).toHaveBeenCalledTimes(3);
    expect(result.refreshedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.results.map((r) => r.status)).toEqual(['refreshed', 'refreshed', 'refreshed']);
    expect(mockPosthogService.trackRefreshConnectionSchemas).toHaveBeenCalled();
    expect(mockAuditLogService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'update', organizationId: ORG_ID, entityId: CONNECTOR_ACCOUNT_ID }),
    );
  });

  it('records per-folder failures (null spec and thrown error) without aborting the batch', async () => {
    jest
      .spyOn(service, 'fetchSchemaSpec')
      .mockResolvedValueOnce(okSpec) // Companies → refreshed
      .mockResolvedValueOnce(null) // Contacts → no schema available
      .mockRejectedValueOnce(new Error('connector exploded')); // Deals → failed

    const result = await service.refreshSchemasForConnection(CONNECTOR_ACCOUNT_ID, ACTOR);

    expect(result.refreshedCount).toBe(1);
    expect(result.failedCount).toBe(2);
    expect(result.results).toEqual([
      { dataFolderId: FOLDER_A, folderName: 'Companies', status: 'refreshed' },
      {
        dataFolderId: FOLDER_B,
        folderName: 'Contacts',
        status: 'failed',
        error: 'No schema available for this data folder',
      },
      { dataFolderId: FOLDER_C, folderName: 'Deals', status: 'failed', error: 'connector exploded' },
    ]);
    expect(mockPosthogService.trackRefreshConnectionSchemas).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ id: CONNECTOR_ACCOUNT_ID }),
      { refreshedCount: 1, failedCount: 2 },
    );
  });

  it('asserts write access to the connection workbook before refreshing', async () => {
    jest.spyOn(service, 'fetchSchemaSpec').mockResolvedValue(okSpec);

    await service.refreshSchemasForConnection(CONNECTOR_ACCOUNT_ID, ACTOR);

    expect(mockConnectorAccountService.findOneById).toHaveBeenCalledWith(CONNECTOR_ACCOUNT_ID, ACTOR);
    expect(mockWorkbookService.assertWritableWorkbook).toHaveBeenCalledWith(ACTOR, WORKBOOK_ID);
  });
});
