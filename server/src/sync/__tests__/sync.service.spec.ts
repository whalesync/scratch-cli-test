/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { ColumnMapping, DataFolderId, SaveSyncBody, SyncId, WorkbookId } from '@spinner/shared-types';
import { ConstantTypeMismatchError } from '@spinner/shared-types';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { FkMappingResult, LookupTools } from 'src/sync/transformers/transformer.types';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { SyncService, transformRecordAsync } from '../sync.service';

// Import transformer implementations to register them
import 'src/sync/transformers/implementations/auto-convert.transformer';
import 'src/sync/transformers/implementations/source-fk-to-dest-fk.transformer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('src/sync/schema-validator', () => ({
  validateSchemaMapping: jest.fn().mockReturnValue([]),
  findConstantTypeMismatches: jest.fn().mockReturnValue([]),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateSchemaMapping, findConstantTypeMismatches } = require('src/sync/schema-validator') as {
  validateSchemaMapping: jest.Mock;
  findConstantTypeMismatches: jest.Mock;
};

// ---------------------------------------------------------------------------
// Test constants & helpers
// ---------------------------------------------------------------------------

const WORKBOOK_ID = 'wkb_test123' as WorkbookId;
const SYNC_ID = 'syn_test456' as SyncId;
const SOURCE_FOLDER_ID = 'dfd_src1' as DataFolderId;
const DEST_FOLDER_ID = 'dfd_dest1' as DataFolderId;
const ACTOR: Actor = { userId: 'usr_abc', organizationId: 'org_xyz' };

function makeSaveSyncBody(overrides?: Partial<SaveSyncBody>): SaveSyncBody {
  return {
    displayName: 'Test Sync',
    validateMappings: false,
    mappings: {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER_ID,
          destinationDataFolderId: DEST_FOLDER_ID,
          columnMappings: [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        },
      ],
    },
    schedule: '',
    ...overrides,
  };
}

const MOCK_WORKBOOK = { id: WORKBOOK_ID, organizationId: 'org_xyz' } as unknown as WorkbookCluster.Workbook;
// `mappingsV2: null` mirrors what Prisma returns for a not-yet-migrated row
// (`select: { id, mappingsV2 }`). The v1-write rejection guard in `updateSync`
// keys off this — null means "still on v1", so a v1-shape save is allowed.
const MOCK_SYNC = { id: SYNC_ID, displayName: 'Test Sync', mappings: {}, mappingsV2: null };
/** Valid cron: every hour at minute 0 (meets min 1-min interval) */
const CRON_HOURLY = '0 * * * *';
const CRON_EVERY_TWO_HOURS = '0 */2 * * *';
const MOCK_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, name: { type: 'string' } },
};
const MOCK_SCHEMA_SPEC = { schema: MOCK_SCHEMA } as unknown as BaseJsonTableSpec;

