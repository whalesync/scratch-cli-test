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
  /** @deprecated Equivalent to FULL_PULL. Retained for runtime tolerance until the enum value is dropped. */
  PULL = 'PULL',
  FULL_PULL = 'FULL_PULL',
  INCREMENTAL_PULL = 'INCREMENTAL_PULL',
  PUBLISH = 'PUBLISH',
  SYNC = 'SYNC',
}

export enum TableDiscoveryMode {
  LIST = 'LIST',
  SEARCH = 'SEARCH',
}

/**
 * Per-folder incremental-pull capability, computed by the server REST API for
 * each DataFolder. NOT a Prisma enum — this is a derived value, distinct from
 * the static per-connector `ConnectorMetadata.incrementalPull` flag (which only
 * says whether the connector TYPE can ever do incremental pulls).
 *
 * - SUPPORTED: the connector supports incremental pulls and this folder is
 *   ready to run one (a last-modified field is explicitly configured or
 *   auto-detected from the table schema).
 * - NEEDS_CONFIGURATION: the connector supports incremental pulls but this
 *   folder is missing the required configuration (e.g. no `modifiedAtField` set
 *   and none detectable in the schema). Configuring it would unlock incremental.
 * - NOT_SUPPORTED: this connector/table cannot do incremental pulls at all.
 */
export enum IncrementalPullSupport {
  SUPPORTED = 'SUPPORTED',
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  NEEDS_CONFIGURATION = 'NEEDS_CONFIGURATION',
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
