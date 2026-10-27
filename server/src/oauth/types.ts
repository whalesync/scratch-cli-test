import { OAuthStatePayload } from '@spinner/shared-types';

/**
 * The server-side record of an in-flight OAuth connect, written by `initiateOAuth` and
 * consumed exactly once by `handleOAuthCallback` (see OAuthPendingAuthorizationStore).
 * It never leaves the server: the OAuth `state` only carries the nonce it is stored under
 * plus the public routing fields in `OAuthStatePayload` (shared-types). The callback acts on
 * this record alone, and only checks the state's routing fields against the copy kept here.
 */
export type PendingOAuthAuthorization = {
  userId: string;
  organizationId: string;
  workbookId: string;
  service: string;
  connectionMethod: 'OAUTH_SYSTEM' | 'OAUTH_CUSTOM';
  customClientId?: string;
  customClientSecret?: string;
  connectionName?: string;
  /** Set on a re-auth: the connection to re-mint. Verified against `workbookId` and `service` at initiate. */
  connectorAccountId?: string;
  quickbooksSandbox?: boolean;
  zohoDataCenter?: string; // Zoho multi-DC: US | EU | IN | AU | JP | CA | CN | SA
  salesforceSandbox?: boolean; // Salesforce: sign in and exchange the code at test.salesforce.com
  youtubeAdditionalChannels?: string; // YouTube: raw extra channel-id list (parsed into extras.additionalChannels)
  googleSheetsSpreadsheetUrls?: string; // Google Sheets: raw spreadsheet URL/id list (parsed into extras.spreadsheetIds)
  /** PKCE verifier (Airtable). Kept server-side so it never travels with the authorization code. */
  codeVerifier?: string;
  // Which OAuth *app* generation this flow authorizes against. Chosen at initiate; the
  // callback stamps it on the connection.
  oauthAppVersion: number;
  /**
   * The public routing fields exactly as written into the state. The callback rejects a
   * state whose fields differ — anything else means it was edited on the way back.
   */
  publicRoutingFieldsAsMinted: Omit<OAuthStatePayload, 'pendingAuthorizationNonce'>;
};
