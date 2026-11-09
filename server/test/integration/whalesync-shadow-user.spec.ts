/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

/**
 * Integration tests for the internal Whalesync shadow-user + session-management endpoints
 * (`/internal/whalesync/*`) and the WHALESYNC_SESSION token behavior.
 *
 * PRECONDITIONS (the suite skips itself, with a warning, if they are not met):
 *   - RUN_WHALESYNC_INTEGRATION=true
 *   - SCRATCH_ADMIN_API_KEY set to the SAME value the running server was started with
 *   - A Scratch server reachable at INTEGRATION_TEST_API_DOMAIN (default localhost:3010)
 *
 * These drive the real server over HTTP, so they exercise the full chain: ScratchAdminGuard →
 * controller → UsersService/WorkbookService → DB → git. Each test uses a fresh random whalesyncUserId
 * and is torn down through the deprovision endpoint so workbook repos are cleaned up (not orphaned).
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
  const provisionedWhalesyncUserIds: string[] = [];

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
    // Deprovision everything created this test (idempotent), so no workbook repos or rows leak.
    for (const whalesyncUserId of provisionedWhalesyncUserIds.splice(0)) {
      await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}`, {
        headers: adminHeaders,
        ...anyStatus,
      });
    }
  });

  afterAll(async () => {
    await prismaForDbRowAssertions?.$disconnect();
  });

  async function createSession(
    whalesyncUserId: string,
    email: string,
    name?: string,
    subscription?: Record<string, unknown>,
  ): Promise<SessionResponse> {
    provisionedWhalesyncUserIds.push(whalesyncUserId);
    const response = await axios.post<SessionResponse>(
      `${apiUrl}/internal/whalesync/sessions`,
      { whalesyncUserId, email, name, subscription },
      { headers: adminHeaders },
    );
    return response.data;
  }

  // PATCH /internal/whalesync/subscription. Does not throw on non-2xx — callers assert the status.
  function patchSubscription(whalesyncUserId: string, subscription: Record<string, unknown>) {
    return axios.patch(
      `${apiUrl}/internal/whalesync/subscription`,
      { whalesyncUserId, subscription },
      { headers: adminHeaders, ...anyStatus },
    );
  }

  // Resolve the actor a session token authenticates as. Does not throw on 401 — callers assert status.
  function fetchCurrentUser(apiToken: string) {
    return axios.get<CurrentUserResponse>(`${apiUrl}/users/current`, {
      headers: { Authorization: `API-Token ${apiToken}` },
      ...anyStatus,
    });
  }

  // 1 + 2 — provision + mint, real (un-prefixed) normalized email, 10-min token
  it('provisions a shadow user with a synthetic clerkId, a real normalized email, and a 10-min token', async () => {
    const whalesyncUserId = randomUUID();
    // Unique address so it cannot collide with any existing user (post-reconciliation we adopt on a
    // collision rather than coexist — see the adoption test below).
    const email = `ada-${whalesyncUserId}@example.com`;
    const before = Date.now();
    const session = await createSession(whalesyncUserId, `  ${email.toUpperCase()}  `, 'Ada Lovelace');

    expect(session.scratchUserId).toBeTruthy();
    expect(session.apiToken).toBeTruthy();

    // expiresAt ≈ 10 minutes out
    const ttlMs = new Date(session.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(1000 * 60 * 8);
    expect(ttlMs).toBeLessThan(1000 * 60 * 12);

    // The minted token authenticates as the shadow user, and /users/current exposes the synthetic
    // clerkId and the real, normalized (un-prefixed) email — asserted over HTTP so it holds in both
    // local and remote/deployed (API-only) modes.
    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.status).toBe(200);
    expect(whoami.data.id).toBe(session.scratchUserId);
    expect(whoami.data.clerkId).toBe(`ws_${whalesyncUserId}`);
    expect(whoami.data.isAdmin).toBe(false); // role === USER
    // Real address, NOT ws:-prefixed, lowercased/trimmed by the DB email-normalization trigger.
    expect(whoami.data.email).toBe(email.toLowerCase());

    if (prismaForDbRowAssertions) {
      // Token type is not exposed over HTTP; assert it directly when a matching DB is available.
      const tokenRow = await prismaForDbRowAssertions.apiToken.findUnique({ where: { token: session.apiToken } });
      expect(tokenRow?.type).toBe('WHALESYNC_SESSION');
      expect(tokenRow?.userId).toBe(session.scratchUserId);
    }
  });

  // 1c — shadow users are auto-subscribed to the internal Whalesync plan ($0, Pro-equivalent), the plan
  // is visible on /users/current, "manage" is not offered (no real Stripe sub), and the assignment is
  // idempotent: a second session does NOT create a duplicate subscription row (self-heal-safe).
  it('auto-subscribes a shadow user to the Whalesync plan without creating duplicates', async () => {
    const whalesyncUserId = randomUUID();
    const email = `plan-${whalesyncUserId}@example.com`;
    const session = await createSession(whalesyncUserId, email, 'Grace Hopper');

    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.status).toBe(200);
    expect(whoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');
    expect(whoami.data.subscription?.planDisplayName).toBe('Whalesync');
    expect(whoami.data.subscription?.costUSD).toBe(0);
    expect(whoami.data.subscription?.status).toBe('valid');
    // Internal plan: no real Stripe subscription behind it, so "manage" must not be offered.
    expect(whoami.data.subscription?.canManageSubscription).toBe(false);

    // A second session for the same user must not create a second Whalesync subscription.
    const second = await createSession(whalesyncUserId, email);
    const secondWhoami = await fetchCurrentUser(second.apiToken);
    expect(secondWhoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');

    if (prismaForDbRowAssertions) {
      const user = await prismaForDbRowAssertions.user.findFirst({ where: { whalesyncUserId } });
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

  // 1d — a session subscription payload with status 'active' records the Whalesync-side shape in
  // Subscription.metadata (product type + Live Export limits) and keeps stripeStatus 'active'.
  it('records the session subscription payload in metadata and applies the UTC expiry when status is active', async () => {
    const whalesyncUserId = randomUUID();
    const email = `sub-active-${whalesyncUserId}@example.com`;
    const expiresAt = '2027-01-15T00:00:00.000Z';
    const session = await createSession(whalesyncUserId, email, 'Katherine Johnson', {
      status: 'active',
      whalesyncProductType: 'growth',
      liveExportRecordCountLimit: 5000,
      liveExportCadence: 'hourly',
      expiresAt,
    });

    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.data.subscription?.planType).toBe('WHALESYNC_PLAN');

    if (prismaForDbRowAssertions) {
      const user = await prismaForDbRowAssertions.user.findFirst({ where: { whalesyncUserId } });
      const subscriptions = await prismaForDbRowAssertions.subscription.findMany({
        where: { organizationId: user?.organizationId ?? '' },
      });
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].stripeStatus).toBe('active');
      // Whalesync's own UTC expiry replaces the nominal far-future expiry.
      expect(subscriptions[0].expiration.toISOString()).toBe(expiresAt);
      expect(subscriptions[0].metadata).toEqual({
        whalesyncStatus: 'active',
        whalesyncProductType: 'growth',
        liveExportRecordCountLimit: 5000,
        liveExportCadence: 'hourly',
      });
    }
  });

  // 1e — a session subscription payload whose status is NOT active must not create a subscription row.
  (isApiOnlyMode ? it.skip : it)(
    'does not create a subscription when the session subscription status is not active',
    async () => {
      const prisma = prismaForDbRowAssertions;
      if (!prisma) return;

      const whalesyncUserId = randomUUID();
      const email = `sub-none-${whalesyncUserId}@example.com`;
      const session = await createSession(whalesyncUserId, email, 'Radia Perlman', { status: 'expired' });

      const user = await prisma.user.findFirst({ where: { whalesyncUserId } });
      expect(user).toBeTruthy(); // the shadow user is still provisioned...
      const subscriptions = await prisma.subscription.findMany({
        where: { organizationId: user?.organizationId ?? '' },
      });
      expect(subscriptions).toHaveLength(0); // ...but no Whalesync plan was granted.

      // Over HTTP the user is not on the Whalesync plan.
      const whoami = await fetchCurrentUser(session.apiToken);
      expect(whoami.data.subscription?.planType).not.toBe('WHALESYNC_PLAN');
    },
  );

  // 3a — PATCH /subscription with a non-active status soft-updates (keeps) the Whalesync row and marks it
  // inactive, so the user drops off the Whalesync plan.
  it('marks the Whalesync plan inactive on a cancelled subscription patch', async () => {
    const whalesyncUserId = randomUUID();
    const email = `patch-cancel-${whalesyncUserId}@example.com`;
    const session = await createSession(whalesyncUserId, email, 'Grace Hopper', { status: 'active' });
    expect((await fetchCurrentUser(session.apiToken)).data.subscription?.planType).toBe('WHALESYNC_PLAN');

    const patched = await patchSubscription(whalesyncUserId, { status: 'cancelled' });
    expect(patched.status).toBe(200);
    expect(patched.data.scratchUserId).toBe(session.scratchUserId);
    expect(patched.data.updated).toBe(true);

    // Over HTTP the user is no longer on the Whalesync plan.
    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.data.subscription?.planType).not.toBe('WHALESYNC_PLAN');

    if (prismaForDbRowAssertions) {
      const user = await prismaForDbRowAssertions.user.findFirst({ where: { whalesyncUserId } });
      const subscriptions = await prismaForDbRowAssertions.subscription.findMany({
        where: { organizationId: user?.organizationId ?? '' },
      });
      // The row is KEPT (soft-update), not deleted, and marked canceled.
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].stripeStatus).toBe('canceled');
    }
  });

  // 3b — PATCH /subscription for a user that doesn't exist is an idempotent no-op (safe to retry).
  it('is an idempotent no-op when patching a subscription for an unknown user', async () => {
    const response = await patchSubscription(randomUUID(), { status: 'expired' });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ scratchUserId: null, updated: false, planType: null });
  });

  // 3c — PATCH /subscription refuses (409) to touch a real Scratch Stripe subscription (paid Pro/Max).
  (isApiOnlyMode ? it.skip : it)(
    'returns 409 when the organization has a real Scratch Stripe subscription',
    async () => {
      const prisma = prismaForDbRowAssertions;
      if (!prisma) return;

      const whalesyncUserId = randomUUID();
      const email = `patch-real-${whalesyncUserId}@example.com`;
      const session = await createSession(whalesyncUserId, email, 'Barbara Liskov', { status: 'active' });

      // Turn the org's Whalesync row into a real (non-Whalesync) active Stripe subscription.
      const user = await prisma.user.findFirst({ where: { whalesyncUserId } });
      await prisma.subscription.updateMany({
        where: { organizationId: user?.organizationId ?? '' },
        data: { planType: 'PRO_PLAN', stripeSubscriptionId: `sub_real_${whalesyncUserId}` },
      });

      const response = await patchSubscription(whalesyncUserId, { status: 'cancelled' });
      expect(response.status).toBe(409);
    },
  );

  // 2b — reconciliation: an existing Scratch user that owns the email is adopted, not duplicated.
  // Requires a local DB matching the target server (to seed the pre-existing native user directly),
  // so it is skipped in API-only mode. Gated on isApiOnlyMode (known at registration time) rather
  // than prismaForDbRowAssertions (assigned later, in beforeAll).
  (isApiOnlyMode ? it.skip : it)(
    'adopts an existing Scratch user that owns the email instead of creating a duplicate',
    async () => {
      const prisma = prismaForDbRowAssertions;
      if (!prisma) return; // narrowing for TS; the it/it.skip guard already gates execution

      const whalesyncUserId = randomUUID();
      const email = `adopt-${whalesyncUserId}@example.com`;
      const nativeUserId = `usr_test_${randomUUID()}`;
      const nativeClerkId = `user_test_${randomUUID()}`;

      // Seed a pre-existing native Scratch user (real Clerk login, not linked to any Whalesync user).
      await prisma.user.create({ data: { id: nativeUserId, clerkId: nativeClerkId, email } });

      try {
        // Provision a Whalesync session for the SAME email under a brand-new whalesyncUserId.
        const session = await createSession(whalesyncUserId, email, 'Ada Lovelace');

        // Adopted: the session resolves to the existing native user, not a freshly-created shadow user.
        expect(session.scratchUserId).toBe(nativeUserId);

        // The adopted user keeps its real clerkId (native login preserved) and is now Whalesync-linked.
        const whoami = await fetchCurrentUser(session.apiToken);
        expect(whoami.status).toBe(200);
        expect(whoami.data.id).toBe(nativeUserId);
        expect(whoami.data.clerkId).toBe(nativeClerkId); // NOT ws_<id>

        const linkedRow = await prisma.user.findUnique({ where: { id: nativeUserId } });
        expect(linkedRow?.whalesyncUserId).toBe(whalesyncUserId);
        expect(linkedRow?.clerkId).toBe(nativeClerkId);
        expect(linkedRow?.email).toBe(email);

        // Exactly one user owns the email — no duplicate shadow user was created.
        const usersOwningEmail = await prisma.user.count({ where: { email } });
        expect(usersOwningEmail).toBe(1);
      } finally {
        // afterEach deprovisions by whalesyncUserId; also clear the seed directly in case adoption
        // failed and the row never got linked (so it would otherwise leak).
        await prisma.apiToken.deleteMany({ where: { userId: nativeUserId } });
        await prisma.user.deleteMany({ where: { id: nativeUserId } });
      }
    },
  );

  // 3 — idempotency: same user, additive token
  it('is idempotent on whalesyncUserId and mints an additional token each call', async () => {
    const whalesyncUserId = randomUUID();
    const first = await createSession(whalesyncUserId, 'repeat@example.com');
    const second = await createSession(whalesyncUserId, 'repeat@example.com');

    // Same shadow user resolved both times (idempotent on whalesyncUserId)...
    expect(second.scratchUserId).toBe(first.scratchUserId);
    // ...and each call minted a distinct, independently-valid token (additive minting), both
    // resolving to the same shadow user — observable over HTTP without a DB.
    expect(second.apiToken).not.toBe(first.apiToken);
    const firstWhoami = await fetchCurrentUser(first.apiToken);
    const secondWhoami = await fetchCurrentUser(second.apiToken);
    expect(firstWhoami.status).toBe(200);
    expect(secondWhoami.status).toBe(200);
    expect(firstWhoami.data.id).toBe(first.scratchUserId);
    expect(secondWhoami.data.id).toBe(first.scratchUserId);

    if (prismaForDbRowAssertions) {
      const userCount = await prismaForDbRowAssertions.user.count({ where: { whalesyncUserId } });
      expect(userCount).toBe(1);

      const sessionTokenCount = await prismaForDbRowAssertions.apiToken.count({
        where: { userId: first.scratchUserId, type: 'WHALESYNC_SESSION' },
      });
      expect(sessionTokenCount).toBe(2);
    }
  });

  // 4 — minted token authenticates a real request as the shadow user
  it('mints a token that authenticates as the shadow user on a normal API route', async () => {
    const whalesyncUserId = randomUUID();
    const session = await createSession(whalesyncUserId, 'whoami@example.com');

    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.status).toBe(200);
    expect(whoami.data.id).toBe(session.scratchUserId);
  });

  // 5 — ensure-only endpoint mints no token
  it('POST /users ensures a shadow user without minting a session token', async () => {
    const whalesyncUserId = randomUUID();
    provisionedWhalesyncUserIds.push(whalesyncUserId);

    const response = await axios.post(
      `${apiUrl}/internal/whalesync/users`,
      { whalesyncUserId, email: 'ensure@example.com' },
      { headers: adminHeaders },
    );
    expect(response.status).toBe(201);
    expect(response.data.scratchUserId).toBeTruthy();
    // The ensure-only endpoint returns no token — minting is exclusive to POST /sessions.
    expect(response.data.apiToken).toBeUndefined();

    if (prismaForDbRowAssertions) {
      const sessionTokenCount = await prismaForDbRowAssertions.apiToken.count({
        where: { userId: response.data.scratchUserId, type: 'WHALESYNC_SESSION' },
      });
      expect(sessionTokenCount).toBe(0);
    }
  });

  // 6 — bulk revoke, and a revoked token stops authenticating
  it('bulk-revokes session tokens and invalidates them', async () => {
    const whalesyncUserId = randomUUID();
    const session = await createSession(whalesyncUserId, 'revoke@example.com');
    await createSession(whalesyncUserId, 'revoke@example.com'); // a second session token

    // Token authenticates before revocation.
    expect((await fetchCurrentUser(session.apiToken)).status).toBe(200);

    const revokeResponse = await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}/sessions`, {
      headers: adminHeaders,
    });
    expect(revokeResponse.data.revoked).toBe(2);

    // The revoked token no longer authenticates.
    const afterRevoke = await fetchCurrentUser(session.apiToken);
    expect(afterRevoke.status).toBe(401);

    if (prismaForDbRowAssertions) {
      const remaining = await prismaForDbRowAssertions.apiToken.count({
        where: { userId: session.scratchUserId, type: 'WHALESYNC_SESSION' },
      });
      expect(remaining).toBe(0);
    }
  });

  // 7 — deprovision tears down user + org + workbooks, idempotent on unknown id
  it('deprovisions a shadow user (user, org, tokens) and is idempotent', async () => {
    const whalesyncUserId = randomUUID();
    const session = await createSession(whalesyncUserId, 'deprovision@example.com');

    const first = await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}`, {
      headers: adminHeaders,
      ...anyStatus,
    });
    expect(first.status).toBe(204);

    // The user and its tokens are gone: the previously-valid token stops authenticating.
    const afterDeprovision = await fetchCurrentUser(session.apiToken);
    expect(afterDeprovision.status).toBe(401);

    if (prismaForDbRowAssertions) {
      const userRow = await prismaForDbRowAssertions.user.findUnique({ where: { whalesyncUserId } });
      expect(userRow).toBeNull();
      const tokenCount = await prismaForDbRowAssertions.apiToken.count({ where: { userId: session.scratchUserId } });
      expect(tokenCount).toBe(0);
    }

    // Idempotent: deleting an unknown / already-gone user still succeeds.
    const second = await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}`, {
      headers: adminHeaders,
      ...anyStatus,
    });
    expect(second.status).toBe(204);
  });

  // 7b — DEV-12578: deprovisioning a REAL Scratch account (adopted by email) only unlinks it. The user, org, and
  // native workbooks stay; the Live Export, the Whalesync plan, the session tokens, and the link go. Seeds the
  // native account directly, so it needs a local DB matching the target server (skipped in API-only mode).
  (isApiOnlyMode ? it.skip : it)(
    'deprovisions an adopted real Scratch user by unlinking it, keeping its org and native workbooks',
    async () => {
      const prisma = prismaForDbRowAssertions;
      if (!prisma) return; // narrowing for TS; the it/it.skip guard already gates execution

      const whalesyncUserId = randomUUID();
      const email = `deprovision-adopted-${whalesyncUserId}@example.com`;
      const nativeUserId = `usr_test_${randomUUID()}`;
      const nativeClerkId = `user_test_${randomUUID()}`;
      const nativeOrganizationId = `org_test_${randomUUID()}`;
      const nativeWorkbookId = `wkb_test_${randomUUID()}`;

      // A native Scratch account (real Clerk login) with its own org and a native workbook (DB row only).
      await prisma.organization.create({
        data: { id: nativeOrganizationId, clerkId: nativeClerkId, name: 'Native Organization' },
      });
      await prisma.user.create({
        data: { id: nativeUserId, clerkId: nativeClerkId, email, organizationId: nativeOrganizationId },
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
        // Whalesync adopts the account by email and grants the Whalesync plan.
        const session = await createSession(whalesyncUserId, email, 'Ada Lovelace', { status: 'active' });
        expect(session.scratchUserId).toBe(nativeUserId);

        // A Live Export created through the API under the Whalesync session, so it has a real repo to tear down.
        const liveExportResponse = await axios.post<{ id: string }>(
          `${apiUrl}/workbook`,
          { name: 'Deals export', managedBy: 'ws_export' },
          { headers: { Authorization: `API-Token ${session.apiToken}` } },
        );
        const liveExportWorkbookId = liveExportResponse.data.id;
        expect(liveExportWorkbookId).toBeTruthy();

        const first = await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}`, {
          headers: adminHeaders,
          ...anyStatus,
        });
        expect(first.status).toBe(204);

        // The account is kept with its native login, but no longer linked to Whalesync.
        const userRow = await prisma.user.findUnique({ where: { id: nativeUserId } });
        expect(userRow).not.toBeNull();
        expect(userRow?.clerkId).toBe(nativeClerkId);
        expect(userRow?.organizationId).toBe(nativeOrganizationId);
        expect(userRow?.whalesyncUserId).toBeNull();

        // The org and the native workbook stay; only the Live Export is gone.
        expect(await prisma.organization.findUnique({ where: { id: nativeOrganizationId } })).not.toBeNull();
        expect(await prisma.workbook.findUnique({ where: { id: nativeWorkbookId } })).not.toBeNull();
        expect(await prisma.workbook.findUnique({ where: { id: liveExportWorkbookId } })).toBeNull();

        // The Whalesync session tokens and the Whalesync plan are gone.
        const sessionTokenCount = await prisma.apiToken.count({
          where: { userId: nativeUserId, type: 'WHALESYNC_SESSION' },
        });
        expect(sessionTokenCount).toBe(0);
        const whalesyncPlanSubscriptionCount = await prisma.subscription.count({
          where: { organizationId: nativeOrganizationId, planType: 'WHALESYNC_PLAN' },
        });
        expect(whalesyncPlanSubscriptionCount).toBe(0);
        expect((await fetchCurrentUser(session.apiToken)).status).toBe(401);

        // Idempotent: a second deprovision is a no-op and the account is still there.
        const second = await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}`, {
          headers: adminHeaders,
          ...anyStatus,
        });
        expect(second.status).toBe(204);
        expect(await prisma.user.findUnique({ where: { id: nativeUserId } })).not.toBeNull();
      } finally {
        // Deprovision through the server first (idempotent), so a Live Export left by a failed assertion has its
        // repo torn down rather than orphaned. Then remove the seeded rows; deleting the org cascades the rest.
        await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}`, {
          headers: adminHeaders,
          ...anyStatus,
        });
        await prisma.workbook.deleteMany({ where: { id: nativeWorkbookId } });
        await prisma.apiToken.deleteMany({ where: { userId: nativeUserId } });
        await prisma.user.deleteMany({ where: { id: nativeUserId } });
        await prisma.organization.deleteMany({ where: { id: nativeOrganizationId } });
      }
    },
  );

  // 8 — admin guard
  describe('ScratchAdminGuard', () => {
    const body = { whalesyncUserId: randomUUID(), email: 'guard@example.com' };

    it('rejects a request with no admin token (401)', async () => {
      const response = await axios.post(`${apiUrl}/internal/whalesync/users`, body, anyStatus);
      expect(response.status).toBe(401);
    });

    it('rejects a request with a wrong admin token (401)', async () => {
      const response = await axios.post(`${apiUrl}/internal/whalesync/users`, body, {
        headers: { 'X-Scratch-Admin-Token': 'definitely-wrong' },
        ...anyStatus,
      });
      expect(response.status).toBe(401);
    });
  });

  // 9 — rate-limit bypass for WHALESYNC_SESSION tokens
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
    const whalesyncUserId = randomUUID();
    const session = await createSession(whalesyncUserId, 'burst@example.com');

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
