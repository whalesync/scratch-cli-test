/**
 * Normalizes the certificates and private keys users paste into database connection forms (MySQL's CA Certificate;
 * Postgres's server CA certificate, client certificate and client private key) into canonical PEM: every block
 * re-wrapped to 64-character lines, one block after another.
 *
 * Pastes arrive mangled in predictable ways — the fields are single-line (password) inputs, so newlines are
 * stripped or replaced by spaces; JSON-escaped pastes carry literal `\n`; Windows files use CRLF; exported bundles
 * carry "Bag Attributes" or comment lines between blocks; the Amazon RDS global bundle holds ~120 certificates
 * (~160 KB). All of those are accepted. What doesn't belong in a field is rejected with a specific message: a
 * private key in a certificate field, a certificate (or nothing) in a key field, a passphrase-encrypted key,
 * PKCS#7 / "TRUSTED CERTIFICATE" containers, and blocks Node can't read.
 *
 * Messages name the field by the caller's label and never contain the pasted text.
 *
 * Expired certificates are deliberately accepted in a CA bundle: the RDS bundles still ship expired legacy roots, and
 * TLS verification only needs one valid chain. (A client certificate's expiry is checked by the caller.)
 *
 * The output is idempotent (normalizing it again returns the same text), so the stored value is stable across edits
 * and connect-time re-validation.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';

/** The Amazon RDS global bundle is about 160 KB; the request body limit is 5 MB. */
export const PEM_CERTIFICATE_BUNDLE_MAX_LENGTH = 512 * 1024;
export const PEM_CERTIFICATE_BUNDLE_MAX_CERTIFICATES = 500;
/** A 4096-bit RSA key in PKCS#8 is about 3.3 KB. */
export const PEM_PRIVATE_KEY_MAX_LENGTH = 16 * 1024;
const PEM_BODY_LINE_LENGTH = 64;
const PEM_CERTIFICATE_BEGIN_MARKER = '-----BEGIN CERTIFICATE-----';
const PEM_CERTIFICATE_END_MARKER = '-----END CERTIFICATE-----';

/** `\r\n`, `\n`, `\r` typed as two characters (a JSON-escaped paste). Base64 never contains a backslash. */
const LITERAL_LINE_BREAK_ESCAPE_PATTERN = /\\r\\n|\\n|\\r/g;
const PRIVATE_KEY_MARKER_PATTERN = /PRIVATE KEY-----/;
const UNSUPPORTED_PEM_CONTAINER_PATTERN = /-----BEGIN (PKCS7|TRUSTED CERTIFICATE)-----/;
const BASE64_TEXT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
/** PKCS#8 (`PRIVATE KEY`) and the traditional RSA / EC forms, in that order of preference. */
const UNENCRYPTED_PRIVATE_KEY_PEM_LABELS: readonly string[] = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'];
/** PKCS#8 encrypted, or a traditional key with a `Proc-Type: 4,ENCRYPTED` header. */
const ENCRYPTED_PRIVATE_KEY_PATTERN = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,\s*ENCRYPTED/;

export enum PemInputProblem {
  TooLarge = 'TOO_LARGE',
  CertificateFieldHoldsPrivateKey = 'CERTIFICATE_FIELD_HOLDS_PRIVATE_KEY',
  CertificateContainerUnsupported = 'CERTIFICATE_CONTAINER_UNSUPPORTED',
  CertificateNotFound = 'CERTIFICATE_NOT_FOUND',
  CertificateMalformed = 'CERTIFICATE_MALFORMED',
  PrivateKeyNotFound = 'PRIVATE_KEY_NOT_FOUND',
  PrivateKeyFieldHoldsCertificate = 'PRIVATE_KEY_FIELD_HOLDS_CERTIFICATE',
  PrivateKeyEncrypted = 'PRIVATE_KEY_ENCRYPTED',
  MoreThanOnePrivateKey = 'MORE_THAN_ONE_PRIVATE_KEY',
  PrivateKeyMalformed = 'PRIVATE_KEY_MALFORMED',
}

/** A pasted certificate or key that can't be used. `message` is safe to show: it never contains the pasted text. */
export class PemInputError extends Error {
  constructor(
    public readonly problem: PemInputProblem,
    message: string,
  ) {
    super(message);
    this.name = 'PemInputError';
  }
}

/** How a certificate field is named in messages. */
export interface PemCertificateFieldWording {
  /** The form label, e.g. `CA Certificate`. */
  readonly fieldLabel: string;
  /** What the field should hold, e.g. `the CA certificate`. */
  readonly expectedCertificate: string;
  /** What to trim an oversized paste down to, e.g. `your provider's CA certificate or bundle`. */
  readonly expectedBundle: string;
}

