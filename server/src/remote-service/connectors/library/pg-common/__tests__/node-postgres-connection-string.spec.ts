import path from 'path';
import {
  POSTGRES_CONNECTION_STRING_MAX_LENGTH,
  prepareConnectionStringForNodePostgres,
  type NodePostgresConnectionStringPreparation,
} from '../node-postgres-connection-string';

/** The `pg-connection-string` node-postgres itself depends on (a newer copy than the one hoisted to the root). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePostgresConnectionStringParser = require(
  require.resolve('pg-connection-string', { paths: [path.dirname(require.resolve('pg'))] }),
) as { parse: (connectionString: string) => Record<string, unknown> };

function expectAccepted(preparation: NodePostgresConnectionStringPreparation): string {
  if (!preparation.accepted) {
    throw new Error(`Expected the connection string to be accepted, got: ${preparation.userFacingReason}`);
  }
  return preparation.connectionStringForNodePostgres;
}

function expectTlsMode(connectionString: string): string {
  const preparation = prepareConnectionStringForNodePostgres(connectionString);
  if (!preparation.accepted) {
    throw new Error(`Expected the connection string to be accepted, got: ${preparation.userFacingReason}`);
  }
  return preparation.tlsMode;
}

function expectRefused(preparation: NodePostgresConnectionStringPreparation): string {
  if (preparation.accepted) {
    throw new Error(
      `Expected the connection string to be refused, got: ${preparation.connectionStringForNodePostgres}`,
    );
  }
  return preparation.userFacingReason;
}

/** What node-postgres reads from the prepared string (parsing it is safe: nothing that reads files is left in it). */
function parseAsNodePostgresWould(connectionString: string): Record<string, unknown> {
  return nodePostgresConnectionStringParser.parse(connectionString);
}

