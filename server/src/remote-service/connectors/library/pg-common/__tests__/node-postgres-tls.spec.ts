import { type PeerCertificate } from 'node:tls';
import { buildTestCertificate } from '../../../utils/__tests__/test-certificates';
import {
  preparePostgresTlsSettings,
  type PostgresTlsCertificates,
  type PostgresTlsMode,
  type PostgresTlsSettingsPreparation,
} from '../node-postgres-tls';

const serverCa = buildTestCertificate({ commonName: 'test-server-ca' });
const clientCa = buildTestCertificate({ commonName: 'test-client-ca' });
const clientCertificate = buildTestCertificate({ commonName: 'test-client', issuer: clientCa });
const otherClientCertificate = buildTestCertificate({ commonName: 'other-client', issuer: clientCa });

function expectAccepted(preparation: PostgresTlsSettingsPreparation) {
  if (!preparation.accepted)
    throw new Error(`Expected the TLS settings to be accepted, got: ${preparation.userFacingReason}`);
  return preparation;
}

function expectRefused(preparation: PostgresTlsSettingsPreparation): string {
  if (preparation.accepted) throw new Error('Expected the TLS settings to be refused');
  return preparation.userFacingReason;
}

function prepare(tlsMode: PostgresTlsMode, certificates: PostgresTlsCertificates = {}, serverHost = 'db.example.com') {
  return preparePostgresTlsSettings({ tlsMode, serverHost, certificates });
}

/** The subset of a peer certificate `tls.checkServerIdentity` reads. */
function peerCertificateNaming(subjectAlternativeNames: string): PeerCertificate {
  return { subject: { CN: 'localhost' }, subjectaltname: subjectAlternativeNames } as unknown as PeerCertificate;
}

