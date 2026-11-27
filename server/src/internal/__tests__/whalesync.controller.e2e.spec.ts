/* eslint-disable @typescript-eslint/no-unsafe-argument -- app.getHttpServer() vs supertest's App */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import request from 'supertest';
import { WhalesyncInternalService } from '../whalesync-internal.service';
import { WhalesyncController } from '../whalesync.controller';

const ADMIN_TOKEN = 'test-admin-token';
const TEAM_ID = 'tm_abc123def456';
const FIRST_TEAM_MEMBER_WHALESYNC_USER_ID = '7d1f0c1e-3c58-4f0b-9a52-6f6d0e1b2a3c';
const SECOND_TEAM_MEMBER_WHALESYNC_USER_ID = '0b9e4a51-2f7c-4c1e-8d3a-5e6f7a8b9c0d';

/**
 * Boots the real controller, admin guard, and validation pipes over HTTP, with the service mocked. Covers what the
 * unit specs can't: that every route names a team (DEV-13019), that the fields a Whalesync backend still sends about
 * the acting person are stripped rather than rejected, and that the by-person and team-link routes are gone.
 */
describe('WhalesyncController (controller-level e2e)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication;
  let service: jest.Mocked<
    Pick<
      WhalesyncInternalService,
      | 'ensureSessionForWhalesyncTeam'
      | 'updateWhalesyncSubscription'
      | 'listLiveExportsForWhalesyncTeam'
      | 'deprovisionWhalesyncTeam'
    >
  >;

  beforeEach(async () => {
    // The session and subscription routes read APP_ENV to decide whether to log the request body. CI doesn't set it
    // (locally it leaks in from server/.env), so pin it to a non-development value here.
    jest.spyOn(ScratchConfigService, 'getScratchEnvironment').mockReturnValue('test');

    service = {
      ensureSessionForWhalesyncTeam: jest.fn().mockResolvedValue({
        scratchUserId: 'usr_shadow',
        apiToken: 'token',
        expiresAt: new Date('2026-11-25T12:10:00.000Z'),
      }),
      updateWhalesyncSubscription: jest.fn().mockResolvedValue({ scratchUserId: 'usr_shadow', updated: true }),
      listLiveExportsForWhalesyncTeam: jest.fn().mockResolvedValue({ liveExports: [] }),
      deprovisionWhalesyncTeam: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [WhalesyncController],
      providers: [
        { provide: WhalesyncInternalService, useValue: service },
        { provide: ScratchConfigService, useValue: { getScratchAdminApiKeys: () => [ADMIN_TOKEN] } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // The same two pipes as `main.ts`.
    app.useGlobalPipes(new ValidationPipe(), new ZodValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const asBottlenose = { 'X-Scratch-Admin-Token': ADMIN_TOKEN };

  it('refuses a request without the admin token', async () => {
    await request(app.getHttpServer())
      .post('/internal/whalesync/sessions')
      .send({ whalesyncTeamId: TEAM_ID })
      .expect(401);
    expect(service.ensureSessionForWhalesyncTeam).not.toHaveBeenCalled();
  });

  it('mints a session for a team', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/whalesync/sessions')
      .set(asBottlenose)
      .send({ whalesyncTeamId: TEAM_ID, name: 'Acme', subscription: { status: 'active' } })
      .expect(201);

    expect(service.ensureSessionForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, 'Acme', { status: 'active' });
    expect(response.body).toEqual({
      scratchUserId: 'usr_shadow',
      apiToken: 'token',
      expiresAt: '2026-11-25T12:10:00.000Z',
    });
  });

  it('strips the acting person fields a Whalesync backend still sends, so every member of a team gets a session', async () => {
    for (const whalesyncUserId of [FIRST_TEAM_MEMBER_WHALESYNC_USER_ID, SECOND_TEAM_MEMBER_WHALESYNC_USER_ID]) {
      await request(app.getHttpServer())
        .post('/internal/whalesync/sessions')
        .set(asBottlenose)
        .send({
          whalesyncTeamId: TEAM_ID,
          whalesyncUserId,
          whalesyncUserIsTeamsOnlyMember: false,
          email: `${whalesyncUserId}@example.com`,
          name: 'Acme',
        })
        .expect(201);
    }

    expect(service.ensureSessionForWhalesyncTeam).toHaveBeenCalledTimes(2);
    expect(service.ensureSessionForWhalesyncTeam).toHaveBeenNthCalledWith(1, TEAM_ID, 'Acme', undefined);
    expect(service.ensureSessionForWhalesyncTeam).toHaveBeenNthCalledWith(2, TEAM_ID, 'Acme', undefined);
  });

  it('refuses a session that names no team, even when it names a person', async () => {
    await request(app.getHttpServer())
      .post('/internal/whalesync/sessions')
      .set(asBottlenose)
      .send({ whalesyncUserId: FIRST_TEAM_MEMBER_WHALESYNC_USER_ID, email: 'ada@example.com' })
      .expect(400);

    expect(service.ensureSessionForWhalesyncTeam).not.toHaveBeenCalled();
  });

  it('applies a plan change by team, ignoring a person sent alongside it', async () => {
    await request(app.getHttpServer())
      .patch('/internal/whalesync/subscription')
      .set(asBottlenose)
      .send({
        whalesyncTeamId: TEAM_ID,
        whalesyncUserId: FIRST_TEAM_MEMBER_WHALESYNC_USER_ID,
        subscription: { status: 'active' },
      })
      .expect(200);

    expect(service.updateWhalesyncSubscription).toHaveBeenCalledWith(TEAM_ID, { status: 'active' });
  });

  it('refuses a plan change that names no team', async () => {
    await request(app.getHttpServer())
      .patch('/internal/whalesync/subscription')
      .set(asBottlenose)
      .send({ whalesyncUserId: FIRST_TEAM_MEMBER_WHALESYNC_USER_ID, subscription: { status: 'active' } })
      .expect(400);

    expect(service.updateWhalesyncSubscription).not.toHaveBeenCalled();
  });

  it('lists and deprovisions by team, ignoring a person in the query string', async () => {
    await request(app.getHttpServer())
      .get(`/internal/whalesync/teams/${TEAM_ID}/live-exports`)
      .query({ whalesyncUserId: FIRST_TEAM_MEMBER_WHALESYNC_USER_ID })
      .set(asBottlenose)
      .expect(200, { liveExports: [] });
    await request(app.getHttpServer())
      .delete(`/internal/whalesync/teams/${TEAM_ID}`)
      .query({ whalesyncUserId: FIRST_TEAM_MEMBER_WHALESYNC_USER_ID })
      .set(asBottlenose)
      .expect(204);

    expect(service.listLiveExportsForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID);
    expect(service.deprovisionWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID);
  });

  it.each([
    ['POST', '/internal/whalesync/users'],
    ['DELETE', `/internal/whalesync/users/${FIRST_TEAM_MEMBER_WHALESYNC_USER_ID}`],
    ['DELETE', `/internal/whalesync/users/${FIRST_TEAM_MEMBER_WHALESYNC_USER_ID}/sessions`],
    ['DELETE', `/internal/whalesync/users/${FIRST_TEAM_MEMBER_WHALESYNC_USER_ID}/subscription`],
    ['GET', `/internal/whalesync/users/${FIRST_TEAM_MEMBER_WHALESYNC_USER_ID}/live-exports`],
    ['GET', '/internal/whalesync/team-links/pending'],
    ['POST', '/internal/whalesync/team-links'],
  ])('answers 404 for the removed route %s %s', async (method, path) => {
    const server = request(app.getHttpServer());
    const pendingRequest =
      method === 'POST' ? server.post(path) : method === 'DELETE' ? server.delete(path) : server.get(path);
    await pendingRequest.set(asBottlenose).send({}).expect(404);
  });
});
