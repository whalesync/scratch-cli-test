/* eslint-disable @typescript-eslint/no-unsafe-member-access */

/**
 * Integration tests for the internal Whalesync shadow-user + session-management endpoints
 * (`/internal/whalesync/*`) and the WHALESYNC_SESSION token behavior. Scratch keeps one pure shadow user per
 * Whalesync team (DEV-13019) and knows nothing about the people in it, so every route names the team.
 *
 * PRECONDITIONS (the suite skips itself, with a warning, if they are not met):
 *   - RUN_WHALESYNC_INTEGRATION=true
 *   - SCRATCH_ADMIN_API_KEY set to the SAME value the running server was started with
 *   - A Scratch server reachable at INTEGRATION_TEST_API_DOMAIN (default localhost:3010)
 *
 * These drive the real server over HTTP, so they exercise the full chain: ScratchAdminGuard →
 * controller → UsersService/WorkbookService → DB → git. Each test uses a fresh random whalesyncTeamId
 * and is torn down through the team deprovision endpoint so workbook repos are cleaned up (not orphaned).
 *
 * DATABASE ASSERTIONS — LOCAL VS. REMOTE.
 * Every behavioral guarantee is asserted over HTTP and holds in both modes. When a Postgres
 * (DATABASE_URL) that the target server actually writes to is available — i.e. a local run against a
 * local server — the suite ADDITIONALLY asserts the persisted row shapes (exact token counts and the
 * WHALESYNC_SESSION token type, which `/users/current` does not expose). Against a remote/deployed
 * server (e.g. the post-deploy environment test hitting test-api.scratch.md) the configured Postgres
 * is a different, empty database, so those direct-DB assertions cannot see the server's writes and are
 * skipped — the suite runs API-only. API-only mode is inferred automatically whenever the target API is
 * not localhost, and can also be forced with WHALESYNC_TEST_API_ONLY=true.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import {
  createScratchApiClient,
  getApiUrl,
  SCRATCH_API_WARM_UP_HOOK_TIMEOUT_MS,
  waitForScratchApiToBeWarm,
} from './common';

// Bounded + transport-retrying client. A bare `axios` has no timeout, so one dropped connection
// used to hang this suite until Jest's 60s cap fired with a message that named no request —
// which is exactly how a healthy server produced a red post-deploy run.
const axios = createScratchApiClient();

const ADMIN_TOKEN = process.env.SCRATCH_ADMIN_API_KEY;
const shouldRun = process.env.RUN_WHALESYNC_INTEGRATION === 'true' && !!ADMIN_TOKEN;

if (!shouldRun) {
  console.warn(
    'Skipping whalesync-shadow-user integration tests: set RUN_WHALESYNC_INTEGRATION=true and SCRATCH_ADMIN_API_KEY ' +
      '(matching the running server) to enable them.',
  );
}

const describeOrSkip = shouldRun ? describe : describe.skip;

/**
 * Run `fn` over `items` with at most `concurrencyLimit` calls in flight at once, preserving input
 * order in the returned results. Used to spread a burst of requests across a fixed-size worker pool
 * instead of a single wide `Promise.all` spike (see the burst-polling test for why that matters).
 */
