import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable electron `app` stub so individual tests can flip `isPackaged` (see updater.spec.ts
// for the same pattern). The vi.mock factory closes over it and is evaluated lazily on import.
const electronAppStub = { isPackaged: false };
const saveCredentialsMock = vi.fn();

vi.mock('electron', () => ({ app: electronAppStub }));
vi.mock('../auth-store', () => ({ saveCredentials: saveCredentialsMock }));

const TEST_CREDENTIALS_ENV_VAR = 'SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON';

const VALID_TEST_CREDENTIALS = {
  apiToken: 'test-api-token-not-a-real-secret',
  email: 'e2e@whalesync.com',
  tokenExpiresAt: '2099-01-01T00:00:00Z',
  serverUrl: 'https://test-api.scratch.md',
};

beforeEach(() => {
  electronAppStub.isPackaged = false;
  saveCredentialsMock.mockClear();
  delete process.env[TEST_CREDENTIALS_ENV_VAR];
  delete process.env.SCRATCH_URL;
});

afterEach(() => {
  delete process.env[TEST_CREDENTIALS_ENV_VAR];
  delete process.env.SCRATCH_URL;
});

describe('seedTestCredentialsFromEnvIfPresent', () => {
  it('returns null and seeds nothing when the env var is absent', async () => {
    const { seedTestCredentialsFromEnvIfPresent } = await import('../test-credentials');

    expect(seedTestCredentialsFromEnvIfPresent()).toBeNull();
    expect(saveCredentialsMock).not.toHaveBeenCalled();
    expect(process.env.SCRATCH_URL).toBeUndefined();
  });

  it('seeds the auth store and SCRATCH_URL in a dev build', async () => {
    process.env[TEST_CREDENTIALS_ENV_VAR] = JSON.stringify(VALID_TEST_CREDENTIALS);
    const { seedTestCredentialsFromEnvIfPresent } = await import('../test-credentials');

    const result = seedTestCredentialsFromEnvIfPresent();

    expect(result).toEqual(VALID_TEST_CREDENTIALS);
    expect(saveCredentialsMock).toHaveBeenCalledWith(VALID_TEST_CREDENTIALS);
    expect(process.env.SCRATCH_URL).toBe(VALID_TEST_CREDENTIALS.serverUrl);
  });

  it('ignores the env var in a packaged build (never trusts an external token in production)', async () => {
    electronAppStub.isPackaged = true;
    process.env[TEST_CREDENTIALS_ENV_VAR] = JSON.stringify(VALID_TEST_CREDENTIALS);
    const { seedTestCredentialsFromEnvIfPresent } = await import('../test-credentials');

    expect(seedTestCredentialsFromEnvIfPresent()).toBeNull();
    expect(saveCredentialsMock).not.toHaveBeenCalled();
    expect(process.env.SCRATCH_URL).toBeUndefined();
  });

  it('throws on invalid JSON rather than silently falling back to the login screen', async () => {
    process.env[TEST_CREDENTIALS_ENV_VAR] = '{not valid json';
    const { seedTestCredentialsFromEnvIfPresent } = await import('../test-credentials');

    expect(() => seedTestCredentialsFromEnvIfPresent()).toThrow(/not valid JSON/);
    expect(saveCredentialsMock).not.toHaveBeenCalled();
  });

  it('throws when a required field is missing', async () => {
    process.env[TEST_CREDENTIALS_ENV_VAR] = JSON.stringify({ apiToken: 'only-a-token' });
    const { seedTestCredentialsFromEnvIfPresent } = await import('../test-credentials');

    expect(() => seedTestCredentialsFromEnvIfPresent()).toThrow(/must include/);
    expect(saveCredentialsMock).not.toHaveBeenCalled();
  });
});
