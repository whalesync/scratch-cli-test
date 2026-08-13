import { AuthType } from '@prisma/client';
import { DecryptedCredentials } from '../../remote-service/connector-account/types/encrypted-credentials.interface';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';
import { OAuthService } from '../oauth.service';

/**
 * Credentials are stored encrypted; these tests swap in an identity "encryption"
 * so the stored blob is just the credential object, keeping assertions about what
 * was persisted readable.
 */
function identityCredentialEncryptionService() {
  return {
    encryptCredentials: (credentials: DecryptedCredentials) => Promise.resolve(credentials),
    decryptCredentials: (encrypted: unknown) => Promise.resolve({ ...(encrypted as DecryptedCredentials) }),
  };
}

function expiryIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * A stand-in for the ConnectorAccount row plus a Prisma-shaped client over it.
 * `$transaction` runs the callback against the same store, so a write inside the
 * transaction is visible to a later re-read — which is what the lock relies on.
 */
function buildDbServiceOverStoredCredentials(storedCredentials: DecryptedCredentials, service = 'AIRTABLE') {
  const row = {
    id: 'coa_1',
    service,
    authType: AuthType.OAUTH,
    version: 1,
    extras: null,
    connectionMethod: 'OAUTH_SYSTEM',
    oauthAppVersion: 'v1',
    encryptedCredentials: storedCredentials as unknown,
  };

  const queryRawCalls: string[] = [];
  const transactionOptions: { timeout?: number; maxWait?: number }[] = [];
  const credentialWrites: unknown[] = [];
  /** Simulates the lock being held elsewhere: each entry answers one attempt. */
  const lockAcquisitionResults: boolean[] = [];

  const tx = {
    $queryRaw: (template: TemplateStringsArray, ...values: unknown[]) => {
      queryRawCalls.push(template.join('?') + JSON.stringify(values));
      const acquired = lockAcquisitionResults.length > 0 ? lockAcquisitionResults.shift() : true;
      return Promise.resolve([{ acquired }]);
    },
    connectorAccount: {
      findUnique: () => Promise.resolve({ ...row }),
      update: ({ data }: { data: { encryptedCredentials: unknown } }) => {
        credentialWrites.push(data.encryptedCredentials);
        row.encryptedCredentials = data.encryptedCredentials;
        return Promise.resolve({ ...row });
      },
    },
  };

  const client = {
    $transaction: async (
      callback: (transactionClient: typeof tx) => Promise<unknown>,
      options?: { timeout?: number; maxWait?: number },
    ) => {
      transactionOptions.push(options ?? {});
      return callback(tx);
    },
    connectorAccount: {
      findUnique: ({ select }: { select?: Record<string, boolean> } = {}) =>
        Promise.resolve(select ? { encryptedCredentials: row.encryptedCredentials } : { ...row }),
      update: ({ data }: { data: { encryptedCredentials: unknown } }) => {
        row.encryptedCredentials = data.encryptedCredentials;
        return Promise.resolve({ ...row });
      },
    },
  };

  return {
    db: { client } as never,
    row,
    queryRawCalls,
    transactionOptions,
    credentialWrites,
    lockAcquisitionResults,
  };
}

/** Build an OAuthService with just the collaborators the refresh path touches. */
function buildOAuthService(args: {
  db: never;
  refreshTokens: jest.Mock<Promise<OAuthTokenResponse>, [string]>;
  service?: string;
}): OAuthService {
  const provider: Partial<OAuthProvider> = {
    refreshTokens: args.refreshTokens as unknown as OAuthProvider['refreshTokens'],
    getServiceName: () => (args.service ?? 'AIRTABLE').toLowerCase(),
  };

  // The constructor only stashes its provider arguments in a Map, so placeholders
  // are safe; the fields the refresh path actually reads are replaced below. The
  // intersection is deliberately NOT with OAuthService — `providers` is private
  // there, which would collapse the intersection to `never`.
  const constructorArguments = [args.db, ...Array.from({ length: 17 }, () => ({}))] as unknown as ConstructorParameters<
    typeof OAuthService
  >;
  const oauthService = new OAuthService(...constructorArguments) as unknown as {
    providers: Map<string, Partial<OAuthProvider>>;
    credentialEncryptionService: ReturnType<typeof identityCredentialEncryptionService>;
    resolveOAuthAppCredentialsForConnection: () => { clientId: string; clientSecret: string };
  };

  oauthService.providers = new Map([[args.service ?? 'AIRTABLE', provider]]);
  oauthService.credentialEncryptionService = identityCredentialEncryptionService();
  oauthService.resolveOAuthAppCredentialsForConnection = () => ({ clientId: 'id', clientSecret: 'secret' });

  return oauthService as unknown as OAuthService;
}

