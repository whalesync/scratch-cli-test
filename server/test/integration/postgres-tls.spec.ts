/**
 * Postgres connector TLS integration test (DEV-12575): the connection string's sslmode, and the server CA
 * certificate, client certificate and client private key settings, against a real Postgres with TLS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * What this validates that the unit tests don't
 * ═══════════════════════════════════════════════════════════════════════════
 * The unit specs check the `ssl` option we build and the error mapping against fakes. This spec connects through
 * the connector exactly as production builds it (AuthParser on save, registry `createConnector`, `KnexPGClient`,
 * node-postgres) to a server that refuses plaintext and has a user who must present a client certificate, and proves:
 *
 *   1. The modes mean what they say. A string with no sslmode is encrypted. `verify-ca` checks the chain against the
 *      pasted CA but not the host name: it passes by IP address against a certificate that names only `localhost`,
 *      which is the Cloud SQL case. `verify-full` checks the host name too, by IP address as well as by name.
 *      `require` with a CA checks the chain. A wrong CA, or none, fails verification.
 *   2. Client certificates work: the certificate user is refused without one and with an untrusted one, and connects
 *      with the trusted one.
 *   3. Pastes as a single-line form field sends them are repaired on save, and a key that doesn't match its
 *      certificate is refused on save.
 *   4. Every failure becomes a readable message with no server or OpenSSL text, address or certificate text.
 *
 * Opt-in. Start the local TLS server first (from server/localdev):
 *   ./postgres-tls/generate-tls-certs.sh
 *   docker compose -f docker-compose.postgres-tls.yml up -d --wait
 * Then:
 *   cd server && POSTGRES_TLS_TEST_URL=postgres://scratch_tls_password_user:scratch-tls-test@localhost:5452/scratch_tls_test \
 *     yarn test:integration test/integration/postgres-tls
 * POSTGRES_TLS_TEST_CERTIFICATES_DIRECTORY overrides where the certificates are read from (default:
 * server/localdev/postgres-tls/certs). Without POSTGRES_TLS_TEST_URL the suite is skipped.
 */
import { type DecryptedCredentials } from '@spinner/shared-types';
import fs from 'fs';
import path from 'path';
import { connectorRegistry } from 'src/remote-service/connectors/connector-registry';
import { ConnectorAuthError } from 'src/remote-service/connectors/error';
import 'src/remote-service/connectors/library';
import {
  buildPostgresClientCertificateRefusedMessage,
  buildPostgresClientCertificateRequiredMessage,
  buildPostgresServerCertificateHostNameMismatchMessage,
  buildPostgresServerCertificateNotTrustedMessage,
  POSTGRES_SERVER_REQUIRES_TLS_MESSAGE,
} from 'src/remote-service/connectors/library/pg-common';
import { Service } from 'src/remote-service/connectors/service-constants';
import { SCRATCH_PRODUCTION_EGRESS_IP_ADDRESS } from 'src/remote-service/connectors/utils/scratch-egress-ip-address';

jest.setTimeout(60_000);

// Blank counts as unset: .env.integration.example ships `POSTGRES_TLS_TEST_URL=`.
const trimmedPostgresTlsTestUrl = process.env.POSTGRES_TLS_TEST_URL?.trim();
const postgresTlsTestUrl = trimmedPostgresTlsTestUrl ? trimmedPostgresTlsTestUrl : undefined;
const certificatesDirectory =
  process.env.POSTGRES_TLS_TEST_CERTIFICATES_DIRECTORY ?? path.join(__dirname, '../../localdev/postgres-tls/certs');
const CERTIFICATE_USER = 'scratch_tls_cert_user';
const postgresFormWording = { connectionFormHasCertificateFields: true };

function readTestPem(fileName: string): string {
  return fs.readFileSync(path.join(certificatesDirectory, fileName), 'utf8');
}

/** How a single-line form field sends a pasted PEM: newlines become spaces. */
function asOneLinePaste(pemText: string): string {
  return pemText.replace(/\r?\n/g, ' ');
}

