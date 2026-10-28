import { type DecryptedCredentials } from '@spinner/shared-types';
import tls from 'node:tls';
import { WSLogger } from 'src/logger';
import { AuthParser } from '../../../connector';
import { ConnectorAuthError } from '../../../error';
import { Service } from '../../../service-constants';
import { MySqlAuthParser } from '../mysql-auth-parser';
import { normalizeMySqlCaCertificateBundlePem } from '../mysql-ca-certificate-bundle';
import * as mysqlConnectionOptionsModule from '../mysql-connection-options';
import {
  MYSQL_UNEXPECTED_CREDENTIAL_PARSING_FAILURE_MESSAGE,
  MySqlCredentialProblem,
  MySqlCredentialsInvalidError,
} from '../mysql-credential-errors';

const caCertificatePem = tls.rootCertificates[0];
const canonicalCaCertificatePem = normalizeMySqlCaCertificateBundlePem(caCertificatePem);
const sentinelPassword = 'S3cr3tSentinel!@#/?%:';

const mySqlAuthParser = new MySqlAuthParser();

async function parseCreate(userProvidedParams: Record<string, unknown>): Promise<Record<string, string>> {
  const { credentials, extras } = await mySqlAuthParser.parseUserProvidedParams({
    userProvidedParams: userProvidedParams as Record<string, string | undefined>,
  });
  expect(extras).toEqual({});
  return credentials;
}

async function parsePatch(
  patch: Record<string, unknown>,
  existingCredentials: Record<string, unknown>,
): Promise<Record<string, string>> {
  const { credentials, extras } = await mySqlAuthParser.parseUserProvidedParams({
    userProvidedParams: patch as Record<string, string | undefined>,
    existingCredentials: existingCredentials as DecryptedCredentials,
  });
  expect(extras).toEqual({});
  expect(credentials).not.toHaveProperty('connectionString');
  return credentials;
}

async function captureParserRejection(parse: () => Promise<unknown>): Promise<MySqlCredentialsInvalidError> {
  try {
    await parse();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorAuthError);
    if (error instanceof MySqlCredentialsInvalidError) {
      expect(error.message).toBe(error.userFriendlyMessage);
      expect(error.message).not.toContain(sentinelPassword);
      expect(error.message).not.toContain('S3cr3tSentinel');
      return error;
    }
    throw error;
  }
  throw new Error('Expected the MySQL AuthParser to reject, but it succeeded');
}

/** The canonical stored blob of an existing connection, spread with the account row the way the service does. */
const existingStoredCredentials = {
  databaseHost: 'db.example.com',
  databasePort: '3307',
  databaseName: 'app_db',
  username: 'app',
  password: 'old-password',
  sslMode: 'REQUIRED',
};
const existingAccountRowKeysAndForeignCredentials = {
  id: 'coa_123',
  service: 'MYSQL',
  authType: 'USER_PROVIDED_PARAMS',
  extras: null,
  apiKey: 'some-other-connectors-key',
  supabaseProjects: [],
};