/** Throws {@link PemInputError} when the text holds no usable certificate. */
export function normalizePemCertificateBundle(rawPemText: string, wording: PemCertificateFieldWording): string {
  const { fieldLabel, expectedCertificate, expectedBundle } = wording;
  if (rawPemText.length > PEM_CERTIFICATE_BUNDLE_MAX_LENGTH) {
    throw new PemInputError(
      PemInputProblem.TooLarge,
      `${fieldLabel} is too large (at most ${PEM_CERTIFICATE_BUNDLE_MAX_LENGTH / 1024} KB). Paste only ${expectedBundle}.`,
    );
  }
  const pemTextWithRealLineBreaks = rawPemText.replace(LITERAL_LINE_BREAK_ESCAPE_PATTERN, '\n');

  if (PRIVATE_KEY_MARKER_PATTERN.test(pemTextWithRealLineBreaks)) {
    throw new PemInputError(
      PemInputProblem.CertificateFieldHoldsPrivateKey,
      `${fieldLabel} contains a private key. Paste only ${expectedCertificate} (-----BEGIN CERTIFICATE-----), never a private key.`,
    );
  }
  if (UNSUPPORTED_PEM_CONTAINER_PATTERN.test(pemTextWithRealLineBreaks)) {
    throw new PemInputError(
      PemInputProblem.CertificateContainerUnsupported,
      `${fieldLabel} must be PEM certificates (-----BEGIN CERTIFICATE-----). PKCS#7 and "TRUSTED CERTIFICATE" files ` +
        'are not supported; convert them first (e.g. openssl pkcs7 -print_certs).',
    );
  }

  const pemCertificateBodies = extractPemBlockBodiesInLinearTime(
    pemTextWithRealLineBreaks,
    PEM_CERTIFICATE_BEGIN_MARKER,
    PEM_CERTIFICATE_END_MARKER,
    () => {
      throw new PemInputError(
        PemInputProblem.TooLarge,
        `${fieldLabel} holds more than ${PEM_CERTIFICATE_BUNDLE_MAX_CERTIFICATES} certificates. Paste only ${expectedBundle}.`,
      );
    },
  );
  if (pemCertificateBodies.length === 0) {
    throw new PemInputError(
      PemInputProblem.CertificateNotFound,
      `${fieldLabel} has no certificate in it. Paste the whole PEM text, including the -----BEGIN CERTIFICATE----- and -----END CERTIFICATE----- lines.`,
    );
  }

  return pemCertificateBodies
    .map((pemCertificateBody, certificateIndex) =>
      rewrapAndCheckPemCertificateBlock(pemCertificateBody, certificateIndex + 1, fieldLabel),
    )
    .join('');
}

/** The certificates of a canonical bundle from {@link normalizePemCertificateBundle}, first one first. */
export function splitCanonicalPemCertificateBundle(canonicalPemCertificateBundle: string): string[] {
  return canonicalPemCertificateBundle
    .split(PEM_CERTIFICATE_END_MARKER)
    .filter((pemCertificateBlockStart) => pemCertificateBlockStart.includes(PEM_CERTIFICATE_BEGIN_MARKER))
    .map((pemCertificateBlockStart) => `${pemCertificateBlockStart.trimStart()}${PEM_CERTIFICATE_END_MARKER}\n`);
}

/**
 * Normalizes one unencrypted private key (PKCS#8 `PRIVATE KEY`, or the traditional `RSA PRIVATE KEY` /
 * `EC PRIVATE KEY`), keeping its label. Other PEM blocks in the text (a certificate pasted along with the key) are
 * ignored. Throws {@link PemInputError} when there is no usable key.
 */
export function normalizePemPrivateKey(rawPemText: string, fieldLabel: string): string {
  if (rawPemText.length > PEM_PRIVATE_KEY_MAX_LENGTH) {
    throw new PemInputError(
      PemInputProblem.TooLarge,
      `${fieldLabel} is too large (at most ${PEM_PRIVATE_KEY_MAX_LENGTH / 1024} KB). Paste only the private key.`,
    );
  }
  const pemTextWithRealLineBreaks = rawPemText.replace(LITERAL_LINE_BREAK_ESCAPE_PATTERN, '\n');

  if (ENCRYPTED_PRIVATE_KEY_PATTERN.test(pemTextWithRealLineBreaks)) {
    throw new PemInputError(
      PemInputProblem.PrivateKeyEncrypted,
      `${fieldLabel} is encrypted with a passphrase. Paste an unencrypted key instead (e.g. openssl pkey -in key.pem -out unencrypted-key.pem).`,
    );
  }

  const privateKeyBlocks: { pemLabel: string; pemBody: string }[] = [];
  for (const pemLabel of UNENCRYPTED_PRIVATE_KEY_PEM_LABELS) {
    const pemBodies = extractPemBlockBodiesInLinearTime(
      pemTextWithRealLineBreaks,
      `-----BEGIN ${pemLabel}-----`,
      `-----END ${pemLabel}-----`,
      () => undefined,
    );
    privateKeyBlocks.push(...pemBodies.map((pemBody) => ({ pemLabel, pemBody })));
  }
  if (privateKeyBlocks.length === 0) {
    if (pemTextWithRealLineBreaks.includes(PEM_CERTIFICATE_BEGIN_MARKER)) {
      throw new PemInputError(
        PemInputProblem.PrivateKeyFieldHoldsCertificate,
        `${fieldLabel} holds a certificate, not a private key. Paste the private key (-----BEGIN PRIVATE KEY-----).`,
      );
    }
    throw new PemInputError(
      PemInputProblem.PrivateKeyNotFound,
      `${fieldLabel} has no private key in it. Paste the whole PEM text, including the -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.`,
    );
  }
  if (privateKeyBlocks.length > 1) {
    throw new PemInputError(
      PemInputProblem.MoreThanOnePrivateKey,
      `${fieldLabel} holds more than one private key. Paste only the key that belongs to the client certificate.`,
    );
  }

  const [{ pemLabel, pemBody }] = privateKeyBlocks;
  const malformedPrivateKeyError = new PemInputError(
    PemInputProblem.PrivateKeyMalformed,
    `${fieldLabel} couldn't be read as a private key.`,
  );
  const canonicalPemPrivateKeyBlock = rewrapPemBlock(pemBody, pemLabel, malformedPrivateKeyError);
  try {
    createPrivateKey(canonicalPemPrivateKeyBlock);
  } catch {
    throw malformedPrivateKeyError;
  }
  return canonicalPemPrivateKeyBlock;
}

