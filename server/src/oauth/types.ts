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
  codeVerifier?: string;
  ts: number;
};
