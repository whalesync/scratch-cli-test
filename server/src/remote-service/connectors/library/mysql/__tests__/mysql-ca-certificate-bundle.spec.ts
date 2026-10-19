import awsSslProfiles from 'aws-ssl-profiles';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import {
  MYSQL_CA_CERTIFICATE_BUNDLE_MAX_CERTIFICATES,
  MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH,
  normalizeMySqlCaCertificateBundlePem,
} from '../mysql-ca-certificate-bundle';
import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from '../mysql-credential-errors';

// Real certificates from Node's own root store and the Amazon RDS bundle, so no fixture has to be committed.
// Node's roots use 72-character body lines, so comparisons go by fingerprint, not by text.
const firstThreeNodeRootCertificatePems = tls.rootCertificates.slice(0, 3);
const firstNodeRootCertificatePem = firstThreeNodeRootCertificatePems[0];

function fingerprintsOfPemCertificates(pemCertificates: readonly string[]): string[] {
  return pemCertificates.map((pemCertificate) => new X509Certificate(pemCertificate).fingerprint256);
}

function splitCanonicalPemBundle(canonicalPemBundle: string): string[] {
  return canonicalPemBundle.match(/-----BEGIN CERTIFICATE-----\n[\s\S]*?\n-----END CERTIFICATE-----\n/g) ?? [];
}

function captureMySqlCredentialsInvalidError(parse: () => unknown): MySqlCredentialsInvalidError {
  try {
    parse();
  } catch (error) {
    if (error instanceof MySqlCredentialsInvalidError) return error;
    throw error;
  }
  throw new Error('Expected a MySqlCredentialsInvalidError, but normalizing succeeded');
}

function expectCanonicalBundleOf(normalizedPemBundle: string, expectedPemCertificates: readonly string[]): void {
  const canonicalBlocks = splitCanonicalPemBundle(normalizedPemBundle);
  expect(canonicalBlocks.join('')).toBe(normalizedPemBundle);
  expect(fingerprintsOfPemCertificates(canonicalBlocks)).toEqual(
    fingerprintsOfPemCertificates(expectedPemCertificates),
  );
  for (const canonicalBlock of canonicalBlocks) {
    const bodyLines = canonicalBlock.split('\n').slice(1, -2);
    expect(bodyLines.length).toBeGreaterThan(0);
    for (const bodyLine of bodyLines.slice(0, -1)) expect(bodyLine).toHaveLength(64);
    expect(bodyLines[bodyLines.length - 1].length).toBeLessThanOrEqual(64);
  }
}

