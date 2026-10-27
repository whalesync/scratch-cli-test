import { ConnectorAuthError } from '../../../error';
import { buildTestCertificate } from '../../../utils/__tests__/test-certificates';
import { PostgresAuthParser } from '../postgres-auth-parser';

const serverCa = buildTestCertificate({ commonName: 'test-server-ca' });
const clientCa = buildTestCertificate({ commonName: 'test-client-ca' });
const clientCertificate = buildTestCertificate({ commonName: 'test-client', issuer: clientCa });
const otherClientCertificate = buildTestCertificate({ commonName: 'other-client', issuer: clientCa });

/** How a single-line form field sends a pasted PEM. */
function asOneLinePaste(pemText: string): string {
  return pemText.replace(/\n/g, ' ');
}

describe('PostgresAuthParser', () => {
  const parser = new PostgresAuthParser();

  async function parseError(params: Parameters<PostgresAuthParser['parseUserProvidedParams']>[0]): Promise<unknown> {
    return parser.parseUserProvidedParams(params).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('stores only the trimmed connection string, as typed', async () => {
    await expect(
      parser.parseUserProvidedParams({
        userProvidedParams: {
          connectionString: '  postgres://u:p@db.example.com:5432/app?pgbouncer=true  ',
          somethingElse: 'ignored',
        },
      }),
    ).resolves.toEqual({
      credentials: { connectionString: 'postgres://u:p@db.example.com:5432/app?pgbouncer=true' },
      extras: {},
    });
  });

  it('refuses a connection string the node-postgres allowlist refuses, with a message safe to show', async () => {
    const error = await parseError({
      userProvidedParams: { connectionString: 'postgres://u:S3cret@db.example.com/app?sslrootcert=/dev/zero' },
    });

    expect(error).toBeInstanceOf(ConnectorAuthError);
    const authError = error as ConnectorAuthError;
    expect(authError.service).toBe('POSTGRES');
    expect(authError.userFriendlyMessage).toContain('Remove sslrootcert');
    expect(authError.userFriendlyMessage).toContain("the connection form's certificate fields");
    expect(authError.message).toBe(authError.userFriendlyMessage);
    expect(authError.userFriendlyMessage).not.toContain('S3cret');
    expect(authError.userFriendlyMessage).not.toContain('/dev/zero');
  });

  it.each([undefined, '', '   '])('requires a connection string (got %p)', async (connectionString) => {
    const error = await parseError({
      userProvidedParams: { connectionString } as unknown as Record<string, string | undefined>,
    });
    expect(error).toBeInstanceOf(ConnectorAuthError);
    expect((error as ConnectorAuthError).userFriendlyMessage).toContain('Enter a connection string');
  });

  it('refuses a connection string that is not text', async () => {
    const error = await parseError({
      userProvidedParams: { connectionString: 42 } as unknown as Record<string, string | undefined>,
    });
    expect((error as ConnectorAuthError).userFriendlyMessage).toBe('Connection String must be text.');
  });

  describe('certificates', () => {
    const connectionString = 'postgres://u:p@10.1.2.3:5432/app?sslmode=verify-ca';

    it('stores the server CA certificate and the client certificate and key in canonical PEM', async () => {
      await expect(
        parser.parseUserProvidedParams({
          userProvidedParams: {
            connectionString,
            sslCaCertificate: asOneLinePaste(serverCa.certificatePem),
            sslClientCertificate: asOneLinePaste(clientCertificate.certificatePem),
            sslClientKey: asOneLinePaste(clientCertificate.privateKeyPem),
          },
        }),
      ).resolves.toEqual({
        credentials: {
          connectionString,
          sslCaCertificate: serverCa.certificatePem,
          sslClientCertificate: clientCertificate.certificatePem,
          sslClientKey: clientCertificate.privateKeyPem,
        },
        extras: {},
      });
    });

    it('leaves blank certificate fields out (the web form sends them blank)', async () => {
      await expect(
        parser.parseUserProvidedParams({
          userProvidedParams: { connectionString, sslCaCertificate: '', sslClientCertificate: ' ', sslClientKey: '' },
        }),
      ).resolves.toEqual({ credentials: { connectionString }, extras: {} });
    });

    it.each([
      [
        "a key that doesn't belong to the certificate",
        { sslClientCertificate: clientCertificate.certificatePem, sslClientKey: otherClientCertificate.privateKeyPem },
        "doesn't belong to Client certificate",
      ],
      [
        'a client certificate without its key',
        { sslClientCertificate: clientCertificate.certificatePem },
        'go together',
      ],
      [
        'a private key as the server CA certificate',
        { sslCaCertificate: clientCertificate.privateKeyPem },
        'contains a private key',
      ],
    ])('refuses %s, with a message safe to show', async (_description, certificateFields, expectedMessageFragment) => {
      const error = await parseError({ userProvidedParams: { connectionString, ...certificateFields } });

      expect(error).toBeInstanceOf(ConnectorAuthError);
      expect((error as ConnectorAuthError).userFriendlyMessage).toContain(expectedMessageFragment);
      expect((error as ConnectorAuthError).userFriendlyMessage).not.toContain(
        clientCertificate.privateKeyPem.split('\n')[1],
      );
    });

    it('refuses certificates with sslmode=disable', async () => {
      const error = await parseError({
        userProvidedParams: {
          connectionString: 'postgres://u:p@h/app?sslmode=disable',
          sslCaCertificate: serverCa.certificatePem,
        },
      });

      expect((error as ConnectorAuthError).userFriendlyMessage).toContain('Certificates need an encrypted connection.');
    });

    it('refuses a certificate field that is not text, naming the field', async () => {
      const error = await parseError({
        userProvidedParams: { connectionString, sslClientKey: ['not', 'text'] } as unknown as Record<string, string>,
      });

      expect((error as ConnectorAuthError).userFriendlyMessage).toBe('Client private key must be text.');
    });
  });

  describe('edits', () => {
    const existingCredentials = { connectionString: 'postgres://u:p@old.example.com/app' };
    const existingCredentialsWithCertificates = {
      connectionString: 'postgres://u:p@old.example.com/app?sslmode=verify-ca',
      sslCaCertificate: serverCa.certificatePem,
      sslClientCertificate: clientCertificate.certificatePem,
      sslClientKey: clientCertificate.privateKeyPem,
      // The stored blob can carry other keys; only the Postgres ones are kept.
      apiKey: 'not-a-postgres-setting',
    };

    it('replaces one certificate without the connection string being sent again', async () => {
      const newServerCa = buildTestCertificate({ commonName: 'rotated-server-ca' });

      const { credentials } = await parser.parseUserProvidedParams({
        userProvidedParams: { sslCaCertificate: asOneLinePaste(newServerCa.certificatePem) },
        existingCredentials: existingCredentialsWithCertificates,
      });

      expect(credentials).toEqual({
        connectionString: existingCredentialsWithCertificates.connectionString,
        sslCaCertificate: newServerCa.certificatePem,
        sslClientCertificate: clientCertificate.certificatePem,
        sslClientKey: clientCertificate.privateKeyPem,
      });
    });

    it("clears certificates the edit sends as '' or null", async () => {
      const { credentials } = await parser.parseUserProvidedParams({
        userProvidedParams: { sslClientCertificate: '', sslClientKey: null } as unknown as Record<string, string>,
        existingCredentials: existingCredentialsWithCertificates,
      });

      expect(credentials).toEqual({
        connectionString: existingCredentialsWithCertificates.connectionString,
        sslCaCertificate: serverCa.certificatePem,
      });
    });

    it('refuses an edit that clears only half of the client certificate pair', async () => {
      expect(
        await parseError({
          userProvidedParams: { sslClientKey: '' },
          existingCredentials: existingCredentialsWithCertificates,
        }),
      ).toBeInstanceOf(ConnectorAuthError);
    });

    it('refuses an edit that turns encryption off while certificates remain', async () => {
      const error = await parseError({
        userProvidedParams: { connectionString: 'postgres://u:p@old.example.com/app?sslmode=disable' },
        existingCredentials: existingCredentialsWithCertificates,
      });

      expect((error as ConnectorAuthError).userFriendlyMessage).toContain('Certificates need an encrypted connection.');
    });

    it('checks a new connection string like a create', async () => {
      await expect(
        parser.parseUserProvidedParams({
          userProvidedParams: { connectionString: 'postgres://u:p@new.example.com/app' },
          existingCredentials,
        }),
      ).resolves.toEqual({ credentials: { connectionString: 'postgres://u:p@new.example.com/app' }, extras: {} });

      expect(
        await parseError({
          userProvidedParams: { connectionString: 'postgres://u:p@new.example.com/app?host=10.0.0.5' },
          existingCredentials,
        }),
      ).toBeInstanceOf(ConnectorAuthError);
    });

    it('keeps the stored connection string when the edit sends none', async () => {
      await expect(parser.parseUserProvidedParams({ userProvidedParams: {}, existingCredentials })).resolves.toEqual({
        credentials: existingCredentials,
        extras: {},
      });
    });

    it('refuses to keep a stored connection string the allowlist refuses', async () => {
      expect(
        await parseError({
          userProvidedParams: {},
          existingCredentials: { connectionString: 'postgres://u:p@h/app?sslkey=/etc/key' },
        }),
      ).toBeInstanceOf(ConnectorAuthError);
    });
  });
});
