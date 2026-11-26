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
const USER_ID = '7d1f0c1e-3c58-4f0b-9a52-6f6d0e1b2a3c';

/**
 * Boots the real controller, admin guard, and validation pipes over HTTP, with the service mocked. Covers what the
 * unit specs can't: the routes Bottlenose calls by team (DEV-13019), their query parameters, and body validation.
 */
describe('WhalesyncController (controller-level e2e)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication;
  let service: jest.Mocked<
    Pick<
      WhalesyncInternalService,
      | 'ensureSessionForWhalesyncUser'
      | 'updateWhalesyncSubscription'
      | 'listLiveExportsForWhalesyncTeam'
      | 'deprovisionWhalesyncTeam'
      | 'deprovisionWhalesyncUser'
      | 'listPendingTeamLinks'
      | 'linkTeams'
    >
  >;

  beforeEach(async () => {
    // The session and subscription routes read APP_ENV to decide whether to log the request body. CI doesn't set it
    // (locally it leaks in from server/.env), so pin it to a non-development value here.
    jest.spyOn(ScratchConfigService, 'getScratchEnvironment').mockReturnValue('test');

    service = {
      ensureSessionForWhalesyncUser: jest.fn().mockResolvedValue({
        scratchUserId: 'usr_shadow',
        apiToken: 'token',
        expiresAt: new Date('2026-11-25T12:10:00.000Z'),
      }),
      updateWhalesyncSubscription: jest.fn().mockResolvedValue({ scratchUserId: 'usr_shadow', updated: true }),
      listLiveExportsForWhalesyncTeam: jest.fn().mockResolvedValue({ liveExports: [] }),
      deprovisionWhalesyncTeam: jest.fn().mockResolvedValue(undefined),
      deprovisionWhalesyncUser: jest.fn().mockResolvedValue(undefined),
      listPendingTeamLinks: jest.fn().mockResolvedValue({ whalesyncUserIds: [USER_ID] }),
      linkTeams: jest.fn().mockResolvedValue({ linked: 1, alreadyLinked: 0, skipped: [] }),
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
    await request(app.getHttpServer()).get('/internal/whalesync/team-links/pending').expect(401);
    expect(service.listPendingTeamLinks).not.toHaveBeenCalled();
  });

  it('mints a session for a team, naming the acting person', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/whalesync/sessions')
      .set(asBottlenose)
      .send({
        whalesyncTeamId: TEAM_ID,
        whalesyncUserId: USER_ID,
        whalesyncUserIsTeamsOnlyMember: true,
        email: 'ada@example.com',
        name: 'Acme',
      })
      .expect(201);

    expect(service.ensureSessionForWhalesyncUser).toHaveBeenCalledWith(USER_ID, 'ada@example.com', 'Acme', undefined, {
      whalesyncTeamId: TEAM_ID,
      actingUserIsTeamsOnlyMember: true,
    });
    expect(response.body).toEqual({
      scratchUserId: 'usr_shadow',
      apiToken: 'token',
      expiresAt: '2026-11-25T12:10:00.000Z',
    });
  });

  it('takes the acting person as one of several in the team unless the body says they are its only member', async () => {
    await request(app.getHttpServer())
      .post('/internal/whalesync/sessions')
      .set(asBottlenose)
      .send({ whalesyncTeamId: TEAM_ID, whalesyncUserId: USER_ID, email: 'ada@example.com' })
      .expect(201);

    expect(service.ensureSessionForWhalesyncUser).toHaveBeenCalledWith(
      USER_ID,
      'ada@example.com',
      undefined,
      undefined,
      { whalesyncTeamId: TEAM_ID, actingUserIsTeamsOnlyMember: false },
    );
  });

  it('still mints a session for a person when the body names no team', async () => {
    await request(app.getHttpServer())
      .post('/internal/whalesync/sessions')
      .set(asBottlenose)
      .send({ whalesyncUserId: USER_ID, email: 'ada@example.com' })
      .expect(201);

    expect(service.ensureSessionForWhalesyncUser).toHaveBeenCalledWith(
      USER_ID,
      'ada@example.com',
      undefined,
      undefined,
      undefined,
    );
  });

  it("applies a plan change by team, with the team's one member when given", async () => {
    await request(app.getHttpServer())
      .patch('/internal/whalesync/subscription')
      .set(asBottlenose)
      .send({ whalesyncTeamId: TEAM_ID, whalesyncUserId: USER_ID, subscription: { status: 'active' } })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/internal/whalesync/subscription')
      .set(asBottlenose)
      .send({ whalesyncTeamId: TEAM_ID, subscription: { status: 'expired' } })
      .expect(200);

    expect(service.updateWhalesyncSubscription).toHaveBeenNthCalledWith(
      1,
      { whalesyncTeamId: TEAM_ID, whalesyncUserId: USER_ID },
      { status: 'active' },
    );
    expect(service.updateWhalesyncSubscription).toHaveBeenNthCalledWith(
      2,
      { whalesyncTeamId: TEAM_ID, whalesyncUserId: undefined },
      { status: 'expired' },
    );
  });

  it('refuses a plan change that names neither a team nor a person', async () => {
    await request(app.getHttpServer())
      .patch('/internal/whalesync/subscription')
      .set(asBottlenose)
      .send({ subscription: { status: 'active' } })
      .expect(400);

    expect(service.updateWhalesyncSubscription).not.toHaveBeenCalled();
  });

  it("lists and deprovisions by team, passing the team's one member through", async () => {
    await request(app.getHttpServer())
      .get(`/internal/whalesync/teams/${TEAM_ID}/live-exports`)
      .query({ whalesyncUserId: USER_ID })
      .set(asBottlenose)
      .expect(200, { liveExports: [] });
    await request(app.getHttpServer()).delete(`/internal/whalesync/teams/${TEAM_ID}`).set(asBottlenose).expect(204);

    expect(service.listLiveExportsForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, USER_ID);
    expect(service.deprovisionWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, undefined);
    // The team route must not fall through to the route that deletes a person's shadow user.
    expect(service.deprovisionWhalesyncUser).not.toHaveBeenCalled();
  });

  it('pages the shadow users with no team, and links them to the teams sent back', async () => {
    await request(app.getHttpServer())
      .get('/internal/whalesync/team-links/pending')
      .query({ after: 'some-user-id' })
      .set(asBottlenose)
      .expect(200, { whalesyncUserIds: [USER_ID] });
    const links = [{ whalesyncUserId: USER_ID, whalesyncTeamId: TEAM_ID }];
    await request(app.getHttpServer())
      .post('/internal/whalesync/team-links')
      .set(asBottlenose)
      .send({ links })
      .expect(200, { linked: 1, alreadyLinked: 0, skipped: [] });

    expect(service.listPendingTeamLinks).toHaveBeenCalledWith('some-user-id');
    expect(service.linkTeams).toHaveBeenCalledWith(links);
  });

  it('refuses more links than one request may carry, and a link with no team', async () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => ({
      whalesyncUserId: `user-${index}`,
      whalesyncTeamId: TEAM_ID,
    }));
    await request(app.getHttpServer())
      .post('/internal/whalesync/team-links')
      .set(asBottlenose)
      .send({ links: tooMany })
      .expect(400);
    await request(app.getHttpServer())
      .post('/internal/whalesync/team-links')
      .set(asBottlenose)
      .send({ links: [{ whalesyncUserId: USER_ID }] })
      .expect(400);

    expect(service.linkTeams).not.toHaveBeenCalled();
  });
});