/** The test URL with its host, sslmode and (optionally) user replaced. */
function buildTestConnectionString(options: { host: string; sslMode?: string; user?: string }): string {
  if (postgresTlsTestUrl === undefined) throw new Error('POSTGRES_TLS_TEST_URL is not set');
  const connectionStringUrl = new URL(postgresTlsTestUrl);
  connectionStringUrl.hostname = options.host;
  connectionStringUrl.searchParams.delete('sslmode');
  if (options.sslMode !== undefined) connectionStringUrl.searchParams.set('sslmode', options.sslMode);
  if (options.user !== undefined) connectionStringUrl.username = options.user;
  return connectionStringUrl.toString();
}

/** The production path: the AuthParser on save, then the registry's `createConnector`, then `testConnection`. */
async function saveAndTestConnection(userProvidedParams: Record<string, string>): Promise<void> {
  const postgresRegistration = connectorRegistry.get(Service.POSTGRES);
  const createAuthParser = postgresRegistration?.createAuthParser;
  if (!postgresRegistration || !createAuthParser) throw new Error('The Postgres connector is not registered');
  const { credentials } = await createAuthParser().parseUserProvidedParams({ userProvidedParams });
  const connector = await postgresRegistration.createConnector({
    connectorAccount: { id: 'coa_postgres_tls_test', authType: 'USER_PROVIDED_PARAMS', extras: null, version: 1 },
    decryptedCredentials: credentials as DecryptedCredentials,
    createOAuthAccessTokenProvider: () => {
      throw new Error('Postgres never uses OAuth');
    },
    createRateLimiter: () => undefined,
    getFolderOptionsByTableId: () => Promise.resolve(null),
    listFolderTableIds: () => Promise.resolve([]),
    isFeatureEnabled: () => Promise.resolve(false),
  });
  try {
    await connector.testConnection();
  } catch (error) {
    // What the connection service shows the user.
    const userFacingError = new Error(connector.extractConnectorErrorDetails(error).userFriendlyMessage);
    throw Object.assign(userFacingError, { rawError: error });
  }
}

async function userFacingFailureOf(userProvidedParams: Record<string, string>): Promise<string> {
  try {
    await saveAndTestConnection(userProvidedParams);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expectNoServerOrCertificateTextIn(message);
    return message;
  }
  throw new Error('Expected the connection to fail, but it connected');
}

function expectNoServerOrCertificateTextIn(message: string): void {
  const messageWithoutPublishedEgressAddress = message.replaceAll(SCRATCH_PRODUCTION_EGRESS_IP_ADDRESS, '');
  expect(messageWithoutPublishedEgressAddress).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  expect(message).not.toMatch(/pg_hba|SSL routines|self-signed|altnames|scratch_tls_|BEGIN|-----/);
}

const describeWhenConfigured = postgresTlsTestUrl === undefined ? describe.skip : describe;