describe('prepareConnectionStringForNodePostgres', () => {
  describe('accepts the connection strings people paste', () => {
    it('passes a plain URL through unchanged', () => {
      const prepared = expectAccepted(
        prepareConnectionStringForNodePostgres('postgres://app_user:s3cret@db.example.com:5432/app'),
      );

      expect(prepared).toBe('postgres://app_user:s3cret@db.example.com:5432/app');
      expect(parseAsNodePostgresWould(prepared)).toMatchObject({
        user: 'app_user',
        password: 's3cret',
        host: 'db.example.com',
        port: '5432',
        database: 'app',
      });
    });

    it('accepts the postgresql:// scheme and trims surrounding whitespace', () => {
      const prepared = expectAccepted(
        prepareConnectionStringForNodePostgres('  postgresql://u:p@db.example.com/app?application_name=a \n'),
      );
      expect(prepared).toBe('postgresql://u:p@db.example.com/app?application_name=a');
    });

    it("drops Prisma's and Supabase's tool-only parameters", () => {
      const prepared = expectAccepted(
        prepareConnectionStringForNodePostgres(
          'postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&schema=public',
        ),
      );
      expect(prepared).toBe('postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
    });

    it("keeps Neon's endpoint option and reads its sslmode, dropping channel_binding", () => {
      const prepared = expectAccepted(
        prepareConnectionStringForNodePostgres(
          'postgresql://neondb_owner:pw@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require&options=endpoint%3Dep-cool-darkness-123456',
        ),
      );

      expect(parseAsNodePostgresWould(prepared)).toMatchObject({ options: 'endpoint=ep-cool-darkness-123456' });
      expect(parseAsNodePostgresWould(prepared)).not.toHaveProperty('channel_binding');
      expect(parseAsNodePostgresWould(prepared)).not.toHaveProperty('sslmode');
    });

    it.each([
      ['disable', 'disable'],
      ['prefer', 'require'],
      ['require', 'require'],
      ['no-verify', 'require'],
      ['verify-ca', 'verify-ca'],
      ['verify-full', 'verify-full'],
    ])('reads sslmode=%s as the %s TLS mode, and removes it from the string', (sslMode, expectedTlsMode) => {
      const connectionString = `postgres://u:p@h/d?sslmode=${sslMode}`;

      expect(expectTlsMode(connectionString)).toBe(expectedTlsMode);
      expect(expectAccepted(prepareConnectionStringForNodePostgres(connectionString))).toBe('postgres://u:p@h/d');
    });

    it('encrypts a connection string that sets no sslmode', () => {
      expect(expectTlsMode('postgres://u:p@h/d')).toBe('require');
    });

    it("reads node-postgres's ssl switch when there is no sslmode, which wins over it", () => {
      expect(expectTlsMode('postgres://u:p@h/d?ssl=true')).toBe('require');
      expect(expectTlsMode('postgres://u:p@h/d?ssl=1')).toBe('require');
      expect(expectTlsMode('postgres://u:p@h/d?ssl=false')).toBe('disable');
      expect(expectTlsMode('postgres://u:p@h/d?ssl=0')).toBe('disable');
      expect(expectTlsMode('postgres://u:p@h/d?ssl=nonsense')).toBe('require');
      expect(expectTlsMode('postgres://u:p@h/d?ssl=false&sslmode=verify-full')).toBe('verify-full');
      expect(expectAccepted(prepareConnectionStringForNodePostgres('postgres://u:p@h/d?ssl=true'))).toBe(
        'postgres://u:p@h/d',
      );
    });

    it('takes the last of repeated sslmode values, as node-postgres does', () => {
      expect(expectTlsMode('postgres://u:p@h/d?sslmode=disable&sslmode=verify-ca')).toBe('verify-ca');
    });

    it('returns the host node-postgres connects to, for checking the certificate against', () => {
      const preparation = prepareConnectionStringForNodePostgres('postgres://u:p@Db.Example.com:5432/d');
      if (!preparation.accepted) throw new Error(preparation.userFacingReason);
      expect(preparation.host.toLowerCase()).toBe('db.example.com');
    });

    it('keeps application_name and drops uselibpqcompat, whose libpq meanings we always use', () => {
      const prepared = expectAccepted(
        prepareConnectionStringForNodePostgres(
          'postgres://u:p@h/d?application_name=My%20Reporting%20App&uselibpqcompat=true&sslmode=require',
        ),
      );
      expect(parseAsNodePostgresWould(prepared)).toMatchObject({ application_name: 'My Reporting App' });
      expect(parseAsNodePostgresWould(prepared)).not.toHaveProperty('uselibpqcompat');
    });

    it('drops parameters that would change how values are decoded, and every unknown parameter', () => {
      const prepared = expectAccepted(
        prepareConnectionStringForNodePostgres(
          'postgres://u:p@h/d?binary=true&client_encoding=LATIN1&statement_timeout=1&keepalives=0&SSLMODE=disable&whatever=1',
        ),
      );

      expect(prepared).toBe('postgres://u:p@h/d');
    });

    it('keeps a percent-encoded password, and a password node-postgres would re-encode', () => {
      expect(
        parseAsNodePostgresWould(
          expectAccepted(prepareConnectionStringForNodePostgres('postgres://u:p%40ss%2Fw%3Frd@db.example.com/app')),
        ).password,
      ).toBe('p@ss/w?rd');
      expect(
        parseAsNodePostgresWould(
          expectAccepted(prepareConnectionStringForNodePostgres('postgres://u:has space%zz@db.example.com/app')),
        ).password,
      ).toBe('has space%zz');
    });

    it.each(['localhost', '127.0.0.1', '[2001:db8::1]', 'db_1.internal-zone.example'])(
      'accepts the network host %s (the database host guard decides whether it may be reached)',
      (host) => {
        expectAccepted(prepareConnectionStringForNodePostgres(`postgres://u:p@${host}:5432/d`));
      },
    );
  });

  describe('refuses', () => {
    it('an empty connection string', () => {
      expect(expectRefused(prepareConnectionStringForNodePostgres('   '))).toContain('Enter a connection string');
    });

    it('an overly long connection string', () => {
      const tooLong = `postgres://u:p@h/d?application_name=${'a'.repeat(POSTGRES_CONNECTION_STRING_MAX_LENGTH)}`;
      expect(expectRefused(prepareConnectionStringForNodePostgres(tooLong))).toContain('longer than');
    });

    it.each([
      ['a MySQL URL', 'mysql://u:p@h/d'],
      ['a JDBC URL', 'jdbc:postgresql://h:5432/d'],
      ['a libpq key/value string', 'host=10.0.0.5 dbname=app user=u password=p'],
      ['a Unix socket path, which node-postgres reads as a socket', '/var/run/postgresql app'],
      ['the socket: scheme', 'socket:/var/run/postgresql?db=app'],
    ])('%s', (_description, connectionString) => {
      expect(expectRefused(prepareConnectionStringForNodePostgres(connectionString))).toContain(
        'must start with postgres:// or postgresql://',
      );
    });

    it('a URL with no host, which node-postgres would point at localhost', () => {
      expect(expectRefused(prepareConnectionStringForNodePostgres('postgres:///app'))).toContain('has no host');
      expect(expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@/app'))).toContain(
        "couldn't be read",
      );
    });

    it('a percent-encoded Unix socket path as the host', () => {
      expect(
        expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@%2Fvar%2Frun%2Fpostgresql/app')),
      ).toContain('Unix socket paths');
    });

    it.each(['sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'sslcrl', 'SSLRootCert'])(
      'the local-file parameter %s, without echoing its value',
      (parameterName) => {
        const refusal = expectRefused(
          prepareConnectionStringForNodePostgres(`postgres://u:p@db.example.com/app?${parameterName}=/dev/zero`),
        );
        expect(refusal).toContain(`Remove ${parameterName.toLowerCase()} from the connection string`);
        expect(refusal).not.toContain('/dev/zero');
      },
    );

    it.each([
      [
        'a form with certificate fields',
        { connectionFormHasCertificateFields: true },
        "Paste the certificate or key itself into the connection form's certificate fields",
      ],
      ['a form without them', { connectionFormHasCertificateFields: false }, 'Use sslmode=require'],
    ])('a local-file parameter, pointing %s to what to do instead', (_description, wordingOptions, expectedAdvice) => {
      expect(
        expectRefused(
          prepareConnectionStringForNodePostgres(
            'postgres://u:p@db.example.com/app?sslmode=verify-full&sslrootcert=/a',
            wordingOptions,
          ),
        ),
      ).toContain(expectedAdvice);
    });

    it('a local-file parameter, without pointing to certificate fields by default', () => {
      expect(
        expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@db.example.com/app?sslrootcert=/a')),
      ).not.toContain('certificate fields');
    });

    it('every local-file parameter at once, naming each', () => {
      expect(
        expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@h/d?sslkey=/a&sslcert=/b&sslrootcert=/c')),
      ).toContain('Remove sslcert, sslkey and sslrootcert from the connection string');
    });

    it.each(['host', 'hostaddr', 'port', 'user', 'password', 'dbname', 'database'])(
      'the %s parameter, which overrides the URL',
      (parameterName) => {
        const refusal = expectRefused(
          prepareConnectionStringForNodePostgres(`postgres://u:p@db.example.com/app?${parameterName}=10.0.0.5`),
        );
        expect(refusal).toContain(`Remove ${parameterName} from after the "?"`);
        expect(refusal).not.toContain('10.0.0.5');
      },
    );

    it('a ?host= Unix socket override', () => {
      expect(
        expectRefused(
          prepareConnectionStringForNodePostgres('postgres://u:p@db.example.com/app?host=/var/run/postgresql'),
        ),
      ).toContain('Remove host');
    });

    it('a replication connection', () => {
      expect(
        expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@h/d?replication=database')),
      ).toContain("replication connections aren't supported");
    });

    it.each(['allow', 'REQUIRE', 'bogus'])('sslmode=%s', (sslMode) => {
      expect(expectRefused(prepareConnectionStringForNodePostgres(`postgres://u:p@h/d?sslmode=${sslMode}`))).toContain(
        'sslmode must be one of',
      );
    });

    it('options other than a Neon endpoint ID', () => {
      expect(
        expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@h/d?options=-c%20search_path%3Devil')),
      ).toContain('only supported for a Neon endpoint ID');
    });

    it('a control character in application_name, which could smuggle in another startup setting', () => {
      expect(
        expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@h/d?application_name=x%00options%00-c')),
      ).toContain('control character');
    });

    it.each([
      ['user', 'postgres://u%00options%00-c%20search_path%3Devil:p@db.example.com:5432/app'],
      ['database', 'postgres://u:p@db.example.com:5432/app%00replication%00database'],
    ])('a control character in the %s, which node-postgres also writes into the startup message', (_part, url) => {
      expect(expectRefused(prepareConnectionStringForNodePostgres(url))).toBe(
        "The connection string's user or database name contains a control character.",
      );
    });

    it('uselibpqcompat other than true or false', () => {
      expect(expectRefused(prepareConnectionStringForNodePostgres('postgres://u:p@h/d?uselibpqcompat=1'))).toContain(
        'uselibpqcompat must be true or false',
      );
    });
  });

  it('never puts the password, user, host or a value in a refusal', () => {
    const refusalReasons = [
      'postgres://secret_user:S3cretPassw0rd@secret-host.example.com/secret_db?sslrootcert=/etc/hosts&host=10.9.8.7',
      'postgres://secret_user:S3cretPassw0rd@secret-host.example.com/secret_db?sslmode=hunter2',
      'postgres://secret_user:S3cretPassw0rd@secret-host.example.com/secret_db?options=hunter2',
      'postgres://secret_user:S3cretPassw0rd@%2Fsecret%2Fpath/secret_db',
      'mysql://secret_user:S3cretPassw0rd@secret-host.example.com/secret_db',
    ].map((connectionString) => expectRefused(prepareConnectionStringForNodePostgres(connectionString)));

    for (const refusalReason of refusalReasons) {
      for (const secretOrValue of [
        'S3cretPassw0rd',
        'secret_user',
        'secret-host',
        'secret_db',
        'secret/path',
        '/etc/hosts',
        '10.9.8.7',
        'hunter2',
      ]) {
        expect(refusalReason).not.toContain(secretOrValue);
      }
    }
  });
});
