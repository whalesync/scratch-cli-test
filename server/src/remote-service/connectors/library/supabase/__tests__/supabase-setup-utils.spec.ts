import { buildConnectionString, buildCreateUserSQL, extractProjectRef } from '../supabase-setup-utils';

describe('buildCreateUserSQL', () => {
  const sql = buildCreateUserSQL('whalesync_svc_abc123', 'pw-with-dashes');

  it('creates the login role', () => {
    expect(sql).toContain(`CREATE ROLE "whalesync_svc_abc123" LOGIN PASSWORD 'pw-with-dashes' BYPASSRLS`);
  });

  /**
   * Regression guard for DEV-11396: Live Export's "New schema" destination runs
   * `CREATE SCHEMA` over this role. That is a DATABASE-level privilege — the
   * per-schema `GRANT ALL ON SCHEMA` loop cannot confer it — so dropping this
   * line makes every new-schema export fail with `42501` while every other
   * operation keeps working.
   */
  it('grants CREATE on the database, so the role can create a schema', () => {
    expect(sql).toContain('GRANT CREATE ON DATABASE %I TO "whalesync_svc_abc123"');
    expect(sql).toContain('current_database()');
  });

  it('grants the database-level CREATE before the per-schema loop needs it', () => {
    expect(sql.indexOf('GRANT CREATE ON DATABASE')).toBeLessThan(sql.indexOf('FOR schema_record IN'));
  });

  it('still grants the per-schema privileges on every non-system schema', () => {
    expect(sql).toContain('GRANT ALL ON SCHEMA %I TO "whalesync_svc_abc123"');
    expect(sql).toContain("AND schema_name NOT LIKE 'pg\\_%'");
  });
});

describe('extractProjectRef', () => {
  it('reads the ref out of a pooler username', () => {
    expect(
      extractProjectRef('postgresql://postgres.abcdefghijklmnop:pw@aws-1-us-east-2.pooler.supabase.com:6543/postgres'),
    ).toBe('abcdefghijklmnop');
  });

  it('reads the ref out of a direct hostname', () => {
    expect(extractProjectRef('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres')).toBe(
      'abcdefghijklmnop',
    );
  });
});

describe('buildConnectionString', () => {
  it('keeps the Supavisor `user.projectRef` username shape', () => {
    const built = buildConnectionString(
      'postgresql://postgres.myref:old@aws-1-us-east-2.pooler.supabase.com:6543/postgres',
      'whalesync_svc_abc123',
      'new-pw',
      'myref',
    );

    expect(new URL(built).username).toBe('whalesync_svc_abc123.myref');
  });
});