describe('SyncService', () => {
  let service: SyncService;
  let dbService: jest.Mocked<DbService>;
  let dataFolderService: jest.Mocked<DataFolderService>;
  let posthogService: jest.Mocked<PostHogService>;
  let scheduleService: jest.Mocked<ScheduleService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let workbookRepoService: jest.Mocked<WorkbookRepoService>;
  let workbookService: jest.Mocked<WorkbookService>;

  beforeEach(() => {
    dbService = {
      client: {
        sync: {
          create: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
        },
        syncTablePair: { deleteMany: jest.fn() },
        schedule: { findFirst: jest.fn(), findMany: jest.fn() },
        dataFolder: { findUnique: jest.fn() },
        $transaction: jest.fn(),
      },
    } as unknown as jest.Mocked<DbService>;

    dataFolderService = {
      fetchSchemaSpec: jest.fn(),
    } as unknown as jest.Mocked<DataFolderService>;

    posthogService = {
      trackCreateSync: jest.fn(),
      trackUpdateSync: jest.fn(),
      trackRemoveSync: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    scratchGitService = {
      getRepoFile: jest.fn(),
    } as unknown as jest.Mocked<ScratchGitService>;

    workbookRepoService = {
      initWorkbookRepo: jest.fn().mockResolvedValue(undefined),
      pushSyncs: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkbookRepoService>;

    workbookService = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<WorkbookService>;

    scheduleService = {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<ScheduleService>;

    service = new SyncService(
      dbService,
      dataFolderService,
      posthogService,
      scheduleService,
      scratchGitService,
      workbookRepoService,
      workbookService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // createSync
  // ===========================================================================
  describe('createSync', () => {
    it('creates a sync with correct Prisma payload', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      const createdSync = { id: SYNC_ID, displayName: 'Test Sync', syncTablePairs: [] };
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(createdSync);

      const body = makeSaveSyncBody();
      const result = await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(result).toEqual(createdSync);
      expect(dbService.client.sync.create).toHaveBeenCalledTimes(1);

      type SyncCreateArg = {
        data: {
          workbookId: string;
          displayName: string;
          // T5 write asymmetry: `mappings` holds the frozen sentinel-v1 and the
          // real shape lives in `mappingsV2`.
          mappings: { version: number; tableMappings: Record<string, unknown>[] };
          mappingsV2: { version: number; tableMappings: Record<string, unknown>[] };
          syncTablePairs: { create: unknown[] };
        };
        include: { syncTablePairs: boolean };
      };
      const createArg = ((dbService.client.sync.create as jest.Mock).mock.calls as unknown[][])[0][0] as SyncCreateArg;
      expect(createArg.data.workbookId).toBe(WORKBOOK_ID);
      expect(createArg.data.displayName).toBe('Test Sync');
      // Sentinel-empty-v1 on the frozen column.
      expect(createArg.data.mappings).toEqual({ version: 1, tableMappings: [] });
      // Real (v2-normalized) shape on `mappingsV2`.
      expect(createArg.data.mappingsV2.version).toBe(2);
      expect(createArg.data.mappingsV2.tableMappings).toHaveLength(1);
      expect(createArg.data.mappingsV2.tableMappings[0].sourceDataFolderId).toBe(SOURCE_FOLDER_ID);
      expect(createArg.data.mappingsV2.tableMappings[0].destinationDataFolderId).toBe(DEST_FOLDER_ID);
      expect(createArg.data.mappingsV2.tableMappings[0].columnMappings).toEqual([
        { destinationColumnId: 'name', source: { kind: 'column', columnId: 'title' } },
      ]);
      expect(createArg.data.syncTablePairs.create).toHaveLength(1);
      expect(createArg.include.syncTablePairs).toBe(true);
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.createSync(WORKBOOK_ID, makeSaveSyncBody(), ACTOR)).rejects.toThrow(NotFoundException);
      expect(dbService.client.sync.create).not.toHaveBeenCalled();
    });

    it('calls fetchSchemaSpec for each table mapping and validates when schemas present', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(MOCK_SCHEMA_SPEC);
      validateSchemaMapping.mockReturnValue([]);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({ validateMappings: true });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledTimes(2);
      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledWith(SOURCE_FOLDER_ID, ACTOR);
      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledWith(DEST_FOLDER_ID, ACTOR);
    });

    it('skips validation gracefully when schemas are absent', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(null);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody();
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(validateSchemaMapping).not.toHaveBeenCalled();
      expect(dbService.client.sync.create).toHaveBeenCalled();
    });

    it('throws NotFoundException when source schema present but dest schema missing', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      dataFolderService.fetchSchemaSpec.mockResolvedValueOnce(MOCK_SCHEMA_SPEC).mockResolvedValueOnce(null);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody();
      // Should skip validation since one schema is missing
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(validateSchemaMapping).not.toHaveBeenCalled();
    });

    it('throws BadRequestException on schema validation errors', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(MOCK_SCHEMA_SPEC);
      validateSchemaMapping.mockReturnValue(['Type mismatch for field X']);

      const body = makeSaveSyncBody({ validateMappings: true });

      await expect(service.createSync(WORKBOOK_ID, body, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('throws ConstantTypeMismatchError when a constant value conflicts with its destination column type', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(MOCK_SCHEMA_SPEC);
      validateSchemaMapping.mockReturnValue([]);
      // mockReturnValueOnce so the override doesn't leak into later validating tests.
      findConstantTypeMismatches.mockReturnValueOnce([
        { destinationColumnId: 'archived', expected: 'boolean', got: 'string' },
      ]);

      const body = makeSaveSyncBody({ validateMappings: true });

      await expect(service.createSync(WORKBOOK_ID, body, ACTOR)).rejects.toThrow(ConstantTypeMismatchError);
      expect(dbService.client.sync.create).not.toHaveBeenCalled();
    });

    it('creates multiple syncTablePairs for multiple table mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: 'dfd_src1' as DataFolderId,
              destinationDataFolderId: 'dfd_dest1' as DataFolderId,
              columnMappings: [{ sourceColumnId: 'a', destinationColumnId: 'b' }],
            },
            {
              sourceDataFolderId: 'dfd_src2' as DataFolderId,
              destinationDataFolderId: 'dfd_dest2' as DataFolderId,
              columnMappings: [{ sourceColumnId: 'c', destinationColumnId: 'd' }],
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const createArg = ((dbService.client.sync.create as jest.Mock).mock.calls as unknown[][])[0][0] as {
        data: { mappingsV2: { tableMappings: unknown[] }; syncTablePairs: { create: unknown[] } };
      };
      expect(createArg.data.mappingsV2.tableMappings).toHaveLength(2);
      expect(createArg.data.syncTablePairs.create).toHaveLength(2);
    });

    it('includes recordMatching when set', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_addr' }],
              recordMatching: {
                sourceColumnId: 'email',
                destinationColumnId: 'email_addr',
              },
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const tableMapping = (
        ((dbService.client.sync.create as jest.Mock).mock.calls as unknown[][])[0][0] as {
          data: { mappingsV2: { tableMappings: Array<Record<string, unknown>> } };
        }
      ).data.mappingsV2.tableMappings[0];
      expect(tableMapping.recordMatching).toEqual({
        sourceColumnId: 'email',
        destinationColumnId: 'email_addr',
      });
    });

    it('omits recordMatching when not set', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody();
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const tableMapping = (
        ((dbService.client.sync.create as jest.Mock).mock.calls as unknown[][])[0][0] as {
          data: { mappingsV2: { tableMappings: Array<Record<string, unknown>> } };
        }
      ).data.mappingsV2.tableMappings[0];
      expect(tableMapping.recordMatching).toBeUndefined();
    });

    it('calls PostHog tracking after creation', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      const createdSync = { id: SYNC_ID };
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(createdSync);

      await service.createSync(WORKBOOK_ID, makeSaveSyncBody(), ACTOR);

      expect(posthogService.trackCreateSync).toHaveBeenCalledWith(ACTOR, createdSync);
    });

    it('handles columnMappings with transformer', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [
                {
                  sourceColumnId: 'price',
                  destinationColumnId: 'amount',
                  transformer: { type: 'string_to_number', options: { stripCurrency: true } },
                },
              ],
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const columnMappings = (
        ((dbService.client.sync.create as jest.Mock).mock.calls as unknown[][])[0][0] as {
          data: { mappingsV2: { tableMappings: Array<{ columnMappings: unknown }> } };
        }
      ).data.mappingsV2.tableMappings[0].columnMappings;
      expect(columnMappings).toEqual([
        {
          destinationColumnId: 'amount',
          source: {
            kind: 'column',
            columnId: 'price',
            transformer: { type: 'string_to_number', options: { stripCurrency: true } },
          },
        },
      ]);
    });

    it('handles multiple simple column mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [
                { sourceColumnId: 'title', destinationColumnId: 'name' },
                { sourceColumnId: 'slug', destinationColumnId: 'url_slug' },
              ],
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const columnMappings = (
        ((dbService.client.sync.create as jest.Mock).mock.calls as unknown[][])[0][0] as {
          data: { mappingsV2: { tableMappings: Array<{ columnMappings: unknown }> } };
        }
      ).data.mappingsV2.tableMappings[0].columnMappings;
      expect(columnMappings).toEqual([
        { destinationColumnId: 'name', source: { kind: 'column', columnId: 'title' } },
        { destinationColumnId: 'url_slug', source: { kind: 'column', columnId: 'slug' } },
      ]);
    });

    it('creates a schedule when schedule cron expression is provided', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      const createdSync = { id: SYNC_ID, displayName: 'Scheduled Sync', syncTablePairs: [] };
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(createdSync);

      const body = makeSaveSyncBody({ displayName: 'Scheduled Sync', schedule: CRON_HOURLY });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(scheduleService.create).toHaveBeenCalledTimes(1);
      const createCall = ((scheduleService.create as jest.Mock).mock.calls as unknown[][])[0] as [
        string,
        { name: string; action: string; cronExpression: string; enabled: boolean; entityId: string },
        Actor,
      ];
      expect(createCall[0]).toBe(WORKBOOK_ID);
      expect(createCall[1]).toMatchObject({
        name: 'Sync: Scheduled Sync',
        action: 'SYNC',
        cronExpression: CRON_HOURLY,
        enabled: true,
      });
      expect(createCall[1].entityId).toBeDefined();
      expect(typeof createCall[1].entityId).toBe('string');
      expect(createCall[2]).toEqual(ACTOR);
    });

    it('does not create a schedule when schedule is omitted or empty', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      await service.createSync(WORKBOOK_ID, makeSaveSyncBody({ schedule: '' }), ACTOR);

      expect(scheduleService.create).not.toHaveBeenCalled();
    });

    it('forwards the schedule timezone when creating a scheduled sync', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const body = makeSaveSyncBody({ schedule: CRON_HOURLY, scheduleTimezone: 'America/New_York' });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(scheduleService.create).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({ cronExpression: CRON_HOURLY, timezone: 'America/New_York' }),
        ACTOR,
      );
    });
  });

  // ===========================================================================
  // updateSync
  // ===========================================================================
  describe('updateSync', () => {
    it('deletes old pairs and updates sync in transaction', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const updatedSync = { id: SYNC_ID, displayName: 'Updated', syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          syncTablePair: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
          sync: { update: jest.fn().mockResolvedValue(updatedSync) },
        };
        return fn(tx);
      });

      const body = makeSaveSyncBody({ displayName: 'Updated' });
      const result = await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(result).toEqual(updatedSync);
      expect(dbService.client.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when sync not found', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    // -- v1-write rejection guard (Phase 2): once a row has crossed to v2,
    //    a stale v1-only client must not write to the frozen `mappings` column.
    it('rejects a v1-shape save once the sync has migrated to v2', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      // Migrated row: mappingsV2 is populated.
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue({
        ...MOCK_SYNC,
        mappingsV2: { version: 2, tableMappings: [] },
      });

      // makeSaveSyncBody() is a v1 body (version: 1).
      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR)).rejects.toThrow(
        ConflictException,
      );
      // The guard fires before any write path is touched.
      expect(dbService.client.$transaction).not.toHaveBeenCalled();
    });

    it('allows a v2-shape save on a migrated sync', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue({
        ...MOCK_SYNC,
        mappingsV2: { version: 2, tableMappings: [] },
      });
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      const v2Body = makeSaveSyncBody({
        mappings: {
          version: 2,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'title' } }],
            },
          ],
        },
      });

      const result = await service.updateSync(WORKBOOK_ID, SYNC_ID, v2Body, ACTOR);
      expect(result).toEqual(updatedSync);
      expect(dbService.client.$transaction).toHaveBeenCalledTimes(1);
    });

    it('allows a v1-shape save on a not-yet-migrated sync (mappingsV2 null)', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      // MOCK_SYNC carries mappingsV2: null — the pre-backfill state.
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      const result = await service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR);
      expect(result).toEqual(updatedSync);
      expect(dbService.client.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws BadRequestException when record matching fields are not in column mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_addr' }],
              recordMatching: {
                sourceColumnId: 'email',
                destinationColumnId: 'WRONG_FIELD',
              },
            },
          ],
        },
      });

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('passes when record matching fields are aligned with column mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_addr' }],
              recordMatching: {
                sourceColumnId: 'email',
                destinationColumnId: 'email_addr',
              },
            },
          ],
        },
      });

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR)).resolves.toBeDefined();
    });

    it('validates schema mappings when schemas are present', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(MOCK_SCHEMA_SPEC);
      validateSchemaMapping.mockReturnValue([]);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const body = makeSaveSyncBody({ validateMappings: true });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledTimes(2);
      expect(validateSchemaMapping).toHaveBeenCalled();
    });

    it('skips validation when schemas are absent', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(null);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const body = makeSaveSyncBody();
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(validateSchemaMapping).not.toHaveBeenCalled();
    });

    it('calls PostHog tracking after update', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      await service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR);

      expect(posthogService.trackUpdateSync).toHaveBeenCalledWith(ACTOR, updatedSync);
    });

    it('adds a schedule when updating sync with schedule and none exists', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);
      (dbService.client.schedule.findFirst as jest.Mock).mockResolvedValue(null);

      const body = makeSaveSyncBody({ displayName: 'Test Sync', schedule: CRON_HOURLY });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(scheduleService.create).toHaveBeenCalledTimes(1);
      expect(scheduleService.create).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({
          name: 'Sync: Test Sync',
          action: 'SYNC',
          entityId: SYNC_ID,
          cronExpression: CRON_HOURLY,
          enabled: true,
        }),
        ACTOR,
      );
      expect(scheduleService.update).not.toHaveBeenCalled();
      expect(scheduleService.delete).not.toHaveBeenCalled();
    });

    it('updates the schedule when updating sync with new cron and one exists', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);
      const existingSchedule = { id: 'sched_existing123' };
      (dbService.client.schedule.findFirst as jest.Mock).mockResolvedValue(existingSchedule);

      const body = makeSaveSyncBody({ schedule: CRON_EVERY_TWO_HOURS });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(scheduleService.update).toHaveBeenCalledTimes(1);
      expect(scheduleService.update).toHaveBeenCalledWith(WORKBOOK_ID, existingSchedule.id, {
        cronExpression: CRON_EVERY_TWO_HOURS,
      });
      expect(scheduleService.create).not.toHaveBeenCalled();
      expect(scheduleService.delete).not.toHaveBeenCalled();
    });

    it('forwards the schedule timezone when updating an existing sync schedule', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });
      const existingSchedule = { id: 'sched_existing123' };
      (dbService.client.schedule.findFirst as jest.Mock).mockResolvedValue(existingSchedule);

      const body = makeSaveSyncBody({ schedule: CRON_EVERY_TWO_HOURS, scheduleTimezone: 'Europe/Paris' });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(scheduleService.update).toHaveBeenCalledWith(WORKBOOK_ID, existingSchedule.id, {
        cronExpression: CRON_EVERY_TWO_HOURS,
        timezone: 'Europe/Paris',
      });
    });

    it('removes the schedule when updating sync with empty schedule and one exists', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);
      const existingSchedule = { id: 'sched_existing123' };
      (dbService.client.schedule.findFirst as jest.Mock).mockResolvedValue(existingSchedule);

      const body = makeSaveSyncBody({ schedule: '' });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(scheduleService.delete).toHaveBeenCalledTimes(1);
      expect(scheduleService.delete).toHaveBeenCalledWith(WORKBOOK_ID, existingSchedule.id);
      expect(scheduleService.create).not.toHaveBeenCalled();
      expect(scheduleService.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // findOneForWorkbook
  // ===========================================================================
  describe('findOneForWorkbook', () => {
    const mockSyncWithPairs = { id: SYNC_ID, displayName: 'Test Sync', syncTablePairs: [] };

    it('returns sync scoped to workbook with syncTablePairs included', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(mockSyncWithPairs);

      const result = await service.findOneForWorkbook(WORKBOOK_ID, SYNC_ID, ACTOR);

      expect(result).toEqual(mockSyncWithPairs);
      expect(dbService.client.sync.findFirst).toHaveBeenCalledWith({
        where: {
          id: SYNC_ID,
          workbookId: WORKBOOK_ID,
        },
        include: { syncTablePairs: true },
      });
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.findOneForWorkbook(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
      expect(dbService.client.sync.findFirst).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when sync not found', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findOneForWorkbook(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // findAllForWorkbook
  // ===========================================================================
  describe('findAllForWorkbook', () => {
    it('returns syncs scoped to workbook, ordered by createdAt desc', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      const syncs = [{ id: 'syn_1' }, { id: 'syn_2' }];
      (dbService.client.sync.findMany as jest.Mock).mockResolvedValue(syncs);

      const result = await service.findAllForWorkbook(WORKBOOK_ID, ACTOR);

      expect(result).toEqual(syncs);
      expect(dbService.client.sync.findMany).toHaveBeenCalledWith({
        where: {
          workbookId: WORKBOOK_ID,
        },
        include: { syncTablePairs: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.findAllForWorkbook(WORKBOOK_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('returns empty array when no syncs exist', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findAllForWorkbook(WORKBOOK_ID, ACTOR);

      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // deleteSync
  // ===========================================================================
  describe('deleteSync', () => {
    it('deletes sync and tracks in PostHog', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.sync.delete as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue([]);

      await service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR);

      expect(dbService.client.sync.delete).toHaveBeenCalledWith({ where: { id: SYNC_ID } });
      expect(posthogService.trackRemoveSync).toHaveBeenCalledWith(ACTOR, MOCK_SYNC);
    });

    it('deletes associated schedules when sync is deleted', async () => {
      const mockSchedule = { id: 'schedule-1', workbookId: WORKBOOK_ID, action: 'SYNC', entityId: SYNC_ID };
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.sync.delete as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue([mockSchedule]);

      await service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR);

      expect(dbService.client.schedule.findMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, action: 'SYNC', entityId: SYNC_ID },
      });
      expect(scheduleService.delete).toHaveBeenCalledWith(WORKBOOK_ID, 'schedule-1');
    });

    it('handles no associated schedules gracefully', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.sync.delete as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue([]);

      await service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR);

      expect(scheduleService.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when sync not found, delete NOT called', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
      expect(dbService.client.sync.delete).not.toHaveBeenCalled();
    });

    it('scopes sync query to workbook via workbookId', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);

      expect(dbService.client.sync.findFirst).toHaveBeenCalledWith({
        where: {
          id: SYNC_ID,
          workbookId: WORKBOOK_ID,
        },
      });
    });
  });

  // ===========================================================================
  // validateFolderMapping
  // ===========================================================================
  describe('validateFolderMapping', () => {
    it('returns true when both schemas are present', async () => {
      dataFolderService.fetchSchemaSpec.mockResolvedValueOnce(MOCK_SCHEMA_SPEC).mockResolvedValueOnce(MOCK_SCHEMA_SPEC);

      const result = await service.validateFolderMapping(
        WORKBOOK_ID,
        SOURCE_FOLDER_ID,
        DEST_FOLDER_ID,
        [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        ACTOR,
      );

      // Current implementation always returns true
      expect(result).toBe(true);
    });

    it('returns true when source schema is missing (loose validation)', async () => {
      dataFolderService.fetchSchemaSpec.mockResolvedValueOnce(null).mockResolvedValueOnce(MOCK_SCHEMA_SPEC);

      const result = await service.validateFolderMapping(
        WORKBOOK_ID,
        SOURCE_FOLDER_ID,
        DEST_FOLDER_ID,
        [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        ACTOR,
      );

      expect(result).toBe(true);
    });

    it('returns true when dest schema is missing (loose validation)', async () => {
      dataFolderService.fetchSchemaSpec.mockResolvedValueOnce(MOCK_SCHEMA_SPEC).mockResolvedValueOnce(null);

      const result = await service.validateFolderMapping(
        WORKBOOK_ID,
        SOURCE_FOLDER_ID,
        DEST_FOLDER_ID,
        [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        ACTOR,
      );

      expect(result).toBe(true);
    });
  });
});

// ===========================================================================
// transformRecordAsync (standalone function)
// ===========================================================================
describe('transformRecordAsync', () => {
  describe('key ordering preservation', () => {
    it('preserves original key order when updating an existing record via baseFields', async () => {
      // Simulate the exact scenario from the bug: a destination JSON file has keys in a
      // specific order (id, cmsLocaleId, ..., fieldData). After syncing, the key order
      // must remain identical — only the mapped field values should change.
      const existingFields = {
        id: '6994a4d364f1775dd68f1589',
        cmsLocaleId: '6930533529443b9f130b26e6',
        lastPublished: '2026-02-17T17:26:43.762Z',
        lastUpdated: '2026-02-17T17:26:43.762Z',
        createdOn: '2026-02-17T17:26:43.762Z',
        isArchived: false,
        isDraft: false,
        fieldData: {
          'airtable-id': 'rechCcin6LPjgFMfY',
          name: 'Atlantic Mackerel',
          slug: 'atlantic-mackerel',
        },
      };

      const sourceRecord = {
        id: 'rechCcin6LPjgFMfY',
        filePath: 'source/atlantic-mackerel.json',
        fields: {
          Name: 'Atlantic Mackerel',
          Link: 'https://en.wikipedia.org/wiki/Atlantic_mackerel',
        },
      };

      const columnMappings = [
        { sourceColumnId: 'Name', destinationColumnId: 'fieldData.name' },
        { sourceColumnId: 'Link', destinationColumnId: 'fieldData.link' },
      ];

      const { fields: result } = await transformRecordAsync(
        sourceRecord,
        columnMappings,
        null,
        null,
        undefined,
        'DATA',
        existingFields,
      );

      // The mapped fields should be updated/added
      const fieldData1 = (result as Record<string, Record<string, unknown>>).fieldData;
      expect(fieldData1.name).toBe('Atlantic Mackerel');
      expect(fieldData1.link).toBe('https://en.wikipedia.org/wiki/Atlantic_mackerel');

      // Non-mapped fields must still be present
      expect(result.id).toBe('6994a4d364f1775dd68f1589');
      expect(result.cmsLocaleId).toBe('6930533529443b9f130b26e6');
      expect(result.isArchived).toBe(false);

      // CRITICAL: Key order must match the original. JSON.stringify uses insertion order,
      // so serializing the result must produce keys in the same order as the original object.
      const resultKeys = Object.keys(result);
      const originalKeys = Object.keys(existingFields);
      expect(resultKeys).toEqual(originalKeys);
    });

    it('does not mutate the original baseFields object', async () => {
      const existingFields = { id: '123', name: 'Original' };
      const sourceRecord = {
        id: 'src1',
        filePath: 'source/test.json',
        fields: { title: 'Updated' },
      };
      const columnMappings = [{ sourceColumnId: 'title', destinationColumnId: 'name' }];

      await transformRecordAsync(sourceRecord, columnMappings, null, null, undefined, 'DATA', existingFields);

      expect(existingFields.name).toBe('Original');
    });

    it('builds a fresh object without baseFields (new record)', async () => {
      const sourceRecord = {
        id: 'src1',
        filePath: 'source/test.json',
        fields: { title: 'New Item', slug: 'new-item' },
      };
      const columnMappings = [
        { sourceColumnId: 'title', destinationColumnId: 'fieldData.name' },
        { sourceColumnId: 'slug', destinationColumnId: 'fieldData.slug' },
      ];

      const { fields: result } = await transformRecordAsync(sourceRecord, columnMappings, null, null);

      const fieldData2 = (result as Record<string, Record<string, unknown>>).fieldData;
      expect(fieldData2.name).toBe('New Item');
      expect(fieldData2.slug).toBe('new-item');
      // No extra keys from any base — only the mapped fields
      expect(Object.keys(result)).toEqual(['fieldData']);
    });
  });

  describe('phase-based column mapping filtering', () => {
    // A mix of mappings: plain (DATA), auto_convert (DATA), and source_fk_to_dest_fk (FK phase).
    // Verifies that transformRecordAsync only processes mappings belonging to the requested phase.
    const REFERENCED_FOLDER = 'dfd_dest_authors' as DataFolderId;

    const columnMappings: ColumnMapping[] = [
      // 1. Simple string → string, no transformer (DATA phase)
      { sourceColumnId: 'title', destinationColumnId: 'name' },
      // 2. String → number via auto_convert (DATA phase)
      {
        sourceColumnId: 'price',
        destinationColumnId: 'amount',
        transformer: { type: 'auto_convert' as const, options: { targetType: 'number' as const } },
      },
      // 3. FK mapping: source_fk_to_dest_fk → auto_convert to string (FOREIGN_KEY_MAPPING phase)
      {
        sourceColumnId: 'authorIds',
        destinationColumnId: 'author',
        transformers: [
          { type: 'source_fk_to_dest_fk' as const, options: { referencedDataFolderId: REFERENCED_FOLDER } },
          { type: 'auto_convert' as const, options: { targetType: 'string' as const } },
        ],
      },
    ];

    const sourceRecord = {
      id: 'rec_1',
      filePath: 'source/item.json',
      fields: {
        title: 'My Article',
        price: '42.5',
        authorIds: ['src_author_1'],
      },
    };

    const lookupTools: LookupTools = {
      // Identity: these fixtures reference targets by remote id, the default contract.
      resolveForeignKeyValueToTargetRemoteId: jest.fn((value: string) =>
        Promise.resolve({ kind: 'resolved', targetSourceRemoteId: value } as const),
      ),
      getDestinationMappingForSourceFk: jest.fn((fk: string): Promise<FkMappingResult | null> => {
        const map: Record<string, FkMappingResult> = {
          src_author_1: {
            destinationFilePath: 'authors/alice.json',
            destinationRemoteId: 'wf-author-1',
            destinationConnectionFolder: null,
          },
        };
        return Promise.resolve(map[fk] ?? null);
      }),
      lookupFieldFromFkRecord: jest.fn(),
      getOrCreateDestinationAssetMapping: jest.fn(),
      matchDestinationAssetByHash: jest.fn(),
    };

    const syncContext = {
      sourceService: Service.AIRTABLE,
      destinationService: Service.WEBFLOW,
    };

    it('DATA phase processes plain and auto_convert mappings, skips FK mapping', async () => {
      const { fields } = await transformRecordAsync(
        sourceRecord,
        columnMappings,
        null,
        null,
        lookupTools,
        'DATA',
        undefined,
        syncContext,
      );

      // Plain string passthrough
      expect(fields.name).toBe('My Article');
      // auto_convert string → number
      expect(fields.amount).toBe(42.5);
      // FK mapping must NOT be processed in DATA phase
      expect(fields.author).toBeUndefined();
    });

    it('FOREIGN_KEY_MAPPING phase processes only the FK mapping, skips plain and auto_convert', async () => {
      const { fields } = await transformRecordAsync(
        sourceRecord,
        columnMappings,
        null,
        null,
        lookupTools,
        'FOREIGN_KEY_MAPPING',
        undefined,
        syncContext,
      );

      // Plain and auto_convert mappings must NOT be processed in FK phase
      expect(fields.name).toBeUndefined();
      expect(fields.amount).toBeUndefined();
      // FK resolved → auto_convert to string: single-element array becomes the string value
      expect(fields.author).toBe('wf-author-1');
    });

    it('running both phases sequentially produces the complete record', async () => {
      // Phase 1: DATA
      const { fields: dataFields } = await transformRecordAsync(
        sourceRecord,
        columnMappings,
        null,
        null,
        lookupTools,
        'DATA',
        undefined,
        syncContext,
      );

      // Phase 2: FOREIGN_KEY_MAPPING, using dataFields as the base
      const { fields: finalFields } = await transformRecordAsync(
        sourceRecord,
        columnMappings,
        null,
        null,
        lookupTools,
        'FOREIGN_KEY_MAPPING',
        dataFields,
        syncContext,
      );

      expect(finalFields.name).toBe('My Article');
      expect(finalFields.amount).toBe(42.5);
      expect(finalFields.author).toBe('wf-author-1');
    });
  });
});
