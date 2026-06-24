/* eslint-disable @typescript-eslint/unbound-method */
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { SyncDraftId, SyncId, WorkbookId } from '@spinner/shared-types';
import { load as loadYaml } from 'js-yaml';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { RoutineService } from 'src/routine/routine.service';
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
  let routineService: jest.Mocked<RoutineService>;

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
        dataFolder: { findFirst: jest.fn(), findMany: jest.fn() },
        // getOrCreate runs its find-or-create inside a transaction guarded by an
        // advisory lock; the mock runs the callback against the same client.
        $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(dbService.client)),
        $executeRaw: jest.fn().mockResolvedValue(0),
      },
    } as unknown as jest.Mocked<DbService>;

    workbookService = {
      assertReadableWorkbook: jest.fn().mockResolvedValue(MOCK_WORKBOOK),
      assertWritableWorkbook: jest.fn().mockResolvedValue(MOCK_WORKBOOK),
      updateWorkbookSettings: jest.fn().mockResolvedValue(undefined),
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
      fetchSchemaFieldsForRemoteTable: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<SchemaBuilderService>;

    dataFolderService = {
      createFolder: jest.fn(),
      fetchSchemaSpec: jest.fn(),
      getSchemaPaths: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DataFolderService>;

    routineService = {
      createRoutineFile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RoutineService>;

    service = new SyncDraftService(
      dbService,
      workbookService,
      syncService,
      schemaBuilderService,
      dataFolderService,
      routineService,
    );
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

    it('carries source transformer(s) back onto the draft so a transform-bearing sync round-trips', async () => {
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
                {
                  destinationColumnId: 'notes',
                  source: {
                    kind: 'column',
                    columnId: 'bio',
                    transformers: [{ type: 'wrap_object', options: { template: { rich_text: '$value' } } }],
                  },
                },
              ],
            },
          ],
        },
      } as never);
      (dbService.client.schedule.findFirst as jest.Mock).mockResolvedValue(null);
      (dbService.client.syncDraft.create as jest.Mock).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => makeDraftRow(data),
      );

      const draft = await service.getOrCreate(WORKBOOK_ID, { fromSyncId: SYNC_ID } as never, ACTOR);
      const columnMappings = draft.tableMappings[0].columnMappings;
      // A single `transformer` normalizes to a one-element pipeline.
      expect(columnMappings[0]).toEqual({
        source: { columnId: 'title' },
        destination: { kind: 'existing', columnId: 'name' },
        transformers: [{ type: 'trim' }],
      });
      // An existing pipeline carries through unchanged.
      expect(columnMappings[1].transformers).toEqual([
        { type: 'wrap_object', options: { template: { rich_text: '$value' } } },
      ]);
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

    it('picks the sync transform for a created column from its real schema and writes it to the draft', async () => {
      const packHint = { type: 'wrap_object', options: { template: { rich_text: '$value' } } };
      const row = makeDraftRow({
        tableMappings: [
          {
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
            },
            columnMappings: [{ source: { columnId: 'title' }, destination: { kind: 'placeholderField', ref: 'Name' } }],
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      schemaBuilderService.createTables.mockResolvedValue({
        status: 'ok',
        tables: [
          { ref: 'spec_contacts', name: 'Contacts', status: 'created', remoteTableId: ['base1', 'tbl1'], fields: [] },
        ],
      } as never);
      // The freshly-created table's 'Name' field carries a pack hint (real schema).
      (schemaBuilderService.fetchSchemaFieldsForRemoteTable as jest.Mock).mockResolvedValue([
        { path: 'properties.Name', type: 'object', suggestedInTransformer: packHint },
      ]);
      // The source 'title' column is a plain string (no hint).
      (dataFolderService.getSchemaPaths as jest.Mock).mockResolvedValue([{ path: 'title', type: 'string' }]);

      const res = await service.materialize(DRAFT_ID, ACTOR);

      expect(schemaBuilderService.fetchSchemaFieldsForRemoteTable).toHaveBeenCalledWith(
        WORKBOOK_ID,
        'coa_1',
        ['base1', 'tbl1'],
        ACTOR,
      );
      expect(res.draft.tableMappings[0].columnMappings[0].transformers).toEqual([packHint]);
    });

    it('does not overwrite a transformer already on a created column', async () => {
      const existing = { type: 'trim' };
      const row = makeDraftRow({
        tableMappings: [
          {
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
            },
            columnMappings: [
              {
                source: { columnId: 'title' },
                destination: { kind: 'placeholderField', ref: 'Name' },
                transformers: [existing],
              },
            ],
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      schemaBuilderService.createTables.mockResolvedValue({
        status: 'ok',
        tables: [
          { ref: 'spec_contacts', name: 'Contacts', status: 'created', remoteTableId: ['base1', 'tbl1'], fields: [] },
        ],
      } as never);

      const res = await service.materialize(DRAFT_ID, ACTOR);

      // The column already had a transformer, so we don't even fetch its schema.
      expect(schemaBuilderService.fetchSchemaFieldsForRemoteTable).not.toHaveBeenCalled();
      expect(res.draft.tableMappings[0].columnMappings[0].transformers).toEqual([existing]);
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

    it('threads a draft column mapping transformer pipeline onto the created sync (CRM Bridge into Notion)', async () => {
      const transformers = [
        { type: 'wrap_object', options: { template: { content: '$value' } } },
        { type: 'wrap_object', options: { template: { type: 'text', text: '$value' } } },
        { type: 'auto_convert', options: { targetType: 'array' } },
        { type: 'wrap_object', options: { template: { type: 'rich_text', rich_text: '$value' } } },
      ];
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
            columnMappings: [
              { source: { columnId: 'title' }, destination: { kind: 'placeholderField', ref: 'Name' }, transformers },
            ],
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

      await service.apply(DRAFT_ID, ACTOR);

      const createSyncCalls = (syncService.createSync as jest.Mock).mock.calls as Array<
        [
          unknown,
          {
            mappings: {
              tableMappings: Array<{ columnMappings: Array<{ source: { kind: string; transformers?: unknown } }> }>;
            };
          },
        ]
      >;
      const source = createSyncCalls[0][1].mappings.tableMappings[0].columnMappings[0].source;
      expect(source.kind).toBe('column');
      expect(source.transformers).toEqual(transformers);
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

    // ── createRoutine flag ─────────────────────────────────────────────────────

    /** A new-sync draft (no sourceSyncId) with one existing source→destination mapping. */
    function existingMappingsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return makeDraftRow({
        displayName: 'Contacts Sync',
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
        ...overrides,
      });
    }

    /** The (workbookId, routineFile) arguments of the first createRoutineFile call. */
    function firstCreateRoutineCall(): [string, { path: string; content: string }] {
      const calls = (routineService.createRoutineFile as jest.Mock).mock.calls as Array<
        [string, { path: string; content: string }]
      >;
      return calls[0];
    }

    it('createRoutine: true writes a routine for the new sync and records its path on the workbook', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(existingMappingsRow());
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_src', connectorAccountId: 'coa_src' },
        { id: 'dfd_dst', connectorAccountId: 'coa_dst' },
      ]);

      const sync = await service.apply(DRAFT_ID, ACTOR, { createRoutine: true });

      expect(sync.id).toBe('syn_new');
      expect(routineService.createRoutineFile).toHaveBeenCalledTimes(1);
      const [calledWorkbookId, file] = firstCreateRoutineCall();
      expect(calledWorkbookId).toBe(WORKBOOK_ID);
      expect(file.path).toBe('routines/run-syn_new.yaml');
      const routine = loadYaml(file.content) as { name: string; steps: Array<Record<string, string>> };
      expect(routine.name).toBe('Run Sync Contacts Sync');
      expect(routine.steps).toEqual([
        { action: 'pull', name: 'Pull Source', connection: 'coa_src' },
        { action: 'pull', name: 'Pull Destination', connection: 'coa_dst' },
        { action: 'sync', name: 'Run Sync', sync: 'syn_new' },
        { action: 'publish', name: 'Publish to Destination', connection: 'coa_dst' },
      ]);

      expect(workbookService.updateWorkbookSettings).toHaveBeenCalledWith(MOCK_WORKBOOK, {
        updates: { sync_routine: 'routines/run-syn_new.yaml' },
      });
    });

    it('does not create a routine when createRoutine is not set', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(existingMappingsRow());
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));

      await service.apply(DRAFT_ID, ACTOR);

      expect(routineService.createRoutineFile).not.toHaveBeenCalled();
      expect(workbookService.updateWorkbookSettings).not.toHaveBeenCalled();
      expect(dbService.client.dataFolder.findMany).not.toHaveBeenCalled();
    });

    it('omits the pull step for a scratch (unlinked) source folder', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(existingMappingsRow());
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_src', connectorAccountId: null },
        { id: 'dfd_dst', connectorAccountId: 'coa_dst' },
      ]);

      await service.apply(DRAFT_ID, ACTOR, { createRoutine: true });

      const routine = loadYaml(firstCreateRoutineCall()[1].content) as { steps: Array<Record<string, string>> };
      expect(routine.steps.map((step) => step.name)).toEqual([
        'Pull Destination',
        'Run Sync',
        'Publish to Destination',
      ]);
    });

    it('still returns the created sync (and skips the settings write) when routine creation fails', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(existingMappingsRow());
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_src', connectorAccountId: 'coa_src' },
        { id: 'dfd_dst', connectorAccountId: 'coa_dst' },
      ]);
      (routineService.createRoutineFile as jest.Mock).mockRejectedValue(new Error('scratch-git unavailable'));

      const sync = await service.apply(DRAFT_ID, ACTOR, { createRoutine: true });

      expect(sync.id).toBe('syn_new');
      expect(workbookService.updateWorkbookSettings).not.toHaveBeenCalled();
    });

    it('still returns the created sync when recording the routine path fails', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(existingMappingsRow());
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_src', connectorAccountId: 'coa_src' },
        { id: 'dfd_dst', connectorAccountId: 'coa_dst' },
      ]);
      (workbookService.updateWorkbookSettings as jest.Mock).mockRejectedValue(new Error('db down'));

      const sync = await service.apply(DRAFT_ID, ACTOR, { createRoutine: true });

      expect(sync.id).toBe('syn_new');
      expect(routineService.createRoutineFile).toHaveBeenCalledTimes(1);
    });
  });
});
