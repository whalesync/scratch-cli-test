/**
 * Readable messages for the ways a Postgres TLS connection fails, instead of node-postgres / OpenSSL text
 * (`self-signed certificate in certificate chain`, `tlsv1 alert unknown ca`) or the server's own (which names our
 * address). Used by the Postgres and Supabase connectors' error mapping. Each case was reproduced against the local TLS
 * server in `server/localdev/docker-compose.postgres-tls.yml`; the codes are Node's and Postgres's.
 *
 * Messages name the Postgres connection form's certificate fields only when the form has them (Supabase's doesn't).
 */
import { type ConnectorErrorDetails } from '../../types';
import { POSTGRES_TLS_CERTIFICATE_FIELD_LABELS } from './node-postgres-tls';

/** Node / OpenSSL codes for a server certificate that doesn't chain to a trusted CA. */
const SERVER_CERTIFICATE_NOT_TRUSTED_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
]);
const SERVER_CERTIFICATE_EXPIRED_ERROR_CODES: ReadonlySet<string> = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);
const SERVER_CERTIFICATE_HOST_NAME_MISMATCH_ERROR_CODE = 'ERR_TLS_CERT_ALTNAME_INVALID';
/** The TLS alerts a server sends when it refuses the client certificate it was given. */
const CLIENT_CERTIFICATE_REFUSED_ERROR_CODES: ReadonlySet<string> = new Set([
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED',
  'ERR_SSL_SSLV3_ALERT_UNSUPPORTED_CERTIFICATE',
  'ERR_SSL_TLSV1_ALERT_ACCESS_DENIED',
]);
/** TLS 1.3's alert for a server that asked for a client certificate and got none. */
const CLIENT_CERTIFICATE_REQUIRED_ERROR_CODE = 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED';
/** Postgres's invalid_authorization_specification, which pg_hba.conf refusals use. */
const POSTGRES_AUTHORIZATION_REFUSED_SQLSTATE = '28000';
/** node-postgres's own error when the server answers "no" to its TLS request. */
const NODE_POSTGRES_SERVER_REFUSES_TLS_MESSAGE = 'The server does not support SSL connections';

const labels = POSTGRES_TLS_CERTIFICATE_FIELD_LABELS;

export const POSTGRES_SERVER_REFUSES_TLS_MESSAGE =
  "The database server doesn't accept encrypted connections. Turn on SSL on the server, or add sslmode=disable to the connection string to connect without encryption.";
export const POSTGRES_SERVER_REQUIRES_TLS_MESSAGE =
  'The database server only accepts encrypted connections. Remove sslmode=disable from the connection string.';
export const POSTGRES_UNENCRYPTED_CONNECTION_NOT_ALLOWED_MESSAGE =
  "The database server has no rule allowing this unencrypted connection. Either it only accepts encrypted connections (remove sslmode=disable from the connection string), or its access rules don't allow this user, database or Scratch's address.";
export const POSTGRES_SERVER_CERTIFICATE_EXPIRED_MESSAGE =
  "The database server's certificate has expired, or isn't valid yet. Ask the database's administrator to renew it.";

export interface PostgresTlsFailureWordingOptions {
  /** Whether the connection form has the certificate fields of {@link POSTGRES_TLS_CERTIFICATE_FIELD_LABELS}. */
  readonly connectionFormHasCertificateFields: boolean;
}

export function buildPostgresServerCertificateNotTrustedMessage(options: PostgresTlsFailureWordingOptions): string {
  return options.connectionFormHasCertificateFields
    ? `The database server's certificate couldn't be verified: it isn't signed by the CA in ${labels.sslCaCertificate} (or, with that empty, by a public certificate authority). Paste the server's CA certificate (for Cloud SQL, server-ca.pem) into ${labels.sslCaCertificate}, or leave it empty and use sslmode=require to encrypt without checking the certificate.`
    : "The database server's certificate isn't signed by a public certificate authority. Use sslmode=require to encrypt without checking the certificate.";
}

export function buildPostgresServerCertificateHostNameMismatchMessage(): string {
  return "The database server's certificate doesn't name the host in the connection string. Use sslmode=verify-ca to check the certificate without its host name (Cloud SQL's certificates name the instance, not its IP address), or connect to a host name the certificate lists.";
}

