export type OAuthStatePayload = {
  /**
   * Absolute URL the OAuth callback forwards the result to once the provider redirects back — the
   * "exit". Web: `${origin}/oauth/callback-step-2`. Desktop: `scratch://oauth-callback`. Whalesync
   * (Live Export): its own landing page. NEVER the OAuth redirect_uri / connector callback itself,
   * or the handler would forward to itself.
   *
   * Required on every state minted now, but typed optional because the callback decodes an
   * arbitrary base64 `state` off the URL: a malformed or pre-cutoff state can genuinely lack it,
   * and the callback must guard rather than trust the type.
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
  /**
   * Web-only: in-app path to land on after the connection completes (read at
   * `/oauth/callback-step-2`). Never a forward target — that is `resultForwardUrl`.
   */
  returnPage?: string;
  connectorAccountId?: string; // used to identify the connector account to reauthorize
  quickbooksSandbox?: boolean;
  zohoDataCenter?: string; // Zoho multi-DC: US | EU | IN | AU | JP | CA | CN | SA
  youtubeAdditionalChannels?: string; // YouTube: raw extra channel-id list (parsed into extras.additionalChannels)
  googleSheetsSpreadsheetUrls?: string; // Google Sheets: raw spreadsheet URL/id list (parsed into extras.spreadsheetIds)
  codeVerifier?: string;
  // Which OAuth *app* generation this flow is authorizing against. Chosen at initiate and
  // echoed back so the code exchange uses the same app's credentials and the connection is
  // stamped with it. Optional for back-compat with states minted before this field existed.
  // The frontend forwards it opaquely and never reads it.
  oauthAppVersion?: number;
  ts: number;
};
