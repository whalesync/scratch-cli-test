import { DecryptedCredentials } from '@spinner/shared-types';
import { AuthParser } from '../../connector';
import { ConnectorAuthError } from '../../error';
import { Service } from '../../service-constants';
import { SquareApiClient } from './square-api-client';

/**
 * Turns the pasted Square access token into stored credentials, recording which Square environment
 * (production or sandbox) the token belongs to.
 *
 * Square issues separate tokens per environment and each environment rejects the other's, so rather
 * than making the user say which kind they pasted, we ask production and then sandbox who the
 * merchant is and keep whichever accepts it. A token neither accepts is rejected here, at the
 * connect form, instead of surfacing later as a failed pull.
 */
export class SquareAuthParser extends AuthParser {
  readonly service = Service.SQUARE;

  /** Edits re-detect the environment whenever a new token is pasted, so the stored pair stays consistent. */
  override readonly parsesCredentialEditsAgainstStoredCredentials = true;

  async parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
    existingCredentials?: DecryptedCredentials;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const pastedAccessToken = params.userProvidedParams.apiKey?.trim();

    if (!pastedAccessToken) {
      const { apiKey: storedAccessToken, squareEnvironment: storedEnvironment } = params.existingCredentials ?? {};
      if (storedAccessToken && storedEnvironment) {
        return { credentials: { apiKey: storedAccessToken, squareEnvironment: storedEnvironment }, extras: {} };
      }
      throw new ConnectorAuthError(
        'Square access token is required',
        'Paste a Square access token to connect.',
        this.service,
      );
    }

    const detectedEnvironment = await SquareApiClient.detectEnvironmentForAccessToken(pastedAccessToken);
    if (!detectedEnvironment) {
      throw new ConnectorAuthError(
        'Square rejected the access token in both production and sandbox',
        'Square did not accept this access token. Copy it again from the Square Developer Dashboard ' +
          '(Applications → your app → Credentials) and make sure it has not been revoked.',
        this.service,
      );
    }

    return { credentials: { apiKey: pastedAccessToken, squareEnvironment: detectedEnvironment }, extras: {} };
  }
}
