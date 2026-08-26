/**
 * NOTE: Keep in sync with packages/shared-types/src/dto/oauth/oauth-state-payload.ts:OAuthStatePayload.
 */
export type OAuthStatePayload = {
  /**
   * Absolute URL the OAuth callback forwards the result to (the "exit"): web
   * `${origin}/oauth/callback-step-2`, desktop `scratch://oauth-callback`, Whalesync its own landing
   * page. Never the OAuth redirect_uri itself. Required on every state minted now, but typed
   * optional because the callback decodes an arbitrary base64 `state` off the URL.
   */
  resultForwardUrl?: string;
  userId: string;
  organizationId: string;
  workbookId: string;
  service: string;
  connectionMethod: 'OAUTH_SYSTEM' | 'OAUTH_CUSTOM';
  customClientId?: string;
  customClientSecret?: string;
  connectionName?: string;
  returnPage?: string;
  connectorAccountId?: string;
  quickbooksSandbox?: boolean;
  zohoDataCenter?: string; // Zoho multi-DC: US | EU | IN | AU | JP | CA | CN | SA
  youtubeAdditionalChannels?: string; // YouTube: raw extra channel-id list (parsed into extras.additionalChannels)
  googleSheetsSpreadsheetUrls?: string; // Google Sheets: raw spreadsheet URL/id list (parsed into extras.spreadsheetIds)
  codeVerifier?: string;
  // Which OAuth *app* generation this flow authorizes against. Chosen at initiate; the
  // callback stamps it on the connection. Optional for back-compat with pre-feature states.
  oauthAppVersion?: number;
  ts: number;
};
