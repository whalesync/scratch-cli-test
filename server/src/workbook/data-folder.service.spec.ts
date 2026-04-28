import type { TSchema } from '@sinclair/typebox';
import type { DataFolderId, WorkbookId } from '@spinner/shared-types';
import type { AuditLogService } from 'src/audit/audit-log.service';
import type { ScratchConfigService } from 'src/config/scratch-config.service';
import type { DbService } from 'src/db/db.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import type { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import type { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import type { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import type { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
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
    id: 'table-1',
    slug: 'table-slug',
    name: 'My Table',
    schema: {} as TSchema,
    idColumnRemoteId: 'id',
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

describe('DataFolderService dotfile filtering', () => {
  const WORKBOOK_ID = 'wkb_test' as WorkbookId;
  const FOLDER_ID = 'df_test' as DataFolderId;
  const ACTOR: Actor = { userId: 'usr_test', organizationId: 'org_test', authType: 'jwt', authSource: 'user' };

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
    );
  });

  describe('getAllFileContentsByFolderId', () => {
    it('should exclude dotfiles like .schema.json', async () => {
      (mockScratchGitService.getRepoFilesPaginated as jest.Mock).mockResolvedValue({
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
      (mockScratchGitService.getRepoFilesPaginated as jest.Mock).mockResolvedValue({
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
      (mockScratchGitService.getRepoFilesPaginated as jest.Mock).mockResolvedValue({
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
    workspacePermissions: [{ workbookId: WORKBOOK_ID, role: 'editor' }],
  };

  let service: DataFolderService;
  let mockDb: jest.Mocked<DbService>;
  let mockScratchGitService: jest.Mocked<ScratchGitService>;
  let mockWorkbookService: jest.Mocked<WorkbookService>;
  let mockWorkbookEventService: jest.Mocked<WorkbookEventService>;
  let mockPosthogService: jest.Mocked<PostHogService>;
  let mockAuditLogService: jest.Mocked<AuditLogService>;

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
      },
    } as unknown as jest.Mocked<DbService>;

    mockScratchGitService = {
      removeDataFolder: jest.fn().mockResolvedValue(undefined),
      resolveConnectionRepoPath: jest.fn().mockResolvedValue(RESOLVED_REPO_ID),
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
    );
  });

  it('should resolve connector account repo path when folder has connectorAccountId', async () => {
    await service.deleteFolder(FOLDER_ID, ACTOR);

    expect(mockScratchGitService.resolveConnectionRepoPath).toHaveBeenCalledWith(CONNECTOR_ACCOUNT_ID);
    expect(mockScratchGitService.removeDataFolder).toHaveBeenCalledWith(RESOLVED_REPO_ID, '/Companies');
  });

  it('should fall back to workbookId as repo ID when folder has no connectorAccountId', async () => {
    (mockDb.client.dataFolder.findUnique as jest.Mock).mockResolvedValue(makeDataFolder({ connectorAccountId: null }));

    await service.deleteFolder(FOLDER_ID, ACTOR);

    expect(mockScratchGitService.resolveConnectionRepoPath).not.toHaveBeenCalled();
    expect(mockScratchGitService.removeDataFolder).toHaveBeenCalledWith(WORKBOOK_ID, '/Companies');
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
});
