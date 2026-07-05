/**
 * NOTE: Keep in sync with packages/shared-types/src/dto/oauth/oauth-state-payload.ts:OAuthStatePayload.
 */
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
  connectorAccountId?: string;
  shopDomain?: string;
  quickbooksSandbox?: boolean;
  zohoDataCenter?: string; // Zoho multi-DC: US | EU | IN | AU | JP | CA | CN | SA
  youtubeAdditionalChannels?: string; // YouTube: raw extra channel-id list (parsed into extras.additionalChannels)
  codeVerifier?: string;
  // Which OAuth *app* generation this flow authorizes against. Chosen at initiate; the
  // callback stamps it on the connection. Optional for back-compat with pre-feature states.
  oauthAppVersion?: number;
  ts: number;
};