describe('preparePostgresTlsSettings', () => {
  describe("node-postgres's ssl option for each mode", () => {
    it('turns TLS off for disable', () => {
      expect(expectAccepted(prepare('disable')).nodePostgresSslOption).toBe(false);
    });

    it('encrypts without checking for require', () => {
      expect(expectAccepted(prepare('require')).nodePostgresSslOption).toEqual({ rejectUnauthorized: false });
    });

    it('checks the chain, but not the host name, for require with a server CA certificate (as libpq does)', () => {
      const sslOption = expectAccepted(
        prepare('require', { sslCaCertificate: serverCa.certificatePem }),
      ).nodePostgresSslOption;
      if (sslOption === false) throw new Error('Expected TLS to be on');

      expect(sslOption.rejectUnauthorized).toBe(true);
      expect(sslOption.ca).toBe(serverCa.certificatePem);
      expect(sslOption.checkServerIdentity?.('anything', peerCertificateNaming('DNS:elsewhere'))).toBeUndefined();
    });

    it.each<[string, PostgresTlsCertificates]>([
      ['with', { sslCaCertificate: serverCa.certificatePem }],
      ['without', {}],
    ])('checks the chain %s a server CA certificate, but not the host name, for verify-ca', (_with, certificates) => {
      const sslOption = expectAccepted(prepare('verify-ca', certificates)).nodePostgresSslOption;
      if (sslOption === false) throw new Error('Expected TLS to be on');

      expect(sslOption.rejectUnauthorized).toBe(true);
      expect(sslOption.ca).toBe(certificates.sslCaCertificate);
      expect(sslOption.checkServerIdentity?.('anything', peerCertificateNaming('DNS:elsewhere'))).toBeUndefined();
    });

    it("checks the host name for verify-full against the connection string's host, IP addresses included", () => {
      const sslOptionFor = (serverHost: string) => {
        const sslOption = expectAccepted(
          prepare('verify-full', { sslCaCertificate: serverCa.certificatePem }, serverHost),
        ).nodePostgresSslOption;
        if (sslOption === false) throw new Error('Expected TLS to be on');
        return sslOption;
      };
      const certificateNamingOnlyLocalhost = peerCertificateNaming('DNS:localhost');

      // Node itself would check an IP address host against "localhost" here, which this certificate names.
      expect(
        sslOptionFor('127.0.0.1').checkServerIdentity?.('localhost', certificateNamingOnlyLocalhost)?.message,
      ).toContain("IP: 127.0.0.1 is not in the cert's list");
      expect(
        sslOptionFor('localhost').checkServerIdentity?.('localhost', certificateNamingOnlyLocalhost),
      ).toBeUndefined();
      expect(
        sslOptionFor('[2001:db8::1]').checkServerIdentity?.(
          'localhost',
          peerCertificateNaming('IP Address:2001:DB8:0:0:0:0:0:1'),
        ),
      ).toBeUndefined();
      expect(sslOptionFor('127.0.0.1').rejectUnauthorized).toBe(true);
      expect(sslOptionFor('127.0.0.1').ca).toBe(serverCa.certificatePem);
    });

    it.each(['require', 'verify-ca', 'verify-full'] as const)(
      'sends the client certificate and key for %s',
      (tlsMode) => {
        const sslOption = expectAccepted(
          prepare(tlsMode, {
            sslClientCertificate: clientCertificate.certificatePem,
            sslClientKey: clientCertificate.privateKeyPem,
          }),
        ).nodePostgresSslOption;
        if (sslOption === false) throw new Error('Expected TLS to be on');

        expect(sslOption.cert).toContain('-----BEGIN CERTIFICATE-----');
        expect(sslOption.key).toContain('-----BEGIN PRIVATE KEY-----');
      },
    );
  });

  it('returns the certificates in canonical PEM, and leaves absent or blank ones out', () => {
    const preparation = expectAccepted(
      prepare('verify-ca', {
        sslCaCertificate: serverCa.certificatePem.replace(/\n/g, ' '),
        sslClientCertificate: '   ',
      }),
    );

    expect(preparation.canonicalCertificates).toEqual({ sslCaCertificate: serverCa.certificatePem });
  });

  it('accepts a client certificate followed by its intermediate, checking the key against the first one', () => {
    expectAccepted(
      prepare('require', {
        sslClientCertificate: `${clientCertificate.certificatePem}${clientCa.certificatePem}`,
        sslClientKey: clientCertificate.traditionalPrivateKeyPem,
      }),
    );
  });

  describe('refuses', () => {
    it.each([
      ['a client certificate without its key', { sslClientCertificate: clientCertificate.certificatePem }],
      ['a client key without its certificate', { sslClientKey: clientCertificate.privateKeyPem }],
    ])('%s', (_description, certificates) => {
      expect(expectRefused(prepare('require', certificates))).toBe(
        'Client certificate and Client private key go together: paste both, or neither.',
      );
    });

    it("a key that doesn't belong to the client certificate", () => {
      expect(
        expectRefused(
          prepare('require', {
            sslClientCertificate: clientCertificate.certificatePem,
            sslClientKey: otherClientCertificate.privateKeyPem,
          }),
        ),
      ).toBe(
        "Client private key doesn't belong to Client certificate. Paste the key that was created with the certificate.",
      );
    });

    it('an expired client certificate', () => {
      const expiredClientCertificate = buildTestCertificate({
        issuer: clientCa,
        validFrom: new Date('2020-01-01T00:00:00Z'),
        validTo: new Date('2021-06-30T00:00:00Z'),
      });

      expect(
        expectRefused(
          prepare('require', {
            sslClientCertificate: expiredClientCertificate.certificatePem,
            sslClientKey: expiredClientCertificate.privateKeyPem,
          }),
        ),
      ).toBe('Client certificate expired on 2021-06-30. Create a new client certificate and paste it with its key.');
    });

    it('certificates with sslmode=disable', () => {
      expect(expectRefused(prepare('disable', { sslCaCertificate: serverCa.certificatePem }))).toContain(
        'Certificates need an encrypted connection.',
      );
    });

    it('a private key pasted as the server CA certificate, naming the field and never the key', () => {
      const refusal = expectRefused(prepare('verify-ca', { sslCaCertificate: clientCertificate.privateKeyPem }));

      expect(refusal).toContain('Server CA certificate contains a private key.');
      expect(refusal).not.toContain(clientCertificate.privateKeyPem.split('\n')[1]);
    });

    it('a certificate pasted as the client key', () => {
      expect(
        expectRefused(
          prepare('require', {
            sslClientCertificate: clientCertificate.certificatePem,
            sslClientKey: clientCertificate.certificatePem,
          }),
        ),
      ).toContain('Client private key holds a certificate, not a private key.');
    });
  });
});
