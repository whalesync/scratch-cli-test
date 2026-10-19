/**
 * Normalizes the CA Certificate the user pastes (for SSL Mode VERIFY_CA / VERIFY_IDENTITY) into a canonical PEM
 * bundle: every `CERTIFICATE` block re-wrapped to 64-character lines, one block after another.
 *
 * Pastes arrive mangled in predictable ways — the field is a single-line (password) input, so newlines are
 * stripped or replaced by spaces; JSON-escaped pastes carry literal `\n`; Windows files use CRLF; exported bundles
 * carry "Bag Attributes" or comment lines between blocks; the Amazon RDS global bundle holds ~120 certificates
 * (~160 KB). All of those are accepted. What is NOT a CA certificate is rejected with a specific message: a private
 * key (never echoed), PKCS#7 / "TRUSTED CERTIFICATE" containers, and blocks Node can't read as X.509.
 *
 * Expired certificates are deliberately accepted: the RDS bundles still ship expired legacy roots, and TLS
 * verification only needs one valid chain.
 *
 * The output is idempotent (normalizing it again returns the same text), so the stored value is stable across
 * edits and connect-time re-validation.
 */
import { X509Certificate } from 'node:crypto';
import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from './mysql-credential-errors';

/** The Amazon RDS global bundle is about 160 KB; the request body limit is 5 MB. */
export const MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH = 512 * 1024;
export const MYSQL_CA_CERTIFICATE_BUNDLE_MAX_CERTIFICATES = 500;
const PEM_BODY_LINE_LENGTH = 64;
const PEM_CERTIFICATE_BEGIN_MARKER = '-----BEGIN CERTIFICATE-----';
const PEM_CERTIFICATE_END_MARKER = '-----END CERTIFICATE-----';

/** `\r\n`, `\n`, `\r` typed as two characters (a JSON-escaped paste). Base64 never contains a backslash. */
const LITERAL_LINE_BREAK_ESCAPE_PATTERN = /\\r\\n|\\n|\\r/g;
const PRIVATE_KEY_MARKER_PATTERN = /PRIVATE KEY-----/;
const UNSUPPORTED_PEM_CONTAINER_PATTERN = /-----BEGIN (PKCS7|TRUSTED CERTIFICATE)-----/;
const BASE64_TEXT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Throws {@link MySqlCredentialsInvalidError} when the text holds no usable CA certificate. */
export function normalizeMySqlCaCertificateBundlePem(rawCaCertificate: string): string {
  if (rawCaCertificate.length > MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.CaCertificateTooLarge,
      `CA Certificate is too large (at most ${MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH / 1024} KB). Paste only your provider's CA certificate or bundle.`,
    );
  }
  const caCertificateTextWithRealLineBreaks = rawCaCertificate.replace(LITERAL_LINE_BREAK_ESCAPE_PATTERN, '\n');

  if (PRIVATE_KEY_MARKER_PATTERN.test(caCertificateTextWithRealLineBreaks)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.CaCertificateIsPrivateKey,
      'CA Certificate contains a private key. Paste only the CA certificate (-----BEGIN CERTIFICATE-----), never a private key.',
    );
  }
  if (UNSUPPORTED_PEM_CONTAINER_PATTERN.test(caCertificateTextWithRealLineBreaks)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.CaCertificateFormatUnsupported,
      'CA Certificate must be PEM certificates (-----BEGIN CERTIFICATE-----). PKCS#7 and "TRUSTED CERTIFICATE" files ' +
        'are not supported; convert them first (e.g. openssl pkcs7 -print_certs).',
    );
  }

  const pemCertificateBodies = extractPemCertificateBodiesInLinearTime(caCertificateTextWithRealLineBreaks);
  if (pemCertificateBodies.length === 0) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.CaCertificateNotFound,
      'CA Certificate has no certificate in it. Paste the whole PEM text, including the -----BEGIN CERTIFICATE----- and -----END CERTIFICATE----- lines.',
    );
  }

  return pemCertificateBodies
    .map((pemCertificateBody, certificateIndex) =>
      rewrapAndCheckPemCertificateBlock(pemCertificateBody, certificateIndex + 1),
    )
    .join('');
}

