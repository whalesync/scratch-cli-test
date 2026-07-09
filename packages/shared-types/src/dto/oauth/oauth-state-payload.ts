export type OAuthStatePayload = {
  /**
   * Absolute URL the OAuth callback forwards the result to once the provider redirects back — the
   * "exit". Web: `${origin}/oauth/callback-step-2`. Desktop: `scratch://oauth-callback`. Whalesync
   * (Live Export): its own landing page. NEVER the OAuth redirect_uri / connector callback itself,
   * or the handler would forward to itself. Replaces `redirectPrefix` and the legacy desktop use of
   * `returnPage`; optional for back-compat with states minted before it existed.
   */
  resultForwardUrl?: string;
  /**
   * @deprecated Origin-only precursor to `resultForwardUrl` (`(http|https)://host(:port)`), from
   * which the callback reconstructs the web exit by appending its known path. Still required — every
   * initiator still sends it during the transition; it becomes optional and is removed at cutoff.
   */
  redirectPrefix: string;
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
   * `/oauth/callback-step-2`). NOTE: legacy desktop callers also pass a `scratch://…` deep link here
   * as the forward target — that legacy usage is superseded by `resultForwardUrl`.
   */
  returnPage?: string;
  connectorAccountId?: string; // used to identify the connector account to reauthorize
  quickbooksSandbox?: boolean;
  zohoDataCenter?: string; // Zoho multi-DC: US | EU | IN | AU | JP | CA | CN | SA
  youtubeAdditionalChannels?: string; // YouTube: raw extra channel-id list (parsed into extras.additionalChannels)
  codeVerifier?: string;
  // Which OAuth *app* generation this flow is authorizing against. Chosen at initiate and
  // echoed back so the code exchange uses the same app's credentials and the connection is
  // stamped with it. Optional for back-compat with states minted before this field existed.
  // The frontend forwards it opaquely and never reads it.
  oauthAppVersion?: number;
  ts: number;
};
