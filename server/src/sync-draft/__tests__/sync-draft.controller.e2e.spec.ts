/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-call -- supertest response.body is typed as any */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- app.getHttpServer() vs supertest's App */
import {
  ConflictException,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ZodValidationExceptionFilter } from 'src/exception-filters/zod-validation.exception-filter';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import request from 'supertest';
import { SyncDraftController } from '../sync-draft.controller';
import { SyncDraftService } from '../sync-draft.service';

const WORKBOOK_ID = 'wkb_e2e';
const DRAFT_ID = 'syd_e2e';
const ORG_ID = 'org_e2e';
const USER_ID = 'usr_e2e';

/**
 * Controller-level e2e for the SyncDraft HTTP surface — the contract the
 * cross-repo RPC client consumes. Boots a real Nest app with the global
 * ZodValidationPipe + the production exception filters and drives it via
 * supertest, so route wiring, request validation, status codes, and response
 * envelopes are all exercised end to end. The service is mocked: this layer is
 * about the wire, not the orchestration (that's covered by the service spec).
 */
describe('SyncDraftController (controller-level e2e)', () => {
  let app: INestApplication;
  let syncDraftService: {
    getOrCreate: jest.Mock;
    get: jest.Mock;
    patch: jest.Mock;
    materialize: jest.Mock;
    apply: jest.Mock;
    delete: jest.Mock;
  };

  /** A representative SyncDraft wire object as the service would return it. */
  const draftResponse = {
    id: DRAFT_ID,
    workbookId: WORKBOOK_ID,
    version: 1,
    displayName: 'Untitled sync',
    schedule: null,
    sourceSyncId: null,
    tableMappings: [],
    archivedAt: null,
    appliedSyncId: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  };

  beforeEach(async () => {
    syncDraftService = {
      getOrCreate: jest.fn().mockResolvedValue(draftResponse),
      get: jest.fn().mockResolvedValue(draftResponse),
      patch: jest.fn().mockResolvedValue(draftResponse),
      materialize: jest.fn().mockResolvedValue({ draft: draftResponse, results: [], status: 'noop' }),
      apply: jest.fn().mockResolvedValue({ id: 'syn_new' }),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SyncDraftController],
      providers: [{ provide: SyncDraftService, useValue: syncDraftService }],
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
    // Only the Zod filter here: it owns the `issues` envelope for validation 400s.
    // 404/409/422 use Nest's native handling, which already returns the right
    // status + the exception's response body (matching what the RPC client sees).
    app.useGlobalFilters(new ZodValidationExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  describe('POST /workbooks/:workbookId/sync-drafts (get-or-create / open)', () => {
    it('opens the editor idempotently (200) and forwards the workbook id', async () => {
      const res = await request(app.getHttpServer()).post(`/workbooks/${WORKBOOK_ID}/sync-drafts`).send({}).expect(200);

      expect(res.body.id).toBe(DRAFT_ID);
      expect(res.body.createdAt).toBe('2026-06-15T00:00:00.000Z'); // ISO string on the wire
      expect(syncDraftService.getOrCreate).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({}),
        expect.objectContaining({ userId: USER_ID, organizationId: ORG_ID }),
      );
    });

    it('forwards fromSyncId when supplied', async () => {
      await request(app.getHttpServer())
        .post(`/workbooks/${WORKBOOK_ID}/sync-drafts`)
        .send({ fromSyncId: 'syn_source' })
        .expect(200);
      expect(syncDraftService.getOrCreate.mock.calls[0][1]).toMatchObject({ fromSyncId: 'syn_source' });
    });

    it('rejects a non-string fromSyncId with 400 (zod)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/workbooks/${WORKBOOK_ID}/sync-drafts`)
        .send({ fromSyncId: 123 })
        .expect(400);
      expect(res.body.issues).toBeDefined();
      expect(syncDraftService.getOrCreate).not.toHaveBeenCalled();
    });
  });

  describe('GET /sync-drafts/:draftId', () => {
    it('returns the draft (200)', async () => {
      const res = await request(app.getHttpServer()).get(`/sync-drafts/${DRAFT_ID}`).expect(200);
      expect(res.body.id).toBe(DRAFT_ID);
      expect(syncDraftService.get).toHaveBeenCalledWith(DRAFT_ID, expect.objectContaining({ userId: USER_ID }));
    });

    it('passes a service NotFound through as 404', async () => {
      syncDraftService.get.mockRejectedValue(new NotFoundException('Sync draft not found'));
      await request(app.getHttpServer()).get(`/sync-drafts/${DRAFT_ID}`).expect(404);
    });
  });

  describe('PATCH /sync-drafts/:draftId', () => {
    it('updates with a valid body (200)', async () => {
      await request(app.getHttpServer())
        .patch(`/sync-drafts/${DRAFT_ID}`)
        .send({ version: 1, displayName: 'Renamed' })
        .expect(200);
      expect(syncDraftService.patch).toHaveBeenCalledWith(
        DRAFT_ID,
        expect.objectContaining({ version: 1, displayName: 'Renamed' }),
        expect.anything(),
      );
    });

    it('rejects a body missing the required version with 400 (zod)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/sync-drafts/${DRAFT_ID}`)
        .send({ displayName: 'Renamed' })
        .expect(400);
      expect(res.body.issues.some((i: { path: (string | number)[] }) => i.path.includes('version'))).toBe(true);
      expect(syncDraftService.patch).not.toHaveBeenCalled();
    });

    it('rejects a malformed tableMappings discriminated union with 400 (zod)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/sync-drafts/${DRAFT_ID}`)
        .send({
          version: 1,
          tableMappings: [
            {
              ref: 'tm1',
              source: { dataFolderId: 'dfd_src' },
              // invalid: destination.kind is not one of existing|placeholderTable
              destination: { kind: 'bogus', dataFolderId: 'dfd_dst' },
              columnMappings: [],
            },
          ],
        })
        .expect(400);
      expect(res.body.issues).toBeDefined();
      expect(syncDraftService.patch).not.toHaveBeenCalled();
    });

    it('passes a service version conflict through as 409 with the error code', async () => {
      syncDraftService.patch.mockRejectedValue(
        new ConflictException({ error: 'SYNC_DRAFT_VERSION_CONFLICT', message: 'stale', currentVersion: 5 }),
      );
      const res = await request(app.getHttpServer()).patch(`/sync-drafts/${DRAFT_ID}`).send({ version: 1 }).expect(409);
      expect(res.body.error).toBe('SYNC_DRAFT_VERSION_CONFLICT');
      expect(res.body.currentVersion).toBe(5);
    });
  });

  describe('POST /sync-drafts/:draftId/materialize', () => {
    it('returns 200 (not 201) with the materialize response', async () => {
      const res = await request(app.getHttpServer()).post(`/sync-drafts/${DRAFT_ID}/materialize`).expect(200);
      expect(res.body.status).toBe('noop');
      expect(syncDraftService.materialize).toHaveBeenCalledWith(DRAFT_ID, expect.anything());
    });
  });

  describe('POST /sync-drafts/:draftId/apply', () => {
    it('returns 200 with the created Sync', async () => {
      const res = await request(app.getHttpServer()).post(`/sync-drafts/${DRAFT_ID}/apply`).expect(200);
      expect(res.body.id).toBe('syn_new');
    });

    it('passes the unresolved-placeholders error through as 422 with offender refs', async () => {
      syncDraftService.apply.mockRejectedValue(
        new UnprocessableEntityException({
          error: 'SYNC_DRAFT_UNRESOLVED_PLACEHOLDERS',
          message: 'run materialize first',
          unresolvedRefs: ['ph_contacts'],
        }),
      );
      const res = await request(app.getHttpServer()).post(`/sync-drafts/${DRAFT_ID}/apply`).expect(422);
      expect(res.body.error).toBe('SYNC_DRAFT_UNRESOLVED_PLACEHOLDERS');
      expect(res.body.unresolvedRefs).toEqual(['ph_contacts']);
    });
  });

  describe('DELETE /sync-drafts/:draftId', () => {
    it('returns 204 with no body', async () => {
      const res = await request(app.getHttpServer()).delete(`/sync-drafts/${DRAFT_ID}`).expect(204);
      expect(res.body).toEqual({});
      expect(syncDraftService.delete).toHaveBeenCalledWith(DRAFT_ID, expect.anything());
    });
  });
});