export function buildPostgresClientCertificateRequiredMessage(options: PostgresTlsFailureWordingOptions): string {
  return options.connectionFormHasCertificateFields
    ? `The database server requires a client certificate. Paste a client certificate it trusts into ${labels.sslClientCertificate}, and its key into ${labels.sslClientKey} (for Cloud SQL, client-cert.pem and client-key.pem).`
    : "The database server requires a client certificate, which this connection can't send.";
}

export function buildPostgresClientCertificateRefusedMessage(options: PostgresTlsFailureWordingOptions): string {
  return options.connectionFormHasCertificateFields
    ? `The database server didn't accept the client certificate. Check that ${labels.sslClientCertificate} is one the server trusts (for Cloud SQL, created for this instance) and that it hasn't been revoked.`
    : "The database server didn't accept the connection's client certificate.";
}

/** The user-facing details for a TLS failure, or undefined for any other error. */
export function describePostgresTlsFailure(
  error: unknown,
  options: PostgresTlsFailureWordingOptions,
): ConnectorErrorDetails | undefined {
  // Duck-typed: Node's TLS errors are created outside the caller's realm under jest's VM, so `instanceof Error` can't
  // be relied on.
  if (typeof error !== 'object' || error === null) return undefined;
  const { code: errorCode, message: errorMessage } = error as { code?: unknown; message?: unknown };
  if (typeof errorMessage !== 'string') return undefined;
  const tlsFailure = (userFriendlyMessage: string): ConnectorErrorDetails => ({
    userFriendlyMessage,
    description: userFriendlyMessage,
    ...(typeof errorCode === 'string' ? { additionalContext: { code: errorCode } } : {}),
  });

  if (errorMessage === NODE_POSTGRES_SERVER_REFUSES_TLS_MESSAGE) {
    return tlsFailure(POSTGRES_SERVER_REFUSES_TLS_MESSAGE);
  }
  if (errorCode === POSTGRES_AUTHORIZATION_REFUSED_SQLSTATE) {
    // The server's own text names our address and the user, so it's only matched here, never shown. Both pg_hba.conf
    // refusals end in "no encryption" for a plaintext connection (Postgres 14+), but only an explicit reject line
    // means the server requires TLS: "no entry" is also what a missing user, database or address rule looks like.
    if (/^pg_hba\.conf rejects connection\b.*\bno encryption\b/.test(errorMessage)) {
      return tlsFailure(POSTGRES_SERVER_REQUIRES_TLS_MESSAGE);
    }
    if (/^no pg_hba\.conf entry\b.*\bno encryption\b/.test(errorMessage)) {
      return tlsFailure(POSTGRES_UNENCRYPTED_CONNECTION_NOT_ALLOWED_MESSAGE);
    }
    if (/\bclient certificate\b/.test(errorMessage)) {
      return tlsFailure(buildPostgresClientCertificateRequiredMessage(options));
    }
    return undefined;
  }
  if (typeof errorCode !== 'string') return undefined;
  if (errorCode === CLIENT_CERTIFICATE_REQUIRED_ERROR_CODE) {
    return tlsFailure(buildPostgresClientCertificateRequiredMessage(options));
  }
  if (CLIENT_CERTIFICATE_REFUSED_ERROR_CODES.has(errorCode)) {
    return tlsFailure(buildPostgresClientCertificateRefusedMessage(options));
  }
  if (errorCode === SERVER_CERTIFICATE_HOST_NAME_MISMATCH_ERROR_CODE) {
    return tlsFailure(buildPostgresServerCertificateHostNameMismatchMessage());
  }
  if (SERVER_CERTIFICATE_EXPIRED_ERROR_CODES.has(errorCode)) {
    return tlsFailure(POSTGRES_SERVER_CERTIFICATE_EXPIRED_MESSAGE);
  }
  if (SERVER_CERTIFICATE_NOT_TRUSTED_ERROR_CODES.has(errorCode)) {
    return tlsFailure(buildPostgresServerCertificateNotTrustedMessage(options));
  }
  return undefined;
}