describe('MySqlAuthParser', () => {
  it('is a drop-in AuthParser called the way the service calls it today (userProvidedParams only)', async () => {
    const authParser: AuthParser = new MySqlAuthParser();
    expect(authParser.service).toBe(Service.MYSQL);

    const parsedUserProvidedParams = await authParser.parseUserProvidedParams({
      userProvidedParams: { databaseHost: 'db.example.com', username: 'app', password: undefined },
    });
    expect(parsedUserProvidedParams).toEqual({
      credentials: { databaseHost: 'db.example.com', databasePort: '3306', username: 'app', sslMode: 'REQUIRED' },
      extras: {},
    });
  });

  describe('create', () => {
    it('returns only the discrete settings, as text, optional ones omitted', async () => {
      expect(
        await parseCreate({
          databaseHost: 'db.example.com',
          databasePort: '3307',
          databaseName: 'app_db',
          username: 'app',
          password: sentinelPassword,
          sslCaCertificate: caCertificatePem,
        }),
      ).toStrictEqual({
        databaseHost: 'db.example.com',
        databasePort: '3307',
        databaseName: 'app_db',
        username: 'app',
        password: sentinelPassword,
        sslMode: 'VERIFY_CA',
        sslCaCertificate: canonicalCaCertificatePem,
      });
    });

    it('decomposes a connection string and never returns it', async () => {
      const connectionString = `mysql://app:${encodeURIComponent(sentinelPassword)}@db.example.com/app_db?sslaccept=strict`;
      const credentials = await parseCreate({ connectionString, sslMode: '', databaseHost: '' });

      expect(credentials).toStrictEqual({
        databaseHost: 'db.example.com',
        databasePort: '3306',
        databaseName: 'app_db',
        username: 'app',
        password: sentinelPassword,
        sslMode: 'VERIFY_IDENTITY',
      });
      expect(credentials).not.toHaveProperty('connectionString');
      expect(Object.values(credentials)).not.toContain(connectionString);
    });

    it('rejects with a ConnectorAuthError whose message is the safe user-facing text', async () => {
      const credentialsInvalidError = await captureParserRejection(() =>
        parseCreate({ databaseHost: `app:${sentinelPassword}@db.example.com`, username: 'app' }),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.HostContainsCredentials);
      expect(credentialsInvalidError.service).toBe(Service.MYSQL);
    });

    it('rejects non-text values from callers that bypass the string DTO (CLI create, raw API)', async () => {
      const credentialsInvalidError = await captureParserRejection(() =>
        parseCreate({ databaseHost: 'db.example.com', username: 'app', databasePort: 3306 }),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.SettingNotText);
    });

    it('wraps an unexpected failure without leaking its text', async () => {
      const wsLoggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
      const parseSpy = jest
        .spyOn(mysqlConnectionOptionsModule, 'parseMySqlCredentialsFromUserInput')
        .mockImplementation(() => {
          throw new TypeError(`x ${sentinelPassword}`);
        });
      try {
        const credentialsInvalidError = await captureParserRejection(() =>
          parseCreate({ databaseHost: 'db.example.com', username: 'app' }),
        );
        expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.Unexpected);
        expect(credentialsInvalidError.message).toBe(MYSQL_UNEXPECTED_CREDENTIAL_PARSING_FAILURE_MESSAGE);
        expect(credentialsInvalidError.message).not.toContain('x ');
        expect(JSON.stringify(wsLoggerErrorSpy.mock.calls)).not.toContain('S3cr3tSentinel');
      } finally {
        parseSpy.mockRestore();
        wsLoggerErrorSpy.mockRestore();
      }
    });
  });

  describe('edit (PATCH semantics with existingCredentials)', () => {
    const existingCredentials = { ...existingAccountRowKeysAndForeignCredentials, ...existingStoredCredentials };

    it('merges a password-only patch and drops everything that is not a MySQL key', async () => {
      expect(await parsePatch({ password: sentinelPassword }, existingCredentials)).toStrictEqual({
        ...existingStoredCredentials,
        password: sentinelPassword,
      });
    });

    it('is idempotent for an empty patch', async () => {
      expect(await parsePatch({}, existingCredentials)).toStrictEqual(existingStoredCredentials);
    });

    it("clears optional settings with '' (or null) and restores defaults", async () => {
      expect(await parsePatch({ password: '' }, existingCredentials)).not.toHaveProperty('password');
      expect(await parsePatch({ password: null }, existingCredentials)).not.toHaveProperty('password');
      expect(await parsePatch({ databaseName: '' }, existingCredentials)).not.toHaveProperty('databaseName');
      // Clearing the port changes the target (3307 → 3306), so the password comes along.
      expect((await parsePatch({ databasePort: '', password: 'new' }, existingCredentials)).databasePort).toBe('3306');
      expect((await parsePatch({ sslMode: '' }, { ...existingCredentials, sslMode: 'VERIFY_IDENTITY' })).sslMode).toBe(
        'REQUIRED',
      );
    });

    it('restores VERIFY_CA when SSL Mode is cleared but a CA certificate remains', async () => {
      const existingWithCa = {
        ...existingCredentials,
        sslMode: 'VERIFY_IDENTITY',
        sslCaCertificate: canonicalCaCertificatePem,
      };
      expect((await parsePatch({ sslMode: '' }, existingWithCa)).sslMode).toBe('VERIFY_CA');
    });

    it('keeps the SSL mode when the CA certificate is cleared (VERIFY_* then trusts the public roots + RDS)', async () => {
      const existingWithCa = {
        ...existingCredentials,
        sslMode: 'VERIFY_IDENTITY',
        sslCaCertificate: canonicalCaCertificatePem,
      };
      const credentials = await parsePatch({ sslCaCertificate: '' }, existingWithCa);
      expect(credentials.sslMode).toBe('VERIFY_IDENTITY');
      expect(credentials).not.toHaveProperty('sslCaCertificate');
    });

    it.each([
      ['databaseHost', MySqlCredentialProblem.HostOrConnectionStringRequired],
      ['username', MySqlCredentialProblem.UsernameRequired],
    ])("rejects clearing %s with ''", async (requiredKey, expectedProblem) => {
      const credentialsInvalidError = await captureParserRejection(() =>
        parsePatch({ [requiredKey]: '' }, existingCredentials),
      );
      expect(credentialsInvalidError.problem).toBe(expectedProblem);
    });

    it('replaces host, port, database, username and password wholesale with a connection string', async () => {
      expect(
        await parsePatch({ connectionString: 'mysql://new_user@db2.example.com' }, existingCredentials),
      ).toStrictEqual({
        databaseHost: 'db2.example.com',
        databasePort: '3306',
        username: 'new_user',
        sslMode: 'REQUIRED',
      });
    });

    it("accepts a connection string next to '' discrete fields (the web edit form)", async () => {
      const credentials = await parsePatch(
        { connectionString: 'mysql://new_user:pw@db2.example.com/db2', databaseHost: '', password: '' },
        existingCredentials,
      );
      expect(credentials).toMatchObject({ databaseHost: 'db2.example.com', password: 'pw', databaseName: 'db2' });
    });

    it('rejects a connection string next to a non-empty discrete field', async () => {
      const credentialsInvalidError = await captureParserRejection(() =>
        parsePatch({ connectionString: 'mysql://new_user@db2.example.com', password: 'pw' }, existingCredentials),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.ConnectionStringCombinedWithDiscreteFields);
    });

    it('keeps the stored SSL mode and CA when the connection string has no SSL option', async () => {
      const existingWithCa = {
        ...existingCredentials,
        sslMode: 'VERIFY_IDENTITY',
        sslCaCertificate: canonicalCaCertificatePem,
      };
      expect(
        await parsePatch({ connectionString: 'mysql://app:pw@db2.example.com/app' }, existingWithCa),
      ).toMatchObject({ sslMode: 'VERIFY_IDENTITY', sslCaCertificate: canonicalCaCertificatePem });
    });

    it("lets the connection string's SSL option override the stored mode", async () => {
      expect(
        (
          await parsePatch(
            { connectionString: 'mysql://app:pw@db2.example.com/app?ssl-mode=REQUIRED' },
            { ...existingCredentials, sslMode: 'VERIFY_IDENTITY' },
          )
        ).sslMode,
      ).toBe('REQUIRED');
    });

    it('rejects a patched SSL Mode weaker than the patched connection string', async () => {
      const credentialsInvalidError = await captureParserRejection(() =>
        parsePatch(
          { connectionString: 'mysql://app:pw@db2.example.com/app?ssl-mode=VERIFY_CA', sslMode: 'REQUIRED' },
          existingCredentials,
        ),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.SslModeWeakerThanConnectionString);
    });

    it.each(['REQUIRED', 'DISABLED'])(
      'upgrades an inherited %s to VERIFY_CA when a CA certificate is added',
      async (sslMode) => {
        expect(
          await parsePatch({ sslCaCertificate: caCertificatePem }, { ...existingCredentials, sslMode }),
        ).toMatchObject({ sslMode: 'VERIFY_CA', sslCaCertificate: canonicalCaCertificatePem });
      },
    );

    it('rejects a patched SSL Mode REQUIRED while a CA certificate stays stored, unless the patch clears it', async () => {
      const existingWithCa = {
        ...existingCredentials,
        sslMode: 'VERIFY_CA',
        sslCaCertificate: canonicalCaCertificatePem,
      };
      const credentialsInvalidError = await captureParserRejection(() =>
        parsePatch({ sslMode: 'REQUIRED' }, existingWithCa),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.CaCertificateRequiresVerifyingSslMode);

      const credentials = await parsePatch({ sslMode: 'REQUIRED', sslCaCertificate: '' }, existingWithCa);
      expect(credentials.sslMode).toBe('REQUIRED');
      expect(credentials).not.toHaveProperty('sslCaCertificate');
    });

    it('purges a stored connection string (interim junk from a raw PATCH)', async () => {
      const credentials = await parsePatch(
        { password: 'new' },
        { ...existingCredentials, connectionString: `mysql://app:${sentinelPassword}@old.example.com/app` },
      );
      expect(credentials).not.toHaveProperty('connectionString');
      expect(credentials.databaseHost).toBe('db.example.com');
    });

    it('rejects a stored non-text MySQL key unless the patch replaces it', async () => {
      const existingWithNumericPort = { ...existingCredentials, databasePort: 3307 };
      const credentialsInvalidError = await captureParserRejection(() =>
        parsePatch({ password: 'new' }, existingWithNumericPort),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.StoredSettingNotText);
      expect(credentialsInvalidError.message).toContain('Port');

      expect((await parsePatch({ databasePort: '3308', password: 'new' }, existingWithNumericPort)).databasePort).toBe(
        '3308',
      );
      expect((await parsePatch({ databasePort: '', password: 'new' }, existingWithNumericPort)).databasePort).toBe(
        '3306',
      );
      expect(
        (await parsePatch({ connectionString: 'mysql://app@db2.example.com:3309' }, existingWithNumericPort))
          .databasePort,
      ).toBe('3309');
    });

    it('drops an unreadable stored SSL mode (it never took effect) instead of failing the edit', async () => {
      expect((await parsePatch({ password: 'new' }, { ...existingCredentials, sslMode: 'PLEASE' })).sslMode).toBe(
        'REQUIRED',
      );
    });

    it('re-validates stored values the patch keeps', async () => {
      const credentialsInvalidError = await captureParserRejection(() =>
        parsePatch({ password: 'new' }, { ...existingCredentials, databaseHost: 'db.example.com:3306' }),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.HostContainsPort);
    });

    it('rejects switching Host to an IP address while VERIFY_IDENTITY is inherited', async () => {
      const existingWithVerifyIdentity = { ...existingCredentials, sslMode: 'VERIFY_IDENTITY' };
      const credentialsInvalidError = await captureParserRejection(() =>
        parsePatch({ databaseHost: '203.0.113.10' }, existingWithVerifyIdentity),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.SslModeVerifyIdentityRequiresHostname);
      expect(
        (
          await parsePatch(
            { databaseHost: '203.0.113.10', sslMode: 'VERIFY_CA', password: 'new' },
            existingWithVerifyIdentity,
          )
        ).sslMode,
      ).toBe('VERIFY_CA');
    });

    it.each<[string, Record<string, unknown>, MySqlCredentialProblem]>([
      ['an unknown key', { host: 'db2.example.com' }, MySqlCredentialProblem.UnknownSetting],
      ['a non-text value', { databasePort: 3308 }, MySqlCredentialProblem.SettingNotText],
      ['a boolean', { sslMode: true }, MySqlCredentialProblem.SettingNotText],
    ])('rejects a patch with %s', async (_description, patch, expectedProblem) => {
      const credentialsInvalidError = await captureParserRejection(() => parsePatch(patch, existingCredentials));
      expect(credentialsInvalidError.problem).toBe(expectedProblem);
    });

    describe('the stored password is reused only for the same host, port and username', () => {
      const connectionTargetEdits: [string, Record<string, unknown>][] = [
        ['the host', { databaseHost: 'attacker.example.net' }],
        ['the port', { databasePort: '3308' }],
        ['the port back to the default', { databasePort: '' }],
        ['the username', { username: 'root' }],
      ];

      it.each(connectionTargetEdits)('rejects changing %s without the password', async (_changedTarget, patch) => {
        const credentialsInvalidError = await captureParserRejection(() => parsePatch(patch, existingCredentials));
        expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.PasswordRequiredForConnectionTargetChange);
        expect(credentialsInvalidError.message).not.toContain('attacker');
        expect(credentialsInvalidError.message).not.toContain('old-password');
      });

      it.each(connectionTargetEdits)('accepts changing %s with the password', async (_changedTarget, patch) => {
        expect((await parsePatch({ ...patch, password: sentinelPassword }, existingCredentials)).password).toBe(
          sentinelPassword,
        );
      });

      it.each(connectionTargetEdits)(
        'accepts changing %s while clearing the password (nothing is reused)',
        async (_changedTarget, patch) => {
          expect(await parsePatch({ ...patch, password: '' }, existingCredentials)).not.toHaveProperty('password');
        },
      );

      it('accepts resending the stored host, port and username unchanged, compared after normalization', async () => {
        expect(
          await parsePatch(
            { databaseHost: ' db.example.com ', databasePort: '3307', username: 'app' },
            existingCredentials,
          ),
        ).toStrictEqual(existingStoredCredentials);

        const existingWithIpv6HostAndDefaultPort = {
          ...existingCredentials,
          databaseHost: '2001:db8::1',
          databasePort: '3306',
        };
        expect(
          await parsePatch({ databaseHost: '[2001:db8::1]', databasePort: '' }, existingWithIpv6HostAndDefaultPort),
        ).toMatchObject({ databaseHost: '2001:db8::1', databasePort: '3306', password: 'old-password' });
      });

      it.each<[string, Record<string, unknown>]>([
        ['Database', { databaseName: 'other_db' }],
        ['SSL Mode', { sslMode: 'VERIFY_CA' }],
        ['CA Certificate', { sslCaCertificate: caCertificatePem }],
      ])('keeps reusing the stored password for a %s-only edit', async (_editedSetting, patch) => {
        expect((await parsePatch(patch, existingCredentials)).password).toBe('old-password');
      });

      it('accepts a target change when no password is stored (there is nothing to reuse)', async () => {
        const existingWithoutPassword = {
          ...existingAccountRowKeysAndForeignCredentials,
          databaseHost: 'db.example.com',
          databasePort: '3307',
          username: 'app',
          sslMode: 'REQUIRED',
        };
        expect(await parsePatch({ databaseHost: 'db2.example.com' }, existingWithoutPassword)).toStrictEqual({
          databaseHost: 'db2.example.com',
          databasePort: '3307',
          username: 'app',
          sslMode: 'REQUIRED',
        });
      });

      it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
        ['an invalid stored host', { databaseHost: 'db.example.com:3306' }, { databaseHost: 'db.example.com' }],
        ['a missing stored host', { databaseHost: undefined }, { databaseHost: 'db.example.com' }],
        ['a non-text stored port', { databasePort: 3307 }, { databasePort: '3307' }],
        ['a missing stored username', { username: null }, { username: 'app' }],
      ])(
        'requires the password when %s is replaced (an unreadable stored target counts as changed)',
        async (_unreadableStoredSetting, storedOverrides, patch) => {
          const credentialsInvalidError = await captureParserRejection(() =>
            parsePatch(patch, { ...existingCredentials, ...storedOverrides }),
          );
          expect(credentialsInvalidError.problem).toBe(
            MySqlCredentialProblem.PasswordRequiredForConnectionTargetChange,
          );
        },
      );
    });

    it('treats an empty existing blob like a create', async () => {
      expect(await parsePatch({ databaseHost: 'db.example.com', username: 'app' }, {})).toStrictEqual({
        databaseHost: 'db.example.com',
        databasePort: '3306',
        username: 'app',
        sslMode: 'REQUIRED',
      });
    });
  });
});

describe('applyMySqlCredentialPatch', () => {
  it('returns the validated connection options along with the stored form', () => {
    const { storedCredentials, connectionOptions } = mysqlConnectionOptionsModule.applyMySqlCredentialPatch(
      { password: 'new' },
      existingStoredCredentials as Partial<DecryptedCredentials>,
    );
    expect(storedCredentials).toStrictEqual({ ...existingStoredCredentials, password: 'new' });
    expect(connectionOptions).toStrictEqual({
      host: 'db.example.com',
      port: 3307,
      databaseName: 'app_db',
      username: 'app',
      password: 'new',
      sslMode: 'REQUIRED',
    });
  });

  it('accepts undefined existing credentials', () => {
    expect(
      mysqlConnectionOptionsModule.applyMySqlCredentialPatch({ databaseHost: 'h', username: 'u' }, undefined)
        .storedCredentials,
    ).toStrictEqual({ databaseHost: 'h', databasePort: '3306', username: 'u', sslMode: 'REQUIRED' });
  });
});