describe('normalizeMySqlCaCertificateBundlePem', () => {
  describe('accepted paste shapes', () => {
    const threeCertificateBundle = firstThreeNodeRootCertificatePems.join('\n');

    it.each<[string, string, readonly string[]]>([
      ['a multi-line PEM', firstNodeRootCertificatePem, [firstNodeRootCertificatePem]],
      ['a newline-stripped single line', firstNodeRootCertificatePem.replace(/\n/g, ''), [firstNodeRootCertificatePem]],
      ['spaces instead of newlines', firstNodeRootCertificatePem.replace(/\n/g, ' '), [firstNodeRootCertificatePem]],
      [
        'JSON-escaped literal \\n sequences',
        firstNodeRootCertificatePem.replace(/\n/g, '\\n'),
        [firstNodeRootCertificatePem],
      ],
      [
        'JSON-escaped literal \\r\\n sequences',
        firstNodeRootCertificatePem.replace(/\n/g, '\\r\\n'),
        [firstNodeRootCertificatePem],
      ],
      ['CRLF line endings', firstNodeRootCertificatePem.replace(/\n/g, '\r\n'), [firstNodeRootCertificatePem]],
      ['a three-certificate bundle', threeCertificateBundle, firstThreeNodeRootCertificatePems],
      [
        'a three-certificate bundle pasted as one line (END and BEGIN markers adjacent)',
        threeCertificateBundle.replace(/\n/g, ''),
        firstThreeNodeRootCertificatePems,
      ],
      [
        'leading and trailing junk and Bag Attributes',
        `Bag Attributes\n    friendlyName: My CA\nsubject=/CN=My CA\n${firstThreeNodeRootCertificatePems[0]}\n# comment between blocks\n${firstThreeNodeRootCertificatePems[1]}\ntrailing text`,
        firstThreeNodeRootCertificatePems.slice(0, 2),
      ],
    ])('%s', (_description, rawCaCertificate, expectedPemCertificates) => {
      expectCanonicalBundleOf(normalizeMySqlCaCertificateBundlePem(rawCaCertificate), expectedPemCertificates);
    });

    it('re-wraps a single-line paste of the real Amazon RDS multi-certificate bundle', () => {
      const amazonRdsCaBundle = awsSslProfiles.ca.join('\n');
      expect(amazonRdsCaBundle.length).toBeLessThan(MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH);
      const singleLineAmazonRdsCaBundle = amazonRdsCaBundle.replace(/\r?\n/g, '');

      const normalizedPemBundle = normalizeMySqlCaCertificateBundlePem(singleLineAmazonRdsCaBundle);

      expectCanonicalBundleOf(normalizedPemBundle, awsSslProfiles.ca);
      expect(splitCanonicalPemBundle(normalizedPemBundle)).toHaveLength(awsSslProfiles.ca.length);
    });

    it('re-wraps a single-line paste of 20 real root certificates', () => {
      const twentyRootCertificatePems = tls.rootCertificates.slice(0, 20);
      const normalizedPemBundle = normalizeMySqlCaCertificateBundlePem(
        twentyRootCertificatePems.join('').replace(/\n/g, ''),
      );
      expectCanonicalBundleOf(normalizedPemBundle, twentyRootCertificatePems);
    });

    it('is idempotent', () => {
      const normalizedOnce = normalizeMySqlCaCertificateBundlePem(
        firstThreeNodeRootCertificatePems.join('').replace(/\n/g, ' '),
      );
      expect(normalizeMySqlCaCertificateBundlePem(normalizedOnce)).toBe(normalizedOnce);
    });

    it('produces the exact canonical layout', () => {
      const normalizedPemBundle = normalizeMySqlCaCertificateBundlePem(firstNodeRootCertificatePem);
      expect(normalizedPemBundle.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
      expect(normalizedPemBundle.endsWith('\n-----END CERTIFICATE-----\n')).toBe(true);
      expect(normalizedPemBundle).not.toContain('\r');
    });
  });

  describe('rejections', () => {
    it('rejects a private key without echoing it', () => {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const privateKeyBodyLine = privateKeyPem.split('\n')[1];

      for (const rawCaCertificate of [privateKeyPem, `${firstNodeRootCertificatePem}\n${privateKeyPem}`]) {
        const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
          normalizeMySqlCaCertificateBundlePem(rawCaCertificate),
        );
        expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.CaCertificateIsPrivateKey);
        expect(credentialsInvalidError.message).not.toContain(privateKeyBodyLine);
      }
    });

    it.each([
      '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----',
    ])('rejects the private-key block %#', (rawCaCertificate) => {
      expect(
        captureMySqlCredentialsInvalidError(() => normalizeMySqlCaCertificateBundlePem(rawCaCertificate)).problem,
      ).toBe(MySqlCredentialProblem.CaCertificateIsPrivateKey);
    });

    it.each([
      '-----BEGIN PKCS7-----\nMIIB\n-----END PKCS7-----',
      '-----BEGIN TRUSTED CERTIFICATE-----\nMIIB\n-----END TRUSTED CERTIFICATE-----',
    ])('rejects the unsupported container %#', (rawCaCertificate) => {
      expect(
        captureMySqlCredentialsInvalidError(() => normalizeMySqlCaCertificateBundlePem(rawCaCertificate)).problem,
      ).toBe(MySqlCredentialProblem.CaCertificateFormatUnsupported);
    });

    it.each(['', 'not a certificate', firstNodeRootCertificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')])(
      'rejects text without certificate markers %#',
      (rawCaCertificate) => {
        expect(
          captureMySqlCredentialsInvalidError(() => normalizeMySqlCaCertificateBundlePem(rawCaCertificate)).problem,
        ).toBe(MySqlCredentialProblem.CaCertificateNotFound);
      },
    );

    it('rejects a bad base64 character, naming the certificate position', () => {
      const secondCertificateWithBadCharacter = firstThreeNodeRootCertificatePems[1].replace(
        /\n([A-Za-z0-9+/]{10})/,
        '\n*$1',
      );
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        normalizeMySqlCaCertificateBundlePem(
          `${firstThreeNodeRootCertificatePems[0]}${secondCertificateWithBadCharacter}`,
        ),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.CaCertificateMalformed);
      expect(credentialsInvalidError.message).toContain('#2');
    });

    it('rejects a body whose length is not a multiple of 4', () => {
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        normalizeMySqlCaCertificateBundlePem('-----BEGIN CERTIFICATE-----\nAAAAA\n-----END CERTIFICATE-----'),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.CaCertificateMalformed);
      expect(credentialsInvalidError.message).toContain('#1');
    });

    it('rejects valid base64 that is not an X.509 certificate, naming the certificate position', () => {
      const notACertificatePem = `-----BEGIN CERTIFICATE-----\n${Buffer.from('definitely not DER').toString('base64')}\n-----END CERTIFICATE-----\n`;
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        normalizeMySqlCaCertificateBundlePem(
          `${firstNodeRootCertificatePem}${firstNodeRootCertificatePem}${notACertificatePem}`,
        ),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.CaCertificateMalformed);
      expect(credentialsInvalidError.message).toContain('#3');
    });

    it(`rejects more than ${MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH} characters`, () => {
      expect(
        captureMySqlCredentialsInvalidError(() =>
          normalizeMySqlCaCertificateBundlePem(
            `${firstNodeRootCertificatePem}${' '.repeat(MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH)}`,
          ),
        ).problem,
      ).toBe(MySqlCredentialProblem.CaCertificateTooLarge);
    });

    it(`rejects more than ${MYSQL_CA_CERTIFICATE_BUNDLE_MAX_CERTIFICATES} certificates`, () => {
      const tinyCertificateBlock = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
      expect(
        captureMySqlCredentialsInvalidError(() =>
          normalizeMySqlCaCertificateBundlePem(
            tinyCertificateBlock.repeat(MYSQL_CA_CERTIFICATE_BUNDLE_MAX_CERTIFICATES + 1),
          ),
        ).problem,
      ).toBe(MySqlCredentialProblem.CaCertificateTooLarge);
    });

    it('ignores a trailing BEGIN marker that has no END marker after it', () => {
      const bundleWithDanglingBeginMarker = `${firstThreeNodeRootCertificatePems.slice(0, 2).join('')}-----BEGIN CERTIFICATE-----\nMIIB`;
      expectCanonicalBundleOf(
        normalizeMySqlCaCertificateBundlePem(bundleWithDanglingBeginMarker),
        firstThreeNodeRootCertificatePems.slice(0, 2),
      );
    });

    it('ignores an END marker that comes before any BEGIN marker', () => {
      expectCanonicalBundleOf(
        normalizeMySqlCaCertificateBundlePem(`-----END CERTIFICATE-----\n${firstNodeRootCertificatePem}`),
        [firstNodeRootCertificatePem],
      );
    });

    it('reads a second BEGIN marker before the first END marker as part of the first block (malformed #1)', () => {
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        normalizeMySqlCaCertificateBundlePem(`-----BEGIN CERTIFICATE-----\nMIIB\n${firstNodeRootCertificatePem}`),
      );
      expect(credentialsInvalidError.problem).toBe(MySqlCredentialProblem.CaCertificateMalformed);
      expect(credentialsInvalidError.message).toContain('#1');
    });

    it('never puts certificate contents into a message', () => {
      const bodyLineOfSecondCertificate = firstThreeNodeRootCertificatePems[1].split('\n')[2];
      const brokenBundle = `${firstThreeNodeRootCertificatePems[0]}${firstThreeNodeRootCertificatePems[1].replace(/\n([A-Za-z0-9+/]{10})/, '\n!$1')}`;
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        normalizeMySqlCaCertificateBundlePem(brokenBundle),
      );
      expect(credentialsInvalidError.message).not.toContain(bodyLineOfSecondCertificate);
    });
  });

  // The normalizer runs synchronously on the API request (and on every connect for a stored value), so hostile
  // input at the size cap must be rejected in linear time. The old lazy-regex scan took ~4 s on the first payload.
  describe('adversarial input at the size cap is rejected without blocking the event loop', () => {
    const maximumRejectionMilliseconds = 100;

    function fillToCaCertificateSizeCap(repeatedUnit: string): string {
      return repeatedUnit.repeat(Math.floor(MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH / repeatedUnit.length));
    }

    function measureRejection(rawCaCertificate: string): {
      credentialsInvalidError: MySqlCredentialsInvalidError;
      elapsedMilliseconds: number;
    } {
      expect(rawCaCertificate.length).toBeLessThanOrEqual(MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH);
      const startedAtMilliseconds = performance.now();
      const credentialsInvalidError = captureMySqlCredentialsInvalidError(() =>
        normalizeMySqlCaCertificateBundlePem(rawCaCertificate),
      );
      return { credentialsInvalidError, elapsedMilliseconds: performance.now() - startedAtMilliseconds };
    }

    it.each<[string, string, MySqlCredentialProblem]>([
      [
        '19,417 BEGIN markers and no END marker (the reported payload)',
        '-----BEGIN CERTIFICATE-----'.repeat(19417),
        MySqlCredentialProblem.CaCertificateNotFound,
      ],
      [
        'BEGIN markers between base64-looking garbage and near-miss END markers',
        fillToCaCertificateSizeCap(`-----BEGIN CERTIFICATE-----\n${'MIIB'.repeat(16)}\n-----END CERTIFICAT\n`),
        MySqlCredentialProblem.CaCertificateNotFound,
      ],
      [
        'BEGIN markers each followed by an END marker one dash short',
        fillToCaCertificateSizeCap('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE----\n'),
        MySqlCredentialProblem.CaCertificateNotFound,
      ],
      [
        'nothing but dashes',
        '-'.repeat(MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH),
        MySqlCredentialProblem.CaCertificateNotFound,
      ],
      [
        'thousands of tiny complete blocks (stops at the certificate cap)',
        fillToCaCertificateSizeCap('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'),
        MySqlCredentialProblem.CaCertificateTooLarge,
      ],
      [
        'every BEGIN marker closed by one END marker at the very end (one malformed block)',
        `${'-----BEGIN CERTIFICATE-----'.repeat(19000)}-----END CERTIFICATE-----`,
        MySqlCredentialProblem.CaCertificateMalformed,
      ],
    ])('%s', (_description, rawCaCertificate, expectedProblem) => {
      // Warm up once so the timing measures the scan, not first-call compilation.
      captureMySqlCredentialsInvalidError(() => normalizeMySqlCaCertificateBundlePem(rawCaCertificate));

      const { credentialsInvalidError, elapsedMilliseconds } = measureRejection(rawCaCertificate);

      expect(credentialsInvalidError.problem).toBe(expectedProblem);
      expect(elapsedMilliseconds).toBeLessThan(maximumRejectionMilliseconds);
    });

    it('still reads the real Amazon RDS bundle quickly after the change', () => {
      const singleLineAmazonRdsCaBundle = awsSslProfiles.ca.join('').replace(/\r?\n/g, '');
      const startedAtMilliseconds = performance.now();
      const normalizedPemBundle = normalizeMySqlCaCertificateBundlePem(singleLineAmazonRdsCaBundle);
      const elapsedMilliseconds = performance.now() - startedAtMilliseconds;

      expect(splitCanonicalPemBundle(normalizedPemBundle)).toHaveLength(awsSslProfiles.ca.length);
      // X.509 parsing of ~120 certificates dominates; the generous bound only guards against a quadratic scan.
      expect(elapsedMilliseconds).toBeLessThan(1000);
    });
  });
});
