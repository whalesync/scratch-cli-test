/**
 * The mysql2 `ssl` option for a validated TLS mode. Mirrors MySQL's own `--ssl-mode` semantics:
 *
 * | sslMode         | mysql2 `ssl`                                        |
 * |-----------------|-----------------------------------------------------|
 * | DISABLED        | undefined (plaintext)                               |
 * | REQUIRED        | `{ rejectUnauthorized: false }` — encrypted, no chain check. Must be explicit: mysql2 defaults `rejectUnauthorized` to true. |
 * | VERIFY_CA       | `{ rejectUnauthorized: true, ca }`                  |
 * | VERIFY_IDENTITY | VERIFY_CA + `verifyIdentity: true` (mysql2 skips the hostname check otherwise). Needs a hostname: for an IP-literal host mysql2 sends no SNI name and Node checks the certificate against `localhost`, so the credential parser rejects that combination. |
 *
 * `ca` is the user's pasted CA bundle ALONE when one was given — adding the public roots next to a private CA
 * (Cloud SQL, DigitalOcean, Aiven) would let any publicly-trusted certificate pass, which defeats the pinning the
 * user asked for (the MySQL CLI's `--ssl-ca` also replaces the trust set). Without a user CA it is Node's roots
 * plus the Amazon RDS bundle, so RDS/Aurora verify with no upload. Node's `ca` REPLACES the default trust store,
 * hence the explicit union.
 */
import awsSslProfiles from 'aws-ssl-profiles';
import tls from 'node:tls';
import { assertUnreachable } from 'src/utils/asserts';
import { type MySqlSslMode } from './mysql-types';

export interface MySql2SslOptions {
  rejectUnauthorized: boolean;
  ca?: string[];
  verifyIdentity?: boolean;
}

let defaultMySqlTrustedCaCertificatesCache: readonly string[] | undefined;

/** Node's root store ∪ the Amazon RDS CA bundle. Computed once; the array is shared, never the ssl object. */
export function getDefaultMySqlTrustedCaCertificates(): readonly string[] {
  defaultMySqlTrustedCaCertificatesCache ??= Object.freeze([...tls.rootCertificates, ...awsSslProfiles.ca]);
  return defaultMySqlTrustedCaCertificatesCache;
}

/**
 * Build a FRESH mysql2 ssl object. It must never be shared or frozen: mysql2 assigns `rejectUnauthorized` on it
 * (throwing on a frozen object, verified in the spike), and keys its SecureContext / TLS-session caches on the
 * object's identity, so sharing one across accounts could let a resumed session skip the identity check.
 */
export function buildMySql2SslOptions(
  sslMode: MySqlSslMode,
  userCaCertificateBundlePem: string | undefined,
): MySql2SslOptions | undefined {
  switch (sslMode) {
    case 'DISABLED':
      return undefined;
    case 'REQUIRED':
      return { rejectUnauthorized: false };
    case 'VERIFY_CA':
    case 'VERIFY_IDENTITY': {
      const trustedCaCertificates = userCaCertificateBundlePem
        ? [userCaCertificateBundlePem]
        : [...getDefaultMySqlTrustedCaCertificates()];
      return {
        rejectUnauthorized: true,
        ca: trustedCaCertificates,
        ...(sslMode === 'VERIFY_IDENTITY' ? { verifyIdentity: true } : {}),
      };
    }
    default:
      return assertUnreachable(sslMode);
  }
}
