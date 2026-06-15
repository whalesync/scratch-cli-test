/* eslint-disable @typescript-eslint/unbound-method */
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { SyncDraftId, SyncId, WorkbookId } from '@spinner/shared-types';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { SchemaBuilderService } from 'src/schema-builder/schema-builder.service';
import { SyncService } from 'src/sync/sync.service';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { SyncDraftService } from '../sync-draft.service';

const WORKBOOK_ID = 'wkb_test123' as WorkbookId;
const OTHER_WORKBOOK_ID = 'wkb_other99' as WorkbookId;
const DRAFT_ID = 'syd_test456' as SyncDraftId;
const SYNC_ID = 'syn_src7890' as SyncId;
const ACTOR: Actor = { userId: 'usr_abc', organizationId: 'org_xyz' };
const MOCK_WORKBOOK = { id: WORKBOOK_ID } as unknown as WorkbookCluster.Workbook;

/** A persisted draft row as Prisma would return it. */
function makeDraftRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    createdAt: new Date('2026-06-14T00:00:00.000Z'),
    updatedAt: new Date('2026-06-14T00:00:00.000Z'),
    workbookId: WORKBOOK_ID,
    version: 1,
    displayName: 'Untitled sync',
    schedule: null,
    sourceSyncId: null,
    tableMappings: [],
    archivedAt: null,
    appliedSyncId: null,
    ...overrides,
  };
}

