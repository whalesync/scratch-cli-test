/**
 * Each error below has the shape node-postgres produced for that failure against the local TLS server
 * (`server/localdev/docker-compose.postgres-tls.yml`); `test/integration/postgres-tls.spec.ts` checks the same cases
 * end to end. The exception is the "no pg_hba.conf entry" text, which that server's pg_hba.conf never produces; it is
 * Postgres's own wording (src/backend/libpq/auth.c).
 */
import {
  buildPostgresClientCertificateRefusedMessage,
  buildPostgresClientCertificateRequiredMessage,
  buildPostgresServerCertificateHostNameMismatchMessage,
  buildPostgresServerCertificateNotTrustedMessage,
  describePostgresTlsFailure,
  POSTGRES_SERVER_CERTIFICATE_EXPIRED_MESSAGE,
  POSTGRES_SERVER_REFUSES_TLS_MESSAGE,
  POSTGRES_SERVER_REQUIRES_TLS_MESSAGE,
  POSTGRES_UNENCRYPTED_CONNECTION_NOT_ALLOWED_MESSAGE,
} from '../pg-tls-failures';

const postgresFormWording = { connectionFormHasCertificateFields: true };
const supabaseFormWording = { connectionFormHasCertificateFields: false };

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('describePostgresTlsFailure', () => {
  it.each([
    [
      'a server without TLS',
      new Error('The server does not support SSL connections'),
      POSTGRES_SERVER_REFUSES_TLS_MESSAGE,
    ],
    [
      'a server that refuses plaintext',
      errorWithCode(
        'pg_hba.conf rejects connection for host "172.20.0.1", user "app", database "app", no encryption',
        '28000',
      ),
      POSTGRES_SERVER_REQUIRES_TLS_MESSAGE,
    ],
    [
      'a plaintext connection no pg_hba.conf line allows, which may be the user, database or address',
      errorWithCode('no pg_hba.conf entry for host "172.20.0.1", user "app", database "app", no encryption', '28000'),
      POSTGRES_UNENCRYPTED_CONNECTION_NOT_ALLOWED_MESSAGE,
    ],
    [
      'a server that wants a client certificate',
      errorWithCode('connection requires a valid client certificate', '28000'),
      buildPostgresClientCertificateRequiredMessage(postgresFormWording),
    ],
    [
      'a TLS 1.3 "certificate required" alert',
      errorWithCode('tlsv13 alert certificate required', 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'),
      buildPostgresClientCertificateRequiredMessage(postgresFormWording),
    ],
    [
      'a refused client certificate',
      errorWithCode(
        '002330FD01000000:error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 48\n',
        'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
      ),
      buildPostgresClientCertificateRefusedMessage(postgresFormWording),
    ],
    [
      'a server certificate from an untrusted CA',
      errorWithCode('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'),
      buildPostgresServerCertificateNotTrustedMessage(postgresFormWording),
    ],
    [
      'a server certificate missing its issuer',
      errorWithCode('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
      buildPostgresServerCertificateNotTrustedMessage(postgresFormWording),
    ],
    [
      'a server certificate for another host',
      errorWithCode(
        "Hostname/IP does not match certificate's altnames: IP: 10.1.2.3 is not in the cert's list: ",
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ),
      buildPostgresServerCertificateHostNameMismatchMessage(),
    ],
    [
      'an expired server certificate',
      errorWithCode('certificate has expired', 'CERT_HAS_EXPIRED'),
      POSTGRES_SERVER_CERTIFICATE_EXPIRED_MESSAGE,
    ],
  ])('explains %s, without the server or OpenSSL text', (_description, error, expectedMessage) => {
    const errorDetails = describePostgresTlsFailure(error, postgresFormWording);

    expect(errorDetails?.userFriendlyMessage).toBe(expectedMessage);
    expect(JSON.stringify(errorDetails)).not.toMatch(/pg_hba|SSL routines|altnames|user \\"app\\"|self-signed/);
    expect(JSON.stringify(errorDetails)).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });

  it('names the certificate fields only on a form that has them', () => {
    const untrustedServerCertificate = errorWithCode(
      'self-signed certificate in certificate chain',
      'SELF_SIGNED_CERT_IN_CHAIN',
    );

    expect(describePostgresTlsFailure(untrustedServerCertificate, postgresFormWording)?.userFriendlyMessage).toContain(
      'Server CA certificate',
    );
    expect(
      describePostgresTlsFailure(untrustedServerCertificate, supabaseFormWording)?.userFriendlyMessage,
    ).not.toContain('Server CA certificate');
    expect(
      describePostgresTlsFailure(
        errorWithCode('connection requires a valid client certificate', '28000'),
        supabaseFormWording,
      )?.userFriendlyMessage,
    ).not.toContain('Client private key');
  });

  it.each([
    ['a wrong password', errorWithCode('password authentication failed for user "app"', '28P01')],
    ['another pg_hba.conf refusal', errorWithCode('pg_hba.conf rejects connection for host "1.2.3.4"', '28000')],
    [
      'an encrypted connection no pg_hba.conf line allows',
      errorWithCode('no pg_hba.conf entry for host "1.2.3.4", user "app", database "app", SSL encryption', '28000'),
    ],
    ['a connection refusal', errorWithCode('connect ECONNREFUSED 1.2.3.4:5432', 'ECONNREFUSED')],
    ['a plain error', new Error('something else')],
    ['a non-error', 'not an error'],
  ])('leaves %s to the rest of the error mapping', (_description, error) => {
    expect(describePostgresTlsFailure(error, postgresFormWording)).toBeUndefined();
  });
});
