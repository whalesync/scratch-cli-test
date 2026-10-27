/**
 * Builds throwaway X.509 certificates and their private keys inside the test, so no key is committed and no test
 * depends on an `openssl` binary. A minimal DER encoder writes a version-3 certificate with a common name, a
 * validity period and the key's public key, signed by the issuer's key (self-signed when no issuer is given). Node's
 * `X509Certificate` reads it and `checkPrivateKey` matches it to its key.
 */
import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

export interface TestCertificate {
  readonly certificatePem: string;
  /** PKCS#8 (`-----BEGIN PRIVATE KEY-----`). */
  readonly privateKeyPem: string;
  /** The traditional form: `-----BEGIN RSA PRIVATE KEY-----` or `-----BEGIN EC PRIVATE KEY-----`. */
  readonly traditionalPrivateKeyPem: string;
  readonly privateKey: KeyObject;
  readonly commonName: string;
}

export interface TestCertificateOptions {
  readonly commonName?: string;
  readonly keyType?: 'ec' | 'rsa';
  readonly validFrom?: Date;
  readonly validTo?: Date;
  /** Signs with this certificate's key and names it as the issuer. Self-signed when absent. */
  readonly issuer?: TestCertificate;
}

const ONE_DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const ECDSA_WITH_SHA256_OBJECT_IDENTIFIER = '1.2.840.10045.4.3.2';
const SHA256_WITH_RSA_ENCRYPTION_OBJECT_IDENTIFIER = '1.2.840.113549.1.1.11';
const COMMON_NAME_OBJECT_IDENTIFIER = '2.5.4.3';

export function buildTestCertificate(options: TestCertificateOptions = {}): TestCertificate {
  const commonName = options.commonName ?? 'scratch-unit-test';
  const keyType = options.keyType ?? 'ec';
  const validFrom = options.validFrom ?? new Date(Date.now() - ONE_DAY_IN_MILLISECONDS);
  const validTo = options.validTo ?? new Date(Date.now() + 365 * ONE_DAY_IN_MILLISECONDS);
  const { publicKey, privateKey } =
    keyType === 'ec'
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });

  const signingKey = options.issuer?.privateKey ?? privateKey;
  const signingAlgorithm = derSequence(
    ...(signingKey.asymmetricKeyType === 'ec'
      ? [derObjectIdentifier(ECDSA_WITH_SHA256_OBJECT_IDENTIFIER)]
      : [derObjectIdentifier(SHA256_WITH_RSA_ENCRYPTION_OBJECT_IDENTIFIER), derNull()]),
  );
  const subjectName = derName(commonName);
  const issuerName = derName(options.issuer?.commonName ?? commonName);
  // Positive, and with a non-zero first byte: DER refuses an integer with a redundant leading zero byte.
  const serialNumber = randomBytes(8);
  serialNumber[0] = (serialNumber[0] & 0x3f) | 0x40;

  const toBeSignedCertificate = derSequence(
    derContextSpecific(0, derInteger(Buffer.from([2]))),
    derInteger(serialNumber),
    signingAlgorithm,
    issuerName,
    derSequence(derUtcTime(validFrom), derUtcTime(validTo)),
    subjectName,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', toBeSignedCertificate, signingKey);
  const certificateDer = derSequence(toBeSignedCertificate, signingAlgorithm, derBitString(signature));

  return {
    certificatePem: toPem('CERTIFICATE', certificateDer),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    traditionalPrivateKeyPem: privateKey
      .export({ type: keyType === 'ec' ? 'sec1' : 'pkcs1', format: 'pem' })
      .toString(),
    privateKey,
    commonName,
  };
}

function toPem(pemLabel: string, der: Buffer): string {
  const base64Lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${pemLabel}-----\n${base64Lines.join('\n')}\n-----END ${pemLabel}-----\n`;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const lengthBytes: number[] = [];
  for (let remainingLength = length; remainingLength > 0; remainingLength >>= 8)
    lengthBytes.unshift(remainingLength & 0xff);
  return Buffer.from([0x80 | lengthBytes.length, ...lengthBytes]);
}

function derElement(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(...elements: Buffer[]): Buffer {
  return derElement(0x30, Buffer.concat(elements));
}

function derName(commonName: string): Buffer {
  const commonNameAttribute = derSequence(
    derObjectIdentifier(COMMON_NAME_OBJECT_IDENTIFIER),
    derElement(0x0c, Buffer.from(commonName, 'utf8')),
  );
  return derSequence(derElement(0x31, commonNameAttribute));
}

function derInteger(unsignedBigEndianValue: Buffer): Buffer {
  const content =
    unsignedBigEndianValue[0] & 0x80
      ? Buffer.concat([Buffer.from([0]), unsignedBigEndianValue])
      : unsignedBigEndianValue;
  return derElement(0x02, content);
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derObjectIdentifier(dottedObjectIdentifier: string): Buffer {
  const [firstArc, secondArc, ...remainingArcs] = dottedObjectIdentifier.split('.').map(Number);
  const encodedBytes = [40 * firstArc + secondArc];
  for (const arc of remainingArcs) {
    const arcBytes = [arc & 0x7f];
    for (let remainingArc = arc >> 7; remainingArc > 0; remainingArc >>= 7)
      arcBytes.unshift((remainingArc & 0x7f) | 0x80);
    encodedBytes.push(...arcBytes);
  }
  return derElement(0x06, Buffer.from(encodedBytes));
}

/** UTCTime (`YYMMDDHHMMSSZ`), valid for 1950 through 2049. */
function derUtcTime(date: Date): Buffer {
  const twoDigits = (value: number) => String(value).padStart(2, '0');
  const utcTimeText = [
    date.getUTCFullYear() % 100,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ]
    .map(twoDigits)
    .join('');
  return derElement(0x17, Buffer.from(`${utcTimeText}Z`, 'ascii'));
}

function derBitString(content: Buffer): Buffer {
  return derElement(0x03, Buffer.concat([Buffer.from([0]), content]));
}

function derContextSpecific(tagNumber: number, content: Buffer): Buffer {
  return derElement(0xa0 | tagNumber, content);
}
