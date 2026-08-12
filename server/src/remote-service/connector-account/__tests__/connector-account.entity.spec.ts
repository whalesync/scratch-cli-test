import { AuthType } from '@spinner/shared-types';
import { ConnectorAccountEntity } from '../entities/connector-account.entity';

/**
 * Regression guard for DEV-11011 / SCR-016: the connections API must never emit credential
 * material — neither the encrypted envelope nor decrypted secrets — to the client.
 *
 * `ConnectorAccountService.getDecryptedAccount` returns `{ ...account, ...decryptedCredentials }`,
 * so the runtime object feeding the controller carries BOTH the stored `encryptedCredentials`
 * envelope AND the decrypted plaintext (apiKey, OAuth tokens, DB password, …) spread on top. We
 * feed the factory an object shaped exactly like that leaky value and assert none of it survives.
 */
describe('ConnectorAccountEntity.from — credential redaction (DEV-11011 / SCR-016)', () => {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');

  const rowWithSpreadSecrets = {
    // ── non-secret connection metadata ───────────────────────────────────────
    id: 'coa_123',
    createdAt: timestamp,
    updatedAt: timestamp,
    userId: 'usr_1',
    workbookId: 'wkb_1',
    service: 'AIRTABLE',
    displayName: 'My Airtable',
    authType: AuthType.API_KEY,
    healthStatus: null,
    healthStatusLastCheckedAt: null,
    healthStatusMessage: null,
    modifier: null,
    extras: { region: 'us' },
    version: 1,
    repoPath: '/org_1/wkb_1/coa_123',
    // ── (1) the encrypted envelope stored on the row ─────────────────────────
    encryptedCredentials: { encrypted: 'CIPHERTEXT_BLOB', iv: 'IV_HEX', salt: 'SALT_HEX' },
    // ── (2) decrypted plaintext spread on top by getDecryptedAccount() ───────
    apiKey: 'SECRET_API_KEY',
    oauthAccessToken: 'SECRET_ACCESS_TOKEN',
    oauthRefreshToken: 'SECRET_REFRESH_TOKEN',
    password: 'SECRET_PASSWORD',
    connectionString: 'postgres://user:SECRET@host/db',
    customOAuthClientSecret: 'SECRET_CLIENT_SECRET',
  };

  it('drops the encrypted envelope and every decrypted secret (by key and by value)', () => {
    const wire = ConnectorAccountEntity.from(rowWithSpreadSecrets as never);
    const serialized = JSON.stringify(wire);

    // No secret KEY survives on the projected object.
    for (const secretKey of [
      'encryptedCredentials',
      'apiKey',
      'oauthAccessToken',
      'oauthRefreshToken',
      'password',
      'connectionString',
      'customOAuthClientSecret',
    ]) {
      expect(wire).not.toHaveProperty(secretKey);
    }

    // No secret VALUE survives anywhere in the serialized payload.
    for (const secretValue of [
      'CIPHERTEXT_BLOB',
      'IV_HEX',
      'SALT_HEX',
      'SECRET_API_KEY',
      'SECRET_ACCESS_TOKEN',
      'SECRET_REFRESH_TOKEN',
      'SECRET_PASSWORD',
      'SECRET_CLIENT_SECRET',
      'SECRET@host',
    ]) {
      expect(serialized).not.toContain(secretValue);
    }
  });

  it('preserves the non-secret connection metadata and ISO-stringifies timestamps', () => {
    const wire = ConnectorAccountEntity.from(rowWithSpreadSecrets as never);
    expect(wire).toEqual({
      id: 'coa_123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      userId: 'usr_1',
      workbookId: 'wkb_1',
      service: 'AIRTABLE',
      displayName: 'My Airtable',
      authType: 'API_KEY',
      healthStatus: null,
      healthStatusLastCheckedAt: null,
      healthStatusMessage: null,
      modifier: null,
      extras: { region: 'us' },
      version: 1,
      repoPath: '/org_1/wkb_1/coa_123',
    });
  });
});