/**
 * The text between each `BEGIN CERTIFICATE` marker and the first `END CERTIFICATE` marker after it, in order —
 * the same bodies the lazy global regex `/BEGIN([\s\S]*?)END/g` would capture, so newline-stripped bundles
 * (`...END CERTIFICATE----------BEGIN CERTIFICATE-----...`) still split and text around the blocks is skipped.
 *
 * Why not that regex: every BEGIN marker with no END after it made the lazy group rescan to the end of the text,
 * so 512 KB of BEGIN markers took ~4 s of synchronous regex work (it runs on the API request and on every connect
 * for a stored value). Here each character is visited once: a missing END ends the scan, because no later BEGIN
 * can have an END after it either. The certificate cap is checked as blocks are found, not after collecting them.
 */
function extractPemCertificateBodiesInLinearTime(caCertificateText: string): string[] {
  const pemCertificateBodies: string[] = [];
  let searchFromIndex = 0;
  for (;;) {
    const beginMarkerIndex = caCertificateText.indexOf(PEM_CERTIFICATE_BEGIN_MARKER, searchFromIndex);
    if (beginMarkerIndex < 0) return pemCertificateBodies;
    const certificateBodyStartIndex = beginMarkerIndex + PEM_CERTIFICATE_BEGIN_MARKER.length;
    const endMarkerIndex = caCertificateText.indexOf(PEM_CERTIFICATE_END_MARKER, certificateBodyStartIndex);
    if (endMarkerIndex < 0) return pemCertificateBodies;
    pemCertificateBodies.push(caCertificateText.slice(certificateBodyStartIndex, endMarkerIndex));
    if (pemCertificateBodies.length > MYSQL_CA_CERTIFICATE_BUNDLE_MAX_CERTIFICATES) {
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.CaCertificateTooLarge,
        `CA Certificate holds more than ${MYSQL_CA_CERTIFICATE_BUNDLE_MAX_CERTIFICATES} certificates. Paste only your provider's CA bundle.`,
      );
    }
    searchFromIndex = endMarkerIndex + PEM_CERTIFICATE_END_MARKER.length;
  }
}

/** One canonical `BEGIN/END CERTIFICATE` block (trailing newline included), verified to parse as X.509. */
function rewrapAndCheckPemCertificateBlock(pemCertificateBody: string, oneBasedCertificatePosition: number): string {
  const base64CertificateBody = pemCertificateBody.replace(/\s+/g, '');
  if (!BASE64_TEXT_PATTERN.test(base64CertificateBody) || base64CertificateBody.length % 4 !== 0) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.CaCertificateMalformed,
      `Certificate #${oneBasedCertificatePosition} in CA Certificate isn't valid PEM text (unexpected characters between its BEGIN and END lines).`,
    );
  }
  const base64BodyLines: string[] = [];
  for (let lineStartIndex = 0; lineStartIndex < base64CertificateBody.length; lineStartIndex += PEM_BODY_LINE_LENGTH) {
    base64BodyLines.push(base64CertificateBody.slice(lineStartIndex, lineStartIndex + PEM_BODY_LINE_LENGTH));
  }
  const canonicalPemCertificateBlock = `${PEM_CERTIFICATE_BEGIN_MARKER}\n${base64BodyLines.join('\n')}\n${PEM_CERTIFICATE_END_MARKER}\n`;
  try {
    new X509Certificate(canonicalPemCertificateBlock);
  } catch {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.CaCertificateMalformed,
      `Certificate #${oneBasedCertificatePosition} in CA Certificate couldn't be read as an X.509 certificate.`,
    );
  }
  return canonicalPemCertificateBlock;
}
