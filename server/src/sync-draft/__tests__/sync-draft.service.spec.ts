/* eslint-disable @typescript-eslint/unbound-method */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { SyncDraftId, SyncId, WorkbookId } from '@spinner/shared-types';
import { load as loadYaml } from 'js-yaml';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { RoutineService } from 'src/routine/routine.service';
import { SchemaBuilderService } from 'src/schema-builder/schema-builder.service';
import { SyncService } from 'src/sync/sync.service';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
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
    activeSaveJobId: null,
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
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let jobService: jest.Mocked<JobService>;

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
        // findMany defaults to [] so materialize's foreignKey-resolution pass (which
        // looks up source/destination folder remote ids) is a noop unless a test sets it.
        dataFolder: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
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
      // Default: the destination supports many-to-many FKs (a link field holding a list), so FK columns
      // stay `array`. Individual tests override this to model a scalar-FK destination (Postgres/Supabase).
      getSchemaCreationCapabilitiesForConnectorAccount: jest
        .fn()
        .mockResolvedValue({ supportsManyToManyForeignKeys: true }),
    } as unknown as jest.Mocked<SchemaBuilderService>;

    dataFolderService = {
      createFolder: jest.fn(),
      fetchSchemaSpec: jest.fn(),
      getSchemaPaths: jest.fn().mockResolvedValue([]),
      getStoredView: jest.fn().mockResolvedValue(null),
      // Default: no stored git schema, so apply falls back to the live fetchSchemaSpec
      // path. Tests for the stored-schema fast path override this per test.
      getStoredSchema: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<DataFolderService>;

    routineService = {
      createRoutineFile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RoutineService>;

    bullEnqueuerService = {
      enqueueApplySyncDraftJob: jest.fn().mockResolvedValue({ id: 'apply-sync-draft-syd_test456-abc12' }),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    jobService = {
      // Default: any referenced save job has finished, so the guard/reuse paths are noops
      // unless a test sets an in-flight state.
      getJobsProgress: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<JobService>;

    service = new SyncDraftService(
      dbService,
      workbookService,
      syncService,
      schemaBuilderService,
      dataFolderService,
      routineService,
      bullEnqueuerService,
      jobService,
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

    it('carries an unmatched-destination delete policy back onto the draft (round-trips)', async () => {
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
              unmatchedSourcePolicy: { type: 'ignore' },
              unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' },
            },
          ],
        },
      } as never);
      (dbService.client.schedule.findFirst as jest.Mock).mockResolvedValue(null);
      (dbService.client.syncDraft.create as jest.Mock).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => makeDraftRow(data),
      );

      const draft = await service.getOrCreate(WORKBOOK_ID, { fromSyncId: SYNC_ID } as never, ACTOR);

      const tm = draft.tableMappings[0];
      expect(tm.unmatchedSourcePolicy).toEqual({ type: 'ignore' });
      expect(tm.unmatchedDestinationPolicy).toEqual({ withMatchKey: 'delete', withoutMatchKey: 'ignore' });
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

    it('422s when a save strands a foreignKey token whose target table was removed (force unmap)', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(makeDraftRow({ version: 1 }));
      // Only the Appointments source remains — the "contacts" source mapping was removed,
      // so the FK token can no longer resolve.
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([{ tableId: ['0-421'] }]);

      const dto = {
        version: 1,
        tableMappings: [
          {
            ref: 'tm_appt',
            source: { dataFolderId: 'dfd_appt_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_appt_dst' },
            fieldAdditions: [
              {
                ref: 'fa_contacts',
                createFieldSpec: {
                  name: 'Associated Contacts',
                  fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } },
                },
              },
            ],
            columnMappings: [],
          },
        ],
      };

      const error = await service.patch(DRAFT_ID, dto as never, ACTOR).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
        error: 'SYNC_DRAFT_FK_TARGET_MISSING',
        missingTargets: [
          {
            tableMappingRef: 'tm_appt',
            fieldName: 'Associated Contacts',
            target: { unresolvedLinkedTableId: 'contacts' },
          },
        ],
      });
      expect(dbService.client.syncDraft.updateMany).not.toHaveBeenCalled();
    });

    it('allows the save when the foreignKey token still resolves to a mapped table', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock)
        .mockResolvedValueOnce(makeDraftRow({ version: 1 }))
        .mockResolvedValueOnce(makeDraftRow({ version: 2 }));
      (dbService.client.syncDraft.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      // The Contacts source mapping is present → its remote id "contacts" satisfies the token.
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { tableId: ['0-421'] },
        { tableId: ['contacts'] },
      ]);

      const dto = {
        version: 1,
        tableMappings: [
          {
            ref: 'tm_appt',
            source: { dataFolderId: 'dfd_appt_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_appt_dst' },
            fieldAdditions: [
              {
                ref: 'fa_contacts',
                createFieldSpec: {
                  name: 'Associated Contacts',
                  fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } },
                },
              },
            ],
            columnMappings: [],
          },
          {
            ref: 'tm_contacts',
            source: { dataFolderId: 'dfd_contacts_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_contacts_dst' },
            columnMappings: [],
          },
        ],
      };

      await expect(service.patch(DRAFT_ID, dto as never, ACTOR)).resolves.toBeDefined();
      expect(dbService.client.syncDraft.updateMany).toHaveBeenCalled();
    });

    it('422s on a foreignKey { ref } that matches no placeholder table in the draft', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(makeDraftRow({ version: 1 }));
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([{ tableId: ['0-421'] }]);

      const dto = {
        version: 1,
        tableMappings: [
          {
            ref: 'tm_appt',
            source: { dataFolderId: 'dfd_appt_src' },
            destination: {
              kind: 'placeholderTable',
              ref: 'ph_appt',
              connectorAccountId: 'coa_1',
              createSpec: {
                ref: 'spec_appt',
                name: 'Appointments',
                fields: [
                  { name: 'Name', fieldType: { kind: 'text' } },
                  { name: 'Linked', fieldType: { kind: 'foreignKey', target: { ref: 'spec_contacts' } } },
                ],
              },
            },
            columnMappings: [],
          },
        ],
      };

      await expect(service.patch(DRAFT_ID, dto as never, ACTOR)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(dbService.client.syncDraft.updateMany).not.toHaveBeenCalled();
    });

    it('allows a foreignKey targeting an existing remote table regardless of draft contents', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock)
        .mockResolvedValueOnce(makeDraftRow({ version: 1 }))
        .mockResolvedValueOnce(makeDraftRow({ version: 2 }));
      (dbService.client.syncDraft.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([{ tableId: ['0-421'] }]);

      const dto = {
        version: 1,
        tableMappings: [
          {
            ref: 'tm_appt',
            source: { dataFolderId: 'dfd_appt_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_appt_dst' },
            fieldAdditions: [
              {
                ref: 'fa_link',
                createFieldSpec: {
                  name: 'Linked',
                  fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['base1', 'tblOther'] } },
                },
              },
            ],
            columnMappings: [],
          },
        ],
      };

      await expect(service.patch(DRAFT_ID, dto as never, ACTOR)).resolves.toBeDefined();
      expect(dbService.client.syncDraft.updateMany).toHaveBeenCalled();
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

    it('ticks onPlaceholderCreatedInBatch with the DRAFT placeholder ref as each table lands mid-batch (DEV-10875)', async () => {
      const row = makeDraftRow({ tableMappings: [placeholderTableDraft()] });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (schemaBuilderService.createTables as jest.Mock).mockImplementation(
        async (_workbookId, _dto, _actor, progressOptions: { onTableResult?: (result: unknown) => Promise<void> }) => {
          // The schema builder notifies per table as each creation lands; the materializer must
          // translate the createSpec ref ('spec_contacts') to the draft placeholder ref.
          await progressOptions?.onTableResult?.({
            ref: 'spec_contacts',
            name: 'Contacts',
            status: 'created',
            remoteTableId: ['base1', 'tbl1'],
            fields: [],
          });
          return {
            status: 'ok',
            tables: [
              {
                ref: 'spec_contacts',
                name: 'Contacts',
                status: 'created',
                remoteTableId: ['base1', 'tbl1'],
                fields: [],
              },
            ],
          };
        },
      );

      const tickedPlaceholderRefs: string[] = [];
      const res = await service.materialize(DRAFT_ID, ACTOR, {
        onPlaceholderCreatedInBatch: (placeholderRef) => {
          tickedPlaceholderRefs.push(placeholderRef);
        },
      });

      expect(tickedPlaceholderRefs).toEqual(['ph_contacts']);
      expect(res.status).toBe('ok');
    });

    it('binds pending foreignKey targets to sibling placeholders before create; leaves truly-unbound ones pending', async () => {
      // Appointments links to two HubSpot object types: "contacts" (also being created
      // in this draft → resolves to a sibling ref) and "deals" (absent → stays pending,
      // so createTables surfaces the requirement instead of the FK being dropped).
      const tableMappings = [
        {
          ref: 'tm_appt',
          source: { dataFolderId: 'dfd_appointments' },
          destination: {
            kind: 'placeholderTable',
            ref: 'ph_appointments',
            connectorAccountId: 'coa_1',
            remoteParentId: ['base1'],
            createSpec: {
              ref: 'spec_appointments',
              name: 'Appointments',
              fields: [
                { name: 'Name', fieldType: { kind: 'text' } },
                {
                  name: 'Associated Contacts',
                  fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } },
                },
                {
                  name: 'Associated Deals',
                  fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'deals' } },
                },
              ],
            },
          },
          columnMappings: [],
        },
        {
          ref: 'tm_contacts',
          source: { dataFolderId: 'dfd_contacts' },
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
          columnMappings: [],
        },
      ];
      const row = makeDraftRow({ tableMappings });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      // The Contacts source folder's remote table id is "contacts" — what the FK points
      // at. No "deals" source exists in the draft.
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_appointments', tableId: ['0-421'] },
        { id: 'dfd_contacts', tableId: ['contacts'] },
      ]);
      schemaBuilderService.createTables.mockResolvedValue({
        status: 'ok',
        tables: [
          {
            ref: 'spec_appointments',
            name: 'Appointments',
            status: 'created',
            remoteTableId: ['base1', 'tblA'],
            fields: [],
          },
          { ref: 'spec_contacts', name: 'Contacts', status: 'created', remoteTableId: ['base1', 'tblC'], fields: [] },
        ],
      } as never);

      await service.materialize(DRAFT_ID, ACTOR);

      const dto = schemaBuilderService.createTables.mock.calls[0][1];
      const appointmentsSpec = dto.tables.find((table) => table.ref === 'spec_appointments');
      const contactsFk = appointmentsSpec?.fields.find((field) => field.name === 'Associated Contacts');
      const dealsFk = appointmentsSpec?.fields.find((field) => field.name === 'Associated Deals');
      // The sibling Contacts table binds to its create-spec ref (the existing topological
      // ordering in createTables then creates it first)...
      expect(contactsFk?.fieldType).toEqual({ kind: 'foreignKey', target: { ref: 'spec_contacts' } });
      // ...while a link to a table not in the draft is left pending for createTables to reject.
      expect(dealsFk?.fieldType).toEqual({ kind: 'foreignKey', target: { unresolvedLinkedTableId: 'deals' } });
    });

    it('binds a foreignKey to an ALREADY-RESOLVED sibling by its remote id, not a dangling ref', async () => {
      // Regression: on a re-run, the sibling target (Contacts) was materialized in a PRIOR run,
      // so it is skipped from this create batch. A `{ ref }` would dangle (the connector then
      // silently drops the FK field); it must bind to the sibling's real remote id instead.
      const tableMappings = [
        {
          ref: 'tm_appt',
          source: { dataFolderId: 'dfd_appointments' },
          destination: {
            kind: 'placeholderTable',
            ref: 'ph_appointments',
            connectorAccountId: 'coa_1',
            remoteParentId: ['base1'],
            createSpec: {
              ref: 'spec_appointments',
              name: 'Appointments',
              fields: [
                { name: 'Name', fieldType: { kind: 'text' } },
                {
                  name: 'Associated Contacts',
                  fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } },
                },
              ],
            },
          },
          columnMappings: [],
        },
        {
          ref: 'tm_contacts',
          source: { dataFolderId: 'dfd_contacts' },
          destination: {
            kind: 'placeholderTable',
            ref: 'ph_contacts',
            connectorAccountId: 'coa_1',
            remoteParentId: ['base1'],
            // Already materialized in a prior run → carries a resolved remote table id.
            resolved: { actualName: 'Contacts', dataFolderId: 'dfd_contacts_dst', remoteTableId: ['base1', 'tblC'] },
            createSpec: {
              ref: 'spec_contacts',
              name: 'Contacts',
              fields: [{ name: 'Name', fieldType: { kind: 'text' } }],
            },
          },
          columnMappings: [],
        },
      ];
      const row = makeDraftRow({ tableMappings });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_appointments', tableId: ['0-421'] },
        { id: 'dfd_contacts', tableId: ['contacts'] },
      ]);
      schemaBuilderService.createTables.mockResolvedValue({
        status: 'ok',
        tables: [
          {
            ref: 'spec_appointments',
            name: 'Appointments',
            status: 'created',
            remoteTableId: ['base1', 'tblA'],
            fields: [],
          },
        ],
      } as never);

      await service.materialize(DRAFT_ID, ACTOR);

      const dto = schemaBuilderService.createTables.mock.calls[0][1];
      const appointmentsSpec = dto.tables.find((table) => table.ref === 'spec_appointments');
      const contactsFk = appointmentsSpec?.fields.find((field) => field.name === 'Associated Contacts');
      // Bound to the resolved sibling's real remote id — NOT a { ref } that would dangle in this batch.
      expect(contactsFk?.fieldType).toEqual({
        kind: 'foreignKey',
        target: { existingRemoteTableId: ['base1', 'tblC'] },
      });
    });

    it('surfaces the create-schema issue message (not the generic one) on a failed table', async () => {
      const row = makeDraftRow({ tableMappings: [placeholderTableDraft()] });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      // createTables rejects with the structured create-schema validation error.
      schemaBuilderService.createTables.mockRejectedValue(
        new BadRequestException({
          message: 'create-schema validation failed',
          issues: [
            {
              code: 'FIELD_NAME_ALREADY_EXISTS',
              message: 'a field named "Country" already exists on the target table',
              path: 'fields[0].name',
            },
          ],
        }),
      );

      const res = await service.materialize(DRAFT_ID, ACTOR);

      expect(res.results[0]).toMatchObject({
        ref: 'ph_contacts',
        kind: 'table',
        status: 'failed',
        error: 'a field named "Country" already exists on the target table',
      });
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
      // The source 'title' column is a plain string (no hint). The value picker now reads the source's
      // RAW schema (via fetchSchemaSpec + the View-keyed resolver), not the flattened getSchemaPaths.
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: { type: 'object', properties: { title: { type: 'string' } } },
      });

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

    it('binds a field-addition foreignKey token to an existing destination table in the draft', async () => {
      // Add "Associated Contacts" (FK → "contacts") to an EXISTING Appointments table.
      // A Contacts table mapping in the same draft (source = the HubSpot Contacts
      // object) supplies the binding, so the pending token resolves to the existing
      // Airtable Contacts table — field additions can only take an existingRemoteTableId.
      const row = makeDraftRow({
        tableMappings: [
          {
            ref: 'tm_appt',
            source: { dataFolderId: 'dfd_appt_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_appt_dst' },
            fieldAdditions: [
              {
                ref: 'fa_contacts',
                createFieldSpec: {
                  name: 'Associated Contacts',
                  fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'contacts' } },
                },
              },
            ],
            columnMappings: [],
          },
          {
            ref: 'tm_contacts',
            source: { dataFolderId: 'dfd_contacts_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_contacts_dst' },
            columnMappings: [],
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_appt_src', tableId: ['0-421'] },
        { id: 'dfd_appt_dst', tableId: ['base1', 'tblAppt'] },
        { id: 'dfd_contacts_src', tableId: ['contacts'] },
        { id: 'dfd_contacts_dst', tableId: ['base1', 'tblContacts'] },
      ]);
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({
        connectorAccountId: 'coa_1',
        tableId: ['base1', 'tblAppt'],
      });
      schemaBuilderService.createFields.mockResolvedValue({
        status: 'ok',
        remoteTableId: ['base1', 'tblAppt'],
        fields: [{ name: 'Associated Contacts', status: 'created', remoteFieldId: 'fld_assoc' }],
      } as never);

      const res = await service.materialize(DRAFT_ID, ACTOR);

      expect(res.results.find((result) => result.ref === 'fa_contacts')).toMatchObject({ status: 'created' });
      // The pending token was bound to the existing Airtable Contacts table BEFORE createFields.
      const dto = schemaBuilderService.createFields.mock.calls[0][1];
      expect(dto.fields[0].fieldType).toEqual({
        kind: 'foreignKey',
        target: { existingRemoteTableId: ['base1', 'tblContacts'] },
      });
    });

    it('attaches the id-extraction + source_fk_to_dest_fk pipeline to an FK column whose related table is synced', async () => {
      // Appointments' "Associated Companies" FK points at the companies object, which is
      // ALSO synced (the Companies table mapping) — so materialize should wire the column
      // to extract the association ids and resolve them to destination linked records.
      const tableMappings = [
        {
          ref: 'tm_appt',
          source: { dataFolderId: 'dfd_appt_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_appt_dst' },
          fieldAdditions: [
            {
              ref: 'fa_companies',
              createFieldSpec: {
                name: 'Associated Companies',
                fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'companies' } },
              },
            },
          ],
          columnMappings: [
            {
              source: { columnId: 'associations.companies.results' },
              destination: { kind: 'placeholderField', ref: 'fa_companies' },
            },
          ],
        },
        {
          ref: 'tm_comp',
          source: { dataFolderId: 'dfd_comp_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_comp_dst' },
          columnMappings: [
            { source: { columnId: 'id' }, destination: { kind: 'existing', columnId: 'fields.hubspot_record_id' } },
          ],
        },
      ];
      const row = makeDraftRow({ tableMappings });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.syncDraft.update as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_appt_src', tableId: ['0-421'] },
        { id: 'dfd_appt_dst', tableId: ['base1', 'tblAppt'] },
        { id: 'dfd_comp_src', tableId: ['companies'] },
        { id: 'dfd_comp_dst', tableId: ['base1', 'tblComp'] },
      ]);
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({
        connectorAccountId: 'coa_1',
        tableId: ['base1', 'tblAppt'],
      });
      schemaBuilderService.createFields.mockResolvedValue({
        status: 'ok',
        remoteTableId: ['base1', 'tblAppt'],
        fields: [{ name: 'Associated Companies', status: 'created', remoteFieldId: 'fld_assoc' }],
      } as never);
      // The source view flattens the association array to its ids via `$[*].id`.
      (dataFolderService.getStoredView as jest.Mock).mockResolvedValue({
        name: 'Default',
        cols: [
          {
            kind: 'col',
            path: 'associations.companies.results',
            name: 'Associated Companies',
            displayTransformer: { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'join_comma' } },
          },
        ],
      });
      // The FK id-extraction resolves the source column View-first; the resolver needs the source's raw
      // schema loaded (the id-extraction expression itself comes from the view displayTransformer above).
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: { type: 'object', properties: {} },
      });

      const res = await service.materialize(DRAFT_ID, ACTOR);

      const apptMapping = res.draft.tableMappings.find((tableMapping) => tableMapping.ref === 'tm_appt');
      const fkColumn = apptMapping?.columnMappings.find(
        (columnMapping) => columnMapping.source.columnId === 'associations.companies.results',
      );
      expect(fkColumn?.transformers).toEqual([
        { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'array' } },
        { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: 'dfd_comp_src', outputType: 'array' } },
      ]);
    });

    it('attaches the FK pipeline for a `{ ref }` target pointing at a sibling placeholder table (DEV-10954)', async () => {
      // Two placeholder tables created in the SAME draft: Appointments' "Associated Companies"
      // FK targets the Companies sibling via `{ ref: 'spec_comp' }` (a shape the draft DTO
      // admits and materialize creates the relation for). The FK-transformer pass must resolve
      // that ref → the sibling mapping's SOURCE folder (dfd_comp_src) and attach the resolution
      // pipeline — otherwise raw source ids are published into the relation (the bug).
      const tableMappings = [
        {
          ref: 'tm_appt',
          source: { dataFolderId: 'dfd_appt_src' },
          destination: {
            kind: 'placeholderTable',
            ref: 'ph_appt',
            connectorAccountId: 'coa_1',
            remoteParentId: ['base1'],
            createSpec: {
              ref: 'spec_appt',
              name: 'Appointments',
              fields: [
                { name: 'Name', fieldType: { kind: 'text' } },
                { name: 'Associated Companies', fieldType: { kind: 'foreignKey', target: { ref: 'spec_comp' } } },
              ],
            },
          },
          columnMappings: [
            {
              source: { columnId: 'associations.companies.results' },
              destination: { kind: 'placeholderField', ref: 'Associated Companies' },
            },
          ],
        },
        {
          ref: 'tm_comp',
          source: { dataFolderId: 'dfd_comp_src' },
          destination: {
            kind: 'placeholderTable',
            ref: 'ph_comp',
            connectorAccountId: 'coa_1',
            remoteParentId: ['base1'],
            createSpec: {
              ref: 'spec_comp',
              name: 'Companies',
              fields: [{ name: 'Name', fieldType: { kind: 'text' } }],
            },
          },
          columnMappings: [],
        },
      ];
      const row = makeDraftRow({ tableMappings });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.syncDraft.update as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_appt_src', tableId: ['0-421'] },
        { id: 'dfd_comp_src', tableId: ['companies'] },
      ]);
      schemaBuilderService.createTables.mockResolvedValue({
        status: 'ok',
        tables: [
          {
            ref: 'spec_appt',
            name: 'Appointments',
            status: 'created',
            remoteTableId: ['base1', 'tblAppt'],
            fields: [],
          },
          { ref: 'spec_comp', name: 'Companies', status: 'created', remoteTableId: ['base1', 'tblComp'], fields: [] },
        ],
      } as never);
      (dataFolderService.getStoredView as jest.Mock).mockResolvedValue({
        name: 'Default',
        cols: [
          {
            kind: 'col',
            path: 'associations.companies.results',
            name: 'Associated Companies',
            displayTransformer: { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'join_comma' } },
          },
        ],
      });
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: { type: 'object', properties: {} },
      });

      const res = await service.materialize(DRAFT_ID, ACTOR);

      const apptMapping = res.draft.tableMappings.find((tableMapping) => tableMapping.ref === 'tm_appt');
      const fkColumn = apptMapping?.columnMappings.find(
        (columnMapping) => columnMapping.source.columnId === 'associations.companies.results',
      );
      expect(fkColumn?.transformers).toEqual([
        { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'array' } },
        { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: 'dfd_comp_src', outputType: 'array' } },
      ]);
    });

    it('attaches the FK pipeline for an `{ existingRemoteTableId }` target that a sibling mapping syncs (Attio → Supabase)', async () => {
      // The Attio→Supabase create-destination bug: People's "Company" FK was persisted with a
      // concrete `{ existingRemoteTableId }` target (the already-provisioned Supabase companies
      // table) rather than a sibling `{ ref }`. That table IS synced here — the Companies table
      // mapping's destination folder points at the same remote table — so the FK-transformer pass
      // must resolve the target → that sibling's SOURCE folder (dfd_comp_src) and attach the
      // resolution pipeline. Without it, the raw Attio `target_record_id` is published straight
      // into the Postgres FK column and Supabase rejects it (foreign key constraint).
      const tableMappings = [
        {
          ref: 'tm_people',
          source: { dataFolderId: 'dfd_people_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_people_dst' },
          fieldAdditions: [
            {
              ref: 'fa_company',
              createFieldSpec: {
                name: 'Company',
                fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['public', 'companies'] } },
              },
            },
          ],
          columnMappings: [
            {
              source: { columnId: 'values.company' },
              destination: { kind: 'placeholderField', ref: 'fa_company' },
            },
          ],
        },
        {
          ref: 'tm_comp',
          source: { dataFolderId: 'dfd_comp_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_comp_dst' },
          columnMappings: [],
        },
      ];
      const row = makeDraftRow({ tableMappings });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.syncDraft.update as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_people_src', tableId: ['people'] },
        { id: 'dfd_people_dst', tableId: ['public', 'people'] },
        { id: 'dfd_comp_src', tableId: ['companies'] },
        // The sibling Companies mapping's destination resolves to the SAME remote table the FK targets.
        { id: 'dfd_comp_dst', tableId: ['public', 'companies'] },
      ]);
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({
        connectorAccountId: 'coa_1',
        tableId: ['public', 'people'],
      });
      schemaBuilderService.createFields.mockResolvedValue({
        status: 'ok',
        remoteTableId: ['public', 'people'],
        fields: [{ name: 'Company', status: 'created', remoteFieldId: 'company' }],
      } as never);
      (dataFolderService.getStoredView as jest.Mock).mockResolvedValue({
        name: 'Default',
        cols: [
          {
            kind: 'col',
            path: 'values.company',
            name: 'Company',
            displayTransformer: {
              type: 'jsonpath',
              options: { expression: '$[*].target_record_id', arrayHandling: 'join_comma' },
            },
          },
        ],
      });
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: { type: 'object', properties: {} },
      });

      const res = await service.materialize(DRAFT_ID, ACTOR);

      const peopleMapping = res.draft.tableMappings.find((tableMapping) => tableMapping.ref === 'tm_people');
      const fkColumn = peopleMapping?.columnMappings.find(
        (columnMapping) => columnMapping.source.columnId === 'values.company',
      );
      expect(fkColumn?.transformers).toEqual([
        { type: 'jsonpath', options: { expression: '$[*].target_record_id', arrayHandling: 'array' } },
        { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: 'dfd_comp_src', outputType: 'array' } },
      ]);
    });

    it('appends the destination pack after source_fk_to_dest_fk when the created FK field declares one (Notion relation)', async () => {
      // Same shape as the pipeline test above, but the destination schema's created FK field
      // carries an `x-scratch-suggested-in-transformer` pack (Notion relation: ids → [{id}] →
      // {type:'relation', relation:[...]}). Without the pack the raw id array lands verbatim in
      // the relation property and Notion rejects the write (DEV-10942).
      const notionRelationPack = {
        type: 'map_array',
        options: {
          elementTransformer: { type: 'wrap_object', options: { template: { id: '$value' } } },
          resultTemplate: { type: 'relation', relation: '$value' },
        },
      };
      const tableMappings = [
        {
          ref: 'tm_appt',
          source: { dataFolderId: 'dfd_appt_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_appt_dst' },
          fieldAdditions: [
            {
              ref: 'fa_companies',
              createFieldSpec: {
                name: 'Associated Companies',
                fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'companies' } },
              },
            },
          ],
          columnMappings: [
            {
              source: { columnId: 'associations.companies.results' },
              destination: { kind: 'placeholderField', ref: 'fa_companies' },
            },
          ],
        },
        {
          ref: 'tm_comp',
          source: { dataFolderId: 'dfd_comp_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_comp_dst' },
          columnMappings: [
            { source: { columnId: 'id' }, destination: { kind: 'existing', columnId: 'fields.hubspot_record_id' } },
          ],
        },
      ];
      const row = makeDraftRow({ tableMappings });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.syncDraft.update as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_appt_src', tableId: ['0-421'] },
        { id: 'dfd_appt_dst', tableId: ['base1', 'tblAppt'] },
        { id: 'dfd_comp_src', tableId: ['companies'] },
        { id: 'dfd_comp_dst', tableId: ['base1', 'tblComp'] },
      ]);
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({
        connectorAccountId: 'coa_1',
        tableId: ['base1', 'tblAppt'],
      });
      schemaBuilderService.createFields.mockResolvedValue({
        status: 'ok',
        remoteTableId: ['base1', 'tblAppt'],
        fields: [{ name: 'Associated Companies', status: 'created', remoteFieldId: 'fld_assoc' }],
      } as never);
      (dataFolderService.getStoredView as jest.Mock).mockResolvedValue({
        name: 'Default',
        cols: [
          {
            kind: 'col',
            path: 'associations.companies.results',
            name: 'Associated Companies',
            displayTransformer: { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'join_comma' } },
          },
        ],
      });
      // One fetchSchemaSpec mock serves both the source context and the destination fields:
      // the destination's created FK field carries the remote field id + the relation pack.
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: {
          type: 'object',
          properties: {
            'Associated Companies': {
              type: 'object',
              'x-scratch-remote-field-id': 'fld_assoc',
              'x-scratch-suggested-in-transformer': notionRelationPack,
            },
          },
        },
      });

      const res = await service.materialize(DRAFT_ID, ACTOR);

      const apptMapping = res.draft.tableMappings.find((tableMapping) => tableMapping.ref === 'tm_appt');
      const fkColumn = apptMapping?.columnMappings.find(
        (columnMapping) => columnMapping.source.columnId === 'associations.companies.results',
      );
      expect(fkColumn?.transformers).toEqual([
        { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'array' } },
        { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: 'dfd_comp_src', outputType: 'array' } },
        notionRelationPack,
      ]);
    });

    it('emits outputType `single` for an FK column whose destination connector holds a scalar foreign key', async () => {
      // Same shape as the array case above, but the destination is a Postgres-like connector whose foreignKey
      // is a single scalar column (supportsManyToManyForeignKeys: false). A scalar column can't hold a list, so
      // the FK pipeline must resolve to a single value (the first linked id) instead of an array — otherwise an
      // empty association serializes to the `{}` array literal a `uuid` column rejects at publish.
      const tableMappings = [
        {
          ref: 'tm_appt',
          source: { dataFolderId: 'dfd_appt_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_appt_dst' },
          fieldAdditions: [
            {
              ref: 'fa_companies',
              createFieldSpec: {
                name: 'Associated Companies',
                fieldType: { kind: 'foreignKey', target: { unresolvedLinkedTableId: 'companies' } },
              },
            },
          ],
          columnMappings: [
            {
              source: { columnId: 'associations.companies.results' },
              destination: { kind: 'placeholderField', ref: 'fa_companies' },
            },
          ],
        },
        {
          ref: 'tm_comp',
          source: { dataFolderId: 'dfd_comp_src' },
          destination: { kind: 'existing', dataFolderId: 'dfd_comp_dst' },
          columnMappings: [
            { source: { columnId: 'id' }, destination: { kind: 'existing', columnId: 'hubspot_record_id' } },
          ],
        },
      ];
      const row = makeDraftRow({ tableMappings });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (dbService.client.syncDraft.update as jest.Mock).mockResolvedValue(row);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfd_appt_src', tableId: ['0-421'], connectorAccountId: 'coa_src' },
        { id: 'dfd_appt_dst', tableId: ['base1', 'Appointments'], connectorAccountId: 'coa_pg' },
        { id: 'dfd_comp_src', tableId: ['companies'], connectorAccountId: 'coa_src' },
        { id: 'dfd_comp_dst', tableId: ['base1', 'Companies'], connectorAccountId: 'coa_pg' },
      ]);
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({
        connectorAccountId: 'coa_pg',
        tableId: ['base1', 'Appointments'],
      });
      schemaBuilderService.createFields.mockResolvedValue({
        status: 'ok',
        remoteTableId: ['base1', 'Appointments'],
        fields: [{ name: 'Associated Companies', status: 'created', remoteFieldId: 'fld_assoc' }],
      } as never);
      // The destination connector's FK is a single scalar column — it can't represent a two-way N→N link.
      (schemaBuilderService.getSchemaCreationCapabilitiesForConnectorAccount as jest.Mock).mockResolvedValue({
        supportsManyToManyForeignKeys: false,
      });
      (dataFolderService.getStoredView as jest.Mock).mockResolvedValue({
        name: 'Default',
        cols: [
          {
            kind: 'col',
            path: 'associations.companies.results',
            name: 'Associated Companies',
            displayTransformer: { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'join_comma' } },
          },
        ],
      });
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: { type: 'object', properties: {} },
      });

      const res = await service.materialize(DRAFT_ID, ACTOR);

      const apptMapping = res.draft.tableMappings.find((tableMapping) => tableMapping.ref === 'tm_appt');
      const fkColumn = apptMapping?.columnMappings.find(
        (columnMapping) => columnMapping.source.columnId === 'associations.companies.results',
      );
      expect(fkColumn?.transformers).toEqual([
        { type: 'jsonpath', options: { expression: '$[*].id', arrayHandling: 'array' } },
        { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: 'dfd_comp_src', outputType: 'single' } },
      ]);
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
      // The just-created folder's schema was written to git by createFolder, so apply
      // resolves the created field from the STORED copy — no second live connector fetch.
      (dataFolderService.getStoredSchema as jest.Mock).mockResolvedValue({
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
      expect(dataFolderService.fetchSchemaSpec).not.toHaveBeenCalled();

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

    it('threads the unmatched-destination delete policy onto the created sync', async () => {
      const row = makeDraftRow({
        tableMappings: [
          {
            ref: 'tm1',
            source: { dataFolderId: 'dfd_src' },
            destination: { kind: 'existing', dataFolderId: 'dfd_dst' },
            columnMappings: [{ source: { columnId: 'title' }, destination: { kind: 'existing', columnId: 'name' } }],
            recordMatching: {
              source: { columnId: 'email' },
              destination: { kind: 'existing', columnId: 'Email' },
            },
            unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' },
          },
        ],
      });
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(row);
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));

      await service.apply(DRAFT_ID, ACTOR);

      const createSyncCalls = (syncService.createSync as jest.Mock).mock.calls as Array<
        [unknown, { mappings: { tableMappings: Array<{ unmatchedDestinationPolicy?: unknown }> } }]
      >;
      expect(createSyncCalls[0][1].mappings.tableMappings[0].unmatchedDestinationPolicy).toEqual({
        withMatchKey: 'delete',
        withoutMatchKey: 'ignore',
      });
    });

    it('threads a draft column mapping transformer pipeline onto the created sync (CRM Mirror into Notion)', async () => {
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
      // getStoredSchema stays at its default null here, so this also covers the
      // fallback: a missing stored copy falls through to the live fetchSchemaSpec.
      (dataFolderService.fetchSchemaSpec as jest.Mock).mockResolvedValue({
        schema: {
          type: 'object',
          properties: { fields: { type: 'object', properties: { Name: { type: 'string' } } } },
        },
      });
      (syncService.createSync as jest.Mock).mockResolvedValue({ id: 'syn_new' });
      (syncService.getSyncForExecution as jest.Mock).mockResolvedValue(makeFullSync('syn_new'));

      await service.apply(DRAFT_ID, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledTimes(1);
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
      const routine = loadYaml(file.content) as { name: string; steps: Array<Record<string, unknown>> };
      expect(routine.name).toBe('Run Sync Contacts Sync');
      expect(routine.steps).toEqual([
        {
          action: 'discard-pending-changes',
          name: 'Prepare workspace for sync',
          comment: 'Pre-flight: clear any leftover unpublished edits so the sync starts from a clean slate.',
        },
        // Both pulls are full: only a full pull reconciles upstream deletions into the sync.
        { action: 'pull', name: 'Pull Source', connection: 'coa_src', options: { fullPull: true } },
        { action: 'pull', name: 'Pull Destination', connection: 'coa_dst', options: { fullPull: true } },
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
        'Prepare workspace for sync',
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

  describe('save (background job, DEV-10875)', () => {
    it('enqueues the apply-sync-draft job, stores its id on the draft, and returns 202-style { jobId }', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(makeDraftRow());
      (dbService.client.syncDraft.update as jest.Mock).mockResolvedValue(makeDraftRow());

      const response = await service.save(DRAFT_ID, { createRoutine: true }, ACTOR);

      expect(workbookService.assertWritableWorkbook).toHaveBeenCalledWith(ACTOR, WORKBOOK_ID);
      expect(bullEnqueuerService.enqueueApplySyncDraftJob).toHaveBeenCalledWith(
        WORKBOOK_ID,
        DRAFT_ID,
        ACTOR,
        { createRoutine: true },
        expect.objectContaining({ trigger: 'web' }),
      );
      expect(response.jobId).toBe('apply-sync-draft-syd_test456-abc12');
      expect(dbService.client.syncDraft.update).toHaveBeenCalledWith({
        where: { id: DRAFT_ID },
        data: { activeSaveJobId: 'apply-sync-draft-syd_test456-abc12' },
      });
    });

    it('returns the running save job id instead of enqueuing a second job (single-flight)', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(
        makeDraftRow({ activeSaveJobId: 'bull-running-1' }),
      );
      (jobService.getJobsProgress as jest.Mock).mockResolvedValue([{ state: 'active' }]);

      const response = await service.save(DRAFT_ID, {}, ACTOR);

      expect(response.jobId).toBe('bull-running-1');
      expect(bullEnqueuerService.enqueueApplySyncDraftJob).not.toHaveBeenCalled();
      expect(dbService.client.syncDraft.update).not.toHaveBeenCalled();
    });

    it('replaces a stale activeSaveJobId (finished or vanished job) with a fresh enqueue', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(
        makeDraftRow({ activeSaveJobId: 'bull-finished-1' }),
      );
      (jobService.getJobsProgress as jest.Mock).mockResolvedValue([{ state: 'failed' }]);
      (dbService.client.syncDraft.update as jest.Mock).mockResolvedValue(makeDraftRow());

      const response = await service.save(DRAFT_ID, {}, ACTOR);

      expect(bullEnqueuerService.enqueueApplySyncDraftJob).toHaveBeenCalledTimes(1);
      expect(response.jobId).toBe('apply-sync-draft-syd_test456-abc12');
    });

    it('409s on an archived draft', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(
        makeDraftRow({ archivedAt: new Date('2026-06-15T00:00:00.000Z') }),
      );

      await expect(service.save(DRAFT_ID, {}, ACTOR)).rejects.toThrow(ConflictException);
      expect(bullEnqueuerService.enqueueApplySyncDraftJob).not.toHaveBeenCalled();
    });

    it('materialize 409s SYNC_DRAFT_SAVE_IN_PROGRESS while a save job is running, unless called by the job itself', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(
        makeDraftRow({ activeSaveJobId: 'bull-running-1' }),
      );
      (jobService.getJobsProgress as jest.Mock).mockResolvedValue([{ state: 'active' }]);

      await expect(service.materialize(DRAFT_ID, ACTOR)).rejects.toMatchObject({
        response: { error: 'SYNC_DRAFT_SAVE_IN_PROGRESS', jobId: 'bull-running-1' },
      });

      // The job's own call bypasses the guard (empty draft → noop materialize).
      const response = await service.materialize(DRAFT_ID, ACTOR, { calledByActiveSaveJob: true });
      expect(response.status).toBe('noop');
    });

    it('apply 409s SYNC_DRAFT_SAVE_IN_PROGRESS while a save job is running', async () => {
      (dbService.client.syncDraft.findFirst as jest.Mock).mockResolvedValue(
        makeDraftRow({ activeSaveJobId: 'bull-running-1' }),
      );
      (jobService.getJobsProgress as jest.Mock).mockResolvedValue([{ state: 'waiting' }]);

      await expect(service.apply(DRAFT_ID, ACTOR)).rejects.toMatchObject({
        response: { error: 'SYNC_DRAFT_SAVE_IN_PROGRESS', jobId: 'bull-running-1' },
      });
    });

    it('clearActiveSaveJobIdIfOwnedByJob clears only when the id still points at that job', async () => {
      (dbService.client.syncDraft.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.clearActiveSaveJobIdIfOwnedByJob(DRAFT_ID, 'bull-running-1');

      expect(dbService.client.syncDraft.updateMany).toHaveBeenCalledWith({
        where: { id: DRAFT_ID, activeSaveJobId: 'bull-running-1' },
        data: { activeSaveJobId: null },
      });
    });
  });
});
