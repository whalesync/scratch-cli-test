import { type DecryptedCredentials } from '@spinner/shared-types';
import tls from 'node:tls';
import { WSLogger } from 'src/logger';
import { normalizeMySqlCaCertificateBundlePem } from '../mysql-ca-certificate-bundle';
import {
  MYSQL_CREDENTIAL_FIELD_LABELS,
  MYSQL_CREDENTIAL_INPUT_KEYS,
  MYSQL_CREDENTIAL_KEYS,
  normalizeMySqlDatabaseHost,
  parseMySqlCredentialsFromUserInput,
  parseStoredMySqlCredentials,
  serializeMySqlConnectionOptionsForStorage,
  type MySqlStoredCredentials,
} from '../mysql-connection-options';
import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from '../mysql-credential-errors';
import { type MySqlConnectionOptions } from '../mysql-types';

const caCertificatePem = tls.rootCertificates[0];
const canonicalCaCertificatePem = normalizeMySqlCaCertificateBundlePem(caCertificatePem);
const sentinelPassword = 'S3cr3tSentinel!@#/?%:';

function captureMySqlCredentialsInvalidError(parse: () => unknown): MySqlCredentialsInvalidError {
  try {
    parse();
  } catch (error) {
    if (error instanceof MySqlCredentialsInvalidError) return error;
    throw error;
  }
  throw new Error('Expected a MySqlCredentialsInvalidError, but parsing succeeded');
}

function expectUserInputProblem(
  userProvidedParams: Record<string, unknown>,
  expectedProblem: MySqlCredentialProblem,
): MySqlCredentialsInvalidError {
  const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
    parseMySqlCredentialsFromUserInput(userProvidedParams),
  );
  expect(credentialsInvalidError.problem).toBe(expectedProblem);
  expect(credentialsInvalidError.message).toBe(credentialsInvalidError.userFriendlyMessage);
  expect(credentialsInvalidError.message).not.toContain(sentinelPassword);
  return credentialsInvalidError;
}

function expectStoredCredentialsProblem(
  decryptedCredentials: unknown,
  expectedProblem: MySqlCredentialProblem,
): MySqlCredentialsInvalidError {
  const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
    parseStoredMySqlCredentials(decryptedCredentials as DecryptedCredentials),
  );
  expect(credentialsInvalidError.problem).toBe(expectedProblem);
  expect(credentialsInvalidError.message).toBe(credentialsInvalidError.userFriendlyMessage);
  expect(credentialsInvalidError.message).not.toContain(sentinelPassword);
  expect(credentialsInvalidError.message).not.toContain('S3cr3tSentinel');
  return credentialsInvalidError;
}

const minimalDiscreteInput = { databaseHost: 'db.example.com', username: 'app' };

describe('MYSQL_CREDENTIAL_KEYS', () => {
  it('lists the stored keys; connectionString is input-only', () => {
    expect(MYSQL_CREDENTIAL_KEYS).toEqual([
      'databaseHost',
      'databasePort',
      'databaseName',
      'username',
      'password',
      'sslMode',
      'sslCaCertificate',
    ]);
    expect(MYSQL_CREDENTIAL_INPUT_KEYS).toEqual([...MYSQL_CREDENTIAL_KEYS, 'connectionString']);
    expect(Object.keys(MYSQL_CREDENTIAL_FIELD_LABELS).sort()).toEqual([...MYSQL_CREDENTIAL_INPUT_KEYS].sort());
  });
});