async function mapWithConcurrency<Item, Result>(
  items: Item[],
  concurrencyLimit: number,
  fn: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array<Result>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  }
  const workerCount = Math.min(concurrencyLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

const apiUrl = getApiUrl();
const adminHeaders = { 'X-Scratch-Admin-Token': ADMIN_TOKEN ?? '' };
const anyStatus = { validateStatus: () => true };

// Direct-DB row-shape assertions require a DATABASE_URL pointing at the SAME database the target
// server writes to, which only holds for a local run against a local server. Against a remote/deployed
// server the configured Postgres is a different database, so we validate purely over HTTP. Inferred
// from a non-localhost API target; can be forced with WHALESYNC_TEST_API_ONLY=true.
const isApiOnlyMode = process.env.WHALESYNC_TEST_API_ONLY === 'true' || !apiUrl.includes('localhost');

interface SessionResponse {
  scratchUserId: string;
  apiToken: string;
  expiresAt: string;
}

interface LiveExportListResponse {
  liveExports: { id: string; name: string; createdAt: string; updatedAt: string }[];
}

/** A Whalesync team id shaped like the real ones (`tm_` and 12 characters), unique to this run. */
function createWhalesyncTeamIdForTest(): string {
  return `tm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

interface CurrentUserResponse {
  id: string;
  email?: string;
  clerkId: string | null;
  isAdmin: boolean;
  subscription?: {
    planType: string;
    planDisplayName: string;
    costUSD: number;
    status: string;
    canManageSubscription: boolean;
  };
}

describeOrSkip('Whalesync shadow-user internal endpoints', () => {
  jest.setTimeout(60000);

  // Present only when a local DB matching the target server is available; undefined in API-only mode.
  let prismaForDbRowAssertions: PrismaClient | undefined;
  const provisionedWhalesyncTeamIds: string[] = [];

  beforeAll(async () => {
    // test-api scales to zero, and the post-deploy job spends its first minutes in suites that never
    // call it, so the instance is often shut down by the time this suite runs. Without a warm-up the
    // first test's write timed out during the ~40s cold start. The warm-up goes here, not in the
    // job's global setup: Cloud Run has shut an idle instance as soon as ~40s after a rollout, so an
    // API warmed at job start can be cold again by the time this suite runs.
    await waitForScratchApiToBeWarm(apiUrl);
    if (!isApiOnlyMode) {
      prismaForDbRowAssertions = new PrismaClient();
    }
  }, SCRATCH_API_WARM_UP_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    // Deprovision every team created this test (idempotent), so no workbook repos or rows leak.
    for (const whalesyncTeamId of provisionedWhalesyncTeamIds.splice(0)) {
      await deprovisionTeam(whalesyncTeamId);
    }
  });

  afterAll(async () => {
    await prismaForDbRowAssertions?.$disconnect();
  });

  function newWhalesyncTeamId(): string {
    const whalesyncTeamId = createWhalesyncTeamIdForTest();
    provisionedWhalesyncTeamIds.push(whalesyncTeamId);
    return whalesyncTeamId;
  }

  // POST /internal/whalesync/sessions. Throws on non-2xx.
  async function createSession(
    whalesyncTeamId: string,
    name?: string,
    subscription?: Record<string, unknown>,
    legacyBodyFieldsScratchNoLongerReads: Record<string, unknown> = {},
  ): Promise<SessionResponse> {
    const response = await axios.post<SessionResponse>(
      `${apiUrl}/internal/whalesync/sessions`,
      { ...legacyBodyFieldsScratchNoLongerReads, whalesyncTeamId, name, subscription },
      { headers: adminHeaders },
    );
    return response.data;
  }

  // PATCH /internal/whalesync/subscription. Does not throw on non-2xx — callers assert the status.
  function patchSubscription(whalesyncTeamId: string, subscription: Record<string, unknown>) {
    return axios.patch(
      `${apiUrl}/internal/whalesync/subscription`,
      { whalesyncTeamId, subscription },
      { headers: adminHeaders, ...anyStatus },
    );
  }

  // PUT /internal/whalesync/teams/:whalesyncTeamId/live-export-access. Does not throw on non-2xx.
  function setTeamLiveExportAccess(whalesyncTeamId: string, liveExportAccess: Record<string, unknown>) {
    return axios.put(`${apiUrl}/internal/whalesync/teams/${whalesyncTeamId}/live-export-access`, liveExportAccess, {
      headers: adminHeaders,
      ...anyStatus,
    });
  }

  // The subscription rows of the team's shadow user's organization. Needs a DB matching the target server.
  async function findSubscriptionRowsOfTeamShadowUserOrganization(prisma: PrismaClient, whalesyncTeamId: string) {
    const shadowUser = await prisma.user.findUnique({ where: { whalesyncTeamId } });
    return prisma.subscription.findMany({ where: { organizationId: shadowUser?.organizationId ?? '' } });
  }

  // GET /internal/whalesync/teams/:whalesyncTeamId/live-exports. Does not throw on non-2xx.
  function listTeamLiveExports(whalesyncTeamId: string) {
    return axios.get<LiveExportListResponse>(`${apiUrl}/internal/whalesync/teams/${whalesyncTeamId}/live-exports`, {
      headers: adminHeaders,
      ...anyStatus,
    });
  }

  // DELETE /internal/whalesync/teams/:whalesyncTeamId. Does not throw on non-2xx.
  function deprovisionTeam(whalesyncTeamId: string) {
    return axios.delete(`${apiUrl}/internal/whalesync/teams/${whalesyncTeamId}`, {
      headers: adminHeaders,
      ...anyStatus,
    });
  }

  // Resolve the actor a session token authenticates as. Does not throw on 401 — callers assert status.
  function fetchCurrentUser(apiToken: string) {
    return axios.get<CurrentUserResponse>(`${apiUrl}/users/current`, {
      headers: { Authorization: `API-Token ${apiToken}` },
      ...anyStatus,
    });
  }

  // 1 + 2 — provision + mint: a pure shadow user for the team, with no email, and a 10-min token
  it("provisions the team's pure shadow user with a synthetic clerkId, no email, and a 10-min token", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const before = Date.now();
    const session = await createSession(whalesyncTeamId, 'Analytical Engines');

    expect(session.scratchUserId).toBeTruthy();
    expect(session.apiToken).toBeTruthy();

    // expiresAt ≈ 10 minutes out
    const ttlMs = new Date(session.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(1000 * 60 * 8);
    expect(ttlMs).toBeLessThan(1000 * 60 * 12);

    // The minted token authenticates as the shadow user, and /users/current exposes the synthetic
    // clerkId and no email (a team has none) — asserted over HTTP so it holds in both local and
    // remote/deployed (API-only) modes.
    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.status).toBe(200);
    expect(whoami.data.id).toBe(session.scratchUserId);
    expect(whoami.data.clerkId).toBe(`ws_${whalesyncTeamId}`);
    expect(whoami.data.isAdmin).toBe(false); // role === USER
    expect(whoami.data.email ?? null).toBeNull();

    if (prismaForDbRowAssertions) {
      // Token type is not exposed over HTTP; assert it directly when a matching DB is available.
      const tokenRow = await prismaForDbRowAssertions.apiToken.findUnique({ where: { token: session.apiToken } });
      expect(tokenRow?.type).toBe('WHALESYNC_SESSION');
      expect(tokenRow?.userId).toBe(session.scratchUserId);
      const shadowUserRow = await prismaForDbRowAssertions.user.findUnique({ where: { id: session.scratchUserId } });
      expect(shadowUserRow).toMatchObject({ whalesyncTeamId, whalesyncUserId: null, email: null });
    }
  });

  // 1b — a Whalesync backend that still sends the acting person's id, email, and team-membership flag keeps working:
  // the unknown keys are stripped, so nothing about the person reaches the shadow user.
  it('accepts and ignores the legacy per-person body fields', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const legacyWhalesyncUserId = randomUUID();
    const legacyEmail = `legacy-${legacyWhalesyncUserId}@example.com`;

    const response = await axios.post<SessionResponse>(
      `${apiUrl}/internal/whalesync/sessions`,
      {
        whalesyncTeamId,
        whalesyncUserId: legacyWhalesyncUserId,
        whalesyncUserIsTeamsOnlyMember: true,
        email: legacyEmail,
        name: 'Legacy Caller Team',
      },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(response.status).toBe(201);
    expect(response.data.scratchUserId).toBeTruthy();

    const whoami = await fetchCurrentUser(response.data.apiToken);
    expect(whoami.data.clerkId).toBe(`ws_${whalesyncTeamId}`);
    expect(whoami.data.email ?? null).toBeNull();

    if (prismaForDbRowAssertions) {
      const shadowUserRow = await prismaForDbRowAssertions.user.findUnique({
        where: { id: response.data.scratchUserId },
      });
      expect(shadowUserRow).toMatchObject({ whalesyncTeamId, whalesyncUserId: null, email: null });
      expect(await prismaForDbRowAssertions.user.count({ where: { email: legacyEmail } })).toBe(0);
    }
  });

  // 1c — the team id is required on both bodies that name a team.
  it('rejects a session or subscription request that names no team (400)', async () => {
    const sessionResponse = await axios.post(
      `${apiUrl}/internal/whalesync/sessions`,
      { whalesyncUserId: randomUUID(), email: 'no-team@example.com' },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(sessionResponse.status).toBe(400);

    const subscriptionResponse = await axios.patch(
      `${apiUrl}/internal/whalesync/subscription`,
      { whalesyncUserId: randomUUID(), subscription: { status: 'expired' } },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(subscriptionResponse.status).toBe(400);
  });

  // 1d — shadow users are auto-subscribed to the internal Whalesync plan ($0, Pro-equivalent), the plan
  // is visible on /users/current, "manage" is not offered (no real Stripe sub), and the assignment is
  // idempotent: a second session does NOT create a duplicate subscription row (self-heal-safe).
  it('auto-subscribes a shadow user to the Whalesync plan without creating duplicates', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId, 'Compilers');

    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.status).toBe(200);
    expect(whoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');
    expect(whoami.data.subscription?.planDisplayName).toBe('Whalesync');
    expect(whoami.data.subscription?.costUSD).toBe(0);
    expect(whoami.data.subscription?.status).toBe('valid');
    // Internal plan: no real Stripe subscription behind it, so "manage" must not be offered.
    expect(whoami.data.subscription?.canManageSubscription).toBe(false);

    // A second session for the same team must not create a second Whalesync subscription.
    const second = await createSession(whalesyncTeamId);
    const secondWhoami = await fetchCurrentUser(second.apiToken);
    expect(secondWhoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');

    if (prismaForDbRowAssertions) {
      const user = await prismaForDbRowAssertions.user.findUnique({ where: { whalesyncTeamId } });
      expect(user).toBeTruthy();
      const subscriptions = await prismaForDbRowAssertions.subscription.findMany({
        where: { organizationId: user?.organizationId ?? '' },
      });
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].planType).toBe('WHALESYNC_PLAN');
      expect(subscriptions[0].priceInDollars).toBe(0);
      expect(subscriptions[0].stripeStatus).toBe('active');
      // Effectively-permanent expiry (far in the future).
      expect(subscriptions[0].expiration.getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() + 99);
    }
  });

  // 1e — a session's old subscription payload with status 'active' becomes the team's Live Export access (DEV-12983):
  // its record limit and cadence are stored in Subscription.metadata, unpaused. Its product type and expiry are
  // ignored, so the plan keeps its nominal far-future expiry and never lapses.
  it("stores an active session subscription payload's limits as the team's Live Export access, ignoring its expiry", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId, 'Trajectories', {
      status: 'active',
      whalesyncProductType: 'growth',
      liveExportRecordCountLimit: 5000,
      liveExportCadence: 'hourly',
      expiresAt: '2027-01-15T00:00:00.000Z',
    });

    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');

    // Setting the same access writes nothing, which shows over HTTP that the session stored exactly this access.
    const sameLiveExportAccessResponse = await setTeamLiveExportAccess(whalesyncTeamId, {
      paused: false,
      recordLimit: 5000,
      fastestCadence: 'hourly',
    });
    expect(sameLiveExportAccessResponse.status).toBe(200);
    expect(sameLiveExportAccessResponse.data).toEqual({ scratchUserId: session.scratchUserId, updated: false });

    if (prismaForDbRowAssertions) {
      const subscriptions = await findSubscriptionRowsOfTeamShadowUserOrganization(
        prismaForDbRowAssertions,
        whalesyncTeamId,
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].stripeStatus).toBe('active');
      // The payload's expiresAt is ignored: the nominal far-future expiry stays.
      expect(subscriptions[0].expiration.getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() + 99);
      expect(subscriptions[0].metadata).toEqual({
        liveExportsPaused: false,
        liveExportRecordCountLimit: 5000,
        liveExportCadence: 'hourly',
      });
    }
  });

  // 1f — a session's old subscription payload whose status is NOT active still gives the team the Whalesync plan, so
  // Scratch's own subscription rules never act on the shadow organization, but with its Live Exports paused.
  it('gives the Whalesync plan with Live Exports paused when the session subscription status is not active', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId, 'Spanning Trees', { status: 'expired' });

    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');
    expect(whoami.data.subscription?.status).toBe('valid');

    // The session stored a paused access, so setting that access again writes nothing.
    const sameLiveExportAccessResponse = await setTeamLiveExportAccess(whalesyncTeamId, {
      paused: true,
      recordLimit: null,
      fastestCadence: null,
    });
    expect(sameLiveExportAccessResponse.data).toEqual({ scratchUserId: session.scratchUserId, updated: false });

    if (prismaForDbRowAssertions) {
      const subscriptions = await findSubscriptionRowsOfTeamShadowUserOrganization(
        prismaForDbRowAssertions,
        whalesyncTeamId,
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].planType).toBe('WHALESYNC_PLAN');
      expect(subscriptions[0].stripeStatus).toBe('active');
      expect(subscriptions[0].metadata).toEqual({ liveExportsPaused: true });
    }
  });

  // 3a — PATCH /subscription with a non-active status pauses the team's Live Exports (DEV-12983). The Whalesync plan
  // row stays active, so the shadow user keeps the plan, and a patch with an active status resumes them.
  it('pauses Live Exports on a cancelled subscription patch, keeping the Whalesync plan, and resumes on an active one', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId, 'Compilers', { status: 'active' });
    expect((await fetchCurrentUser(session.apiToken)).data.subscription?.planType).toBe('WHALESYNC_PLAN');

    const pausingPatchResponse = await patchSubscription(whalesyncTeamId, { status: 'cancelled' });
    expect(pausingPatchResponse.status).toBe(200);
    expect(pausingPatchResponse.data).toEqual({
      scratchUserId: session.scratchUserId,
      updated: true,
      planType: 'WHALESYNC_PLAN',
    });
    // A repeat writes nothing: the pause is already stored.
    expect((await patchSubscription(whalesyncTeamId, { status: 'cancelled' })).data.updated).toBe(false);

    // Over HTTP the user is still on the Whalesync plan: pausing Live Exports never lapses it.
    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');
    expect(whoami.data.subscription?.status).toBe('valid');

    if (prismaForDbRowAssertions) {
      const subscriptions = await findSubscriptionRowsOfTeamShadowUserOrganization(
        prismaForDbRowAssertions,
        whalesyncTeamId,
      );
      // The one row is kept active, with the pause in its metadata.
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].stripeStatus).toBe('active');
      expect(subscriptions[0].cancelAt).toBeNull();
      expect(subscriptions[0].metadata).toEqual({ liveExportsPaused: true });
    }

    const resumingPatchResponse = await patchSubscription(whalesyncTeamId, { status: 'active' });
    expect(resumingPatchResponse.data.updated).toBe(true);
    if (prismaForDbRowAssertions) {
      const subscriptions = await findSubscriptionRowsOfTeamShadowUserOrganization(
        prismaForDbRowAssertions,
        whalesyncTeamId,
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].metadata).toEqual({ liveExportsPaused: false });
    }
  });

  // 3b — PATCH /subscription for a team with no shadow user is an idempotent no-op (safe to retry).
  it('is an idempotent no-op when patching a subscription for a team with no shadow user', async () => {
    const response = await patchSubscription(createWhalesyncTeamIdForTest(), { status: 'expired' });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ scratchUserId: null, updated: false, planType: null });
  });

  // 3c — PUT /teams/:whalesyncTeamId/live-export-access sets the team's whole Live Export access (DEV-12983): a repeat
  // writes nothing, and a null limit is no limit, so it is left out of the stored metadata.
  it("sets a team's whole Live Export access, writing nothing on a repeat", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId, 'Abstract Data Types');
    const pausedAndLimitedLiveExportAccess = { paused: true, recordLimit: 250, fastestCadence: 'daily' };

    const firstResponse = await setTeamLiveExportAccess(whalesyncTeamId, pausedAndLimitedLiveExportAccess);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.data).toEqual({ scratchUserId: session.scratchUserId, updated: true });
    const repeatedResponse = await setTeamLiveExportAccess(whalesyncTeamId, pausedAndLimitedLiveExportAccess);
    expect(repeatedResponse.data).toEqual({ scratchUserId: session.scratchUserId, updated: false });
    expect((await fetchCurrentUser(session.apiToken)).data.subscription?.planType).toBe('WHALESYNC_PLAN');

    if (prismaForDbRowAssertions) {
      const subscriptions = await findSubscriptionRowsOfTeamShadowUserOrganization(
        prismaForDbRowAssertions,
        whalesyncTeamId,
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].stripeStatus).toBe('active');
      expect(subscriptions[0].metadata).toEqual({
        liveExportsPaused: true,
        liveExportRecordCountLimit: 250,
        liveExportCadence: 'daily',
      });
    }

    const noLimitsResponse = await setTeamLiveExportAccess(whalesyncTeamId, {
      paused: false,
      recordLimit: null,
      fastestCadence: null,
    });
    expect(noLimitsResponse.data).toEqual({ scratchUserId: session.scratchUserId, updated: true });
    if (prismaForDbRowAssertions) {
      const subscriptions = await findSubscriptionRowsOfTeamShadowUserOrganization(
        prismaForDbRowAssertions,
        whalesyncTeamId,
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].metadata).toEqual({ liveExportsPaused: false });
    }
  });

  // 3d — a session's liveExportAccess is applied, and wins over the old subscription payload sent alongside it.
  it("applies a session's liveExportAccess over the subscription payload it carries", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const liveExportAccess = { paused: true, recordLimit: 10, fastestCadence: 'frequent' };
    const sessionResponse = await axios.post<SessionResponse>(
      `${apiUrl}/internal/whalesync/sessions`,
      { whalesyncTeamId, name: 'Access Team', liveExportAccess, subscription: { status: 'active' } },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(sessionResponse.status).toBe(201);

    // The session stored exactly this access (paused, not the active subscription), so setting it again writes nothing.
    const sameLiveExportAccessResponse = await setTeamLiveExportAccess(whalesyncTeamId, liveExportAccess);
    expect(sameLiveExportAccessResponse.data).toEqual({
      scratchUserId: sessionResponse.data.scratchUserId,
      updated: false,
    });

    if (prismaForDbRowAssertions) {
      const subscriptions = await findSubscriptionRowsOfTeamShadowUserOrganization(
        prismaForDbRowAssertions,
        whalesyncTeamId,
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].metadata).toEqual({
        liveExportsPaused: true,
        liveExportRecordCountLimit: 10,
        liveExportCadence: 'frequent',
      });
    }
  });

  // 3e — setting the Live Export access of a team with no shadow user is a no-op that creates nothing, and an access
  // that is not whole is refused (400).
  it('answers updated: false for a team with no shadow user, and 400 for a Live Export access that is not whole', async () => {
    const teamWithoutShadowUser = createWhalesyncTeamIdForTest();
    const noShadowUserResponse = await setTeamLiveExportAccess(teamWithoutShadowUser, {
      paused: true,
      recordLimit: null,
      fastestCadence: null,
    });
    expect(noShadowUserResponse.status).toBe(200);
    expect(noShadowUserResponse.data).toEqual({ scratchUserId: null, updated: false });
    if (prismaForDbRowAssertions) {
      expect(await prismaForDbRowAssertions.user.count({ where: { whalesyncTeamId: teamWithoutShadowUser } })).toBe(0);
    }

    const partialLiveExportAccessResponse = await setTeamLiveExportAccess(teamWithoutShadowUser, { paused: true });
    expect(partialLiveExportAccessResponse.status).toBe(400);
  });

  // 3 — idempotency: every member of a team reaches the same shadow user, each session an additive token
  it("gives every member's session the team's one shadow user and mints an additional token each call", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    // Two members of the team: what an older Whalesync backend sends about each person is ignored.
    const firstMemberSession = await createSession(whalesyncTeamId, 'Shared Team', undefined, {
      whalesyncUserId: randomUUID(),
      email: `member-one-${randomUUID()}@example.com`,
    });
    const secondMemberSession = await createSession(whalesyncTeamId, 'Shared Team', undefined, {
      whalesyncUserId: randomUUID(),
      email: `member-two-${randomUUID()}@example.com`,
    });

    // Same shadow user resolved both times (idempotent on whalesyncTeamId)...
    expect(secondMemberSession.scratchUserId).toBe(firstMemberSession.scratchUserId);
    // ...and each call minted a distinct, independently-valid token (additive minting), both
    // resolving to the same shadow user — observable over HTTP without a DB.
    expect(secondMemberSession.apiToken).not.toBe(firstMemberSession.apiToken);
    const firstWhoami = await fetchCurrentUser(firstMemberSession.apiToken);
    const secondWhoami = await fetchCurrentUser(secondMemberSession.apiToken);
    expect(firstWhoami.status).toBe(200);
    expect(secondWhoami.status).toBe(200);
    expect(firstWhoami.data.id).toBe(firstMemberSession.scratchUserId);
    expect(secondWhoami.data.id).toBe(firstMemberSession.scratchUserId);

    if (prismaForDbRowAssertions) {
      const userCount = await prismaForDbRowAssertions.user.count({ where: { clerkId: `ws_${whalesyncTeamId}` } });
      expect(userCount).toBe(1);

      const sessionTokenCount = await prismaForDbRowAssertions.apiToken.count({
        where: { userId: firstMemberSession.scratchUserId, type: 'WHALESYNC_SESSION' },
      });
      expect(sessionTokenCount).toBe(2);
    }
  });

  // 4 — minted token authenticates a real request as the shadow user
  it('mints a token that authenticates as the shadow user on a normal API route', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId);

    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.status).toBe(200);
    expect(whoami.data.id).toBe(session.scratchUserId);
  });

  // 5 — the team's Live Exports, listed for Whalesync's admin dev tools
  it("lists a team's Live Exports, and an empty list for a team with no shadow user", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId, 'Exporters');
    // A Live Export created through the API under the Whalesync session, so it has a real repo to tear down.
    const liveExportResponse = await axios.post<{ id: string }>(
      `${apiUrl}/workbook`,
      { name: 'Deals export', managedBy: 'ws_export' },
      { headers: { Authorization: `API-Token ${session.apiToken}` } },
    );
    const liveExportWorkbookId = liveExportResponse.data.id;
    expect(liveExportWorkbookId).toBeTruthy();

    const listResponse = await listTeamLiveExports(whalesyncTeamId);
    expect(listResponse.status).toBe(200);
    // The default workspace every new user gets is not a Live Export, so it isn't listed.
    expect(listResponse.data.liveExports.map((liveExport) => liveExport.id)).toEqual([liveExportWorkbookId]);
    expect(listResponse.data.liveExports[0].name).toBe('Deals export');

    // Read-only: a team with no shadow user gets an empty list, and none is created.
    const teamWithoutShadowUser = createWhalesyncTeamIdForTest();
    const emptyListResponse = await listTeamLiveExports(teamWithoutShadowUser);
    expect(emptyListResponse.status).toBe(200);
    expect(emptyListResponse.data).toEqual({ liveExports: [] });
    if (prismaForDbRowAssertions) {
      expect(await prismaForDbRowAssertions.user.count({ where: { whalesyncTeamId: teamWithoutShadowUser } })).toBe(0);
    }
  });

  // 7 — deprovision tears down user + org + workbooks + tokens, idempotent on an unknown team
  it("deprovisions a team's shadow user (user, org, Live Exports, tokens) and is idempotent", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId, 'Short-lived Team');
    const liveExportResponse = await axios.post<{ id: string }>(
      `${apiUrl}/workbook`,
      { name: 'Doomed export', managedBy: 'ws_export' },
      { headers: { Authorization: `API-Token ${session.apiToken}` } },
    );
    const liveExportWorkbookId = liveExportResponse.data.id;
    const organizationIdOfShadowUser = prismaForDbRowAssertions
      ? (await prismaForDbRowAssertions.user.findUnique({ where: { id: session.scratchUserId } }))?.organizationId
      : undefined;

    const first = await deprovisionTeam(whalesyncTeamId);
    expect(first.status).toBe(204);

    // The user and its tokens are gone: the previously-valid token stops authenticating.
    const afterDeprovision = await fetchCurrentUser(session.apiToken);
    expect(afterDeprovision.status).toBe(401);
    // ...and the team has no Live Exports left.
    expect((await listTeamLiveExports(whalesyncTeamId)).data).toEqual({ liveExports: [] });

    if (prismaForDbRowAssertions) {
      expect(await prismaForDbRowAssertions.user.findUnique({ where: { whalesyncTeamId } })).toBeNull();
      expect(await prismaForDbRowAssertions.apiToken.count({ where: { userId: session.scratchUserId } })).toBe(0);
      expect(await prismaForDbRowAssertions.workbook.findUnique({ where: { id: liveExportWorkbookId } })).toBeNull();
      expect(
        await prismaForDbRowAssertions.organization.findUnique({ where: { id: organizationIdOfShadowUser ?? '' } }),
      ).toBeNull();
    }

    // Idempotent: deprovisioning an already-gone (or never-provisioned) team still succeeds.
    expect((await deprovisionTeam(whalesyncTeamId)).status).toBe(204);
    expect((await deprovisionTeam(createWhalesyncTeamIdForTest())).status).toBe(204);
  });

  // 7b — the fail-safe: a real Scratch account (real Clerk login) that carries a team id is refused (409) by every
  // team route, and nothing about it changes. Seeds the account directly, so it needs a local DB matching the target
  // server (skipped in API-only mode).
  (isApiOnlyMode ? it.skip : it)(
    'refuses (409) every team route for a real Scratch account that carries the team id, changing nothing',
    async () => {
      const prisma = prismaForDbRowAssertions;
      if (!prisma) return; // narrowing for TS; the it/it.skip guard already gates execution

      // Not pushed to provisionedWhalesyncTeamIds: its teardown is the direct cleanup below, never a deprovision.
      const whalesyncTeamId = createWhalesyncTeamIdForTest();
      const nativeUserId = `usr_test_${randomUUID()}`;
      const nativeClerkId = `user_test_${randomUUID()}`;
      const nativeOrganizationId = `org_test_${randomUUID()}`;
      const nativeWorkbookId = `wkb_test_${randomUUID()}`;
      const nativeEmail = `real-account-${randomUUID()}@example.com`;

      await prisma.organization.create({
        data: { id: nativeOrganizationId, clerkId: nativeClerkId, name: 'Native Organization' },
      });
      await prisma.user.create({
        data: {
          id: nativeUserId,
          clerkId: nativeClerkId,
          email: nativeEmail,
          organizationId: nativeOrganizationId,
          whalesyncTeamId,
        },
      });
      await prisma.workbook.create({
        data: {
          id: nativeWorkbookId,
          name: 'Native workbook',
          organizationId: nativeOrganizationId,
          userId: nativeUserId,
        },
      });

      try {
        const realAccountBefore = await prisma.user.findUniqueOrThrow({ where: { id: nativeUserId } });

        const sessionResponse = await axios.post(
          `${apiUrl}/internal/whalesync/sessions`,
          { whalesyncTeamId, name: 'Team' },
          { headers: adminHeaders, ...anyStatus },
        );
        expect(sessionResponse.status).toBe(409);
        expect((await patchSubscription(whalesyncTeamId, { status: 'active' })).status).toBe(409);
        const setLiveExportAccessResponse = await setTeamLiveExportAccess(whalesyncTeamId, {
          paused: true,
          recordLimit: null,
          fastestCadence: null,
        });
        expect(setLiveExportAccessResponse.status).toBe(409);
        expect((await listTeamLiveExports(whalesyncTeamId)).status).toBe(409);
        expect((await deprovisionTeam(whalesyncTeamId)).status).toBe(409);

        expect(await prisma.user.findUniqueOrThrow({ where: { id: nativeUserId } })).toEqual(realAccountBefore);
        expect(await prisma.organization.findUnique({ where: { id: nativeOrganizationId } })).not.toBeNull();
        expect(await prisma.workbook.findUnique({ where: { id: nativeWorkbookId } })).not.toBeNull();
        expect(await prisma.apiToken.count({ where: { userId: nativeUserId } })).toBe(0);
        expect(await prisma.subscription.count({ where: { organizationId: nativeOrganizationId } })).toBe(0);
        expect(await prisma.user.count({ where: { clerkId: `ws_${whalesyncTeamId}` } })).toBe(0);
      } finally {
        // Deleting the org cascades its workbooks; the user goes with its tokens.
        await prisma.apiToken.deleteMany({ where: { userId: nativeUserId } });
        await prisma.user.deleteMany({ where: { id: nativeUserId } });
        await prisma.organization.deleteMany({ where: { id: nativeOrganizationId } });
      }
    },
  );

  // 8 — the per-person routes and the team-link routes are gone
  describe('removed routes', () => {
    const someWhalesyncUserId = randomUUID();
    const removedRoutes: { method: 'get' | 'post' | 'delete'; path: string; body?: Record<string, unknown> }[] = [
      {
        method: 'post',
        path: '/internal/whalesync/users',
        body: { whalesyncUserId: someWhalesyncUserId, email: 'removed@example.com' },
      },
      { method: 'delete', path: `/internal/whalesync/users/${someWhalesyncUserId}` },
      { method: 'delete', path: `/internal/whalesync/users/${someWhalesyncUserId}/sessions` },
      { method: 'delete', path: `/internal/whalesync/users/${someWhalesyncUserId}/subscription` },
      { method: 'get', path: `/internal/whalesync/users/${someWhalesyncUserId}/live-exports` },
      { method: 'get', path: '/internal/whalesync/team-links/pending' },
      {
        method: 'post',
        path: '/internal/whalesync/team-links',
        body: { links: [{ whalesyncUserId: someWhalesyncUserId, whalesyncTeamId: 'tm_removed0000' }] },
      },
    ];

    it.each(removedRoutes)('$method $path answers 404', async ({ method, path, body }) => {
      const response = await axios.request({
        method,
        url: `${apiUrl}${path}`,
        data: body,
        headers: adminHeaders,
        ...anyStatus,
      });
      expect(response.status).toBe(404);
    });
  });

  // 9 — admin guard
  describe('ScratchAdminGuard', () => {
    const body = { whalesyncTeamId: createWhalesyncTeamIdForTest() };

    it('rejects a request with no admin token (401)', async () => {
      const response = await axios.post(`${apiUrl}/internal/whalesync/sessions`, body, anyStatus);
      expect(response.status).toBe(401);
    });

    it('rejects a request with a wrong admin token (401)', async () => {
      const response = await axios.post(`${apiUrl}/internal/whalesync/sessions`, body, {
        headers: { 'X-Scratch-Admin-Token': 'definitely-wrong' },
        ...anyStatus,
      });
      expect(response.status).toBe(401);
    });
  });

  // 10 — rate-limit bypass for WHALESYNC_SESSION tokens
  //
  // Sends the full burst through a small fixed-size worker pool rather than firing all 75 at once.
  // Against the remote deployed server a 75-wide `Promise.all` spike inflates tail latency on both the
  // runner egress and the server, and the retry client's 15s-per-attempt timeout can then turn a single
  // stalled GET into ~46s of retries — which, awaited alongside the rest, used to push the whole test
  // past its 60s cap and flake with a timeout that named no request. A bounded pool lands all 75 within
  // a couple seconds (still inside the 60s rate-limit window and still well over the ~60-req cap), so the
  // assertion is identical while the herd that caused the flakiness is gone.
  //
  // The 120s per-test timeout is a backstop above the suite-wide 60s cap: a genuinely slow (but
  // non-throttling) remote should not read as a failure. The bounded pool is what actually caps the
  // tail; the larger timeout is the margin.
  it('does not rate limit WHALESYNC_SESSION tokens under burst polling', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await createSession(whalesyncTeamId);

    // Fire well over the default 60 req / 60s cap. With the bypass in place none should be throttled.
    // NOTE: if API_RATE_LIMIT_DISABLED is true (the default in `development`), this trivially passes and
    // proves nothing — the real throttling contrast is covered by the ApiRateLimitGuard unit test.
    const requestIndexes = Array.from({ length: 75 }, (_unused, index) => index);
    const responses = await mapWithConcurrency(requestIndexes, 10, () =>
      axios.get(`${apiUrl}/users/current`, {
        headers: { Authorization: `API-Token ${session.apiToken}` },
        ...anyStatus,
      }),
    );
    const throttled = responses.filter((response) => response.status === 429);
    expect(throttled).toHaveLength(0);
  }, 120_000);
});
