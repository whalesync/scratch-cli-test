import { ServiceUnavailableException } from '@nestjs/common';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import {
  OAUTH_PENDING_AUTHORIZATION_TTL_SECONDS,
  OAuthPendingAuthorizationStore,
} from '../oauth-pending-authorization-store.service';
import { PendingOAuthAuthorization } from '../types';

// Key-aware in-memory Redis covering just SET … EX and MULTI GET/DEL, so the tests exercise the
// store's real keys and its single-use consume.
let redisStore: Map<string, string>;
let failNextRedisCommand: boolean;
const mockRedisSet = jest.fn((key: string, value: string) => {
  if (failNextRedisCommand) {
    return Promise.reject(new Error('Connection is closed.'));
  }
  redisStore.set(key, value);
  return Promise.resolve('OK');
});
const mockRedisMulti = jest.fn(() => {
  const queuedKeys: { command: 'get' | 'del'; key: string }[] = [];
  const transaction = {
    get: (key: string) => {
      queuedKeys.push({ command: 'get', key });
      return transaction;
    },
    del: (key: string) => {
      queuedKeys.push({ command: 'del', key });
      return transaction;
    },
    exec: () => {
      if (failNextRedisCommand) {
        return Promise.reject(new Error('Connection is closed.'));
      }
      return Promise.resolve(
        queuedKeys.map(({ command, key }) => {
          if (command === 'get') {
            return [null, redisStore.get(key) ?? null];
          }
          const existed = redisStore.delete(key);
          return [null, existed ? 1 : 0];
        }),
      );
    },
  };
  return transaction;
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    set: mockRedisSet,
    multi: mockRedisMulti,
    quit: jest.fn().mockResolvedValue(undefined),
  }));
});

function buildStore(): OAuthPendingAuthorizationStore {
  const configService = {
    getRedisHost: () => 'localhost',
    getRedisPort: () => 6379,
    getRedisPassword: () => undefined,
  } as unknown as ScratchConfigService;
  return new OAuthPendingAuthorizationStore(configService);
}

const PENDING_AUTHORIZATION: PendingOAuthAuthorization = {
  userId: 'usr_1',
  organizationId: 'org_1',
  workbookId: 'wkb_1',
  service: 'AIRTABLE',
  connectionMethod: 'OAUTH_SYSTEM',
  connectorAccountId: 'coa_1',
  codeVerifier: 'pkce-verifier',
  oauthAppVersion: 2,
  publicRoutingFieldsAsMinted: { service: 'AIRTABLE', workbookId: 'wkb_1' },
};

describe('OAuthPendingAuthorizationStore', () => {
  beforeEach(() => {
    redisStore = new Map();
    failNextRedisCommand = false;
    jest.clearAllMocks();
  });

  it('stores the record under the user and a fresh unguessable nonce, with the TTL', async () => {
    const store = buildStore();

    const firstNonce = await store.savePendingAuthorizationAndReturnNonce(PENDING_AUTHORIZATION);
    const secondNonce = await store.savePendingAuthorizationAndReturnNonce(PENDING_AUTHORIZATION);

    expect(firstNonce).not.toEqual(secondNonce);
    expect(Buffer.from(firstNonce, 'base64url')).toHaveLength(32);
    expect(mockRedisSet).toHaveBeenCalledWith(
      `oauth:pending-authorization:usr_1:${firstNonce}`,
      JSON.stringify(PENDING_AUTHORIZATION),
      'EX',
      OAUTH_PENDING_AUTHORIZATION_TTL_SECONDS,
    );
  });

  it('hands the record back once, to the user who stored it', async () => {
    const store = buildStore();
    const nonce = await store.savePendingAuthorizationAndReturnNonce(PENDING_AUTHORIZATION);

    await expect(store.consumePendingAuthorizationForUser('usr_other', nonce)).resolves.toBeNull();
    await expect(store.consumePendingAuthorizationForUser('usr_1', nonce)).resolves.toEqual(PENDING_AUTHORIZATION);
    await expect(store.consumePendingAuthorizationForUser('usr_1', nonce)).resolves.toBeNull();
  });

  it('resolves to null for a nonce it never issued', async () => {
    await expect(buildStore().consumePendingAuthorizationForUser('usr_1', 'never-issued')).resolves.toBeNull();
  });

  it('surfaces an unreachable Redis as a retryable error rather than a missing record', async () => {
    const store = buildStore();
    const nonce = await store.savePendingAuthorizationAndReturnNonce(PENDING_AUTHORIZATION);

    failNextRedisCommand = true;
    await expect(store.consumePendingAuthorizationForUser('usr_1', nonce)).rejects.toThrow(ServiceUnavailableException);
    await expect(store.savePendingAuthorizationAndReturnNonce(PENDING_AUTHORIZATION)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
