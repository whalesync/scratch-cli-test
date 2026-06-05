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
 *   - A reachable Postgres (DATABASE_URL) — used to assert persisted row shapes
 *
 * These drive the real server over HTTP, so they exercise the full chain: ScratchAdminGuard →
 * controller → UsersService/WorkbookService → DB → git. Each test uses a fresh random whalesyncUserId
 * and is torn down through the deprovision endpoint so workbook repos are cleaned up (not orphaned).
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

interface SessionResponse {
  scratchUserId: string;
  apiToken: string;
  expiresAt: string;
}

describeOrSkip('Whalesync shadow-user internal endpoints', () => {
  jest.setTimeout(60000);

  let prisma: PrismaClient;
  const provisionedWhalesyncUserIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaClient();
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
    await prisma.$disconnect();
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

    const userRow = await prisma.user.findUnique({ where: { whalesyncUserId } });
    expect(userRow?.clerkId).toBe(`ws_${whalesyncUserId}`);
    expect(userRow?.role).toBe('USER');
    // ws: prefix applied AND lowercased/trimmed by the DB email-normalization trigger
    expect(userRow?.email).toBe('ws:ada@example.com');

    const tokenRow = await prisma.apiToken.findUnique({ where: { token: session.apiToken } });
    expect(tokenRow?.type).toBe('WHALESYNC_SESSION');
    expect(tokenRow?.userId).toBe(session.scratchUserId);

    // A native user with the un-prefixed email can coexist (the whole point of the prefix).
    expect(userRow?.email).not.toBe('ada@example.com');
  });

  // 3 — idempotency: same user, additive token
  it('is idempotent on whalesyncUserId and mints an additional token each call', async () => {
    const whalesyncUserId = randomUUID();
    const first = await createSession(whalesyncUserId, 'repeat@example.com');
    const second = await createSession(whalesyncUserId, 'repeat@example.com');

    expect(second.scratchUserId).toBe(first.scratchUserId);

    const userCount = await prisma.user.count({ where: { whalesyncUserId } });
    expect(userCount).toBe(1);

    const sessionTokenCount = await prisma.apiToken.count({
      where: { userId: first.scratchUserId, type: 'WHALESYNC_SESSION' },
    });
    expect(sessionTokenCount).toBe(2);
  });

  // 4 — minted token authenticates a real request as the shadow user
  it('mints a token that authenticates as the shadow user on a normal API route', async () => {
    const whalesyncUserId = randomUUID();
    const session = await createSession(whalesyncUserId, 'whoami@example.com');

    const whoami = await axios.get(`${apiUrl}/users/current`, {
      headers: { Authorization: `API-Token ${session.apiToken}` },
    });
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

    const sessionTokenCount = await prisma.apiToken.count({
      where: { userId: response.data.scratchUserId, type: 'WHALESYNC_SESSION' },
    });
    expect(sessionTokenCount).toBe(0);
  });

  // 6 — bulk revoke, and a revoked token stops authenticating
  it('bulk-revokes session tokens and invalidates them', async () => {
    const whalesyncUserId = randomUUID();
    const session = await createSession(whalesyncUserId, 'revoke@example.com');
    await createSession(whalesyncUserId, 'revoke@example.com'); // a second session token

    const revokeResponse = await axios.delete(`${apiUrl}/internal/whalesync/users/${whalesyncUserId}/sessions`, {
      headers: adminHeaders,
    });
    expect(revokeResponse.data.revoked).toBe(2);

    const remaining = await prisma.apiToken.count({
      where: { userId: session.scratchUserId, type: 'WHALESYNC_SESSION' },
    });
    expect(remaining).toBe(0);

    const afterRevoke = await axios.get(`${apiUrl}/users/current`, {
      headers: { Authorization: `API-Token ${session.apiToken}` },
      ...anyStatus,
    });
    expect(afterRevoke.status).toBe(401);
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

    const userRow = await prisma.user.findUnique({ where: { whalesyncUserId } });
    expect(userRow).toBeNull();
    const tokenCount = await prisma.apiToken.count({ where: { userId: session.scratchUserId } });
    expect(tokenCount).toBe(0);

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
