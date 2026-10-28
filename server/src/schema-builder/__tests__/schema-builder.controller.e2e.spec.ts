/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-call -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- app.getHttpServer() vs supertest's App */
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CreateFieldResult,
  CreateSchemaTablesDto,
  CreateTableResult,
  FieldMappingNote,
  PrimaryFieldRequirement,
  WorkbookId,
} from '@spinner/shared-types';
import { ZodValidationPipe } from 'nestjs-zod';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { Connector } from 'src/remote-service/connectors/connector';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { MYSQL_SCHEMA_CREATION_CAPABILITIES } from 'src/remote-service/connectors/library/mysql/mysql-create-schema';
import { dotPath } from 'src/remote-service/connectors/types';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import request from 'supertest';
import { SchemaBuilderController } from '../schema-builder.controller';
import { SchemaBuilderService } from '../schema-builder.service';

const WORKBOOK_ID = 'wb_e2e';
const ORG_ID = 'org_e2e';
const USER_ID = 'user_e2e';
const CONNECTOR_ACCOUNT_ID = 'conn_e2e';

/** Build a partial Connector stub; only the create-schema surface is exercised. */
function connectorStub(overrides: Partial<Connector>): Connector {
  return {
    service: 'AIRTABLE',
    supportsSchemaCreation: () => false,
    // Default to no existing tables so plan generation finds no conflicts; tests
    // that exercise table-name conflict detection override this.
    listTables: () => Promise.resolve([]),
    ...overrides,
  } as unknown as Connector;
}

