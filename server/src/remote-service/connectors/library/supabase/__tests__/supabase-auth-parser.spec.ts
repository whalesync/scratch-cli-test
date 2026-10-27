import { ConnectorAuthError } from '../../../error';
import { SupabaseAuthParser } from '../supabase-auth-parser';

describe('SupabaseAuthParser', () => {
  const parser = new SupabaseAuthParser();
  const poolerConnectionString =
    'postgresql://postgres.abcdefgh:S3cret@aws-0-us-east-1.pooler.supabase.com:6543/postgres';

  it('stores a pooler connection string as typed', async () => {
    await expect(
      parser.parseUserProvidedParams({
        userProvidedParams: { connectionString: `${poolerConnectionString}?pgbouncer=true` },
      }),
    ).resolves.toEqual({ credentials: { connectionString: `${poolerConnectionString}?pgbouncer=true` }, extras: {} });
  });

  it.each([
    ['a certificate file', '?sslrootcert=/dev/zero', 'Remove sslrootcert'],
    [
      'a certificate file, without naming certificate fields its form lacks',
      '?sslrootcert=/dev/zero',
      'Use sslmode=require',
    ],
    ['a host override', '?host=10.0.0.5', 'Remove host'],
    ['replication', '?replication=database', 'replication'],
  ])('refuses %s with a message safe to show', async (_description, query, expectedMessageFragment) => {
    const error: unknown = await parser
      .parseUserProvidedParams({ userProvidedParams: { connectionString: `${poolerConnectionString}${query}` } })
      .then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

    expect(error).toBeInstanceOf(ConnectorAuthError);
    expect((error as ConnectorAuthError).service).toBe('SUPABASE');
    expect((error as ConnectorAuthError).userFriendlyMessage).toContain(expectedMessageFragment);
    expect((error as ConnectorAuthError).userFriendlyMessage).not.toContain('S3cret');
  });
});