/**
 * The text between each begin marker and the first end marker after it, in order — the same bodies the lazy global
 * regex `/BEGIN([\s\S]*?)END/g` would capture, so newline-stripped bundles
 * (`...END CERTIFICATE----------BEGIN CERTIFICATE-----...`) still split and text around the blocks is skipped.
 *
 * Why not that regex: every begin marker with no end after it made the lazy group rescan to the end of the text, so
 * 512 KB of begin markers took ~4 s of synchronous regex work (it runs on the API request and on every connect for a
 * stored value). Here each character is visited once: a missing end ends the scan, because no later begin can have an
 * end after it either. `onTooManyBlocks` runs as soon as the certificate cap is passed.
 */
function extractPemBlockBodiesInLinearTime(
  pemText: string,
  beginMarker: string,
  endMarker: string,
  onTooManyBlocks: () => void,
): string[] {
  const pemBlockBodies: string[] = [];
  let searchFromIndex = 0;
  for (;;) {
    const beginMarkerIndex = pemText.indexOf(beginMarker, searchFromIndex);
    if (beginMarkerIndex < 0) return pemBlockBodies;
    const blockBodyStartIndex = beginMarkerIndex + beginMarker.length;
    const endMarkerIndex = pemText.indexOf(endMarker, blockBodyStartIndex);
    if (endMarkerIndex < 0) return pemBlockBodies;
    pemBlockBodies.push(pemText.slice(blockBodyStartIndex, endMarkerIndex));
    if (pemBlockBodies.length > PEM_CERTIFICATE_BUNDLE_MAX_CERTIFICATES) onTooManyBlocks();
    searchFromIndex = endMarkerIndex + endMarker.length;
  }
}

/** One canonical `BEGIN/END CERTIFICATE` block (trailing newline included), verified to parse as X.509. */
function rewrapAndCheckPemCertificateBlock(
  pemCertificateBody: string,
  oneBasedCertificatePosition: number,
  fieldLabel: string,
): string {
  const canonicalPemCertificateBlock = rewrapPemBlock(
    pemCertificateBody,
    'CERTIFICATE',
    new PemInputError(
      PemInputProblem.CertificateMalformed,
      `Certificate #${oneBasedCertificatePosition} in ${fieldLabel} isn't valid PEM text (unexpected characters between its BEGIN and END lines).`,
    ),
  );
  try {
    new X509Certificate(canonicalPemCertificateBlock);
  } catch {
    throw new PemInputError(
      PemInputProblem.CertificateMalformed,
      `Certificate #${oneBasedCertificatePosition} in ${fieldLabel} couldn't be read as an X.509 certificate.`,
    );
  }
  return canonicalPemCertificateBlock;
}

/** `-----BEGIN <label>-----`, the body's base64 in 64-character lines, `-----END <label>-----`, and a newline. */
function rewrapPemBlock(pemBlockBody: string, pemLabel: string, errorWhenNotBase64: PemInputError): string {
  const base64BlockBody = pemBlockBody.replace(/\s+/g, '');
  if (!BASE64_TEXT_PATTERN.test(base64BlockBody) || base64BlockBody.length % 4 !== 0) {
    throw errorWhenNotBase64;
  }
  const base64BodyLines: string[] = [];
  for (let lineStartIndex = 0; lineStartIndex < base64BlockBody.length; lineStartIndex += PEM_BODY_LINE_LENGTH) {
    base64BodyLines.push(base64BlockBody.slice(lineStartIndex, lineStartIndex + PEM_BODY_LINE_LENGTH));
  }
  return `-----BEGIN ${pemLabel}-----\n${base64BodyLines.join('\n')}\n-----END ${pemLabel}-----\n`;
}
