/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-call -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- app.getHttpServer() vs supertest's App */
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CreateFieldResult, CreateTableResult, PrimaryFieldRequirement } from '@spinner/shared-types';
import { ZodValidationPipe } from 'nestjs-zod';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { Connector } from 'src/remote-service/connectors/connector';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
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
  let app: INestApplication;
  let connectorsService: { getConnector: jest.Mock };
  let connectorAccountService: { findOneById: jest.Mock };
  let dataFolderService: { getStoredSchema: jest.Mock; getStoredView: jest.Mock; createFolder: jest.Mock };
  let auditLogService: { logEvent: jest.Mock };
  let dbService: { client: { dataFolder: { findUnique: jest.Mock; findFirst: jest.Mock } } };

  beforeEach(async () => {
    const workbookService = {
      assertWritableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID, organizationId: ORG_ID }),
    };
    connectorAccountService = {
      findOneById: jest.fn().mockResolvedValue({
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
      idColumnRemoteId: 'id',
      titleColumnRemoteId: ['name'],
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