describe('SyncDraftService', () => {
  let service: SyncDraftService;
  let dbService: jest.Mocked<DbService>;
  let workbookService: jest.Mocked<WorkbookService>;
  let syncService: jest.Mocked<SyncService>;
  let schemaBuilderService: jest.Mocked<SchemaBuilderService>;
  let dataFolderService: jest.Mocked<DataFolderService>;

  beforeEach(() => {
    dbService = {
      client: {
        syncDraft: {
          create: jest.fn(),
          findFirst: jest.fn(),
          updateMany: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
        },
        schedule: { findFirst: jest.fn() },
        dataFolder: { findFirst: jest.fn() },
        // getOrCreate runs its find-or-create inside a transaction guarded by an
        // advisory lock; the mock runs the callback against the same client.
        $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(dbService.client)),
        $executeRaw: jest.fn().mockResolvedValue(0),
      },
    } as unknown as jest.Mocked<DbService>;

    workbookService = {
      assertReadableWorkbook: jest.fn().mockResolvedValue(MOCK_WORKBOOK),
      assertWritableWorkbook: jest.fn().mockResolvedValue(MOCK_WORKBOOK),
    } as unknown as jest.Mocked<WorkbookService>;

    syncService = {
      getSync: jest.fn(),
      getSyncForExecution: jest.fn(),
      createSync: jest.fn(),
      updateSync: jest.fn(),
    } as unknown as jest.Mocked<SyncService>;

    schemaBuilderService = {
      createTables: jest.fn(),
      createFields: jest.fn(),
    } as unknown as jest.Mocked<SchemaBuilderService>;

    dataFolderService = {
      createFolder: jest.fn(),
      fetchSchemaSpec: jest.fn(),
    } as unknown as jest.Mocked<DataFolderService>;

    service = new SyncDraftService(dbService, workbookService, syncService, schemaBuilderService, dataFolderService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOrCreate (blank)', () => {
    it('creates an empty draft when none exists, and asserts write permission', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(null);
      (dbService.client.syncDraft.create as jest.Mock).mockResolvedValue(makeDraftRow());

      const draft = await service.getOrCreate(WORKBOOK_ID, {} as never, ACTOR);

      expect(workbookService.assertWritableWorkbook).toHaveBeenCalledWith(ACTOR, WORKBOOK_ID);
      expect(draft.tableMappings).toEqual([]);
      expect(draft.version).toBe(1);
      expect(draft.sourceSyncId).toBeNull();
      const createCalls = (dbService.client.syncDraft.create as jest.Mock).mock.calls as Array<
        [{ data: { id: string; sourceSyncId: string | null } }]
      >;
      expect(createCalls[0][0].data.id).toMatch(/^syd_/);
      expect(createCalls[0][0].data.sourceSyncId).toBeNull();
    });

    it('returns the existing active draft for the target without creating a new one', async () => {
      const existing = makeDraftRow({ id: 'syd_existing', version: 4 });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(existing);

      const draft = await service.getOrCreate(WORKBOOK_ID, {} as never, ACTOR);

      expect(draft.id).toBe('syd_existing');
      expect(draft.version).toBe(4);
      // The active-draft lookup is keyed on the target with archivedAt: null.
      const findCalls = (dbService.client.syncDraft.findFirst as jest.Mock).mock.calls as Array<
        [{ where: { workbookId: string; sourceSyncId: string | null; archivedAt: null } }]
      >;
      expect(findCalls[0][0].where).toMatchObject({ workbookId: WORKBOOK_ID, sourceSyncId: null, archivedAt: null });
      expect(dbService.client.syncDraft.create).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreate (fromSyncId)', () => {
    it('converts an existing v2 sync into all-existing draft mappings', async () => {
      syncService.getSync.mockResolvedValue({
        id: SYNC_ID,
        workbookId: WORKBOOK_ID,
        displayName: 'Contacts → Airtable',
        mappings: {
          version: 2,
          tableMappings: [
            {
              sourceDataFolderId: 'dfd_src1',
              destinationDataFolderId: 'dfd_dst1',
              columnMappings: [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'title' } }],
              recordMatching: { sourceColumnId: 'email', destinationColumnId: 'Email' },
            },
          ],
        },
      } as never);
      (dbService.client.schedule.findFirst as jest.Mock).mockResolvedValue({ cronExpression: '0 * * * *' });
      (dbService.client.syncDraft.create as jest.Mock).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => makeDraftRow(data),
      );

      const draft = await service.getOrCreate(WORKBOOK_ID, { fromSyncId: SYNC_ID } as never, ACTOR);

      expect(draft.sourceSyncId).toBe(SYNC_ID);
      expect(draft.displayName).toBe('Contacts → Airtable');
      expect(draft.schedule).toBe('0 * * * *');
      expect(draft.tableMappings).toHaveLength(1);
      const tm = draft.tableMappings[0];
      expect(tm.destination).toEqual({ kind: 'existing', dataFolderId: 'dfd_dst1' });
      expect(tm.columnMappings[0]).toEqual({
        source: { columnId: 'title' },
        destination: { kind: 'existing', columnId: 'name' },
      });
      expect(tm.recordMatching).toEqual({
        source: { columnId: 'email' },
        destination: { kind: 'existing', columnId: 'Email' },
      });
    });

    it('rejects a sync that uses a constant column mapping with 422', async () => {
      syncService.getSync.mockResolvedValue({
        id: SYNC_ID,
        workbookId: WORKBOOK_ID,
        displayName: 'x',
        mappings: {
          version: 2,
          tableMappings: [
            {
              sourceDataFolderId: 'dfd_src1',
              destinationDataFolderId: 'dfd_dst1',
              columnMappings: [{ destinationColumnId: 'status', source: { kind: 'constant', value: 'active' } }],
            },
          ],
        },
      } as never);

      await expect(service.getOrCreate(WORKBOOK_ID, { fromSyncId: SYNC_ID } as never, ACTOR)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(dbService.client.syncDraft.create).not.toHaveBeenCalled();
    });

    it('rejects a sync whose mapping carries a transformer with 422', async () => {
      syncService.getSync.mockResolvedValue({
        id: SYNC_ID,
        workbookId: WORKBOOK_ID,
        displayName: 'x',
        mappings: {
          version: 2,
          tableMappings: [
            {
              sourceDataFolderId: 'dfd_src1',
              destinationDataFolderId: 'dfd_dst1',
              columnMappings: [
                {
                  destinationColumnId: 'name',
                  source: { kind: 'column', columnId: 'title', transformer: { type: 'trim' } },
                },
              ],
            },
          ],
        },
      } as never);

      await expect(service.getOrCreate(WORKBOOK_ID, { fromSyncId: SYNC_ID } as never, ACTOR)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('404s when the source sync belongs to a different workbook', async () => {
      syncService.getSync.mockResolvedValue({
        id: SYNC_ID,
        workbookId: OTHER_WORKBOOK_ID,
        displayName: 'x',
        mappings: { version: 2, tableMappings: [] },
      } as never);

      await expect(service.getOrCreate(WORKBOOK_ID, { fromSyncId: SYNC_ID } as never, ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('get', () => {
    it('404s when the draft does not exist', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.get(DRAFT_ID, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the draft after a readable-permission check', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(makeDraftRow());
      const draft = await service.get(DRAFT_ID, ACTOR);
      expect(workbookService.assertReadableWorkbook).toHaveBeenCalledWith(ACTOR, WORKBOOK_ID);
      expect(draft.id).toBe(DRAFT_ID);
    });
  });

  describe('patch', () => {
    it('writes provided fields, increments version conditionally on the supplied version', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock)
        .mockResolvedValueOnce(makeDraftRow({ version: 3 }))
        .mockResolvedValueOnce(makeDraftRow({ version: 4, displayName: 'Renamed' }));
      (dbService.client.syncDraft.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const draft = await service.patch(DRAFT_ID, { version: 3, displayName: 'Renamed' } as never, ACTOR);

      const updateCalls = (dbService.client.syncDraft.updateMany as jest.Mock).mock.calls as Array<
        [{ where: unknown; data: { version: unknown; displayName: string } }]
      >;
      const updateArg = updateCalls[0][0];
      expect(updateArg.where).toEqual({ id: DRAFT_ID, version: 3 });
      expect(updateArg.data.version).toEqual({ increment: 1 });
      expect(updateArg.data.displayName).toBe('Renamed');
      expect(draft.version).toBe(4);
    });

    it('409s on a version conflict (0 rows updated)', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(makeDraftRow({ version: 5 }));
      (dbService.client.syncDraft.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.patch(DRAFT_ID, { version: 3 } as never, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s when the draft is archived', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(
        makeDraftRow({ archivedAt: new Date('2026-06-14T01:00:00.000Z') }),
      );
      await expect(service.patch(DRAFT_ID, { version: 1 } as never, ACTOR)).rejects.toBeInstanceOf(ConflictException);
      expect(dbService.client.syncDraft.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes after a writable-permission check', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(makeDraftRow());
      await service.delete(DRAFT_ID, ACTOR);
      expect(workbookService.assertWritableWorkbook).toHaveBeenCalledWith(ACTOR, WORKBOOK_ID);
      expect(dbService.client.syncDraft.delete).toHaveBeenCalledWith({ where: { id: DRAFT_ID } });
    });
  });

  describe('materialize', () => {
    /** A draft mapping whose destination is an unresolved placeholder table. */
    function placeholderTableDraft(destinationOverrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        ref: 'tm1',
        source: { dataFolderId: 'dfd_src' },
        destination: {
          kind: 'placeholderTable',
          ref: 'ph_contacts',
          connectorAccountId: 'coa_1',
          remoteParentId: ['base1'],
          createSpec: {
            ref: 'spec_contacts',
            name: 'Contacts',
            fields: [{ name: 'Name', fieldType: { kind: 'text' } }],
          },
          ...destinationOverrides,
        },
        columnMappings: [],
      };
    }

    it('creates an unresolved placeholder table and checkpoints the result', async () => {
      const row = makeDraftRow({ tableMappings: [placeholderTableDraft()] });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      schemaBuilderService.createTables.mockResolvedValue({
        status: 'ok',
        tables: [
          { ref: 'spec_contacts', name: 'Contacts', status: 'created', remoteTableId: ['base1', 'tbl1'], fields: [] },
        ],
      } as never);

      const res = await service.materialize(DRAFT_ID, ACTOR);

      expect(schemaBuilderService.createTables).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('ok');
      expect(res.results[0]).toMatchObject({
        ref: 'ph_contacts',
        kind: 'table',
        status: 'created',
        remoteTableId: ['base1', 'tbl1'],
      });
      expect(dbService.client.syncDraft.update).toHaveBeenCalled();
      const dest = res.draft.tableMappings[0].destination;
      expect(dest.kind === 'placeholderTable' && dest.resolved?.remoteTableId).toEqual(['base1', 'tbl1']);
    });

    it('does not re-attempt an already-resolved placeholder (noop)', async () => {
      const row = makeDraftRow({
        tableMappings: [
          placeholderTableDraft({ resolved: { remoteTableId: ['base1', 'tbl1'], actualName: 'Contacts' } }),
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);

      const res = await service.materialize(DRAFT_ID, ACTOR);

      expect(schemaBuilderService.createTables).not.toHaveBeenCalled();
      expect(res.status).toBe('noop');
      expect(res.results[0]).toMatchObject({ status: 'alreadyResolved', kind: 'table' });
    });

    it('creates field additions on an existing table', async () => {
      const row = makeDraftRow({
        tableMappings: [
          {
            ref: 'tm1',
            source: { dataFolderId: 'dfd_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_dst' },
            fieldAdditions: [{ ref: 'fa_phone', createFieldSpec: { name: 'Phone', fieldType: { kind: 'phone' } } }],
            columnMappings: [],
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({
        connectorAccountId: 'coa_1',
        tableId: ['base1', 'tbl1'],
      });
      schemaBuilderService.createFields.mockResolvedValue({
        status: 'ok',
        remoteTableId: ['base1', 'tbl1'],
        fields: [{ name: 'Phone', status: 'created', remoteFieldId: 'fld1' }],
      } as never);

      const res = await service.materialize(DRAFT_ID, ACTOR);

      expect(res.status).toBe('ok');
      expect(res.results[0]).toMatchObject({
        ref: 'fa_phone',
        kind: 'field',
        status: 'created',
        remoteFieldId: 'fld1',
      });
    });

    it('reports a failed table creation without throwing', async () => {
      const row = makeDraftRow({ tableMappings: [placeholderTableDraft()] });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      schemaBuilderService.createTables.mockResolvedValue({
        status: 'failed',
        tables: [{ ref: 'spec_contacts', name: 'Contacts', status: 'failed', fields: [], error: 'name taken' }],
      } as never);

      const res = await service.materialize(DRAFT_ID, ACTOR);

      expect(res.status).toBe('failed');
      expect(res.results[0]).toMatchObject({ status: 'failed', error: 'name taken' });
    });
  });

  describe('apply', () => {
    function makeFullSync(id: string): Record<string, unknown> {
      return {
        id,
        createdAt: new Date('2026-06-14T00:00:00.000Z'),
        updatedAt: new Date('2026-06-14T00:00:00.000Z'),
        displayName: 'x',
        displayOrder: 0,
        mappings: { version: 2, tableMappings: [] },
        syncState: 'OFF',
        syncStateLastChanged: null,
        lastSyncTime: null,
        publishAfterSync: false,
        syncTablePairs: [],
      };
    }

    it('422s when placeholders are unresolved', async () => {
      const row = makeDraftRow({
        tableMappings: [
          {
            ref: 'tm1',
            source: { dataFolderId: 'dfd_src' },
            destination: {
              kind: 'placeholderTable',
              ref: 'ph1',
              connectorAccountId: 'coa_1',
              createSpec: { ref: 's1', name: 'T', fields: [{ name: 'Name', fieldType: { kind: 'text' } }] },
            },
            columnMappings: [],
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);

      await expect(service.apply(DRAFT_ID, ACTOR)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(syncService.createSync).not.toHaveBeenCalled();
    });

    it('creates folders, resolves placeholder field refs by name, creates the sync, and archives the draft', async () => {
      const row = makeDraftRow({
        tableMappings: [
          {
            ref: 'tm1',
            source: { dataFolderId: 'dfd_src' },
            destination: {
              kind: 'placeholderTable',
              ref: 'ph1',
              connectorAccountId: 'coa_1',
              remoteParentId: ['base1'],
              createSpec: { ref: 's1', name: 'Contacts', fields: [{ name: 'Name', fieldType: { kind: 'text' } }] },
              resolved: { remoteTableId: ['base1', 'tbl1'], actualName: 'Contacts' },
            },
            columnMappings: [{ source: { columnId: 'title' }, destination: { kind: 'placeholderField', ref: 'Name' } }],
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dataFolderService.createFolder as jest.Mock).mockResolvedValue({ id: 'dfd_new' });
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: {
          type: 'object',
          properties: { fields: { type: 'object', properties: { Name: { type: 'string' } } } },
        },
      });
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));

      const sync = await service.apply(DRAFT_ID, ACTOR);

      expect(dataFolderService.createFolder).toHaveBeenCalledTimes(1);
      const folderCalls = (dataFolderService.createFolder as jest.Mock).mock.calls as Array<[{ tableId: string[] }]>;
      expect(folderCalls[0][0].tableId).toEqual(['base1', 'tbl1']);

      const createSyncCalls = (syncService.createSync as jest.Mock).mock.calls as Array<
        [
          unknown,
          {
            mappings: {
              version: number;
              tableMappings: Array<{ columnMappings: Array<{ destinationColumnId: string }> }>;
            };
          },
        ]
      >;
      const body = createSyncCalls[0][1];
      expect(body.mappings.version).toBe(2);
      expect(body.mappings.tableMappings[0].columnMappings[0].destinationColumnId.split('.').pop()).toBe('Name');

      const updateCalls = (dbService.client.syncDraft.update as jest.Mock).mock.calls as Array<
        [{ data: { appliedSyncId: string; archivedAt: Date } }]
      >;
      const archiveData = updateCalls[updateCalls.length - 1][0].data;
      expect(archiveData.appliedSyncId).toBe('syn_new');
      expect(archiveData.archivedAt).toBeInstanceOf(Date);
      expect(sync.id).toBe('syn_new');
    });

    it('updates the existing sync when sourceSyncId is set (existing mappings only)', async () => {
      const row = makeDraftRow({
        sourceSyncId: SYNC_ID,
        tableMappings: [
          {
            ref: 'tm1',
            source: { dataFolderId: 'dfd_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_dst' },
            columnMappings: [
              { source: { columnId: 'title' }, destination: { kind: 'existing', columnId: 'fields.Name' } },
            ],
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync(SYNC_ID));

      const sync = await service.apply(DRAFT_ID, ACTOR);

      expect(syncService.updateSync).toHaveBeenCalledTimes(1);
      expect(syncService.createSync).not.toHaveBeenCalled();
      expect(dataFolderService.createFolder).not.toHaveBeenCalled();
      expect(dataFolderService.fetchSchemaSpec).not.toHaveBeenCalled();
      expect(sync.id).toBe(SYNC_ID);
    });
  });
});
