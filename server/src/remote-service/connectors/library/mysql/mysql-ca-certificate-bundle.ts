/**
 * Normalizes the CA Certificate the user pastes (for SSL Mode VERIFY_CA / VERIFY_IDENTITY) into a canonical PEM
 * bundle, with the shared certificate normalizer in `connectors/utils/pem-certificates-and-keys.ts` (also used by the
 * Postgres connector). What that rejects becomes a {@link MySqlCredentialsInvalidError} with the matching problem.
 */
import { assertUnreachable } from 'src/utils/asserts';
import {
  normalizePemCertificateBundle,
  PEM_CERTIFICATE_BUNDLE_MAX_CERTIFICATES,
  PEM_CERTIFICATE_BUNDLE_MAX_LENGTH,
  PemInputError,
  PemInputProblem,
} from '../../utils/pem-certificates-and-keys';
import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from './mysql-credential-errors';

/** The Amazon RDS global bundle is about 160 KB; the request body limit is 5 MB. */
export const MYSQL_CA_CERTIFICATE_BUNDLE_MAX_LENGTH = PEM_CERTIFICATE_BUNDLE_MAX_LENGTH;
export const MYSQL_CA_CERTIFICATE_BUNDLE_MAX_CERTIFICATES = PEM_CERTIFICATE_BUNDLE_MAX_CERTIFICATES;

/** Throws {@link MySqlCredentialsInvalidError} when the text holds no usable CA certificate. */
export function normalizeMySqlCaCertificateBundlePem(rawCaCertificate: string): string {
  try {
    return normalizePemCertificateBundle(rawCaCertificate, {
      fieldLabel: 'CA Certificate',
      expectedCertificate: 'the CA certificate',
      expectedBundle: "your provider's CA certificate or bundle",
    });
  } catch (error) {
    if (error instanceof PemInputError) {
      throw new MySqlCredentialsInvalidError(mySqlCredentialProblemForPemInputProblem(error.problem), error.message);
    }
    throw error;
  }
}

function mySqlCredentialProblemForPemInputProblem(pemInputProblem: PemInputProblem): MySqlCredentialProblem {
  switch (pemInputProblem) {
    case PemInputProblem.TooLarge:
      return MySqlCredentialProblem.CaCertificateTooLarge;
    case PemInputProblem.CertificateFieldHoldsPrivateKey:
      return MySqlCredentialProblem.CaCertificateIsPrivateKey;
    case PemInputProblem.CertificateContainerUnsupported:
      return MySqlCredentialProblem.CaCertificateFormatUnsupported;
    case PemInputProblem.CertificateNotFound:
      return MySqlCredentialProblem.CaCertificateNotFound;
    case PemInputProblem.CertificateMalformed:
      return MySqlCredentialProblem.CaCertificateMalformed;
    // Private-key problems: the certificate normalizer never raises them.
    case PemInputProblem.PrivateKeyNotFound:
    case PemInputProblem.PrivateKeyFieldHoldsCertificate:
    case PemInputProblem.PrivateKeyEncrypted:
    case PemInputProblem.MoreThanOnePrivateKey:
    case PemInputProblem.PrivateKeyMalformed:
      return MySqlCredentialProblem.Unexpected;
    default:
      return assertUnreachable(pemInputProblem);
  }
}
