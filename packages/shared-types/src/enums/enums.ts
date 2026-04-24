/**
 * Shared enums between client and server.
 * These enums mirror the Prisma schema enums in server/prisma/schema.prisma
 *
 * IMPORTANT: When adding/modifying enums in the Prisma schema, update this file accordingly.
 */

/**
 * Service is a string type. New connectors register via the connector registry
 * and no longer require a DB migration to add a new enum value.
 *
 * The const object with service key constants lives in the server:
 * server/src/remote-service/connectors/service-constants.ts
 */
export type Service = string;

export enum AuthType {
  API_KEY = 'API_KEY',
  OAUTH = 'OAUTH',
  USER_PROVIDED_PARAMS = 'USER_PROVIDED_PARAMS',
}

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum TokenType {
  WEBSOCKET = 'WEBSOCKET',
  USER = 'USER',
  MCP = 'MCP',
}

export enum ConnectorHealthStatus {
  OK = 'OK',
  FAILED = 'FAILED',
}

export enum ActionType {
  PUBLISH = 'PUBLISH',
}

export enum SyncState {
  OFF = 'OFF',
  ON = 'ON',
}

export enum ScheduleAction {
  PULL = 'PULL',
  PUBLISH = 'PUBLISH',
  SYNC = 'SYNC',
}

export enum TableDiscoveryMode {
  LIST = 'LIST',
  SEARCH = 'SEARCH',
}

export enum PublishPlanStatus {
  Planning = 'planning',
  Planned = 'planned',
  AssetUploadRunning = 'asset-upload-running',
  AssetUploadCompleted = 'asset-upload-completed',
  EditsRunning = 'edits-running',
  EditsCompleted = 'edits-completed',
  CreatesRunning = 'creates-running',
  CreatesCompleted = 'creates-completed',
  DeletesRunning = 'deletes-running',
  DeletesCompleted = 'deletes-completed',
  BackfillRunning = 'backfill-running',
  BackfillCompleted = 'backfill-completed',
  RenameFilesRunning = 'rename-files-running',
  Completed = 'completed',
  CompletedWithErrors = 'completed-with-errors',
  Failed = 'failed',
  Canceled = 'canceled',
}

/**
 * SendGrid dynamic template IDs.
 * Replace these placeholder values with real template IDs from the SendGrid dashboard.
 */
export enum EmailTemplate {
  WorkspaceInvite = 'd-d62ed43be3b64fb6b30d69cd3a1f3495',
  InviteAccepted = 'd-90e62f0837604ce782d130497c866d31',
  WaitlistApproved = 'd-58ff7ed006e3405ab0e71c0180fda91c',
}
