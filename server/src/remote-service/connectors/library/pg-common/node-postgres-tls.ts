/**
 * TLS for every node-postgres connection Scratch opens (the Postgres and Supabase connectors, through `KnexPGClient`):
 * the connection string's `sslmode`, read with standard Postgres (libpq) meanings, plus the certificates a Postgres
 * connection can carry (a server CA certificate, and a client certificate with its private key).
 *
 * We build node-postgres's `ssl` option here rather than letting it read `sslmode` itself, for three reasons:
 * - node-postgres reads `sslmode` its own way: unless `uselibpqcompat=true`, `prefer`, `require` and `verify-ca` all
 *   mean `verify-full` against Node's built-in public CAs, so a server with a private CA (Cloud SQL, Amazon RDS) fails
 *   every mode except `no-verify`.
 * - It only takes certificates from file paths (`sslrootcert`, `sslcert`, `sslkey`), which the connection-string
 *   allowlist refuses: they make our server read a file.
 * - It replaces any `ssl` option we pass with whatever it parses from the URL. So the connection-string allowlist
 *   removes `sslmode`, `ssl` and `uselibpqcompat` from the string node-postgres sees, and the mode comes back here.
 *
 * | mode          | encrypted | checks the CA                                   | checks the host name |
 * | ------------- | --------- | ----------------------------------------------- | -------------------- |
 * | `disable`     | no        | –                                               | –                    |
 * | `require`     | yes       | only when a server CA certificate is given      | no                   |
 * | `verify-ca`   | yes       | against the given CA, or the public CAs         | no                   |
 * | `verify-full` | yes       | against the given CA, or the public CAs         | yes                  |
 *
 * `require` with a CA verifies the chain, as libpq does when it has a root certificate. A given CA is the only one
 * trusted (Node's `ca` option replaces the public CAs). A client certificate and key are sent in every encrypted mode.
 * `verify-ca` is what a Cloud SQL instance with its default per-instance CA needs: its certificate is named
 * `<project>:<instance>`, not the IP address we connect to, so only the chain can be checked.
 *
 * `verify-full` checks the certificate against the connection string's host ourselves. Left to Node, a TLS
 * connection made over an existing socket to an IP address (node-postgres sets no server name for one) is checked
 * against `localhost`, so any certificate naming `localhost` would pass.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import { assertUnreachable } from 'src/utils/asserts';
import {
  normalizePemCertificateBundle,
  normalizePemPrivateKey,
  PemInputError,
  splitCanonicalPemCertificateBundle,
} from '../../utils/pem-certificates-and-keys';

export type PostgresTlsMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

/** A Postgres connection's certificate settings, as typed or as stored. Absent (or blank) = not used. */
export interface PostgresTlsCertificates {
  /** PEM: the CA (or bundle) that signed the server's certificate, e.g. Cloud SQL's `server-ca.pem`. */
  readonly sslCaCertificate?: string;
  /** PEM: a client certificate the server trusts (and any intermediates), e.g. Cloud SQL's `client-cert.pem`. */
  readonly sslClientCertificate?: string;
  /** PEM: the unencrypted private key of the client certificate, e.g. Cloud SQL's `client-key.pem`. */
  readonly sslClientKey?: string;
}

/** The connection form's labels for the certificate settings; messages name fields by these. */
export const POSTGRES_TLS_CERTIFICATE_FIELD_LABELS = Object.freeze({
  sslCaCertificate: 'Server CA certificate',
  sslClientCertificate: 'Client certificate',
  sslClientKey: 'Client private key',
} satisfies Record<keyof PostgresTlsCertificates, string>);

export type PostgresTlsSettingsPreparation =
  | {
      readonly accepted: true;
      /** The given certificates in canonical PEM (what to store). Absent fields stay absent. */
      readonly canonicalCertificates: PostgresTlsCertificates;
      /** node-postgres's `ssl` option: `false` for no TLS, otherwise Node TLS options. */
      readonly nodePostgresSslOption: false | ConnectionOptions;
    }
  | {
      readonly accepted: false;
      /** Safe to show and to store: never contains certificate or key text. */
      readonly userFacingReason: string;
    };

export interface PostgresTlsSettingsRequest {
  readonly tlsMode: PostgresTlsMode;
  /** The host the connection string names, which `verify-full` checks the certificate against. */
  readonly serverHost: string;
  readonly certificates: PostgresTlsCertificates;
  /** When a client certificate must still be valid. Defaults to now. */
  readonly now?: Date;
}

