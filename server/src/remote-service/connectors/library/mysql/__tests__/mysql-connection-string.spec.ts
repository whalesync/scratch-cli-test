import { parseMySqlCredentialsFromUserInput } from '../mysql-connection-options';
import {
  decodePercentEncodedRunsTolerantly,
  MYSQL_CONNECTION_STRING_MAX_LENGTH,
  parseMySqlConnectionString,
  type ParsedMySqlConnectionString,
} from '../mysql-connection-string';
import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from '../mysql-credential-errors';
import { type MySqlSslMode } from '../mysql-types';

function captureMySqlCredentialsInvalidError(parse: () => unknown): MySqlCredentialsInvalidError {
  try {
    parse();
  } catch (error) {
    if (error instanceof MySqlCredentialsInvalidError) return error;
    throw error;
  }
  throw new Error('Expected a MySqlCredentialsInvalidError, but parsing succeeded');
}

function expectConnectionStringProblem(
  connectionString: string,
  expectedProblem: MySqlCredentialProblem,
): MySqlCredentialsInvalidError {
  const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
    parseMySqlConnectionString(connectionString),
  );
  expect(credentialsInvalidError.problem).toBe(expectedProblem);
  expect(credentialsInvalidError.message).toBe(credentialsInvalidError.userFriendlyMessage);
  return credentialsInvalidError;
}

function sslModeOf(queryString: string): MySqlSslMode | undefined {
  return parseMySqlConnectionString(`mysql://app:pw@db.example.com/app?${queryString}`).sslModeFromConnectionString;
}

