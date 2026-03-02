import type { TSchema } from '@sinclair/typebox';
import type { DataFolderId, WorkbookId } from '@spinner/shared-types';
import type { AuditLogService } from 'src/audit/audit-log.service';
import type { ScratchConfigService } from 'src/config/scratch-config.service';
import type { DbService } from 'src/db/db.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import type { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
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

  it('should build path from connector display name and table name', () => {
    const result = service.buildConnectorFolderPath('My Airtable', makeTableSpec({ name: 'Products' }));
    expect(result).toBe('/My Airtable/Products');
  });

  it('should include basePath segments between connector name and table name', () => {
    const result = service.buildConnectorFolderPath(
      'My Airtable',
      makeTableSpec({ name: 'Products', basePath: ['Base One'] }),
    );
    expect(result).toBe('/My Airtable/Base One/Products');
  });

  it('should include multiple basePath segments', () => {
    const result = service.buildConnectorFolderPath(
      'Webflow',
      makeTableSpec({ name: 'Blog Posts', basePath: ['My Site', 'CMS'] }),
    );
    expect(result).toBe('/Webflow/My Site/CMS/Blog Posts');
  });

  it('should prepend parentFolderPath when provided', () => {
    const result = service.buildConnectorFolderPath('My Airtable', makeTableSpec({ name: 'Products' }), '/Parent');
    expect(result).toBe('/Parent/My Airtable/Products');
  });

  it('should handle parentFolderPath with basePath', () => {
    const result = service.buildConnectorFolderPath(
      'My Airtable',
      makeTableSpec({ name: 'Products', basePath: ['Base One'] }),
      '/Parent/Sub',
    );
    expect(result).toBe('/Parent/Sub/My Airtable/Base One/Products');
  });

  it('should replace slashes with spaces in connector display name', () => {
    const result = service.buildConnectorFolderPath('My/Airtable', makeTableSpec({ name: 'Products' }));
    expect(result).toBe('/My Airtable/Products');
  });

  it('should replace slashes with spaces in table name', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Products/Items' }));
    expect(result).toBe('/Airtable/Products Items');
  });

  it('should replace slashes with spaces in basePath segments', () => {
    const result = service.buildConnectorFolderPath(
      'Airtable',
      makeTableSpec({ name: 'Table', basePath: ['Base/One'] }),
    );
    expect(result).toBe('/Airtable/Base One/Table');
  });

  it('should replace asterisks and question marks with spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'What*is*this?' }));
    expect(result).toBe('/Airtable/What is this');
  });

  it('should replace double quotes with spaces and collapse consecutive spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'The "Best" Table' }));
    expect(result).toBe('/Airtable/The Best Table');
  });

  it('should replace angle brackets and pipes with spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: '<Input|Output>' }));
    expect(result).toBe('/Airtable/Input Output');
  });

  it('should convert tabs to spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Tab\there' }));
    expect(result).toBe('/Airtable/Tab here');
  });

  it('should collapse multiple consecutive spaces', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Too   many    spaces' }));
    expect(result).toBe('/Airtable/Too many spaces');
  });

  it('should trim leading and trailing whitespace from segments', () => {
    const result = service.buildConnectorFolderPath('  Airtable  ', makeTableSpec({ name: '  Products  ' }));
    expect(result).toBe('/Airtable/Products');
  });

  it('should trim trailing dots but preserve leading dots', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: '..hidden.' }));
    expect(result).toBe('/Airtable/..hidden');
  });

  it('should filter out falsy basePath entries', () => {
    const result = service.buildConnectorFolderPath(
      'Airtable',
      makeTableSpec({ name: 'Table', basePath: ['Base', '', 'Sub'] }),
    );
    expect(result).toBe('/Airtable/Base/Sub/Table');
  });

  it('should handle empty basePath array', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Table', basePath: [] }));
    expect(result).toBe('/Airtable/Table');
  });

  it('should handle undefined basePath', () => {
    const result = service.buildConnectorFolderPath('Airtable', makeTableSpec({ name: 'Table', basePath: undefined }));
    expect(result).toBe('/Airtable/Table');
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
            parentId: null,
            schema: null,
            filter: null,
            lock: null,
            lastSyncTime: null,
            lastSchemaRefreshAt: null,
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
    } as unknown as jest.Mocked<ScratchGitService>;

    // Create service with only the dependencies these methods use
    const stub = {} as unknown;
    service = new DataFolderService(
      { findOne: jest.fn().mockResolvedValue({ id: WORKBOOK_ID }) } as unknown as WorkbookService,
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
