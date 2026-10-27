/**
 * The shared PEM normalizers. The certificate-bundle cases MySQL relies on are covered through its wrapper in
 * `library/mysql/__tests__/mysql-ca-certificate-bundle.spec.ts`; these cover the private-key normalizer, the
 * caller-supplied field names in messages, and splitting a canonical bundle.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import {
  normalizePemCertificateBundle,
  normalizePemPrivateKey,
  PEM_PRIVATE_KEY_MAX_LENGTH,
  PemInputError,
  PemInputProblem,
  splitCanonicalPemCertificateBundle,
} from '../pem-certificates-and-keys';
import { buildTestCertificate } from './test-certificates';

const clientCertificateWording = {
  fieldLabel: 'Client certificate',
  expectedCertificate: 'the client certificate',
  expectedBundle: 'the client certificate (and any intermediate certificates)',
};

function capturePemInputError(normalize: () => unknown): PemInputError {
  try {
    normalize();
  } catch (error) {
    if (error instanceof PemInputError) return error;
    throw error;
  }
  throw new Error('Expected a PemInputError, but normalizing succeeded');
}

function collapseToOneLineLikeABrowserPaste(pemText: string): string {
  return pemText.replace(/\r?\n/g, ' ');
}

describe('buildTestCertificate (test helper)', () => {
  it.each(['ec', 'rsa'] as const)('builds a %s certificate Node can read, which matches its key', (keyType) => {
    const testCertificate = buildTestCertificate({ keyType, commonName: 'helper-check' });
    const certificate = new X509Certificate(testCertificate.certificatePem);

    expect(certificate.subject).toContain('CN=helper-check');
    expect(certificate.checkPrivateKey(createPrivateKey(testCertificate.privateKeyPem))).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
  });

  it('signs with the issuer, so the issuer verifies it', () => {
    const issuer = buildTestCertificate({ commonName: 'test-ca' });
    const issuedCertificate = new X509Certificate(buildTestCertificate({ issuer }).certificatePem);

    expect(issuedCertificate.issuer).toContain('CN=test-ca');
    expect(issuedCertificate.verify(new X509Certificate(issuer.certificatePem).publicKey)).toBe(true);
  });
});

describe('normalizePemPrivateKey', () => {
  const ecTestCertificate = buildTestCertificate({ keyType: 'ec' });
  const rsaTestCertificate = buildTestCertificate({ keyType: 'rsa' });

  it.each([
    ['a PKCS#8 EC key', ecTestCertificate.privateKeyPem, 'PRIVATE KEY'],
    ['a PKCS#8 RSA key', rsaTestCertificate.privateKeyPem, 'PRIVATE KEY'],
    ['a traditional RSA key', rsaTestCertificate.traditionalPrivateKeyPem, 'RSA PRIVATE KEY'],
    ['a traditional EC key', ecTestCertificate.traditionalPrivateKeyPem, 'EC PRIVATE KEY'],
  ])('keeps %s, re-wrapped, with its label', (_description, privateKeyPem, expectedPemLabel) => {
    const canonicalPrivateKeyPem = normalizePemPrivateKey(privateKeyPem, 'Client private key');

    expect(canonicalPrivateKeyPem.startsWith(`-----BEGIN ${expectedPemLabel}-----\n`)).toBe(true);
    expect(canonicalPrivateKeyPem.endsWith(`-----END ${expectedPemLabel}-----\n`)).toBe(true);
    for (const bodyLine of canonicalPrivateKeyPem.split('\n').slice(1, -3)) expect(bodyLine).toHaveLength(64);
    expect(
      createPrivateKey(canonicalPrivateKeyPem)
        .export({ type: 'pkcs8', format: 'der' })
        .equals(createPrivateKey(privateKeyPem).export({ type: 'pkcs8', format: 'der' })),
    ).toBe(true);
    expect(normalizePemPrivateKey(canonicalPrivateKeyPem, 'Client private key')).toBe(canonicalPrivateKeyPem);
  });

  it.each([
    ['newlines turned into spaces', collapseToOneLineLikeABrowserPaste(rsaTestCertificate.privateKeyPem)],
    ['newlines removed', rsaTestCertificate.privateKeyPem.replace(/\n/g, '')],
    ['literal \\n escapes', rsaTestCertificate.privateKeyPem.replace(/\n/g, '\\n')],
    ['Windows line breaks', rsaTestCertificate.privateKeyPem.replace(/\n/g, '\r\n')],
    ['the certificate pasted along with it', `${rsaTestCertificate.certificatePem}${rsaTestCertificate.privateKeyPem}`],
  ])('repairs a paste with %s', (_description, mangledPrivateKeyPem) => {
    expect(normalizePemPrivateKey(mangledPrivateKeyPem, 'Client private key')).toBe(
      normalizePemPrivateKey(rsaTestCertificate.privateKeyPem, 'Client private key'),
    );
  });

  it.each([
    [
      'a passphrase-encrypted PKCS#8 key',
      ecTestCertificate.privateKey
        .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'secret' })
        .toString(),
      PemInputProblem.PrivateKeyEncrypted,
    ],
    [
      'a passphrase-encrypted traditional key',
      rsaTestCertificate.privateKey
        .export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'secret' })
        .toString(),
      PemInputProblem.PrivateKeyEncrypted,
    ],
    ['a certificate', ecTestCertificate.certificatePem, PemInputProblem.PrivateKeyFieldHoldsCertificate],
    ['text with no PEM block', 'not a key', PemInputProblem.PrivateKeyNotFound],
    [
      'two keys',
      `${ecTestCertificate.privateKeyPem}${rsaTestCertificate.privateKeyPem}`,
      PemInputProblem.MoreThanOnePrivateKey,
    ],
    [
      'a key block that is not base64',
      '-----BEGIN PRIVATE KEY-----\nnot*base64\n-----END PRIVATE KEY-----\n',
      PemInputProblem.PrivateKeyMalformed,
    ],
    [
      'base64 that is not a key',
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
      PemInputProblem.PrivateKeyMalformed,
    ],
    ['an oversized paste', 'A'.repeat(PEM_PRIVATE_KEY_MAX_LENGTH + 1), PemInputProblem.TooLarge],
  ])('refuses %s, naming the field but never the text', (_description, rawPemText, expectedProblem) => {
    const pemInputError = capturePemInputError(() => normalizePemPrivateKey(rawPemText, 'Client private key'));

    expect(pemInputError.problem).toBe(expectedProblem);
    expect(pemInputError.message).toContain('Client private key');
    const firstBodyLine = rawPemText.split('\n')[1];
    if (firstBodyLine && firstBodyLine.length > 8) expect(pemInputError.message).not.toContain(firstBodyLine);
  });
});

describe('normalizePemCertificateBundle with caller-supplied wording', () => {
  it('names the field and what belongs in it', () => {
    const { privateKeyPem } = buildTestCertificate();
    const pemInputError = capturePemInputError(() =>
      normalizePemCertificateBundle(privateKeyPem, clientCertificateWording),
    );

    expect(pemInputError.problem).toBe(PemInputProblem.CertificateFieldHoldsPrivateKey);
    expect(pemInputError.message).toBe(
      'Client certificate contains a private key. Paste only the client certificate (-----BEGIN CERTIFICATE-----), never a private key.',
    );
  });

  it('refuses text with no certificate, naming the field', () => {
    const pemInputError = capturePemInputError(() =>
      normalizePemCertificateBundle('nothing', clientCertificateWording),
    );

    expect(pemInputError.problem).toBe(PemInputProblem.CertificateNotFound);
    expect(pemInputError.message).toContain('Client certificate has no certificate in it.');
  });
});

describe('splitCanonicalPemCertificateBundle', () => {
  it('returns each certificate of a canonical bundle, in order', () => {
    const firstCertificate = buildTestCertificate({ commonName: 'first' });
    const secondCertificate = buildTestCertificate({ commonName: 'second' });
    const canonicalBundle = normalizePemCertificateBundle(
      collapseToOneLineLikeABrowserPaste(`${firstCertificate.certificatePem}${secondCertificate.certificatePem}`),
      clientCertificateWording,
    );

    const splitCertificates = splitCanonicalPemCertificateBundle(canonicalBundle);

    expect(splitCertificates.join('')).toBe(canonicalBundle);
    expect(splitCertificates.map((certificatePem) => new X509Certificate(certificatePem).subject)).toEqual([
      'CN=first',
      'CN=second',
    ]);
  });
});
