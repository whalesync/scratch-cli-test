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
  codeVerifier?: string;
  ts: number;
};