describe('SchemaBuilderController (controller-level e2e)', () => {
  // Each test boots a fresh Nest app; on a loaded CI runner that alone can starve
  // past Jest's 5s default and flake. Give the suite generous headroom — it's a
  // timeout-only flake, not a correctness issue.
  jest.setTimeout(30_000);

  let app: INestApplication;
  let connectorsService: { getConnector: jest.Mock };
  let connectorAccountService: { findOneByIdUnscoped: jest.Mock };
  let dataFolderService: { getStoredSchema: jest.Mock; getStoredView: jest.Mock; createFolder: jest.Mock };
  let auditLogService: { logEvent: jest.Mock };
  let dbService: { client: { dataFolder: { findUnique: jest.Mock; findFirst: jest.Mock } } };

  beforeEach(async () => {
    const workbookService = {
      assertWritableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID, organizationId: ORG_ID }),
    };
    connectorAccountService = {
      findOneByIdUnscoped: jest.fn().mockResolvedValue({
        id: CONNECTOR_ACCOUNT_ID,
        workbookId: WORKBOOK_ID,
        service: 'AIRTABLE',
      }),
    };
    connectorsService = { getConnector: jest.fn().mockResolvedValue(connectorStub({})) };
    dataFolderService = {
      getStoredSchema: jest.fn().mockResolvedValue(null),
      getStoredView: jest.fn().mockResolvedValue(null),
      createFolder: jest.fn().mockResolvedValue({ id: 'folder_new' }),
    };
    auditLogService = { logEvent: jest.fn().mockResolvedValue(undefined) };
    dbService = { client: { dataFolder: { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) } } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SchemaBuilderController],
      providers: [
        SchemaBuilderService,
        { provide: WorkbookService, useValue: workbookService },
        { provide: ConnectorAccountService, useValue: connectorAccountService },
        { provide: ConnectorsService, useValue: connectorsService },
        { provide: DataFolderService, useValue: dataFolderService },
        { provide: DbService, useValue: dbService },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    })
      .overrideGuard(ScratchAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<RequestWithUser>();
          req.user = {
            id: USER_ID,
            organizationId: ORG_ID,
            authType: 'api-token',
            authSource: 'cli',
          } as unknown as RequestWithUser['user'];
          return true;
        },
      })
      .overrideGuard(ApiRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe(), new ZodValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const validTablesBody = {
    connectorAccountId: CONNECTOR_ACCOUNT_ID,
    tables: [
      {
        ref: 't1',
        name: 'Posts',
        fields: [
          { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
          { name: 'Count', fieldType: { kind: 'number' } },
        ],
      },
    ],
  };

  describe('POST .../schema/validate', () => {
    it('returns valid:true for a well-formed body', async () => {
      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/validate`)
        .send(validTablesBody)
        .expect(201);
      expect(res.body).toMatchObject({ valid: true, issues: [], schemaCreationSupported: false, service: 'AIRTABLE' });
    });

    it('returns the issue list for a malformed body without throwing', async () => {
      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/validate`)
        .send({
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          tables: [
            {
              ref: 't1',
              name: 'Posts',
              fields: [
                { name: 'Dup', fieldType: { kind: 'text' } },
                { name: 'dup', fieldType: { kind: 'text' } },
              ],
            },
          ],
        })
        .expect(201);
      expect(res.body.valid).toBe(false);
      expect(res.body.issues.map((issue: { code: string }) => issue.code)).toContain('DUPLICATE_FIELD_NAME');
    });
  });

  describe('POST .../schema/tables', () => {
    it('returns not_supported when the connector cannot create schema', async () => {
      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/tables`)
        .send(validTablesBody)
        .expect(201);
      expect(res.body.status).toBe('not_supported');
      expect(res.body.unsupported.service).toBe('AIRTABLE');
    });

    it('dispatches to a supporting connector and materializes a local folder', async () => {
      const createTable = jest.fn(
        (): Promise<CreateTableResult> =>
          Promise.resolve({
            ref: 't1',
            name: 'Posts',
            status: 'created',
            remoteTableId: ['tblNew'],
            fields: [{ name: 'Title', status: 'created', remoteFieldId: 'fld1' } as CreateFieldResult],
          }),
      );
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({ supportsSchemaCreation: () => true, createTable }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/tables`)
        .send({ ...validTablesBody, materializeLocally: true })
        .expect(201);

      expect(createTable).toHaveBeenCalledTimes(1);
      expect(res.body.status).toBe('ok');
      expect(res.body.tables[0].remoteTableId).toEqual(['tblNew']);
      expect(res.body.tables[0].dataFolderId).toBe('folder_new');

      expect(dataFolderService.createFolder).toHaveBeenCalledTimes(1);
      expect(dataFolderService.createFolder.mock.calls[0][0]).toMatchObject({
        workbookId: WORKBOOK_ID,
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        tableId: ['tblNew'],
      });
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
    });

    // The per-table progress observer (DEV-10875) is a service-level side channel — not reachable
    // through the HTTP surface — so these two drive SchemaBuilderService.createTables directly.
    describe('per-table progress observer', () => {
      const actor: Actor = { userId: USER_ID, organizationId: ORG_ID } as Actor;
      const twoTablesDto = {
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        tables: [
          { ref: 't1', name: 'Posts', fields: [{ name: 'Title', fieldType: { kind: 'text' }, isPrimary: true }] },
          { ref: 't2', name: 'Authors', fields: [{ name: 'Name', fieldType: { kind: 'text' }, isPrimary: true }] },
        ],
      } as CreateSchemaTablesDto;

      function createTableStubResolvingEachRef(): jest.Mock {
        return jest.fn(
          (plan: { ref: string; name: string }): Promise<CreateTableResult> =>
            Promise.resolve({
              ref: plan.ref,
              name: plan.name,
              status: 'created',
              remoteTableId: [`tbl_${plan.ref}`],
              fields: [],
            }),
        );
      }

      it('notifies onTableResult after EACH table lands, not once at batch end', async () => {
        const createTable = createTableStubResolvingEachRef();
        connectorsService.getConnector.mockResolvedValue(
          connectorStub({ supportsSchemaCreation: () => true, createTable }),
        );
        const service = app.get(SchemaBuilderService);

        const observed: Array<{ ref: string; createTableCallsSoFar: number }> = [];
        const response = await service.createTables(WORKBOOK_ID as WorkbookId, twoTablesDto, actor, {
          onTableResult: (result) => {
            // Capture how many creations had run when this tick fired — proves the first tick
            // arrives mid-batch (after table 1, before table 2), not at batch end.
            observed.push({ ref: result.ref, createTableCallsSoFar: createTable.mock.calls.length });
          },
        });

        expect(observed).toEqual([
          { ref: 't1', createTableCallsSoFar: 1 },
          { ref: 't2', createTableCallsSoFar: 2 },
        ]);
        expect(response.status).toBe('ok');
        expect(response.tables).toHaveLength(2);
      });

      it('an observer throw is swallowed: creation continues and the batch still succeeds', async () => {
        const createTable = createTableStubResolvingEachRef();
        connectorsService.getConnector.mockResolvedValue(
          connectorStub({ supportsSchemaCreation: () => true, createTable }),
        );
        const service = app.get(SchemaBuilderService);

        const response = await service.createTables(WORKBOOK_ID as WorkbookId, twoTablesDto, actor, {
          onTableResult: () => {
            throw new Error('observer bug');
          },
        });

        expect(createTable).toHaveBeenCalledTimes(2);
        expect(response.status).toBe('ok');
        expect(response.tables.map((table) => table.status)).toEqual(['created', 'created']);
      });

      it("adds a table's deferred foreign keys with the ref of the request that created it", async () => {
        const createTable = createTableStubResolvingEachRef();
        const createFields = jest.fn(
          (plan: { fields: { name: string }[] }): Promise<CreateFieldResult[]> =>
            Promise.resolve(
              plan.fields.map((field) => ({ name: field.name, status: 'created', remoteFieldId: field.name })),
            ),
        );
        connectorsService.getConnector.mockResolvedValue(
          connectorStub({ supportsSchemaCreation: () => true, createTable, createFields }),
        );
        const service = app.get(SchemaBuilderService);

        await service.createTables(
          WORKBOOK_ID as WorkbookId,
          {
            connectorAccountId: CONNECTOR_ACCOUNT_ID,
            tables: [
              {
                ref: 't1',
                name: 'Posts',
                fields: [
                  { name: 'Title', fieldType: { kind: 'text' }, isPrimary: true },
                  { name: 'Parent', fieldType: { kind: 'foreignKey', target: { ref: 't1' } } },
                ],
              },
            ],
          } as CreateSchemaTablesDto,
          actor,
        );

        expect(createFields).toHaveBeenCalledTimes(1);
        expect(createFields.mock.calls[0][0]).toMatchObject({
          remoteTableId: ['tbl_t1'],
          fields: [{ name: 'Parent' }],
          createRef: 't1',
        });
      });
    });
  });

  describe('POST .../schema/plan-from-folder', () => {
    // A flat Authors source schema; the destination is a subset (id + name only).
    const sourceSchema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        bio: { type: 'string' },
        age: { type: 'integer' },
      },
    };
    const destinationSchema = {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    };
    const sourceFolder = {
      id: 'src_authors',
      workbookId: WORKBOOK_ID,
      connectorAccountId: 'conn_src',
      tableId: ['tblSrcAuthors'],
      name: 'Authors',
    };
    const sourceStoredSchema = {
      schema: sourceSchema,
      name: 'Authors',
      idPath: 'id',
      titlePath: dotPath('name'),
    };

    it('generates a create-tables plan when no existing destination is given', async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({ sources: [{ dataFolderId: 'src_authors' }], destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID })
        .expect(201);

      expect(res.body.fieldPlans).toEqual([]);
      expect(res.body.plan.tables).toHaveLength(1);
      expect(res.body.plan.tables[0].name).toBe('Authors');
      // id is skipped (destination owns it); name (primary) + bio + age remain, plus
      // the injected source-record-id field (generic name: the source folder mock has
      // no connectorService).
      expect(res.body.plan.tables[0].fields.map((f: { name: string }) => f.name)).toEqual([
        'name',
        'bio',
        'age',
        'source_record_id',
      ]);
    });

    it("surfaces the destination connector's prerequisites on the plan (primary field required)", async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);
      // A connector that mandates a primary/title field (Airtable / Notion shape).
      const primaryField: PrimaryFieldRequirement = {
        displayName: 'Title',
        description: 'Notion requires a title property.',
        kinds: ['text', 'longText'],
        docsLink: { label: 'Learn about the title property', url: 'https://example.test/title' },
      };
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({
          getSchemaCreationCapabilities: () => ({ supportedFieldKinds: ['text', 'longText'], primaryField }),
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({ sources: [{ dataFolderId: 'src_authors' }], destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID })
        .expect(201);

      // The whole primary-field requirement — label, helper text, allowed kinds, docs link — carries through verbatim.
      expect(res.body.prerequisites).toEqual({ primaryField });
    });

    it('reports a null primary-field requirement when the connector requires none', async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({ sources: [{ dataFolderId: 'src_authors' }], destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID })
        .expect(201);

      expect(res.body.prerequisites).toEqual({ primaryField: null });
    });

    it("surfaces the destination's field cap and notes the fields past it over_field_limit (DEV-12414)", async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({
          getSchemaCreationCapabilities: () => ({
            supportedFieldKinds: ['text', 'longText', 'number'],
            primaryField: null,
            maxFieldsPerTable: 3,
          }),
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({ sources: [{ dataFolderId: 'src_authors' }], destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID })
        .expect(201);

      expect(res.body.prerequisites).toEqual({ primaryField: null, maxFieldsPerTable: 3 });
      // name, bio, age + the injected source_record_id: every field stays in the plan, the last data field is noted.
      expect(res.body.plan.tables[0].fields).toHaveLength(4);
      const overLimitFieldNames = (res.body.notes as FieldMappingNote[])
        .filter((note) => note.status === 'over_field_limit')
        .map((note) => note.fieldName);
      expect(overLimitFieldNames).toEqual(['age']);
    });

    it('diffs against an existing destination folder and emits an add-fields plan', async () => {
      const destinationFolder = {
        id: 'dst_authors',
        workbookId: WORKBOOK_ID,
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        tableId: ['tblDstAuthors'],
        name: 'Authors',
      };
      dbService.client.dataFolder.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'dst_authors' ? destinationFolder : sourceFolder),
      );
      dataFolderService.getStoredSchema.mockImplementation((id: string) =>
        Promise.resolve(id === 'dst_authors' ? { schema: destinationSchema } : sourceStoredSchema),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({
          sources: [{ dataFolderId: 'src_authors', existingDestinationDataFolderId: 'dst_authors' }],
          destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID,
        })
        .expect(201);

      // No new table; one add-fields plan with only the missing fields.
      expect(res.body.plan.tables).toEqual([]);
      expect(res.body.fieldPlans).toHaveLength(1);
      expect(res.body.fieldPlans[0]).toMatchObject({
        sourceDataFolderId: 'src_authors',
        destinationDataFolderId: 'dst_authors',
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        remoteTableId: ['tblDstAuthors'],
      });
      // id skipped, 'name' already on destination (same kind → adopted) → only bio + age are added.
      expect(res.body.fieldPlans[0].fields.map((f: { name: string }) => f.name)).toEqual(['bio', 'age']);
      expect(res.body.notes.find((note: { fieldName: string }) => note.fieldName === 'name')).toMatchObject({
        status: 'adopted',
      });
      expect(res.body.destinationSupportsCreation).toBe(false);
    });

    it('rejects an existing destination folder from a different connector', async () => {
      dbService.client.dataFolder.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'dst_authors'
            ? { id: 'dst_authors', workbookId: WORKBOOK_ID, connectorAccountId: 'other_conn', tableId: ['x'] }
            : sourceFolder,
        ),
      );
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);

      await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({
          sources: [{ dataFolderId: 'src_authors', existingDestinationDataFolderId: 'dst_authors' }],
          destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID,
        })
        .expect(400);
    });

    it('renames a new table that conflicts with an existing destination table under the parent (DEV-10441)', async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({
          listTables: jest
            .fn()
            .mockResolvedValue([{ id: { wsId: 'w', remoteId: ['baseX', 'tblExisting'] }, displayName: 'Authors' }]),
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({
          sources: [{ dataFolderId: 'src_authors' }],
          destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID,
          remoteParentId: ['baseX'],
        })
        .expect(201);

      expect(res.body.plan.tables[0].name).toBe('Authors 2');
      expect(res.body.tableNotes).toHaveLength(1);
      expect(res.body.tableNotes[0]).toMatchObject({
        tableName: 'Authors 2',
        renamedFromName: 'Authors',
        reason: 'conflicts_with_existing_table',
      });
    });

    it('ignores a same-named table under a different parent (scoping by remoteParentId)', async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({
          listTables: jest
            .fn()
            .mockResolvedValue([{ id: { wsId: 'w2', remoteId: ['baseY', 'tblOther'] }, displayName: 'Authors' }]),
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({
          sources: [{ dataFolderId: 'src_authors' }],
          destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID,
          remoteParentId: ['baseX'],
        })
        .expect(201);

      expect(res.body.plan.tables[0].name).toBe('Authors');
      expect(res.body.tableNotes).toEqual([]);
    });

    describe('a parent given as the whole create-destination id (how Live Export addresses it)', () => {
      /**
       * Supabase-shaped ids: tables are `[projectRef, schema, table]`, destinations fold to `"<ref>/<schema>"`,
       * and the "New schema" sentinel lands in an UNUSED schema named after `newParentName` (default
       * `scratch_export`), suffixed `_2` when an existing table's schema already has that name.
       */
      const NEW_SCHEMA_SENTINEL = 'scratch-new-schema-sentinel';
      const splitSupabaseParent = (remoteParentId: string[]) =>
        remoteParentId.flatMap((segment) => segment.split('/')).filter((segment) => segment !== '');
      /** Records every `resolveRemoteParentIdTheCreateWillLandIn` call the plan makes, as `[remoteParentId, newParentName]`. */
      let parentResolutionCalls: [string[], string | undefined][];
      beforeEach(() => {
        parentResolutionCalls = [];
      });
      const supabaseShaped = (tables: { remoteId: string[]; displayName: string }[]) => {
        const existingSchemaNames = new Set(tables.map((table) => table.remoteId[1]));
        return connectorStub({
          service: 'SUPABASE',
          listTables: jest
            .fn()
            .mockResolvedValue(tables.map((table) => ({ id: { wsId: 'w', remoteId: table.remoteId }, ...table }))),
          createDestinationIdForParent: (remoteParentId: string[]) => {
            const segments = splitSupabaseParent(remoteParentId);
            return segments[0] ? `${segments[0]}/${segments[1] ?? 'public'}` : undefined;
          },
          resolveRemoteParentIdTheCreateWillLandIn: jest.fn(
            (remoteParentId: string[], newParentName: string | undefined) => {
              parentResolutionCalls.push([remoteParentId, newParentName]);
              const [projectRef, schema] = splitSupabaseParent(remoteParentId);
              if (!projectRef || schema !== NEW_SCHEMA_SENTINEL) return Promise.resolve(remoteParentId);
              const foldedSchemaName = (newParentName ?? 'scratch_export').toLowerCase().replace(/[^a-z0-9]+/g, '_');
              const unusedSchemaName = existingSchemaNames.has(foldedSchemaName)
                ? `${foldedSchemaName}_2`
                : foldedSchemaName;
              return Promise.resolve([projectRef, unusedSchemaName]);
            },
          ),
        });
      };
      const planAuthorsInto = (remoteParentId: string[], extraBody: { newParentName?: string } = {}) =>
        request(app.getHttpServer())
          .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
          .send({
            sources: [{ dataFolderId: 'src_authors' }],
            destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID,
            remoteParentId,
            ...extraBody,
          })
          .expect(201);

      beforeEach(() => {
        dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
        dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);
      });

      it('renames against a same-named table in the same project and schema', async () => {
        connectorsService.getConnector.mockResolvedValue(
          supabaseShaped([{ remoteId: ['ref', 'public', 'authors'], displayName: 'Authors' }]),
        );
        const res = await planAuthorsInto(['ref/public']);
        expect(res.body.plan.tables[0].name).toBe('Authors 2');
        expect(res.body.tableNotes[0]).toMatchObject({ reason: 'conflicts_with_existing_table' });
      });

      it('ignores a same-named table in another schema or another project', async () => {
        connectorsService.getConnector.mockResolvedValue(
          supabaseShaped([
            { remoteId: ['ref', 'staging', 'authors'], displayName: 'Authors' },
            { remoteId: ['otherRef', 'public', 'authors'], displayName: 'Authors' },
          ]),
        );
        const res = await planAuthorsInto(['ref/public']);
        expect(res.body.plan.tables[0].name).toBe('Authors');
        expect(res.body.tableNotes).toEqual([]);
      });

      it('treats a project-only parent as its default schema', async () => {
        connectorsService.getConnector.mockResolvedValue(
          supabaseShaped([{ remoteId: ['ref', 'staging', 'authors'], displayName: 'Authors' }]),
        );
        const res = await planAuthorsInto(['ref']);
        expect(res.body.plan.tables[0].name).toBe('Authors');
        expect(res.body.tableNotes).toEqual([]);
      });

      it('ignores existing tables elsewhere when "New schema" provisions a schema that does not exist yet', async () => {
        connectorsService.getConnector.mockResolvedValue(
          supabaseShaped([{ remoteId: ['ref', 'public', 'authors'], displayName: 'Authors' }]),
        );
        const res = await planAuthorsInto([`ref/${NEW_SCHEMA_SENTINEL}`]);
        expect(res.body.plan.tables[0].name).toBe('Authors');
        expect(res.body.tableNotes).toEqual([]);
      });

      it('keeps the name when "New schema" will provision a fresh schema beside an earlier export of the same name', async () => {
        dbService.client.dataFolder.findUnique.mockResolvedValue({ ...sourceFolder, connectorService: 'AIRTABLE' });
        connectorsService.getConnector.mockResolvedValue(
          supabaseShaped([{ remoteId: ['ref', 'airtable_export', 'authors'], displayName: 'Authors' }]),
        );
        const res = await planAuthorsInto([`ref/${NEW_SCHEMA_SENTINEL}`]);
        expect(res.body.plan.tables[0].name).toBe('Authors');
        expect(res.body.tableNotes).toEqual([]);
        // Named exactly as materialize will name it: the source-derived suggestion.
        expect(parentResolutionCalls).toEqual([[[`ref/${NEW_SCHEMA_SENTINEL}`], 'Airtable export']]);
      });

      it('resolves "New schema" from the newParentName the user chose', async () => {
        dbService.client.dataFolder.findUnique.mockResolvedValue({ ...sourceFolder, connectorService: 'AIRTABLE' });
        connectorsService.getConnector.mockResolvedValue(supabaseShaped([]));
        await planAuthorsInto([`ref/${NEW_SCHEMA_SENTINEL}`], { newParentName: 'Marketing' });
        expect(parentResolutionCalls).toEqual([[[`ref/${NEW_SCHEMA_SENTINEL}`], 'Marketing']]);
      });
    });

    it('does not rename a new table against existing destination tables when the destination allows duplicate table names (Notion — DEV-10943)', async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);
      const listTables = jest
        .fn()
        .mockResolvedValue([{ id: { wsId: 'w', remoteId: ['dbExisting', 'dsExisting'] }, displayName: 'Authors' }]);
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({
          service: 'NOTION',
          listTables,
          getSchemaCreationCapabilities: () => ({
            supportedFieldKinds: ['text'],
            primaryField: null,
            requiresUniqueTableNames: false,
          }),
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({
          sources: [{ dataFolderId: 'src_authors' }],
          destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID,
          remoteParentId: ['pageX'],
        })
        .expect(201);

      // The brand-new database keeps its bare name despite a same-named database existing elsewhere...
      expect(res.body.plan.tables[0].name).toBe('Authors');
      expect(res.body.tableNotes).toEqual([]);
      // ...and we never even list the destination's tables, since collision detection is pointless there.
      expect(listTables).not.toHaveBeenCalled();
    });

    it("removes characters the destination can't hold from table and field names (MySQL — DEV-12413)", async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue({
        ...sourceStoredSchema,
        name: 'Authors \u{1F680}',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            'mood \u{1F600}': { type: 'string' },
            'Trailing space ': { type: 'string' },
          },
        },
        titlePath: undefined,
      });
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({ service: 'MYSQL', getSchemaCreationCapabilities: () => MYSQL_SCHEMA_CREATION_CAPABILITIES }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({ sources: [{ dataFolderId: 'src_authors' }], destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID })
        .expect(201);

      expect(res.body.plan.tables[0].name).toBe('Authors');
      expect(res.body.plan.tables[0].fields.map((f: { name: string }) => f.name)).toEqual([
        'mood',
        'Trailing space',
        'source_record_id',
      ]);
      expect(res.body.tableNotes).toEqual([
        expect.objectContaining({ renamedFromName: 'Authors \u{1F680}', reason: 'unsupported_characters' }),
      ]);
    });

    it('still generates a plan when listing destination tables fails (graceful degradation)', async () => {
      dbService.client.dataFolder.findUnique.mockResolvedValue(sourceFolder);
      dataFolderService.getStoredSchema.mockResolvedValue(sourceStoredSchema);
      connectorsService.getConnector.mockResolvedValue(
        connectorStub({ listTables: jest.fn().mockRejectedValue(new Error('boom')) }),
      );

      const res = await request(app.getHttpServer())
        .post(`/workbook/${WORKBOOK_ID}/schema/plan-from-folder`)
        .send({
          sources: [{ dataFolderId: 'src_authors' }],
          destinationConnectorAccountId: CONNECTOR_ACCOUNT_ID,
          remoteParentId: ['baseX'],
        })
        .expect(201);

      expect(res.body.plan.tables[0].name).toBe('Authors');
      expect(res.body.tableNotes).toEqual([]);
    });
  });
});