describe('parseMySqlConnectionString', () => {
  describe('schemes', () => {
    it.each([
      'mysql',
      'MYSQL',
      'mysql2',
      'mariadb',
      'MariaDB',
      'jdbc:mysql',
      'jdbc:mariadb',
      'mysql+pymysql',
      'mysql+mysqlconnector',
      'mariadb+mariadbconnector',
    ])('accepts %s://', (scheme) => {
      expect(
        parseMySqlConnectionString(`${scheme}://app:pw@db.example.com:3307/app_db`),
      ).toEqual<ParsedMySqlConnectionString>({
        host: 'db.example.com',
        port: 3307,
        databaseName: 'app_db',
        username: 'app',
        password: 'pw',
        sslModeFromConnectionString: undefined,
      });
    });

    it.each(['postgres', 'postgresql', 'jdbc:postgresql', 'POSTGRES'])(
      'points %s:// at the PostgreSQL connector',
      (scheme) => {
        const credentialsInvalidError = expectConnectionStringProblem(
          `${scheme}://app:pw@db.example.com/app`,
          MySqlCredentialProblem.ConnectionStringIsPostgres,
        );
        expect(credentialsInvalidError.message).toContain('PostgreSQL connector');
      },
    );

    it.each(['mysqlx', 'jdbc:mysqlx'])('explains that %s:// (X Protocol) is not supported', (scheme) => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `${scheme}://app:pw@db.example.com:33060/app`,
        MySqlCredentialProblem.ConnectionStringXProtocol,
      );
      expect(credentialsInvalidError.message).toContain('3306');
    });

    it('rejects DNS SRV connection strings (mysql2 would dial the SRV name itself)', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql+srv://app:pw@cluster.example.com/app',
        MySqlCredentialProblem.ConnectionStringSchemeUnsupported,
      );
      expect(credentialsInvalidError.message).toContain('SRV');
    });

    it.each(['jdbc:mysql:loadbalance', 'jdbc:mysql:replication', 'jdbc:mariadb:sequential'])(
      'rejects the multi-host JDBC form %s://',
      (scheme) => {
        expectConnectionStringProblem(
          `${scheme}://h1.example.com,h2.example.com/app`,
          MySqlCredentialProblem.ConnectionStringMultipleHosts,
        );
      },
    );

    it.each(['mongodb://app:pw@db.example.com/app', 'http://db.example.com', 'https://app:pw@db.example.com/app'])(
      'rejects %s',
      (connectionString) => {
        expectConnectionStringProblem(connectionString, MySqlCredentialProblem.ConnectionStringSchemeUnsupported);
      },
    );

    it.each(['app:pw@db.example.com/app', 'db.example.com:3306', '//app:pw@db.example.com/app'])(
      'rejects %s without a scheme',
      (connectionString) => {
        const credentialsInvalidError = expectConnectionStringProblem(
          connectionString,
          MySqlCredentialProblem.ConnectionStringSchemeUnsupported,
        );
        expect(credentialsInvalidError.message).toContain('mysql://');
      },
    );
  });

  describe('other connection-string formats', () => {
    it.each([
      'app:pw@tcp(db.example.com:3306)/app?parseTime=true',
      'app:pw@unix(/var/run/mysqld/mysqld.sock)/app',
      'app:pw@tcp6([::1]:3306)/app',
      'tcp(db.example.com:3306)/app',
      'mysql://app:pw@tcp(db.example.com:3306)/app',
    ])('names the Go DSN form in %s', (connectionString) => {
      const credentialsInvalidError = expectConnectionStringProblem(
        connectionString,
        MySqlCredentialProblem.ConnectionStringGoDsnNotSupported,
      );
      expect(credentialsInvalidError.message).toContain('Use a URL-style connection string instead');
    });

    it.each([
      'Server=db.example.com;Port=3306;Database=app;Uid=app;Pwd=pw;',
      'Data Source=db.example.com;User Id=app;Password=pw',
      'host=db.example.com; user id=app; password=pw',
      'Driver={MySQL ODBC 8.0 Driver};Server=db.example.com;Database=app;',
    ])('names the ADO.NET / ODBC form in %s', (connectionString) => {
      expectConnectionStringProblem(connectionString, MySqlCredentialProblem.ConnectionStringAdoNetNotSupported);
    });
  });

  describe('host, port and database', () => {
    it('leaves the port undefined when absent (the caller defaults it)', () => {
      expect(parseMySqlConnectionString('mysql://app:pw@db.example.com/app').port).toBeUndefined();
      expect(parseMySqlConnectionString('mysql://app:pw@db.example.com:/app').port).toBeUndefined();
    });

    it.each([
      ['mysql://app@db.example.com', undefined],
      ['mysql://app@db.example.com/', undefined],
      ['mysql://app@db.example.com?ssl-mode=REQUIRED', undefined],
      ['mysql://app@db.example.com/?ssl-mode=REQUIRED', undefined],
      ['mysql://app@db.example.com/my%20db', 'my db'],
      ['mysql://app@db.example.com/caf%C3%A9', 'café'],
      ['mysql://app@db.example.com/app_db', 'app_db'],
    ])('reads the database of %s as %j', (connectionString, expectedDatabaseName) => {
      expect(parseMySqlConnectionString(connectionString).databaseName).toBe(expectedDatabaseName);
    });

    it('trims surrounding whitespace (pastes often carry a newline)', () => {
      expect(parseMySqlConnectionString('  mysql://app:pw@db.example.com/app\n').host).toBe('db.example.com');
    });

    it.each([
      ['mysql://app@[::1]:3307/app', '::1', 3307],
      ['mysql://app@[2001:db8::1]/app', '2001:db8::1', undefined],
      ['mysql://app:pw@127.0.0.1:3306/app', '127.0.0.1', 3306],
      ['mysql://app:pw@mysql/app', 'mysql', undefined],
      ['mysql://app:pw@DB.Example.COM/app', 'DB.Example.COM', undefined],
    ])('reads the host of %s', (connectionString, expectedHost, expectedPort) => {
      const parsedConnectionString = parseMySqlConnectionString(connectionString);
      expect(parsedConnectionString.host).toBe(expectedHost);
      expect(parsedConnectionString.port).toBe(expectedPort);
    });

    it('requires IPv6 literals in brackets', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql://app:pw@2001:db8::1/app',
        MySqlCredentialProblem.ConnectionStringUnparseable,
      );
      expect(credentialsInvalidError.message).toContain('[brackets]');
    });

    it.each(['mysql://app@[fe80::1%25eth0]/app', 'mysql://app@[not-an-address]/app', 'mysql://app@[::1/app'])(
      'rejects the bracketed host in %s',
      (connectionString) => {
        expectConnectionStringProblem(connectionString, MySqlCredentialProblem.HostInvalid);
      },
    );

    it.each(['mysql://app@db example.com/app', 'mysql://app@db.example.com%2Fx/app', 'mysql://app@db!/app'])(
      'rejects the host in %s',
      (connectionString) => {
        expectConnectionStringProblem(connectionString, MySqlCredentialProblem.HostInvalid);
      },
    );

    it.each([
      'mysql://app@h1.example.com,h2.example.com/app',
      'jdbc:mysql://h1.example.com:3306,h2.example.com:3306/app',
      'mysql://app:pw@h1.example.com,h2.example.com/app',
    ])('rejects several hosts in %s', (connectionString) => {
      expectConnectionStringProblem(connectionString, MySqlCredentialProblem.ConnectionStringMultipleHosts);
    });

    it('rejects the JDBC address=(...) host syntax', () => {
      expectConnectionStringProblem(
        'jdbc:mysql://address=(host=db.example.com)(port=3306)/app',
        MySqlCredentialProblem.ConnectionStringUnparseable,
      );
    });

    it.each(['0', '65536', '99999', 'abc', '3306x', '123456'])('rejects port %s', (portText) => {
      expectConnectionStringProblem(
        `mysql://app:pw@db.example.com:${portText}/app`,
        MySqlCredentialProblem.PortInvalid,
      );
    });

    it.each(['1', '65535', '25060'])('accepts port %s', (portText) => {
      expect(parseMySqlConnectionString(`mysql://app:pw@db.example.com:${portText}/app`).port).toBe(Number(portText));
    });

    it.each([
      'mysql://app:pw@db.example.com/app#section',
      'mysql://app:pw@db.example.com/app?ssl-mode=REQUIRED#section',
      'mysql://db.example.com/app?user=app&password=p#w',
    ])('rejects the fragment in %s', (connectionString) => {
      expectConnectionStringProblem(connectionString, MySqlCredentialProblem.ConnectionStringFragment);
    });

    it.each(['mysql://', 'mysql:///app', 'mysql://app:pw@/app', 'mysql://?user=app'])(
      'rejects %s (no host)',
      (connectionString) => {
        expectConnectionStringProblem(connectionString, MySqlCredentialProblem.ConnectionStringUnparseable);
      },
    );

    it('rejects a second path segment after the database', () => {
      expectConnectionStringProblem(
        'mysql://app@db.example.com/app/extra',
        MySqlCredentialProblem.ConnectionStringUnparseable,
      );
    });

    it(`rejects more than ${MYSQL_CONNECTION_STRING_MAX_LENGTH} characters`, () => {
      expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?ssl-mode=${'R'.repeat(MYSQL_CONNECTION_STRING_MAX_LENGTH)}`,
        MySqlCredentialProblem.SettingTooLong,
      );
    });
  });

  describe('passwords', () => {
    it.each([
      ['percent-encoded @ # / ? %', 'app:%40%23%2F%3F%25@db.example.com/app', '@#/?%'],
      ['an unencoded @', 'app:p@ss@db.example.com/app', 'p@ss'],
      ['an unencoded #', 'app:p#ss@db.example.com/app', 'p#ss'],
      ['an unencoded ?', 'app:p?ss@db.example.com/app', 'p?ss'],
      ['an unencoded /', 'app:p/ss@db.example.com/app', 'p/ss'],
      ['an unencoded :', 'app:p:ss:x@db.example.com/app', 'p:ss:x'],
      ['a literal % not followed by hex', 'app:50%off@db.example.com/app', '50%off'],
      ['a +', 'app:a+b@db.example.com/app', 'a+b'],
      ['mixed a/b@c#d?e', 'app:a/b@c#d?e@db.example.com/app', 'a/b@c#d?e'],
      ['a@b/c', 'app:a@b/c@db.example.com/app', 'a@b/c'],
      ['a/b@c', 'app:a/b@c@db.example.com/app', 'a/b@c'],
      ['a@b?c=d', 'app:a@b?c=d@db.example.com/app', 'a@b?c=d'],
      ['an invalid UTF-8 escape kept as typed', 'app:%FFx@db.example.com/app', '%FFx'],
      ['a percent-encoded space', 'app:a%20b@db.example.com/app', 'a b'],
    ])('keeps %s', (_description, connectionStringAfterScheme, expectedPassword) => {
      const parsedConnectionString = parseMySqlConnectionString(`mysql://${connectionStringAfterScheme}`);
      expect(parsedConnectionString.password).toBe(expectedPassword);
      expect(parsedConnectionString.username).toBe('app');
      expect(parsedConnectionString.host).toBe('db.example.com');
      expect(parsedConnectionString.databaseName).toBe('app');
    });

    it('round-trips a password with every special character through percent-encoding', () => {
      const passwordWithEverySpecialCharacter = `S3cr3t !"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~é`;
      const parsedConnectionString = parseMySqlConnectionString(
        `mysql://app:${encodeURIComponent(passwordWithEverySpecialCharacter)}@db.example.com/app`,
      );
      expect(parsedConnectionString.password).toBe(passwordWithEverySpecialCharacter);
    });

    it.each(['mysql://app:@db.example.com/app', 'mysql://app@db.example.com/app'])(
      'reads no password from %s',
      (connectionString) => {
        expect(parseMySqlConnectionString(connectionString).password).toBeUndefined();
      },
    );
  });

  describe('usernames and query credentials', () => {
    it('reads a user@domain username from ?user= when there is no userinfo', () => {
      const parsedConnectionString = parseMySqlConnectionString('mysql://db.example.com/app?user=a@b');
      expect(parsedConnectionString.username).toBe('a@b');
      expect(parsedConnectionString.host).toBe('db.example.com');
      expect(parsedConnectionString.password).toBeUndefined();
    });

    it('does not mistake host:port?user=a@b for userinfo', () => {
      const parsedConnectionString = parseMySqlConnectionString('jdbc:mysql://db.example.com:3306?user=me@example.com');
      expect(parsedConnectionString).toMatchObject({ host: 'db.example.com', port: 3306, username: 'me@example.com' });
    });

    it('reads JDBC / Azure style credentials from the query', () => {
      expect(
        parseMySqlConnectionString(
          'jdbc:mysql://srv.mysql.database.azure.com:3306/app?user=admin@srv&password=p@ss&useSSL=true&requireSSL=true',
        ),
      ).toEqual<ParsedMySqlConnectionString>({
        host: 'srv.mysql.database.azure.com',
        port: 3306,
        databaseName: 'app',
        username: 'admin@srv',
        password: 'p@ss',
        sslModeFromConnectionString: 'REQUIRED',
      });
    });

    it('reads an unencoded user@domain username from the userinfo', () => {
      const parsedConnectionString = parseMySqlConnectionString('mysql://admin@srv:pw@srv.example.com/app');
      expect(parsedConnectionString).toMatchObject({ username: 'admin@srv', password: 'pw', host: 'srv.example.com' });
    });

    it('percent-decodes the username', () => {
      expect(parseMySqlConnectionString('mysql://app%40corp:pw@db.example.com').username).toBe('app@corp');
    });

    it('skips a userinfo candidate whose username contains a /', () => {
      expectConnectionStringProblem(
        'mysql://a/b:pw@db.example.com/app',
        MySqlCredentialProblem.ConnectionStringUnparseable,
      );
    });

    it('accepts the same username given twice', () => {
      expect(parseMySqlConnectionString('mysql://app:pw@db.example.com/app?user=app').username).toBe('app');
    });

    it.each(['mysql://app:pw@db.example.com/app?user=other', 'mysql://app:pw@db.example.com/app?password=other'])(
      'rejects conflicting credentials in %s',
      (connectionString) => {
        const credentialsInvalidError = expectConnectionStringProblem(
          connectionString,
          MySqlCredentialProblem.ConnectionStringCredentialsConflict,
        );
        expect(credentialsInvalidError.message).not.toContain('other');
      },
    );

    it.each([
      'mysql://db.example.com/app',
      'mysql://:pw@db.example.com/app',
      'mysql://db.example.com/app?user=',
      'mysql://db.example.com/app?password=pw',
    ])('requires a username in %s', (connectionString) => {
      expectConnectionStringProblem(connectionString, MySqlCredentialProblem.UsernameRequired);
    });
  });

  describe('SSL options', () => {
    it('reports no SSL mode when the connection string has no SSL option', () => {
      expect(parseMySqlConnectionString('mysql://app:pw@db.example.com/app').sslModeFromConnectionString).toBe(
        undefined,
      );
    });

    it.each<[string, MySqlSslMode | undefined]>([
      ['ssl-mode=DISABLED', 'DISABLED'],
      ['ssl-mode=disable', 'DISABLED'],
      ['sslmode=PREFERRED', 'REQUIRED'],
      ['sslmode=prefer', 'REQUIRED'],
      ['sslmode=allow', 'REQUIRED'],
      ['sslMode=REQUIRED', 'REQUIRED'],
      ['ssl_mode=require', 'REQUIRED'],
      ['SSL-MODE=verify_ca', 'VERIFY_CA'],
      ['sslmode=verify-ca', 'VERIFY_CA'],
      ['ssl-mode=VERIFY_IDENTITY', 'VERIFY_IDENTITY'],
      ['sslmode=verify-full', 'VERIFY_IDENTITY'],
      ['sslaccept=strict', 'VERIFY_IDENTITY'],
      ['sslaccept=accept_invalid_certs', 'REQUIRED'],
      ['ssl=true', 'REQUIRED'],
      ['ssl=TRUE', 'REQUIRED'],
      ['ssl=1', 'REQUIRED'],
      ['ssl=required', 'REQUIRED'],
      ['ssl=false', 'DISABLED'],
      ['ssl=0', 'DISABLED'],
      ['ssl=Amazon%20RDS', 'VERIFY_CA'],
      ['ssl=Amazon+RDS', 'VERIFY_CA'],
      [`ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}`, 'REQUIRED'],
      [`ssl=${encodeURIComponent('{"rejectUnauthorized":true}')}`, 'VERIFY_CA'],
      [`ssl=${encodeURIComponent('{}')}`, 'VERIFY_CA'],
      ['ssl={"verifyIdentity":true}', 'VERIFY_IDENTITY'],
      [`ssl=${encodeURIComponent('{"rejectUnauthorized":true,"verifyIdentity":true}')}`, 'VERIFY_IDENTITY'],
      ['useSSL=true', 'REQUIRED'],
      ['requireSSL=true', 'REQUIRED'],
      ['useSSL=false', 'DISABLED'],
      ['useSSL=true&requireSSL=true', 'REQUIRED'],
      ['useSSL=true&verifyServerCertificate=true', 'VERIFY_CA'],
      ['useSSL=yes&verifyServerCertificate=no', 'REQUIRED'],
      ['requireSSL=false', undefined],
      ['verifyServerCertificate=false', undefined],
      ['ssl-mode=REQUIRED&ssl=true', 'REQUIRED'],
      ['sslaccept=strict&ssl-mode=VERIFY_IDENTITY', 'VERIFY_IDENTITY'],
      ['&ssl=true&', 'REQUIRED'],
    ])('reads %s as %s', (queryString, expectedSslMode) => {
      expect(sslModeOf(queryString)).toBe(expectedSslMode);
    });

    it.each([
      ['ssl-mode=FOO', "'ssl-mode'"],
      ['sslmode=', "'sslmode'"],
      ['sslaccept=maybe', "'sslaccept'"],
      ['ssl=yes', "'ssl'"],
      ['useSSL=maybe', "'useSSL'"],
      ['ssl={rejectUnauthorized:false}', "'ssl'"],
      ['ssl=[1]', "'ssl'"],
      ['ssl=null', "'ssl'"],
      [`ssl=${encodeURIComponent('{"rejectUnauthorized":"false"}')}`, "'ssl'"],
      [`ssl=${encodeURIComponent('{"rejectUnauthorized":false,"verifyIdentity":true}')}`, "'ssl'"],
      [`ssl=${encodeURIComponent(`{"rejectUnauthorized":true,"x":"${'y'.repeat(600)}"}`)}`, "'ssl'"],
    ])('rejects the SSL option value in %s, naming the option but not the value', (queryString, expectedName) => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?${queryString}`,
        MySqlCredentialProblem.SslAliasValueInvalid,
      );
      expect(credentialsInvalidError.message).toContain(expectedName);
      expect(credentialsInvalidError.message).not.toContain('FOO');
      expect(credentialsInvalidError.message).not.toContain('maybe');
    });

    it.each([
      ['{"ca":"-----BEGIN CERTIFICATE-----"}', "'ca'"],
      ['{"key":"x"}', "'key'"],
      ['{"rejectUnauthorized":true,"minVersion":"TLSv1"}', "'minVersion'"],
      ['{"passphrase":"S3cr3tValue"}', "'passphrase'"],
    ])('rejects the ssl JSON key in %s by name', (sslJson, expectedKeyName) => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?ssl=${encodeURIComponent(sslJson)}`,
        MySqlCredentialProblem.SslAliasValueInvalid,
      );
      expect(credentialsInvalidError.message).toContain(expectedKeyName);
      expect(credentialsInvalidError.message).toContain('CA Certificate');
    });

    it.each(['{"Secret1":true}', '{"rejectUnauthorized":true,"Hunter2Secret":1}', '{"__proto__":{}}'])(
      'rejects the ssl JSON key in %s without echoing it (the JSON is a parameter value)',
      (sslJson) => {
        const credentialsInvalidError = expectConnectionStringProblem(
          `mysql://app:pw@db.example.com/app?ssl=${encodeURIComponent(sslJson)}`,
          MySqlCredentialProblem.SslAliasValueInvalid,
        );
        expect(credentialsInvalidError.message).toContain("The connection string's ssl option sets a key");
        for (const valueFragment of ['Secret1', 'Hunter2Secret', '__proto__']) {
          expect(credentialsInvalidError.message).not.toContain(valueFragment);
        }
      },
    );

    it('rejects a __proto__ key without polluting Object.prototype', () => {
      expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?ssl=${encodeURIComponent('{"__proto__":{"polluted":true},"rejectUnauthorized":false}')}`,
        MySqlCredentialProblem.SslAliasValueInvalid,
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    });

    it.each([
      'ssl-mode=REQUIRED&sslaccept=strict',
      'ssl=false&ssl-mode=REQUIRED',
      'useSSL=false&requireSSL=true',
      'useSSL=false&verifyServerCertificate=true',
      'useSSL=true&ssl-mode=VERIFY_CA',
    ])('rejects disagreeing SSL options in %s', (queryString) => {
      expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?${queryString}`,
        MySqlCredentialProblem.SslAliasesConflict,
      );
    });
  });

  describe('every other query parameter is rejected by name', () => {
    it.each([
      'socketPath',
      'multipleStatements',
      'flags',
      'timezone',
      'localAddress',
      'debug',
      'typeCast',
      'enableCleartextPlugin',
      'connectAttributes',
      'password2',
      'password3',
      'infileStreamFactory',
      'localInfile',
      'allowLocalInfile',
      'authPlugins',
      'charset',
      'serverTimezone',
      'allowPublicKeyRetrieval',
      'connectTimeout',
      'database',
      'host',
      'port',
      'stream',
      'rejectUnauthorized',
      'ssl.ca',
    ])('%s', (parameterName) => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?${parameterName}=S3cr3tValue`,
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      expect(credentialsInvalidError.message).toContain(`'${parameterName}'`);
      expect(credentialsInvalidError.message).not.toContain('S3cr3tValue');
      expect(credentialsInvalidError.message).toContain('ssl-mode');
    });

    it('names at most three unsupported parameters', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql://app:pw@db.example.com/app?charset=utf8mb4&timezone=Z&flags=-FOUND_ROWS&debug=true&socketPath=/tmp/s',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      expect(credentialsInvalidError.message).toContain("'charset', 'timezone', 'flags' and 2 more");
      expect(credentialsInvalidError.message).not.toContain('socketPath');
    });

    it('does not echo a parameter name that looks like a pasted secret', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?${encodeURIComponent('S3cr3t!Sentinel')}=1`,
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      expect(credentialsInvalidError.message).toBe(
        "The connection string has an unsupported option. Remove everything after '?' except SSL settings " +
          '(ssl-mode, sslaccept, ssl, useSSL, requireSSL).',
      );
    });

    it('counts, but does not name, several parameters that look like pasted secrets', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?${encodeURIComponent('S3cr3t!One')}=1&${encodeURIComponent('S3cr3t!Two')}=2`,
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      expect(credentialsInvalidError.message).toContain('The connection string has 2 unsupported options.');
      expect(credentialsInvalidError.message).not.toContain('S3cr3t');
    });

    it('names the option-shaped parameters and counts the rest', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?charset=utf8mb4&${encodeURIComponent('S3cr3t!One')}=1`,
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      expect(credentialsInvalidError.message).toContain("The connection-string options 'charset' and 1 more aren't");
      expect(credentialsInvalidError.message).not.toContain('S3cr3t');
    });

    it.each([
      'sslca',
      'ssl-ca',
      'sslrootcert',
      'sslcert',
      'ssl-key',
      'sslcapath',
      'serverSslCert',
      'trustCertificateKeyStoreUrl',
      'clientCertificateKeyStoreUrl',
    ])('points the certificate-file option %s at the CA Certificate field', (parameterName) => {
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?${parameterName}=/etc/ssl/ca.pem`,
        MySqlCredentialProblem.ConnectionStringCertificatePathParameter,
      );
      expect(credentialsInvalidError.message).toContain('CA Certificate');
      expect(credentialsInvalidError.message).not.toContain('/etc/ssl');
    });

    it.each([
      'ssl-mode=REQUIRED&sslMode=REQUIRED',
      'user=a&user=a',
      'ssl=true&SSL=true',
      'sslmode=REQUIRED&ssl_mode=REQUIRED',
    ])('rejects the duplicated option in %s', (queryString) => {
      expectConnectionStringProblem(
        `mysql://db.example.com/app?${queryString}`,
        MySqlCredentialProblem.ConnectionStringParameterDuplicated,
      );
    });

    it('names a duplicated option as typed when no password comes before it', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql://app:pw@db.example.com/app?ssl-mode=REQUIRED&sslMode=REQUIRED',
        MySqlCredentialProblem.ConnectionStringParameterDuplicated,
      );
      expect(credentialsInvalidError.message).toBe(
        "The connection-string option 'sslMode' appears more than once. Keep one.",
      );
    });

    it('describes a duplicated option whose name does not look like an option name without naming it', () => {
      const secretLookingName = encodeURIComponent('S3cr3t!Sentinel');
      const credentialsInvalidError = expectConnectionStringProblem(
        `mysql://app:pw@db.example.com/app?${secretLookingName}=1&${secretLookingName}=2`,
        MySqlCredentialProblem.ConnectionStringParameterDuplicated,
      );
      expect(credentialsInvalidError.message).toBe(
        'An option in the connection string appears more than once. Keep one.',
      );
    });
  });

  // The query is split on '&', so an unencoded '&' in a `?password=` value turns the rest of the password into what
  // looks like an option NAME. Messages are logged and returned to the client, so such a name is never echoed.
  describe('password fragments split off by an unencoded & never reach a message', () => {
    function expectPasswordFragmentNotInMessage(
      connectionString: string,
      expectedProblem: MySqlCredentialProblem,
      passwordFragments: readonly string[],
    ): MySqlCredentialsInvalidError {
      const credentialsInvalidError = expectConnectionStringProblem(connectionString, expectedProblem);
      for (const passwordFragment of passwordFragments) {
        expect(credentialsInvalidError.message).not.toContain(passwordFragment);
        expect(credentialsInvalidError.userFriendlyMessage).not.toContain(passwordFragment);
      }
      expect(credentialsInvalidError.message).toContain('percent-encode');
      expect(credentialsInvalidError.message).toContain('%26');
      return credentialsInvalidError;
    }

    it.each<[string, MySqlCredentialProblem, readonly string[]]>([
      [
        'jdbc:mysql://db.example.com:3306/app?user=admin&password=Tr0ub4dor&Hunter2Secret',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['Hunter2Secret', 'Tr0ub4dor'],
      ],
      [
        'mysql://db.example.com/app?password=p1&p2Secret&user=admin',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['p2Secret'],
      ],
      [
        'mysql://h/app?user=admin&password=abc&Secret1',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['Secret1'],
      ],
      [
        'mysql://db.example.com/app?user=admin&password=abc&Secret1',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['Secret1'],
      ],
      [
        'jdbc:mysql://db.example.com/app?user=admin&password=abc&Secret1&sslMode=REQUIRED',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['Secret1'],
      ],
      [
        'mysql://db.example.com/app?user=admin&password=abc&Secret1=more&Secret2',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['Secret1', 'Secret2', 'more'],
      ],
      [
        'mysql://db.example.com/app?password=abc&Secret1&Secret1',
        MySqlCredentialProblem.ConnectionStringParameterDuplicated,
        ['Secret1'],
      ],
      [
        'mysql://db.example.com/app?user=admin&password=abc&Secret1&user=admin',
        MySqlCredentialProblem.ConnectionStringParameterDuplicated,
        ['Secret1', "'user'"],
      ],
    ])('%s', (connectionString, expectedProblem, passwordFragments) => {
      expectPasswordFragmentNotInMessage(connectionString, expectedProblem, passwordFragments);
    });

    it('says what is wrong without the name, and keeps the credentials in its guidance', () => {
      const credentialsInvalidError = expectPasswordFragmentNotInMessage(
        'jdbc:mysql://db.example.com:3306/app?user=admin&password=Tr0ub4dor&Hunter2Secret',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['Hunter2Secret'],
      );
      expect(credentialsInvalidError.message).toBe(
        'The connection string has an unsupported option. If your password contains special characters ' +
          '(& = # % ? / @), percent-encode them (e.g. & as %26). Otherwise keep only user, password and SSL settings ' +
          "(ssl-mode, sslaccept, ssl, useSSL, requireSSL) after '?'.",
      );
    });

    it('rejects a duplicated option after the password without naming it', () => {
      const credentialsInvalidError = expectPasswordFragmentNotInMessage(
        'mysql://db.example.com/app?password=abc&Secret1&Secret1',
        MySqlCredentialProblem.ConnectionStringParameterDuplicated,
        ['Secret1'],
      );
      expect(credentialsInvalidError.message).toMatch(/^An option in the connection string appears more than once/);
    });

    it('still names an ordinary unsupported option that comes before the password', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'jdbc:mysql://db.example.com/app?serverTimezone=UTC&user=admin&password=abc',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      expect(credentialsInvalidError.message).toContain(
        "The connection-string option 'serverTimezone' isn't supported.",
      );
      expect(credentialsInvalidError.message).not.toContain('percent-encode');
    });

    it('names the options before the password and only counts those after it', () => {
      const credentialsInvalidError = expectPasswordFragmentNotInMessage(
        'jdbc:mysql://db.example.com/app?serverTimezone=UTC&user=admin&password=abc&Secret1',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
        ['Secret1'],
      );
      expect(credentialsInvalidError.message).toContain("The connection-string options 'serverTimezone' and 1 more");
    });

    it('still names a duplicated option that comes before the password', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql://db.example.com/app?charset=a&charset=b&user=admin&password=abc',
        MySqlCredentialProblem.ConnectionStringParameterDuplicated,
      );
      expect(credentialsInvalidError.message).toBe(
        "The connection-string option 'charset' appears more than once. Keep one.",
      );
    });

    it.each([
      ['SSL_Mode=bogus', "'ssl-mode'", 'SSL_Mode'],
      ['SslAccept=maybe', "'sslaccept'", 'SslAccept'],
      ['SSL=yes', "'ssl'", "'SSL'"],
      ['UseSsl=maybe', "'useSSL'", 'UseSsl'],
      ['Require-SSL=maybe', "'requireSSL'", 'Require-SSL'],
      ['Verify_Server_Certificate=maybe', "'verifyServerCertificate'", 'Verify_Server_Certificate'],
      ['SSL-CA=/etc/ssl/ca.pem', "'sslca'", 'SSL-CA'],
    ])(
      'names the recognized option %s after the password in our own spelling, never as typed',
      (queryParameter, expectedQuotedName, typedNameThatMustNotAppear) => {
        const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
          parseMySqlConnectionString(`mysql://db.example.com/app?user=admin&password=abc&${queryParameter}`),
        );
        expect(credentialsInvalidError.message).toContain(expectedQuotedName);
        expect(credentialsInvalidError.message).not.toContain(typedNameThatMustNotAppear);
      },
    );

    it('names SSL options that disagree after the password in our own spelling', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql://db.example.com/app?SSL_MODE=REQUIRED&user=admin&password=abc&Ssl_Accept=strict',
        MySqlCredentialProblem.SslAliasesConflict,
      );
      expect(credentialsInvalidError.message).toContain("('SSL_MODE', 'sslaccept')");
    });

    it('keeps accepting a recognized SSL option after the password', () => {
      expect(
        parseMySqlConnectionString('jdbc:mysql://db.example.com/app?user=admin&password=p%26ss&useSSL=true'),
      ).toMatchObject({ username: 'admin', password: 'p&ss', sslModeFromConnectionString: 'REQUIRED' });
    });

    it('does not echo the fragment through the settings parser either (what POST /connector-accounts runs)', () => {
      let caughtError: unknown;
      try {
        parseMySqlCredentialsFromUserInput({
          connectionString: 'jdbc:mysql://db.example.com:3306/app?user=admin&password=Tr0ub4dor&Hunter2Secret',
        });
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(MySqlCredentialsInvalidError);
      if (!(caughtError instanceof MySqlCredentialsInvalidError)) return;
      expect(caughtError.problem).toBe(MySqlCredentialProblem.ConnectionStringParameterUnsupported);
      expect(caughtError.message).not.toContain('Hunter2Secret');
      expect(caughtError.userFriendlyMessage).not.toContain('Hunter2Secret');
    });
  });

  // When a `user:password@` candidate's host part fails (here the port) and the string is re-read without
  // userinfo, a '?' in the password starts the query, so the query holds password text.
  describe('a query that may hold userinfo password text never has its names echoed', () => {
    it('withholds every query-parameter name after a failed user:password@ candidate', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql://admin:2024?Hunter2&Secret1&x@db.example.com:99999/app',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      for (const passwordFragment of ['Hunter2', 'Secret1', '2024']) {
        expect(credentialsInvalidError.message).not.toContain(passwordFragment);
      }
      expect(credentialsInvalidError.message).toContain('The connection string has 3 unsupported options.');
      expect(credentialsInvalidError.message).toContain('percent-encode');
    });

    it('names a recognized SSL option there only in our own spelling', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'mysql://admin:2024?SSL-Mode=Secret1&x@db.example.com:99999/app',
        MySqlCredentialProblem.SslAliasValueInvalid,
      );
      expect(credentialsInvalidError.message).toContain("'ssl-mode'");
      expect(credentialsInvalidError.message).not.toContain('SSL-Mode');
      expect(credentialsInvalidError.message).not.toContain('Secret1');
    });

    it('keeps naming options when the @ belongs to a ?user= value (no userinfo candidate)', () => {
      const credentialsInvalidError = expectConnectionStringProblem(
        'jdbc:mysql://db.example.com:3306/app?user=me@example.com&serverTimezone=UTC',
        MySqlCredentialProblem.ConnectionStringParameterUnsupported,
      );
      expect(credentialsInvalidError.message).toContain("'serverTimezone'");
    });
  });

  describe('secrets never appear in messages', () => {
    const sentinelUsername = 'sentinel_user';
    const sentinelPassword = 'S3cr3tSentinel!@#';
    const encodedSentinelPassword = encodeURIComponent(sentinelPassword);
    const userinfoWithRawSentinel = `${sentinelUsername}:${sentinelPassword}`;
    const userinfoWithEncodedSentinel = `${sentinelUsername}:${encodedSentinelPassword}`;

    const connectionStringsThatMustFail = [
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?socketPath=/tmp/x`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?ssl=${encodedSentinelPassword}`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?ssl-mode=${encodedSentinelPassword}`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?sslaccept=${encodedSentinelPassword}`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?useSSL=${encodedSentinelPassword}`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?${encodedSentinelPassword}=1`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?user=other`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?password=other`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?sslca=${encodedSentinelPassword}`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?ssl=${encodeURIComponent(`{"ca":"${sentinelPassword}"}`)}`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?ssl-mode=REQUIRED&sslmode=REQUIRED`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?ssl-mode=REQUIRED&sslaccept=strict`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?useSSL=false&requireSSL=true`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?ssl=[1]`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app#fragment`,
      `mysql://${userinfoWithEncodedSentinel}@db.example.com/app/extra`,
      `mysql://${userinfoWithRawSentinel}@h1.example.com,h2.example.com/app`,
      `mysql://${userinfoWithRawSentinel}@2001:db8::1/app`,
      `mysql://${userinfoWithRawSentinel}@[zz]/app`,
      `mysql://${userinfoWithRawSentinel}@db.example.com:99999/app`,
      `mysql://${userinfoWithRawSentinel}@db.example.com:abc/app`,
      `mysql://${userinfoWithRawSentinel}@/app`,
      `mysql://${userinfoWithRawSentinel}@tcp(db.example.com:3306)/app`,
      `mysql://:${sentinelPassword}@db.example.com/app`,
      `postgres://${userinfoWithRawSentinel}@db.example.com/app`,
      `mysqlx://${userinfoWithRawSentinel}@db.example.com/app`,
      `mysql+srv://${userinfoWithRawSentinel}@db.example.com/app`,
      `jdbc:mysql:loadbalance://${userinfoWithRawSentinel}@db.example.com/app`,
      `https://${userinfoWithRawSentinel}@db.example.com/app`,
      `${userinfoWithRawSentinel}@tcp(db.example.com:3306)/app`,
      `Server=db.example.com;Uid=${sentinelUsername};Pwd=${sentinelPassword};`,
      `${userinfoWithRawSentinel}@db.example.com/app`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?${'x'.repeat(MYSQL_CONNECTION_STRING_MAX_LENGTH)}`,
      `mysql://db.example.com/app?user=${sentinelUsername}&password=S3cr3tSentinel&S3cr3tSentinel`,
      `mysql://db.example.com/app?user=${sentinelUsername}&password=x&S3cr3tSentinel&S3cr3tSentinel`,
      `mysql://db.example.com/app?user=${sentinelUsername}&password=x&S3cr3tSentinel=1&ssl-mode=REQUIRED`,
      `mysql://${sentinelUsername}:2024?S3cr3tSentinel&x@db.example.com:99999/app`,
      `mysql://${userinfoWithRawSentinel}@db.example.com/app?ssl=${encodeURIComponent('{"S3cr3tSentinel":true}')}`,
    ];

    it.each(connectionStringsThatMustFail)('%s', (connectionString) => {
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        parseMySqlConnectionString(connectionString),
      );
      for (const secretFragment of [
        sentinelPassword,
        encodedSentinelPassword,
        'S3cr3tSentinel',
        sentinelUsername,
        connectionString,
      ]) {
        expect(credentialsInvalidError.message).not.toContain(secretFragment);
        expect(credentialsInvalidError.userFriendlyMessage).not.toContain(secretFragment);
      }
    });
  });
});

describe('decodePercentEncodedRunsTolerantly', () => {
  it.each([
    ['a%40b', 'a@b'],
    ['50%off', '50%off'],
    ['100%', '100%'],
    ['%zz', '%zz'],
    ['a+b', 'a+b'],
    ['%C3%A9', 'é'],
    ['%FF', '%FF'],
    ['x%2', 'x%2'],
  ])('decodes %j as %j', (rawText, expectedText) => {
    expect(decodePercentEncodedRunsTolerantly(rawText)).toBe(expectedText);
  });
});
