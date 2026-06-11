/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-call -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- app.getHttpServer() vs supertest's App */
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CreateFieldResult, CreateTableResult } from '@spinner/shared-types';
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
    ...overrides,
  } as unknown as Connector;
}

describe('SchemaBuilderController (controller-level e2e)', () => {
  let app: INestApplication;
  let connectorsService: { getConnector: jest.Mock };
  let connectorAccountService: { findOneById: jest.Mock };
  let dataFolderService: { getStoredSchema: jest.Mock; createFolder: jest.Mock };
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
});