/** Check the certificate settings against each other and the mode, and build node-postgres's `ssl` option. */
export function preparePostgresTlsSettings(request: PostgresTlsSettingsRequest): PostgresTlsSettingsPreparation {
  const { tlsMode, serverHost, certificates, now = new Date() } = request;
  const refuse = (userFacingReason: string): PostgresTlsSettingsPreparation => ({ accepted: false, userFacingReason });
  const labels = POSTGRES_TLS_CERTIFICATE_FIELD_LABELS;

  let canonicalServerCaCertificate: string | undefined;
  let canonicalClientCertificate: string | undefined;
  let canonicalClientKey: string | undefined;
  try {
    canonicalServerCaCertificate = isGiven(certificates.sslCaCertificate)
      ? normalizePemCertificateBundle(certificates.sslCaCertificate, {
          fieldLabel: labels.sslCaCertificate,
          expectedCertificate: "the server's CA certificate",
          expectedBundle: "your provider's CA certificate or bundle",
        })
      : undefined;
    canonicalClientCertificate = isGiven(certificates.sslClientCertificate)
      ? normalizePemCertificateBundle(certificates.sslClientCertificate, {
          fieldLabel: labels.sslClientCertificate,
          expectedCertificate: 'the client certificate',
          expectedBundle: 'the client certificate (and any intermediate certificates)',
        })
      : undefined;
    canonicalClientKey = isGiven(certificates.sslClientKey)
      ? normalizePemPrivateKey(certificates.sslClientKey, labels.sslClientKey)
      : undefined;
  } catch (error) {
    if (error instanceof PemInputError) return refuse(error.message);
    throw error;
  }

  if ((canonicalClientCertificate === undefined) !== (canonicalClientKey === undefined)) {
    return refuse(`${labels.sslClientCertificate} and ${labels.sslClientKey} go together: paste both, or neither.`);
  }
  if (canonicalClientCertificate !== undefined && canonicalClientKey !== undefined) {
    const clientCertificateProblem = describeClientCertificateProblem(
      canonicalClientCertificate,
      canonicalClientKey,
      now,
    );
    if (clientCertificateProblem !== undefined) return refuse(clientCertificateProblem);
  }

  const someCertificateIsGiven = [canonicalServerCaCertificate, canonicalClientCertificate].some(
    (canonicalPem) => canonicalPem !== undefined,
  );
  if (tlsMode === 'disable' && someCertificateIsGiven) {
    return refuse(
      'Certificates need an encrypted connection. Remove sslmode=disable from the connection string, or remove the certificates.',
    );
  }

  const canonicalCertificates: PostgresTlsCertificates = {
    ...(canonicalServerCaCertificate !== undefined ? { sslCaCertificate: canonicalServerCaCertificate } : {}),
    ...(canonicalClientCertificate !== undefined ? { sslClientCertificate: canonicalClientCertificate } : {}),
    ...(canonicalClientKey !== undefined ? { sslClientKey: canonicalClientKey } : {}),
  };
  return {
    accepted: true,
    canonicalCertificates,
    nodePostgresSslOption: buildNodePostgresSslOption(tlsMode, serverHost, canonicalCertificates),
  };
}

function buildNodePostgresSslOption(
  tlsMode: PostgresTlsMode,
  serverHost: string,
  canonicalCertificates: PostgresTlsCertificates,
): false | ConnectionOptions {
  if (tlsMode === 'disable') return false;

  const clientCertificateOptions: ConnectionOptions =
    canonicalCertificates.sslClientCertificate !== undefined && canonicalCertificates.sslClientKey !== undefined
      ? { cert: canonicalCertificates.sslClientCertificate, key: canonicalCertificates.sslClientKey }
      : {};
  const trustedCaOptions: ConnectionOptions =
    canonicalCertificates.sslCaCertificate !== undefined ? { ca: canonicalCertificates.sslCaCertificate } : {};
  const skipHostNameCheck: ConnectionOptions = { checkServerIdentity: () => undefined };

  switch (tlsMode) {
    case 'require':
      return canonicalCertificates.sslCaCertificate !== undefined
        ? { rejectUnauthorized: true, ...trustedCaOptions, ...skipHostNameCheck, ...clientCertificateOptions }
        : { rejectUnauthorized: false, ...clientCertificateOptions };
    case 'verify-ca':
      return { rejectUnauthorized: true, ...trustedCaOptions, ...skipHostNameCheck, ...clientCertificateOptions };
    case 'verify-full': {
      // Node's own check handles an IP address (against the certificate's IP names) once it is given one.
      const hostToCheckTheCertificateAgainst = serverHost.replace(/^\[(.*)\]$/, '$1');
      return {
        rejectUnauthorized: true,
        ...trustedCaOptions,
        checkServerIdentity: (_hostNameNodeWouldCheck, peerCertificate) =>
          checkServerIdentity(hostToCheckTheCertificateAgainst, peerCertificate),
        ...clientCertificateOptions,
      };
    }
    default:
      return assertUnreachable(tlsMode);
  }
}

/** Undefined when the client certificate (its first, leaf certificate) is current and matches the key. */
function describeClientCertificateProblem(
  canonicalClientCertificateBundle: string,
  canonicalClientKey: string,
  now: Date,
): string | undefined {
  const labels = POSTGRES_TLS_CERTIFICATE_FIELD_LABELS;
  const [leafClientCertificatePem] = splitCanonicalPemCertificateBundle(canonicalClientCertificateBundle);
  const leafClientCertificate = new X509Certificate(leafClientCertificatePem);
  const clientCertificateExpiry = new Date(leafClientCertificate.validTo);
  if (clientCertificateExpiry.getTime() < now.getTime()) {
    return `${labels.sslClientCertificate} expired on ${clientCertificateExpiry.toISOString().slice(0, 10)}. Create a new client certificate and paste it with its key.`;
  }
  if (!leafClientCertificate.checkPrivateKey(createPrivateKey(canonicalClientKey))) {
    return `${labels.sslClientKey} doesn't belong to ${labels.sslClientCertificate}. Paste the key that was created with the certificate.`;
  }
  return undefined;
}

function isGiven(pemText: string | undefined): pemText is string {
  return pemText !== undefined && pemText.trim().length > 0;
}
