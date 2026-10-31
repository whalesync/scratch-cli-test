import { Injectable } from '@nestjs/common';
import axios, { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { SQUARE_CONNECTOR_API_VERSION } from '../../remote-service/connectors/library/square/square-api-client';
import {
  SQUARE_API_BASE_URL_BY_ENVIRONMENT,
  SQUARE_OAUTH_READ_SCOPES,
  squareEnvironmentForOAuthApplicationId,
} from '../../remote-service/connectors/library/square/square-types';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const LOG_SOURCE = 'SquareOAuthProvider';

/**
 * The longest an access token is recorded as valid. Square's tokens last 30 days, but Square asks apps to refresh
 * them every 7 days or sooner, so a token is recorded as expiring at whichever comes first.
 * https://developer.squareup.com/docs/oauth-api/refresh-revoke-limit-scope
 */
export const SQUARE_MAXIMUM_RECORDED_ACCESS_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

interface SquareTokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  /** When the access token expires (ISO 8601). Square sends this in place of `expires_in`. */
  expires_at?: string;
  merchant_id?: string;
  /** The current error form. */
  errors?: { category?: string; code?: string; detail?: string }[];
  /** The older error form, which the token endpoint still sends for some failures. */
  message?: string;
  type?: string;
}

/** The most useful human-readable reason in a failed token response. */
function describeSquareTokenEndpointFailure(tokenEndpointResponse: SquareTokenEndpointResponse): string {
  const errorDetails = (tokenEndpointResponse.errors ?? [])
    .map((squareError) => squareError.detail ?? squareError.code)
    .filter((errorDetail): errorDetail is string => typeof errorDetail === 'string' && errorDetail.length > 0);
  if (errorDetails.length > 0) {
    return errorDetails.join('; ');
  }
  return tokenEndpointResponse.message ?? tokenEndpointResponse.type ?? 'no access_token in response';
}

/** Seconds from now until Square's `expires_at`, capped at {@link SQUARE_MAXIMUM_RECORDED_ACCESS_TOKEN_LIFETIME_SECONDS}. */
export function squareAccessTokenLifetimeSecondsToRecord(expiresAt: string | undefined): number {
  const expiresAtMilliseconds = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(expiresAtMilliseconds)) {
    return SQUARE_MAXIMUM_RECORDED_ACCESS_TOKEN_LIFETIME_SECONDS;
  }
  const secondsUntilSquareExpiry = Math.floor((expiresAtMilliseconds - Date.now()) / 1000);
  // At least one second: a zero lifetime is recorded as "never expires", which would stop the token from refreshing.
  return Math.max(1, Math.min(secondsUntilSquareExpiry, SQUARE_MAXIMUM_RECORDED_ACCESS_TOKEN_LIFETIME_SECONDS));
}

/**
 * Square OAuth 2.0 (the code flow, for an app that keeps its secret on a server), through Whalesync's Square app.
 *
 * - The environment comes from the app: Square gives an app one id per environment, and a `sandbox-` id signs in,
 *   exchanges, and refreshes at the sandbox host. Test environments run the app's sandbox credentials, production its
 *   production ones.
 * - The environment is returned as `workspace_id`, so the host persists it in `oauthWorkspaceId` and the connector
 *   sends API calls to the matching host.
 * - The code flow's refresh token never expires and comes back unchanged from a refresh, so a connection only has
 *   to be reconnected if the seller revokes the app.
 * - Square sends `expires_at` rather than `expires_in`; see {@link squareAccessTokenLifetimeSecondsToRecord}.
 *
 * https://developer.squareup.com/docs/oauth-api/overview
 */
@Injectable()
export class SquareOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials): string {
    const environment = squareEnvironmentForOAuthApplicationId(credentials.clientId);
    const authorizeUrl = new URL(`${SQUARE_API_BASE_URL_BY_ENVIRONMENT[environment]}/oauth2/authorize`);
    authorizeUrl.searchParams.set('client_id', credentials.clientId);
    authorizeUrl.searchParams.set('scope', SQUARE_OAUTH_READ_SCOPES.join(' '));
    authorizeUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authorizeUrl.searchParams.set('state', state);
    if (environment === 'production') {
      // Square requires this for a production sign-in: the seller logs in even when the browser already has a Square
      // session, so a connection can't land on whichever account happened to be signed in. It has no effect in the
      // sandbox, which signs in through the sandbox seller dashboard opened from the Developer Console.
      authorizeUrl.searchParams.set('session', 'false');
    }
    return authorizeUrl.toString();
  }

  async exchangeCodeForTokens(code: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const tokenResponse = await this.requestToken(credentials, {
      grant_type: 'authorization_code',
      code,
      // Required because the sign-in link sent one.
      redirect_uri: credentials.redirectUri,
    });
    if (!tokenResponse.refresh_token) {
      throw new Error('Square authorization failed: no refresh token was issued.');
    }
    return {
      access_token: tokenResponse.accessToken,
      refresh_token: tokenResponse.refresh_token,
      expires_in: squareAccessTokenLifetimeSecondsToRecord(tokenResponse.expires_at),
      workspace_id: squareEnvironmentForOAuthApplicationId(credentials.clientId),
    };
  }

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const tokenResponse = await this.requestToken(credentials, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return {
      access_token: tokenResponse.accessToken,
      refresh_token: tokenResponse.refresh_token,
      expires_in: squareAccessTokenLifetimeSecondsToRecord(tokenResponse.expires_at),
    };
  }

  getServiceName(): string {
    return 'square';
  }

  /**
   * POST a token request (ObtainToken) to the app's environment and return the response, turning a failure (see
   * {@link describeSquareTokenEndpointFailure}) into a message the user can act on.
   */
  private async requestToken(
    credentials: OAuthAppCredentials,
    grantParameters: Record<string, string>,
  ): Promise<SquareTokenEndpointResponse & { accessToken: string }> {
    const environment = squareEnvironmentForOAuthApplicationId(credentials.clientId);
    let tokenEndpointResponse: SquareTokenEndpointResponse;
    try {
      const response = await axios.post<SquareTokenEndpointResponse>(
        `${SQUARE_API_BASE_URL_BY_ENVIRONMENT[environment]}/oauth2/token`,
        { client_id: credentials.clientId, client_secret: credentials.clientSecret, ...grantParameters },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Square-Version': SQUARE_CONNECTOR_API_VERSION,
          },
        },
      );
      tokenEndpointResponse = response.data;
    } catch (error) {
      tokenEndpointResponse = (isAxiosError(error) &&
        (error.response?.data as SquareTokenEndpointResponse | undefined)) || {
        message: error instanceof Error ? error.message : 'request failed',
      };
    }

    if (!tokenEndpointResponse.access_token) {
      const reason = describeSquareTokenEndpointFailure(tokenEndpointResponse);
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Square token request failed (${grantParameters.grant_type}, ${environment}): ${reason}`,
      });
      throw new Error(`Square authorization failed: ${reason}`);
    }
    return { ...tokenEndpointResponse, accessToken: tokenEndpointResponse.access_token };
  }
}
