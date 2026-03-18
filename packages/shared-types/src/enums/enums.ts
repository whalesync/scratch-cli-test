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
 * The const object below provides backward-compatible constants (Service.AIRTABLE still works).
 */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export const Service = {
  NOTION: 'NOTION',
  AIRTABLE: 'AIRTABLE',
  POSTGRES: 'POSTGRES',
  YOUTUBE: 'YOUTUBE',
  WORDPRESS: 'WORDPRESS',
  WEBFLOW: 'WEBFLOW',
  WIX_BLOG: 'WIX_BLOG',
  AUDIENCEFUL: 'AUDIENCEFUL',
  MOCO: 'MOCO',
  SHOPIFY: 'SHOPIFY',
  SUPABASE: 'SUPABASE',
  QUICKBOOKS: 'QUICKBOOKS',
  PIPEDRIVE: 'PIPEDRIVE',
} as const;
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
  AGENT = 'AGENT',
  WEBSOCKET = 'WEBSOCKET',
  USER = 'USER',
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
