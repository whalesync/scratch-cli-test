export type OAuthStatePayload = {
  redirectPrefix: string;
  userId: string;
  organizationId: string;
  workbookId: string;
  service: string;
  connectionMethod: 'OAUTH_SYSTEM' | 'OAUTH_CUSTOM';
  customClientId?: string;
  customClientSecret?: string;
  connectionName?: string;
  returnPage?: string;
  connectorAccountId?: string; // used to identify the connector account to reauthorize
  shopDomain?: string;
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
