/**
 * Behavioral test for the shared api-client's transparent reauthorize-and-retry, exercised through
 * the real axios interceptor stack (`packages/shared-types/src/api-client/http.ts`). `axios` is
 * mocked only at the transport boundary — a custom adapter lets each test script the HTTP status
 * sequence and observe the exact `Authorization` header each attempt carried.
 *
 * Locks the four semantics the client owns:
 *   1. once-only retry (a 401 on the retried request is terminal — no loops)
 *   2. single-flight `reauthorize` (N concurrent 401s → one mint, all replay)
 *   3. replay with the freshly-minted token
 *   4. terminal fallthrough (null / throw / second-401 → reject + `onUnauthorized`)
 */

import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Responder = (config: InternalAxiosRequestConfig) => Promise<unknown>;
const adapterState: { responder: Responder | null } = { responder: null };

vi.mock('axios', async (importActual) => {
  const actual = await importActual<typeof import('axios')>();
  const create = (cfg?: object) =>
    actual.default.create({
      ...cfg,
      adapter: (config: InternalAxiosRequestConfig) => {
        if (!adapterState.responder) throw new Error('reauth.spec: no responder configured');
        return adapterState.responder(config);
      },
    });
  return { ...actual, default: { ...actual.default, create }, create };
});

// A custom axios adapter is responsible for settling status itself (axios does not re-run
// validateStatus on an adapter's resolved response), so success resolves a 2xx response and a 401
// rejects with a real AxiosError carrying the 401 response.
const ok = (config: InternalAxiosRequestConfig) =>
  Promise.resolve({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config });
const unauthorized = (config: InternalAxiosRequestConfig) =>
  Promise.reject(
    new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config, undefined, {
      data: { message: 'token expired' },
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
    }),
  );

async function makeClient(auth: {
  getToken: () => string | null | Promise<string | null>;
  reauthorize?: () => string | null | Promise<string | null>;
  onUnauthorized?: () => void;
}) {
  const { createScratchApiClient } = await import('@spinner/shared-types/api-client');
  return createScratchApiClient({
    baseUrl: 'http://test.local',
    auth: { scheme: 'API-Token', getToken: auth.getToken, reauthorize: auth.reauthorize },
    onUnauthorized: auth.onUnauthorized,
  });
}

beforeEach(() => {
  adapterState.responder = null;
});

describe('transparent reauthorize', () => {
  it('retries once with the freshly-minted token and does NOT fire onUnauthorized (semantics 1+3)', async () => {
    const seenAuth: (string | undefined)[] = [];
    let attempt = 0;
    adapterState.responder = (config) => {
      seenAuth.push(config.headers.Authorization as string | undefined);
      attempt += 1;
      return attempt === 1 ? unauthorized(config) : ok(config);
    };
    const reauthorize = vi.fn(() => 'fresh');
    const onUnauthorized = vi.fn();

    const client = await makeClient({ getToken: () => 'stale', reauthorize, onUnauthorized });
    const result = await client.users.activeUser();

    expect(result).toEqual({ ok: true });
    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(seenAuth).toEqual(['API-Token stale', 'API-Token fresh']);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('reuses an already-refreshed token from getToken on 401 without minting (burst refinement)', async () => {
    const seenAuth: (string | undefined)[] = [];
    let attempt = 0;
    adapterState.responder = (config) => {
      seenAuth.push(config.headers.Authorization as string | undefined);
      attempt += 1;
      return attempt === 1 ? unauthorized(config) : ok(config);
    };
    // Shared cell: a sibling request / proactive timer advanced it between the original send (read
    // #1) and the 401 handler's re-read (read #2).
    let tokenReads = 0;
    const getToken = () => (++tokenReads === 1 ? 'stale' : 'refreshed');
    const reauthorize = vi.fn(() => 'minted');
    const onUnauthorized = vi.fn();

    const client = await makeClient({ getToken, reauthorize, onUnauthorized });
    const result = await client.users.activeUser();

    expect(result).toEqual({ ok: true });
    expect(seenAuth).toEqual(['API-Token stale', 'API-Token refreshed']);
    expect(reauthorize).not.toHaveBeenCalled(); // cell already advanced — no redundant mint
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('is terminal when the retried request 401s again — retries exactly once, then onUnauthorized (semantics 1+4)', async () => {
    let attempt = 0;
    adapterState.responder = (config) => {
      attempt += 1;
      return unauthorized(config); // always 401
    };
    const reauthorize = vi.fn(() => 'fresh');
    const onUnauthorized = vi.fn();

    const client = await makeClient({ getToken: () => 'stale', reauthorize, onUnauthorized });
    await expect(client.users.activeUser()).rejects.toMatchObject({ statusCode: 401 });

    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(attempt).toBe(2); // original + one retry, no loop
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('is terminal when reauthorize returns null — no retry, surfaces 401, onUnauthorized (semantics 4)', async () => {
    let attempt = 0;
    adapterState.responder = (config) => {
      attempt += 1;
      return unauthorized(config);
    };
    const reauthorize = vi.fn(() => null);
    const onUnauthorized = vi.fn();

    const client = await makeClient({ getToken: () => 'stale', reauthorize, onUnauthorized });
    await expect(client.users.activeUser()).rejects.toMatchObject({ statusCode: 401 });

    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(attempt).toBe(1); // no replay
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('is terminal when reauthorize throws (semantics 4)', async () => {
    adapterState.responder = (config) => unauthorized(config);
    const reauthorize = vi.fn(() => {
      throw new Error('broker down');
    });
    const onUnauthorized = vi.fn();

    const client = await makeClient({ getToken: () => 'stale', reauthorize, onUnauthorized });
    await expect(client.users.activeUser()).rejects.toMatchObject({ statusCode: 401 });

    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent 401s into a single reauthorize, then replays all (semantics 2)', async () => {
    const firstAttemptSeen = new Set<string>();
    adapterState.responder = (config) => {
      // Key each logical request by its URL so we can 401 the first attempt and 200 the replay.
      const url = config.url ?? '';
      if (!firstAttemptSeen.has(url)) {
        firstAttemptSeen.add(url);
        return unauthorized(config);
      }
      return ok(config);
    };
    const reauthorize = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10)); // keep the mint in-flight while all 401s arrive
      return 'fresh';
    });
    const onUnauthorized = vi.fn();

    const client = await makeClient({ getToken: () => 'stale', reauthorize, onUnauthorized });
    const results = await Promise.all([
      client.users.activeUser(),
      client.workspaces.detail('wkb_1'),
      client.workspaces.detail('wkb_2'),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(reauthorize).toHaveBeenCalledTimes(1); // single-flight: one mint for all three
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('without reauthorize, a 401 is terminal and fires onUnauthorized (backwards compatible)', async () => {
    adapterState.responder = (config) => unauthorized(config);
    const onUnauthorized = vi.fn();

    const client = await makeClient({ getToken: () => 'stale', onUnauthorized });
    await expect(client.users.activeUser()).rejects.toMatchObject({ statusCode: 401 });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
