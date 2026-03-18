import { AuthType, ConnectorHealthStatus } from '../enums';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma ConnectorAccount model
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
  encryptedCredentials: Record<string, string>;
  healthStatus: ConnectorHealthStatus | null;
  healthStatusLastCheckedAt: string | null; // DateTime
  healthStatusMessage: string | null; // Message if health status is not OK
  modifier: string | null; // ID of the custom connector or other modifier entity
  extras: Record<string, unknown> | null; // Additional service-specific configuration
  authType: AuthType;
  repoPath: string | null;
}

///
/// End "keep in sync" section
///