describeWhenConfigured('Postgres connector TLS against a Postgres that requires it', () => {
  // Read in beforeAll, not at describe time: Jest runs a skipped describe's body too, and the certificates directory
  // only exists once generate-tls-certs.sh has run.
  let serverCaPem: string;
  beforeAll(() => {
    serverCaPem = readTestPem('ca.pem');
  });

  describe('sslmode', () => {
    it('encrypts a connection string that sets no sslmode', async () => {
      await expect(
        saveAndTestConnection({ connectionString: buildTestConnectionString({ host: '127.0.0.1' }) }),
      ).resolves.toBeUndefined();
    });

    it('fails sslmode=disable against a server that only accepts encryption, saying so', async () => {
      expect(
        await userFacingFailureOf({
          connectionString: buildTestConnectionString({ host: '127.0.0.1', sslMode: 'disable' }),
        }),
      ).toBe(POSTGRES_SERVER_REQUIRES_TLS_MESSAGE);
    });

    it("passes verify-ca by IP address, checking the chain but not the certificate's names (the Cloud SQL case)", async () => {
      await expect(
        saveAndTestConnection({
          connectionString: buildTestConnectionString({ host: '127.0.0.1', sslMode: 'verify-ca' }),
          sslCaCertificate: asOneLinePaste(serverCaPem),
        }),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['verify-ca with the wrong CA', 'verify-ca', 'wrong-ca.pem'],
      ['verify-ca with no CA (the test CA is not a public one)', 'verify-ca', undefined],
      ['require with the wrong CA, which then checks the chain', 'require', 'wrong-ca.pem'],
    ])('fails %s, saying the certificate could not be verified', async (_description, sslMode, caPemFileName) => {
      expect(
        await userFacingFailureOf({
          connectionString: buildTestConnectionString({ host: '127.0.0.1', sslMode }),
          ...(caPemFileName !== undefined ? { sslCaCertificate: readTestPem(caPemFileName) } : {}),
        }),
      ).toBe(buildPostgresServerCertificateNotTrustedMessage(postgresFormWording));
    });

    it('passes verify-full for the host name the certificate names', async () => {
      await expect(
        saveAndTestConnection({
          connectionString: buildTestConnectionString({ host: 'localhost', sslMode: 'verify-full' }),
          sslCaCertificate: serverCaPem,
        }),
      ).resolves.toBeUndefined();
    });

    it('fails verify-full by an IP address the certificate does not name, which Node alone would let through', async () => {
      expect(
        await userFacingFailureOf({
          connectionString: buildTestConnectionString({ host: '127.0.0.1', sslMode: 'verify-full' }),
          sslCaCertificate: serverCaPem,
        }),
      ).toBe(buildPostgresServerCertificateHostNameMismatchMessage());
    });
  });

  describe('client certificates', () => {
    let clientCertificatePem: string;
    let clientKeyPem: string;
    beforeAll(() => {
      clientCertificatePem = readTestPem('client-cert.pem');
      clientKeyPem = readTestPem('client-key.pem');
    });

    it('connects as the certificate user with the trusted client certificate and key, pasted on one line', async () => {
      await expect(
        saveAndTestConnection({
          connectionString: buildTestConnectionString({
            host: '127.0.0.1',
            sslMode: 'verify-ca',
            user: CERTIFICATE_USER,
          }),
          sslCaCertificate: asOneLinePaste(serverCaPem),
          sslClientCertificate: asOneLinePaste(clientCertificatePem),
          sslClientKey: asOneLinePaste(clientKeyPem),
        }),
      ).resolves.toBeUndefined();
    });

    it('fails without a client certificate, saying one is required', async () => {
      expect(
        await userFacingFailureOf({
          connectionString: buildTestConnectionString({ host: '127.0.0.1', user: CERTIFICATE_USER }),
        }),
      ).toBe(buildPostgresClientCertificateRequiredMessage(postgresFormWording));
    });

    it('fails with a client certificate the server does not trust, saying so', async () => {
      expect(
        await userFacingFailureOf({
          connectionString: buildTestConnectionString({ host: '127.0.0.1', user: CERTIFICATE_USER }),
          sslClientCertificate: readTestPem('untrusted-client-cert.pem'),
          sslClientKey: readTestPem('untrusted-client-key.pem'),
        }),
      ).toBe(buildPostgresClientCertificateRefusedMessage(postgresFormWording));
    });

    it("refuses on save a key that doesn't belong to the client certificate", async () => {
      const error: unknown = await saveAndTestConnection({
        connectionString: buildTestConnectionString({ host: '127.0.0.1', user: CERTIFICATE_USER }),
        sslClientCertificate: clientCertificatePem,
        sslClientKey: readTestPem('untrusted-client-key.pem'),
      }).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(ConnectorAuthError);
      expect((error as ConnectorAuthError).userFriendlyMessage).toContain("doesn't belong to Client certificate");
      expectNoServerOrCertificateTextIn((error as ConnectorAuthError).userFriendlyMessage);
    });
  });
});
