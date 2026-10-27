import { ConnectorAuthError } from '../../../error';
import { PostgresAuthParser } from '../postgres-auth-parser';

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
    expect(authError.message).toBe(authError.userFriendlyMessage);
    expect(authError.userFriendlyMessage).not.toContain('S3cret');
    expect(authError.userFriendlyMessage).not.toContain('/dev/zero');
  });

  it.each([undefined, '', '   ', 42])('requires a connection string (got %p)', async (connectionString) => {
    const error = await parseError({
      userProvidedParams: { connectionString } as unknown as Record<string, string | undefined>,
    });
    expect(error).toBeInstanceOf(ConnectorAuthError);
    expect((error as ConnectorAuthError).userFriendlyMessage).toContain('Enter a connection string');
  });

  describe('edits', () => {
    const existingCredentials = { connectionString: 'postgres://u:p@old.example.com/app' };

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
