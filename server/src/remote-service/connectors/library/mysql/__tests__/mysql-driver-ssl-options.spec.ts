import awsSslProfiles from 'aws-ssl-profiles';
import tls from 'node:tls';
import { buildMySql2SslOptions, getDefaultMySqlTrustedCaCertificates } from '../mysql-driver-ssl-options';

const userCaCertificateBundlePem = tls.rootCertificates.slice(0, 2).join('\n');

describe('buildMySql2SslOptions', () => {
  it('DISABLED: no ssl option at all (plaintext)', () => {
    expect(buildMySql2SslOptions('DISABLED', undefined)).toBeUndefined();
    expect(buildMySql2SslOptions('DISABLED', userCaCertificateBundlePem)).toBeUndefined();
  });

  it('REQUIRED: encrypted with an explicit rejectUnauthorized:false (mysql2 defaults it to true) and no CA', () => {
    expect(buildMySql2SslOptions('REQUIRED', undefined)).toStrictEqual({ rejectUnauthorized: false });
    expect(buildMySql2SslOptions('REQUIRED', userCaCertificateBundlePem)).toStrictEqual({ rejectUnauthorized: false });
  });

  it("VERIFY_CA without a user CA: trusts every Node root and every Amazon RDS certificate, and doesn't check the hostname", () => {
    const mysql2SslOptions = buildMySql2SslOptions('VERIFY_CA', undefined);

    expect(mysql2SslOptions?.rejectUnauthorized).toBe(true);
    expect(mysql2SslOptions).not.toHaveProperty('verifyIdentity');
    const trustedCaCertificates = mysql2SslOptions?.ca ?? [];
    expect(trustedCaCertificates).toHaveLength(tls.rootCertificates.length + awsSslProfiles.ca.length);
    expect(trustedCaCertificates).toEqual(expect.arrayContaining([...tls.rootCertificates]));
    expect(trustedCaCertificates).toEqual(expect.arrayContaining(awsSslProfiles.ca));
  });

  it('VERIFY_CA with a user CA: trusts ONLY the user CA (a private CA must not be widened by public roots)', () => {
    expect(buildMySql2SslOptions('VERIFY_CA', userCaCertificateBundlePem)).toStrictEqual({
      rejectUnauthorized: true,
      ca: [userCaCertificateBundlePem],
    });
  });

  it('VERIFY_IDENTITY: VERIFY_CA plus verifyIdentity (mysql2 skips the hostname check otherwise)', () => {
    expect(buildMySql2SslOptions('VERIFY_IDENTITY', userCaCertificateBundlePem)).toStrictEqual({
      rejectUnauthorized: true,
      ca: [userCaCertificateBundlePem],
      verifyIdentity: true,
    });
    const mysql2SslOptionsWithDefaultTrust = buildMySql2SslOptions('VERIFY_IDENTITY', undefined);
    expect(mysql2SslOptionsWithDefaultTrust?.verifyIdentity).toBe(true);
    expect(mysql2SslOptionsWithDefaultTrust?.ca).toEqual([...getDefaultMySqlTrustedCaCertificates()]);
  });

  it('treats an empty user CA as absent', () => {
    expect(buildMySql2SslOptions('VERIFY_CA', '')?.ca).toEqual([...getDefaultMySqlTrustedCaCertificates()]);
  });

  it('builds a FRESH, mutable ssl object every call (mysql2 assigns to it and keys TLS caches on its identity)', () => {
    for (const sslMode of ['REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const) {
      const firstMysql2SslOptions = buildMySql2SslOptions(sslMode, undefined);
      const secondMysql2SslOptions = buildMySql2SslOptions(sslMode, undefined);
      expect(firstMysql2SslOptions).not.toBe(secondMysql2SslOptions);
      expect(Object.isFrozen(firstMysql2SslOptions)).toBe(false);
      if (!firstMysql2SslOptions) throw new Error('expected ssl options');
      // What mysql2 does to the object it is given — must not throw, must not leak into the next client.
      firstMysql2SslOptions.rejectUnauthorized = !firstMysql2SslOptions.rejectUnauthorized;
      expect(buildMySql2SslOptions(sslMode, undefined)?.rejectUnauthorized).toBe(sslMode !== 'REQUIRED');
    }
  });

  it('never hands out the cached default CA array itself', () => {
    const mysql2SslOptions = buildMySql2SslOptions('VERIFY_CA', undefined);
    expect(mysql2SslOptions?.ca).not.toBe(getDefaultMySqlTrustedCaCertificates());
    expect(Object.isFrozen(mysql2SslOptions?.ca)).toBe(false);
  });
});

describe('getDefaultMySqlTrustedCaCertificates', () => {
  it('computes the Node roots ∪ Amazon RDS array once and freezes it', () => {
    const defaultTrustedCaCertificates = getDefaultMySqlTrustedCaCertificates();
    expect(getDefaultMySqlTrustedCaCertificates()).toBe(defaultTrustedCaCertificates);
    expect(Object.isFrozen(defaultTrustedCaCertificates)).toBe(true);
    expect(defaultTrustedCaCertificates).toEqual([...tls.rootCertificates, ...awsSslProfiles.ca]);
  });
});
