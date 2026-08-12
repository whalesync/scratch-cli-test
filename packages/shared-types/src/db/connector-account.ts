import { AuthType, ConnectorHealthStatus } from '../enums';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma ConnectorAccount model.
/// EXCEPTION: `encryptedCredentials` is intentionally NOT exposed on the wire (DEV-11011 /
/// SCR-016). The encrypted credential envelope — and any decrypted secrets — must never leave
/// the server. The server projects rows through `ConnectorAccountEntity.from()` (an allowlist)
/// that drops this secret column, so do NOT "resync" it back onto this interface. The only
/// sanctioned outbound path for credentials is the admin-gated, audited `…/credentials/reveal`
/// endpoint.
/// Begin "keep in sync" section
///

export interface ConnectorAccount {
  id: string; // ConnectorAccountId
  createdAt: string; // DateTime
  updatedAt: string; // DateTime
  userId: string; // Uuid
  workbookId: string; // WorkbookId
  service: string;
  displayName: string;
  healthStatus: ConnectorHealthStatus | null;
  healthStatusLastCheckedAt: string | null; // DateTime
  healthStatusMessage: string | null; // Message if health status is not OK
  modifier: string | null; // ID of the custom connector or other modifier entity
  extras: Record<string, unknown> | null; // Additional service-specific configuration
  version: number; // Connector code version snapshotted at creation (DEV-10302)
  authType: AuthType;
  repoPath: string | null;
}

///
/// End "keep in sync" section
///