describe('OAuthService — per-connection refresh lock (DEV-11270)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('gives up on a hung provider before the transaction times out, leaving credentials untouched', async () => {
    // A vendor token endpoint that never answers. If the call were allowed to
    // outlast the transaction, Prisma would close it and the write persisting the
    // new tokens would fail with P2028 — after the provider had already retired
    // the old refresh token. Failing first keeps the stored refresh token live.
    jest.useFakeTimers();
    const { db, row, credentialWrites } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'stale-access-token',
      oauthRefreshToken: 'refresh-token-A',
      oauthExpiresAt: expiryIso(-1000),
    });

    let providerCallReached: () => void = () => undefined;
    const providerWasCalled = new Promise<void>((resolve) => {
      providerCallReached = resolve;
    });
    const refreshTokens = jest.fn<Promise<OAuthTokenResponse>, [string]>().mockImplementation(() => {
      providerCallReached();
      return new Promise<OAuthTokenResponse>(() => undefined); // never settles
    });

    // Attach the rejection expectation up front: advancing the timers below is what
    // triggers the rejection, and an unobserved one would fail the run.
    const refreshRejects = expect(buildOAuthService({ db, refreshTokens }).refreshOAuthTokens('coa_1')).rejects.toThrow(
      /did not respond within/,
    );

    await providerWasCalled; // the timeout is armed by the time this resolves
    await jest.advanceTimersByTimeAsync(20_000);
    await refreshRejects;

    expect(credentialWrites).toHaveLength(0);
    expect((row.encryptedCredentials as DecryptedCredentials).oauthRefreshToken).toBe('refresh-token-A');
  });

  it('takes a connection-scoped advisory lock and re-reads credentials inside the transaction', async () => {
    const { db, queryRawCalls, transactionOptions } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'stale-access-token',
      oauthRefreshToken: 'refresh-token-A',
      oauthExpiresAt: expiryIso(-1000),
    });
    const refreshTokens = jest
      .fn<Promise<OAuthTokenResponse>, [string]>()
      .mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh-token-B', expires_in: 3600 });

    await buildOAuthService({ db, refreshTokens }).refreshOAuthTokens('coa_1');

    expect(queryRawCalls).toHaveLength(1);
    // Non-blocking: a contender must never queue inside the transaction.
    expect(queryRawCalls[0]).toContain('pg_try_advisory_xact_lock');
    expect(queryRawCalls[0]).toContain('oauth-token-refresh:coa_1');
    // The vendor round-trip happens under the lock, so the transaction has to
    // outlast it — with margin for the reads and the write either side.
    expect(transactionOptions[0].timeout).toBeGreaterThan(8_000);
  });

  it('releases the transaction immediately when another refresher holds the lock, then retries', async () => {
    // Losing the race must not park a pool connection on the lock: the attempt
    // returns at once and the wait happens outside any transaction.
    const { db, transactionOptions, credentialWrites, lockAcquisitionResults } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'stale-access-token',
      oauthRefreshToken: 'refresh-token-A',
      oauthExpiresAt: expiryIso(-1000),
    });
    lockAcquisitionResults.push(false, false); // busy twice, then free
    const refreshTokens = jest
      .fn<Promise<OAuthTokenResponse>, [string]>()
      .mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh-token-B', expires_in: 3600 });

    await buildOAuthService({ db, refreshTokens }).refreshOAuthTokens('coa_1');

    // Three transactions: two that found the lock busy and bailed, one that worked.
    expect(transactionOptions).toHaveLength(3);
    expect(credentialWrites).toHaveLength(1);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('a contender that only wanted a usable token stops as soon as the holder publishes one', async () => {
    // Never acquires the lock, but the stored token is already valid — so the
    // holder's refresh is good enough and no refresh token is spent here.
    const { db, credentialWrites, lockAcquisitionResults } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'token-from-the-holder',
      oauthRefreshToken: 'refresh-token-B',
      oauthExpiresAt: expiryIso(60 * 60 * 1000),
    });
    lockAcquisitionResults.push(false);
    const refreshTokens = jest.fn<Promise<OAuthTokenResponse>, [string]>();
    const oauthService = buildOAuthService({ db, refreshTokens });

    await (
      oauthService as unknown as {
        refreshOAuthTokensUnderConnectionLock(
          connectorAccountId: string,
          options: { skipIfAnotherRefreshAlreadySucceeded: boolean },
        ): Promise<void>;
      }
    ).refreshOAuthTokensUnderConnectionLock('coa_1', { skipIfAnotherRefreshAlreadySucceeded: true });

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(credentialWrites).toHaveLength(0);
  });

  it('refreshes with the token stored at lock time, not one read before queueing', async () => {
    // The winner of the race rotated A → B while we queued on the lock. Presenting
    // A now would spend an already-consumed (single-use) refresh token.
    const { db, row } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'stale-access-token',
      oauthRefreshToken: 'refresh-token-B',
      oauthExpiresAt: expiryIso(-1000),
    });
    const refreshTokens = jest
      .fn<Promise<OAuthTokenResponse>, [string]>()
      .mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh-token-C', expires_in: 3600 });

    await buildOAuthService({ db, refreshTokens }).refreshOAuthTokens('coa_1');

    expect(refreshTokens).toHaveBeenCalledWith('refresh-token-B', expect.anything(), expect.anything());
    expect((row.encryptedCredentials as DecryptedCredentials).oauthRefreshToken).toBe('refresh-token-C');
  });

  it('getValidAccessToken skips the refresh when another process already stored a valid token', async () => {
    // Queued on the lock while the winner refreshed; by our turn the stored token
    // is good, so spending a refresh token would be pure waste.
    const { db, row } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'token-from-the-winner',
      oauthRefreshToken: 'refresh-token-B',
      oauthExpiresAt: expiryIso(60 * 60 * 1000),
    });
    const refreshTokens = jest.fn<Promise<OAuthTokenResponse>, [string]>();
    const oauthService = buildOAuthService({ db, refreshTokens });

    await (
      oauthService as unknown as {
        refreshOAuthTokensUnderConnectionLock(
          connectorAccountId: string,
          options: { skipIfAnotherRefreshAlreadySucceeded: boolean },
        ): Promise<void>;
      }
    ).refreshOAuthTokensUnderConnectionLock('coa_1', { skipIfAnotherRefreshAlreadySucceeded: true });

    expect(refreshTokens).not.toHaveBeenCalled();
    expect((row.encryptedCredentials as DecryptedCredentials).oauthRefreshToken).toBe('refresh-token-B');
  });

  it('still refreshes under the skip flag when the stored token is genuinely expired', async () => {
    const { db } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'stale-access-token',
      oauthRefreshToken: 'refresh-token-A',
      oauthExpiresAt: expiryIso(-1000),
    });
    const refreshTokens = jest
      .fn<Promise<OAuthTokenResponse>, [string]>()
      .mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh-token-B', expires_in: 3600 });
    const oauthService = buildOAuthService({ db, refreshTokens });

    await (
      oauthService as unknown as {
        refreshOAuthTokensUnderConnectionLock(
          connectorAccountId: string,
          options: { skipIfAnotherRefreshAlreadySucceeded: boolean },
        ): Promise<void>;
      }
    ).refreshOAuthTokensUnderConnectionLock('coa_1', { skipIfAnotherRefreshAlreadySucceeded: true });

    expect(refreshTokens).toHaveBeenCalledWith('refresh-token-A', expect.anything(), expect.anything());
  });

  it('an explicit refreshOAuthTokens is never skipped, even when the stored token is still valid', async () => {
    const { db } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'still-valid',
      oauthRefreshToken: 'refresh-token-A',
      oauthExpiresAt: expiryIso(60 * 60 * 1000),
    });
    const refreshTokens = jest
      .fn<Promise<OAuthTokenResponse>, [string]>()
      .mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh-token-B', expires_in: 3600 });

    await buildOAuthService({ db, refreshTokens }).refreshOAuthTokens('coa_1');

    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing refresh token when the provider returns none (Google, Zoho)', async () => {
    const { db, row } = buildDbServiceOverStoredCredentials({
      oauthAccessToken: 'stale-access-token',
      oauthRefreshToken: 'long-lived-refresh-token',
      oauthExpiresAt: expiryIso(-1000),
    });
    const refreshTokens = jest
      .fn<Promise<OAuthTokenResponse>, [string]>()
      .mockResolvedValue({ access_token: 'fresh', expires_in: 3600 });

    await buildOAuthService({ db, refreshTokens }).refreshOAuthTokens('coa_1');

    expect((row.encryptedCredentials as DecryptedCredentials).oauthRefreshToken).toBe('long-lived-refresh-token');
  });
});