describe('parseMySqlCredentialsFromUserInput', () => {
  describe('discrete fields', () => {
    it('applies the defaults: port 3306, REQUIRED, no database, empty password', () => {
      const { storedCredentials, connectionOptions } = parseMySqlCredentialsFromUserInput(minimalDiscreteInput);

      expect(connectionOptions).toStrictEqual<MySqlConnectionOptions>({
        host: 'db.example.com',
        port: 3306,
        username: 'app',
        password: '',
        sslMode: 'REQUIRED',
      });
      expect(storedCredentials).toStrictEqual<MySqlStoredCredentials>({
        databaseHost: 'db.example.com',
        databasePort: '3306',
        username: 'app',
        sslMode: 'REQUIRED',
      });
      expect(Object.isFrozen(connectionOptions)).toBe(true);
    });

    it('stores every field in canonical form', () => {
      const { storedCredentials, connectionOptions } = parseMySqlCredentialsFromUserInput({
        databaseHost: 'db.example.com',
        databasePort: '25060',
        databaseName: 'app_db',
        username: 'app',
        password: sentinelPassword,
        sslMode: 'verify-full',
        sslCaCertificate: caCertificatePem.replace(/\n/g, ''),
      });
      expect(storedCredentials).toStrictEqual<MySqlStoredCredentials>({
        databaseHost: 'db.example.com',
        databasePort: '25060',
        databaseName: 'app_db',
        username: 'app',
        password: sentinelPassword,
        sslMode: 'VERIFY_IDENTITY',
        sslCaCertificate: canonicalCaCertificatePem,
      });
      expect(connectionOptions).toStrictEqual<MySqlConnectionOptions>({
        host: 'db.example.com',
        port: 25060,
        databaseName: 'app_db',
        username: 'app',
        password: sentinelPassword,
        sslMode: 'VERIFY_IDENTITY',
        sslCaCertificatePem: canonicalCaCertificatePem,
      });
    });

    it('trims every field except the password', () => {
      const { storedCredentials } = parseMySqlCredentialsFromUserInput({
        databaseHost: '  db.example.com\n',
        databasePort: ' 3307 ',
        databaseName: ' app_db ',
        username: ' app ',
        password: '  pass word  ',
        sslMode: ' verify-ca ',
      });
      expect(storedCredentials).toStrictEqual<MySqlStoredCredentials>({
        databaseHost: 'db.example.com',
        databasePort: '3307',
        databaseName: 'app_db',
        username: 'app',
        password: '  pass word  ',
        sslMode: 'VERIFY_CA',
      });
    });

    it('keeps a whitespace-only password (it is a real password)', () => {
      expect(
        parseMySqlCredentialsFromUserInput({ ...minimalDiscreteInput, password: '   ' }).connectionOptions.password,
      ).toBe('   ');
    });

    it("treats '', whitespace-only and null as not given (the web form sends '' for untouched fields)", () => {
      const { storedCredentials } = parseMySqlCredentialsFromUserInput({
        ...minimalDiscreteInput,
        databasePort: '',
        databaseName: '  ',
        password: '',
        sslMode: null,
        sslCaCertificate: '',
        connectionString: ' ',
      });
      expect(storedCredentials).toStrictEqual<MySqlStoredCredentials>({
        databaseHost: 'db.example.com',
        databasePort: '3306',
        username: 'app',
        sslMode: 'REQUIRED',
      });
    });

    it.each<[string, Record<string, unknown>, MySqlCredentialProblem]>([
      ['nothing at all', {}, MySqlCredentialProblem.HostOrConnectionStringRequired],
      ['only empty values', { databaseHost: '', username: '' }, MySqlCredentialProblem.HostOrConnectionStringRequired],
      ['a username without a host', { username: 'app' }, MySqlCredentialProblem.HostOrConnectionStringRequired],
      ['a host without a username', { databaseHost: 'db.example.com' }, MySqlCredentialProblem.UsernameRequired],
      [
        'a whitespace-only username',
        { databaseHost: 'db.example.com', username: '   ' },
        MySqlCredentialProblem.UsernameRequired,
      ],
    ])('requires a host and username: %s', (_description, userProvidedParams, expectedProblem) => {
      expectUserInputProblem(userProvidedParams, expectedProblem);
    });
  });

  describe('host rules', () => {
    it.each<[string, MySqlCredentialProblem]>([
      ['mysql://db.example.com', MySqlCredentialProblem.HostContainsUrl],
      [`mysql://app:${sentinelPassword}@db.example.com/app`, MySqlCredentialProblem.HostContainsUrl],
      [`app:${sentinelPassword}@db.example.com`, MySqlCredentialProblem.HostContainsCredentials],
      ['app@db.example.com', MySqlCredentialProblem.HostContainsCredentials],
      ['db.example.com/app', MySqlCredentialProblem.HostContainsPath],
      ['db.example.com\\app', MySqlCredentialProblem.HostContainsPath],
      ['db.example.com?ssl=true', MySqlCredentialProblem.HostContainsPath],
      ['db.example.com#x', MySqlCredentialProblem.HostContainsPath],
      ['db.example.com:3306', MySqlCredentialProblem.HostContainsPort],
      ['10.20.30.40:3306', MySqlCredentialProblem.HostContainsPort],
      ['[::1]:3306', MySqlCredentialProblem.HostContainsPort],
      ['fe80::1%eth0', MySqlCredentialProblem.HostInvalid],
      ['[fe80::1%eth0]', MySqlCredentialProblem.HostInvalid],
      ['[not-ipv6]', MySqlCredentialProblem.HostInvalid],
      ['[::1', MySqlCredentialProblem.HostInvalid],
      ['db example.com', MySqlCredentialProblem.HostInvalid],
      ['db!.example.com', MySqlCredentialProblem.HostInvalid],
      ['db.example.com:', MySqlCredentialProblem.HostInvalid],
      ['a:b:c', MySqlCredentialProblem.HostInvalid],
      [`${'a'.repeat(254)}`, MySqlCredentialProblem.SettingTooLong],
    ])('rejects %j without echoing it', (databaseHost, expectedProblem) => {
      const credentialsInvalidError = expectUserInputProblem({ databaseHost, username: 'app' }, expectedProblem);
      expect(credentialsInvalidError.message).not.toContain(databaseHost);
    });

    it.each([
      ['mysql', 'mysql'],
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['10.20.30.40', '10.20.30.40'],
      ['::1', '::1'],
      ['[::1]', '::1'],
      ['2001:db8::1', '2001:db8::1'],
      ['[2001:db8::1]', '2001:db8::1'],
      ['DB.Example.COM', 'DB.Example.COM'],
      ['my_db-host.internal.', 'my_db-host.internal.'],
      ['a'.repeat(253), 'a'.repeat(253)],
    ])(
      'accepts %j as %j (private and loopback hosts are the connect-time guard’s job)',
      (databaseHost, expectedHost) => {
        expect(parseMySqlCredentialsFromUserInput({ databaseHost, username: 'app' }).connectionOptions.host).toBe(
          expectedHost,
        );
        expect(normalizeMySqlDatabaseHost(databaseHost)).toBe(expectedHost);
      },
    );
  });

  describe('port', () => {
    it.each([
      ['08', 8],
      ['1', 1],
      ['65535', 65535],
      ['3306', 3306],
    ])('accepts %j as %d, stored as canonical decimal text', (databasePort, expectedPort) => {
      const { storedCredentials, connectionOptions } = parseMySqlCredentialsFromUserInput({
        ...minimalDiscreteInput,
        databasePort,
      });
      expect(connectionOptions.port).toBe(expectedPort);
      expect(storedCredentials.databasePort).toBe(String(expectedPort));
    });

    it.each(['0', '65536', '3306.0', '1e3', 'abc', '-1', '+3306', '0x10', '123456', '３３０６'])(
      'rejects %j',
      (databasePort) => {
        expectUserInputProblem({ ...minimalDiscreteInput, databasePort }, MySqlCredentialProblem.PortInvalid);
      },
    );
  });

  describe('database, username and password', () => {
    it.each(['app\u0000db', 'x'.repeat(65)])('rejects the database name %#', (databaseName) => {
      expectUserInputProblem({ ...minimalDiscreteInput, databaseName }, MySqlCredentialProblem.DatabaseNameInvalid);
    });

    it('accepts a 64-character database name with dots and spaces inside', () => {
      const databaseName = `my db.${'x'.repeat(58)}`;
      expect(
        parseMySqlCredentialsFromUserInput({ ...minimalDiscreteInput, databaseName }).connectionOptions.databaseName,
      ).toBe(databaseName);
    });

    it('caps the username and password', () => {
      expectUserInputProblem(
        { ...minimalDiscreteInput, username: 'u'.repeat(257) },
        MySqlCredentialProblem.SettingTooLong,
      );
      expectUserInputProblem(
        { ...minimalDiscreteInput, password: 'p'.repeat(4097) },
        MySqlCredentialProblem.SettingTooLong,
      );
      expect(
        parseMySqlCredentialsFromUserInput({ ...minimalDiscreteInput, password: 'p'.repeat(4096) }).connectionOptions
          .password,
      ).toHaveLength(4096);
    });

    it('rejects a NUL in the username (mysql2 would silently truncate it)', () => {
      expectUserInputProblem(
        { ...minimalDiscreteInput, username: 'app\u0000root' },
        MySqlCredentialProblem.UsernameInvalid,
      );
    });
  });

  describe('input shape', () => {
    it.each<[string, unknown, string]>([
      ['databasePort', 3306, 'Port must be text, e.g. "3306".'],
      ['databaseHost', true, 'Host must be text.'],
      ['password', { value: sentinelPassword }, 'Password must be text.'],
      ['sslCaCertificate', [caCertificatePem], 'CA Certificate must be text.'],
      ['connectionString', 42, 'Connection String must be text.'],
    ])('rejects a non-text %s, naming its label', (credentialKey, nonTextValue, expectedMessage) => {
      const credentialsInvalidError = expectUserInputProblem(
        { ...minimalDiscreteInput, [credentialKey]: nonTextValue },
        MySqlCredentialProblem.SettingNotText,
      );
      expect(credentialsInvalidError.message).toBe(expectedMessage);
    });

    it('rejects an unknown setting by name (CLI --param typos)', () => {
      const credentialsInvalidError = expectUserInputProblem(
        { host: 'db.example.com', username: 'app' },
        MySqlCredentialProblem.UnknownSetting,
      );
      expect(credentialsInvalidError.message).toContain("'host'");
      expect(credentialsInvalidError.message).toContain('databaseHost');
    });

    it('rejects an unknown setting even when it is empty', () => {
      expectUserInputProblem({ ...minimalDiscreteInput, apiKey: '' }, MySqlCredentialProblem.UnknownSetting);
    });

    it('does not echo an unknown setting name that looks like a pasted secret', () => {
      const credentialsInvalidError = expectUserInputProblem(
        { ...minimalDiscreteInput, [sentinelPassword]: 'x' },
        MySqlCredentialProblem.UnknownSetting,
      );
      expect(credentialsInvalidError.message).not.toContain('S3cr3tSentinel');
    });

    it('ignores inherited properties', () => {
      const inputWithInheritedHost = Object.create({ databaseHost: 'inherited.example.com' }) as Record<
        string,
        unknown
      >;
      inputWithInheritedHost.username = 'app';
      expectUserInputProblem(inputWithInheritedHost, MySqlCredentialProblem.HostOrConnectionStringRequired);
    });
  });

  describe('connection string', () => {
    const connectionString = `mysql://app:${encodeURIComponent(sentinelPassword)}@db.example.com:3307/app_db?ssl-mode=REQUIRED`;

    it('decomposes the URL into the discrete settings and never stores it', () => {
      const { storedCredentials, connectionOptions } = parseMySqlCredentialsFromUserInput({ connectionString });

      expect(storedCredentials).toStrictEqual<MySqlStoredCredentials>({
        databaseHost: 'db.example.com',
        databasePort: '3307',
        databaseName: 'app_db',
        username: 'app',
        password: sentinelPassword,
        sslMode: 'REQUIRED',
      });
      expect(connectionOptions.password).toBe(sentinelPassword);
      expect(storedCredentials).not.toHaveProperty('connectionString');
      expect(JSON.stringify(storedCredentials)).not.toContain('mysql://');
      expect(JSON.stringify(connectionOptions)).not.toContain('mysql://');
    });

    it('defaults the port and stores an IPv6 host without brackets', () => {
      expect(
        parseMySqlCredentialsFromUserInput({ connectionString: 'mysql://app@[2001:db8::1]/app' }).storedCredentials,
      ).toMatchObject({ databaseHost: '2001:db8::1', databasePort: '3306' });
    });

    it.each(['databaseHost', 'databasePort', 'databaseName', 'username', 'password'])(
      'rejects the connection string together with a non-empty %s as ambiguous',
      (credentialKey) => {
        const credentialsInvalidError = expectUserInputProblem(
          { connectionString, [credentialKey]: credentialKey === 'databasePort' ? '3306' : 'value' },
          MySqlCredentialProblem.ConnectionStringCombinedWithDiscreteFields,
        );
        expect(credentialsInvalidError.message).toContain(
          MYSQL_CREDENTIAL_FIELD_LABELS[credentialKey as keyof typeof MYSQL_CREDENTIAL_FIELD_LABELS],
        );
      },
    );

    it("accepts the connection string next to '' discrete fields", () => {
      expect(
        parseMySqlCredentialsFromUserInput({
          connectionString,
          databaseHost: '',
          databasePort: '',
          databaseName: '',
          username: ' ',
          password: '',
        }).storedCredentials.databaseHost,
      ).toBe('db.example.com');
    });

    it('accepts SSL Mode and CA Certificate next to the connection string', () => {
      const { storedCredentials } = parseMySqlCredentialsFromUserInput({
        connectionString,
        sslMode: 'VERIFY_CA',
        sslCaCertificate: caCertificatePem,
      });
      expect(storedCredentials).toMatchObject({ sslMode: 'VERIFY_CA', sslCaCertificate: canonicalCaCertificatePem });
    });

    it.each([
      ['a field stronger than the URL wins', '?ssl-mode=REQUIRED', 'VERIFY_IDENTITY', 'VERIFY_IDENTITY'],
      ['a field equal to the URL is fine', '?ssl-mode=VERIFY_CA', 'VERIFY_CA', 'VERIFY_CA'],
      ['the URL option alone applies', '?sslaccept=strict', undefined, 'VERIFY_IDENTITY'],
      ['the field alone applies', '', 'DISABLED', 'DISABLED'],
    ])('%s', (_description, urlQuery, sslMode, expectedSslMode) => {
      expect(
        parseMySqlCredentialsFromUserInput({
          connectionString: `mysql://app:pw@db.example.com/app${urlQuery}`,
          ...(sslMode ? { sslMode } : {}),
        }).storedCredentials.sslMode,
      ).toBe(expectedSslMode);
    });

    it('rejects a field weaker than the URL', () => {
      expectUserInputProblem(
        { connectionString: 'mysql://app:pw@db.example.com/app?ssl-mode=VERIFY_CA', sslMode: 'REQUIRED' },
        MySqlCredentialProblem.SslModeWeakerThanConnectionString,
      );
    });

    it('upgrades a URL REQUIRED to VERIFY_CA when a CA certificate is given', () => {
      expect(
        parseMySqlCredentialsFromUserInput({
          connectionString: 'mysql://app:pw@db.example.com/app?ssl-mode=REQUIRED',
          sslCaCertificate: caCertificatePem,
        }).storedCredentials.sslMode,
      ).toBe('VERIFY_CA');
    });

    it('rejects a URL that turns SSL off next to a CA certificate', () => {
      expectUserInputProblem(
        { connectionString: 'mysql://app:pw@db.example.com/app?ssl=false', sslCaCertificate: caCertificatePem },
        MySqlCredentialProblem.CaCertificateRequiresVerifyingSslMode,
      );
    });

    it("propagates the connection string's own errors", () => {
      expectUserInputProblem(
        { connectionString: `mysql://app:${sentinelPassword}@db.example.com/app?socketPath=/tmp/mysql.sock` },
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
    });
  });

  describe('TLS with discrete fields', () => {
    it('defaults to VERIFY_CA when only a CA certificate is given', () => {
      expect(
        parseMySqlCredentialsFromUserInput({ ...minimalDiscreteInput, sslCaCertificate: caCertificatePem })
          .storedCredentials.sslMode,
      ).toBe('VERIFY_CA');
    });

    it.each(['REQUIRED', 'DISABLED'])('rejects SSL Mode %s together with a CA certificate', (sslMode) => {
      expectUserInputProblem(
        { ...minimalDiscreteInput, sslMode, sslCaCertificate: caCertificatePem },
        MySqlCredentialProblem.CaCertificateRequiresVerifyingSslMode,
      );
    });

    it('rejects an unknown SSL mode', () => {
      expectUserInputProblem({ ...minimalDiscreteInput, sslMode: 'PLEASE' }, MySqlCredentialProblem.SslModeInvalid);
    });

    it('propagates CA certificate errors', () => {
      expectUserInputProblem(
        { ...minimalDiscreteInput, sslCaCertificate: 'not a certificate' },
        MySqlCredentialProblem.CaCertificateNotFound,
      );
    });

    // mysql2 sends no SNI name for an IP host and Node then checks the certificate against "localhost".
    it.each<[string, Record<string, unknown>]>([
      ['an IPv4 host', { databaseHost: '203.0.113.10', username: 'app', sslMode: 'VERIFY_IDENTITY' }],
      ['an IPv6 host', { databaseHost: '[2001:db8::1]', username: 'app', sslMode: 'verify-full' }],
      ['an IP host from a connection string', { connectionString: 'mysql://app:pw@203.0.113.10/app?sslaccept=strict' }],
    ])('rejects VERIFY_IDENTITY with %s', (_description, userProvidedParams) => {
      const credentialsInvalidError = expectUserInputProblem(
        userProvidedParams,
        MySqlCredentialProblem.SslModeVerifyIdentityRequiresHostname,
      );
      expect(credentialsInvalidError.message).not.toContain('203.0.113.10');
      expect(credentialsInvalidError.message).not.toContain('2001:db8::1');
    });

    it('accepts VERIFY_CA with an IP host and VERIFY_IDENTITY with a hostname', () => {
      expect(
        parseMySqlCredentialsFromUserInput({ databaseHost: '203.0.113.10', username: 'app', sslMode: 'VERIFY_CA' })
          .connectionOptions.sslMode,
      ).toBe('VERIFY_CA');
      expect(
        parseMySqlCredentialsFromUserInput({ ...minimalDiscreteInput, sslMode: 'VERIFY_IDENTITY' }).connectionOptions
          .sslMode,
      ).toBe('VERIFY_IDENTITY');
    });
  });
});

describe('serializeMySqlConnectionOptionsForStorage', () => {
  it('round-trips through both the user-input and the stored-credentials parsers', () => {
    const inputs: Record<string, unknown>[] = [
      minimalDiscreteInput,
      { ...minimalDiscreteInput, password: ' p ', databaseName: 'app', databasePort: '3307', sslMode: 'DISABLED' },
      { ...minimalDiscreteInput, sslCaCertificate: caCertificatePem, sslMode: 'VERIFY_IDENTITY' },
      { databaseHost: '[::1]', username: 'app', sslCaCertificate: caCertificatePem },
      { connectionString: 'mysql://app:pw@db.example.com/app?sslaccept=strict' },
    ];
    for (const userProvidedParams of inputs) {
      const { storedCredentials, connectionOptions } = parseMySqlCredentialsFromUserInput(userProvidedParams);
      expect(serializeMySqlConnectionOptionsForStorage(connectionOptions)).toStrictEqual(storedCredentials);
      expect(parseMySqlCredentialsFromUserInput(storedCredentials)).toStrictEqual({
        storedCredentials,
        connectionOptions,
      });
      expect(parseStoredMySqlCredentials(storedCredentials)).toStrictEqual(connectionOptions);
      expect(
        Object.keys(storedCredentials).every((storedKey) =>
          (MYSQL_CREDENTIAL_KEYS as readonly string[]).includes(storedKey),
        ),
      ).toBe(true);
      expect(Object.values(storedCredentials).every((storedValue) => typeof storedValue === 'string')).toBe(true);
    }
  });
});

describe('parseStoredMySqlCredentials (connect-time re-validation)', () => {
  const canonicalStoredCredentials: MySqlStoredCredentials = {
    databaseHost: 'db.example.com',
    databasePort: '3307',
    databaseName: 'app_db',
    username: 'app',
    password: sentinelPassword,
    sslMode: 'VERIFY_IDENTITY',
    sslCaCertificate: canonicalCaCertificatePem,
  };
  /** What `ctx.decryptedCredentials` really is: the account row spread with the decrypted blob. */
  const accountRowKeys = {
    id: 'coa_123',
    service: 'MYSQL',
    authType: 'USER_PROVIDED_PARAMS',
    displayName: 'Production MySQL',
    workbookId: 'wkb_123',
    userId: 'usr_123',
    healthStatus: 'OK',
    healthStatusMessage: null,
    extras: { anything: true },
    version: 3,
    encryptedCredentials: { encrypted: 'x', iv: 'y', salt: 'z' },
    modifier: null,
    createdAt: new Date(),
  };

  it('reads a canonical blob spread with the account row, ignoring every other key', () => {
    expect(
      parseStoredMySqlCredentials({
        ...accountRowKeys,
        ...canonicalStoredCredentials,
        apiKey: 'other-connector-key',
        supabaseProjects: [],
      } as unknown as DecryptedCredentials),
    ).toStrictEqual<MySqlConnectionOptions>({
      host: 'db.example.com',
      port: 3307,
      databaseName: 'app_db',
      username: 'app',
      password: sentinelPassword,
      sslMode: 'VERIFY_IDENTITY',
      sslCaCertificatePem: canonicalCaCertificatePem,
    });
  });

  it.each([null, undefined])('rejects missing credentials (%s)', (decryptedCredentials) => {
    expectStoredCredentialsProblem(decryptedCredentials, MySqlCredentialProblem.StoredCredentialsMissing);
  });

  it.each([
    ['with discrete keys', { ...canonicalStoredCredentials }],
    ['alone', {}],
  ])('refuses a stored connection string %s — never parsing it', (_description, otherStoredKeys) => {
    const storedConnectionString = `mysql://app:${sentinelPassword}@evil.example.com/app?socketPath=/tmp/x`;
    const credentialsInvalidError = expectStoredCredentialsProblem(
      { ...otherStoredKeys, connectionString: storedConnectionString },
      MySqlCredentialProblem.StoredConnectionStringNotSupported,
    );
    expect(credentialsInvalidError.message).toContain('Delete this connection and create it again');
    expect(credentialsInvalidError.message).not.toContain('evil.example.com');
  });

  it.each(['', '   ', null])('ignores an empty stored connection string (%j)', (connectionString) => {
    expect(
      parseStoredMySqlCredentials({
        ...canonicalStoredCredentials,
        connectionString,
      } as unknown as DecryptedCredentials).host,
    ).toBe('db.example.com');
  });

  it('rejects a non-text stored connection string', () => {
    const credentialsInvalidError = expectStoredCredentialsProblem(
      { ...canonicalStoredCredentials, connectionString: { host: 'x' } },
      MySqlCredentialProblem.StoredSettingNotText,
    );
    expect(credentialsInvalidError.message).toContain('Connection String');
  });

  it.each<[string, unknown, string]>([
    ['databasePort', 3307, 'Port'],
    ['databaseHost', true, 'Host'],
    ['password', { secret: sentinelPassword }, 'Password'],
    ['sslCaCertificate', [canonicalCaCertificatePem], 'CA Certificate'],
    ['sslMode', 2, 'SSL Mode'],
  ])('rejects a non-text stored %s, naming its label', (credentialKey, nonTextValue, expectedLabel) => {
    const credentialsInvalidError = expectStoredCredentialsProblem(
      { ...canonicalStoredCredentials, [credentialKey]: nonTextValue },
      MySqlCredentialProblem.StoredSettingNotText,
    );
    expect(credentialsInvalidError.message).toBe(
      `This MySQL connection's saved ${expectedLabel} isn't valid. Edit the connection and enter ${expectedLabel} again.`,
    );
  });

  it('treats null MySQL keys as absent', () => {
    expect(
      parseStoredMySqlCredentials({
        ...canonicalStoredCredentials,
        password: null,
        databaseName: null,
        databasePort: null,
        sslMode: null,
        sslCaCertificate: null,
      } as unknown as DecryptedCredentials),
    ).toStrictEqual<MySqlConnectionOptions>({
      host: 'db.example.com',
      port: 3306,
      username: 'app',
      password: '',
      sslMode: 'REQUIRED',
    });
  });

  it('accepts and normalizes valid but non-canonical values in memory', () => {
    const connectionOptions = parseStoredMySqlCredentials({
      databaseHost: ' db.example.com ',
      databasePort: ' 3307',
      username: 'app',
      sslMode: 'verify-full',
      sslCaCertificate: caCertificatePem.replace(/\n/g, ''),
    });
    expect(connectionOptions).toStrictEqual<MySqlConnectionOptions>({
      host: 'db.example.com',
      port: 3307,
      username: 'app',
      password: '',
      sslMode: 'VERIFY_IDENTITY',
      sslCaCertificatePem: canonicalCaCertificatePem,
    });
  });

  it.each<[string, Record<string, unknown>, MySqlCredentialProblem]>([
    [
      'a URL in Host',
      { databaseHost: `mysql://app:${sentinelPassword}@db.example.com` },
      MySqlCredentialProblem.HostContainsUrl,
    ],
    ['a port in Host', { databaseHost: 'db.example.com:3306' }, MySqlCredentialProblem.HostContainsPort],
    [
      'a bad PEM',
      { sslCaCertificate: '-----BEGIN CERTIFICATE-----\n@@@@\n-----END CERTIFICATE-----' },
      MySqlCredentialProblem.CaCertificateMalformed,
    ],
    ['a bad port', { databasePort: '99999' }, MySqlCredentialProblem.PortInvalid],
    ['an unknown SSL mode', { sslMode: 'PLEASE' }, MySqlCredentialProblem.SslModeInvalid],
    [
      'VERIFY_IDENTITY with an IP host',
      { databaseHost: '203.0.113.10' },
      MySqlCredentialProblem.SslModeVerifyIdentityRequiresHostname,
    ],
  ])('rejects %s with the same error as on create', (_description, invalidStoredValues, expectedProblem) => {
    expectStoredCredentialsProblem({ ...canonicalStoredCredentials, ...invalidStoredValues }, expectedProblem);
  });

  it('upgrades a stored REQUIRED that gained a CA certificate through a raw PATCH to VERIFY_CA', () => {
    expect(parseStoredMySqlCredentials({ ...canonicalStoredCredentials, sslMode: 'REQUIRED' }).sslMode).toBe(
      'VERIFY_CA',
    );
  });

  it.each([
    ['databaseHost', 'Host'],
    ['username', 'Username'],
  ])('rejects a blob without %s', (missingKey, expectedLabel) => {
    const credentialsInvalidError = expectStoredCredentialsProblem(
      { ...canonicalStoredCredentials, [missingKey]: '' },
      MySqlCredentialProblem.StoredCredentialsMissing,
    );
    expect(credentialsInvalidError.message).toContain(expectedLabel);
  });

  it('wraps an unexpected failure (e.g. a throwing getter) as a safe error', () => {
    const wsLoggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
    const credentialsWithThrowingGetter = { ...canonicalStoredCredentials };
    Object.defineProperty(credentialsWithThrowingGetter, 'databaseHost', {
      enumerable: true,
      get(): string {
        throw new TypeError(`Cannot read ${sentinelPassword}`);
      },
    });
    expectStoredCredentialsProblem(credentialsWithThrowingGetter, MySqlCredentialProblem.Unexpected);
    expect(JSON.stringify(wsLoggerErrorSpy.mock.calls)).not.toContain('S3cr3tSentinel');
    wsLoggerErrorSpy.mockRestore();
  });

  it('does no I/O and returns synchronously', () => {
    expect(parseStoredMySqlCredentials(canonicalStoredCredentials)).not.toBeInstanceOf(Promise);
  });
});
