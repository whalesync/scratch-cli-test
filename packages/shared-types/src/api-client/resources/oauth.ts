import type { OAuthInitiateOptionsDto } from '../../dto/oauth/oauth-initiate-options.dto';
import type {
  ClaimInboundInstallResponse,
  PendingOAuthInstallInfo,
  RedeemInboundInstallResponse,
} from '../../dto/oauth/oauth-install.dto';
import type {
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthInitiateResponse,
} from '../../dto/oauth/oauth-responses.dto';
import type { Http } from '../http';

/**
 * OAuth-flow operations: initiate a service's authorization, exchange the callback code for
 * tokens, and (web only) refresh a connector account's tokens. Reached as `client.oauth.*`.
 *
 * Web (`client/src/lib/api/oauth.ts`) and desktop (`scratch-desktop/.../oauth-api.ts`) share the
 * `initiate` and `callback` routes/bodies/returns; the only divergences are:
 *   - `initiate`'s `options` arg is OPTIONAL on web, REQUIRED on desktop — kept optional here (a
 *     superset that satisfies both call sites).
 *   - `refresh` exists ONLY on web (desktop has no token-refresh endpoint).
 */
export function createOauthApi(http: Http) {
  return {
    /** POST `/oauth/:service/initiate` — start the OAuth flow for a service. (both web + desktop) */
    initiate: async (service: string, options?: OAuthInitiateOptionsDto): Promise<OAuthInitiateResponse> => {
      const res = await http.post<OAuthInitiateResponse>(`/oauth/${service}/initiate`, options, {
        fallbackMessage: `Failed to initiate OAuth for ${service}`,
      });
      return res.data;
    },

    /** POST `/oauth/:service/callback` — exchange the callback code for tokens. (both web + desktop) */
    callback: async (service: string, callbackData: OAuthCallbackRequest): Promise<OAuthCallbackResponse> => {
      const res = await http.post<OAuthCallbackResponse>(`/oauth/${service}/callback`, callbackData, {
        fallbackMessage: `Failed to handle OAuth callback for ${service}`,
      });
      return res.data;
    },

    /** POST `/oauth/refresh` — refresh a connector account's OAuth tokens. (WEB-ONLY) */
    refresh: async (connectorAccountId: string): Promise<{ success: boolean }> => {
      const res = await http.post<{ success: boolean }>(
        '/oauth/refresh',
        { connectorAccountId },
        { fallbackMessage: 'Failed to refresh OAuth tokens' },
      );
      return res.data;
    },

    /**
     * POST `/oauth/install/:service` — redeem a marketplace-initiated ("inbound") install: exchange
     * the one-time `code` and stash the tokens under a single-use `installId`. Called (pre-auth) by
     * the public `/oauth/install/[service]` web page the marketplace redirects to. (WEB-ONLY)
     */
    redeemInboundInstall: async (service: string, code: string): Promise<RedeemInboundInstallResponse> => {
      const res = await http.post<RedeemInboundInstallResponse>(
        `/oauth/install/${service}`,
        { code },
        { fallbackMessage: 'This install link is invalid or has expired' },
      );
      return res.data;
    },

    /**
     * GET `/oauth/pending-install/:installId` — metadata for a marketplace-initiated ("inbound")
     * install awaiting claim (never returns tokens). Powers the `/connect/[service]` claim page.
     * (WEB-ONLY)
     */
    getPendingInstall: async (installId: string): Promise<PendingOAuthInstallInfo> => {
      const res = await http.get<PendingOAuthInstallInfo>(`/oauth/pending-install/${installId}`, {
        fallbackMessage: 'This install link is invalid or has expired',
      });
      return res.data;
    },

    /**
     * POST `/oauth/pending-install/:installId/claim` — the signed-in user claims an inbound install;
     * the server auto-creates a workbook and moves the stashed tokens into a real connection.
     * (WEB-ONLY)
     */
    claimPendingInstall: async (installId: string): Promise<ClaimInboundInstallResponse> => {
      const res = await http.post<ClaimInboundInstallResponse>(`/oauth/pending-install/${installId}/claim`, undefined, {
        fallbackMessage: 'Failed to finish connecting your account',
      });
      return res.data;
    },
  };
}

export type OauthApi = ReturnType<typeof createOauthApi>;
