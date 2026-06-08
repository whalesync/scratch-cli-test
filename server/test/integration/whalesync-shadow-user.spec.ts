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
import axios from 'axios';
import { randomUUID } from 'crypto';

import { getApiUrl } from './common';

const ADMIN_TOKEN = process.env.SCRATCH_ADMIN_API_KEY;
const shouldRun = process.env.RUN_WHALESYNC_INTEGRATION === 'true' && !!ADMIN_TOKEN;

if (!shouldRun) {
  console.warn(
    'Skipping whalesync-shadow-user integration tests: set RUN_WHALESYNC_INTEGRATION=true and SCRATCH_ADMIN_API_KEY ' +
      '(matching the running server) to enable them.',
  );
}

const describeOrSkip = shouldRun ? describe : describe.skip;

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
}

describeOrSkip('Whalesync shadow-user internal endpoints', () => {
  jest.setTimeout(60000);

  // Present only when a local DB matching the target server is available; undefined in API-only mode.
  let prismaForDbRowAssertions: PrismaClient | undefined;
  const provisionedWhalesyncUserIds: string[] = [];

  beforeAll(() => {
    if (!isApiOnlyMode) {
      prismaForDbRowAssertions = new PrismaClient();
    }
  });

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

  async function createSession(whalesyncUserId: string, email: string, name?: string): Promise<SessionResponse> {
    provisionedWhalesyncUserIds.push(whalesyncUserId);
    const response = await axios.post<SessionResponse>(
      `${apiUrl}/internal/whalesync/sessions`,
      { whalesyncUserId, email, name },
      { headers: adminHeaders },
    );
    return response.data;
  }

  // Resolve the actor a session token authenticates as. Does not throw on 401 — callers assert status.
  function fetchCurrentUser(apiToken: string) {
    return axios.get<CurrentUserResponse>(`${apiUrl}/users/current`, {
      headers: { Authorization: `API-Token ${apiToken}` },
      ...anyStatus,
    });
  }

  // 1 + 2 — provision + mint, ws: email prefix + normalization, coexistence with a native email
  it('provisions a shadow user with a synthetic clerkId, ws:-prefixed normalized email, and a 10-min token', async () => {
    const whalesyncUserId = randomUUID();
    const before = Date.now();
    const session = await createSession(whalesyncUserId, '  Ada@Example.COM  ', 'Ada Lovelace');

    expect(session.scratchUserId).toBeTruthy();
    expect(session.apiToken).toBeTruthy();

    // expiresAt ≈ 10 minutes out
    const ttlMs = new Date(session.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(1000 * 60 * 8);
    expect(ttlMs).toBeLessThan(1000 * 60 * 12);

    // The minted token authenticates as the shadow user, and /users/current exposes the synthetic
    // clerkId and the ws:-prefixed, normalized email — so these are asserted over HTTP and hold in
    // both local and remote/deployed (API-only) modes.
    const whoami = await fetchCurrentUser(session.apiToken);
    expect(whoami.status).toBe(200);
    expect(whoami.data.id).toBe(session.scratchUserId);
    expect(whoami.data.clerkId).toBe(`ws_${whalesyncUserId}`);
    expect(whoami.data.isAdmin).toBe(false); // role === USER
    // ws: prefix applied AND lowercased/trimmed by the DB email-normalization trigger.
    expect(whoami.data.email).toBe('ws:ada@example.com');
    // A native user with the un-prefixed email can coexist (the whole point of the prefix).
    expect(whoami.data.email).not.toBe('ada@example.com');

    if (prismaForDbRowAssertions) {
      // Token type is not exposed over HTTP; assert it directly when a matching DB is available.
      const tokenRow = await prismaForDbRowAssertions.apiToken.findUnique({ where: { token: session.apiToken } });
      expect(tokenRow?.type).toBe('WHALESYNC_SESSION');
      expect(tokenRow?.userId).toBe(session.scratchUserId);
    }
  });

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
  it('does not rate limit WHALESYNC_SESSION tokens under burst polling', async () => {
    const whalesyncUserId = randomUUID();
    const session = await createSession(whalesyncUserId, 'burst@example.com');

    // Fire well over the default 60 req / 60s cap. With the bypass in place none should be throttled.
    // NOTE: if API_RATE_LIMIT_DISABLED is true (the default in `development`), this trivially passes and
    // proves nothing — the real throttling contrast is covered by the ApiRateLimitGuard unit test.
    const requests = Array.from({ length: 75 }, () =>
      axios.get(`${apiUrl}/users/current`, {
        headers: { Authorization: `API-Token ${session.apiToken}` },
        ...anyStatus,
      }),
    );
    const responses = await Promise.all(requests);
    const throttled = responses.filter((response) => response.status === 429);
    expect(throttled).toHaveLength(0);
  });
});
