/**
 * Shared enums between client and server.
 * Most of these mirror the Prisma schema enums in server/prisma/schema.prisma —
 * when adding/modifying one of those enums in the Prisma schema, update this file
 * accordingly. The exceptions are string-backed sets that are intentionally NOT
 * Prisma enums (the DB column is a plain `String`): `Service` and `ScheduleAction`.
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
  // Short-lived browser session tokens for Whalesync shadow users, brokered via Bottlenose.
  WHALESYNC_SESSION = 'WHALESYNC_SESSION',
}

export enum ConnectorHealthStatus {
  OK = 'OK',
  FAILED = 'FAILED',
}

/**
 * The external app that owns and manages a workbook, if any. A `null`
 * `Workspace.managedBy` means a standalone Scratch workbook (not managed by any
 * app); `ws_export` means it is managed by Whalesync's export (via dusky), which
 * constrains its config. Mirrors the `WorkbookManager` Prisma enum in
 * server/prisma/schema.prisma.
 */
export enum WorkbookManager {
  WS_EXPORT = 'ws_export',
}

export enum ActionType {
  PUBLISH = 'PUBLISH',
}

export enum SyncState {
  OFF = 'OFF',
  ON = 'ON',
}

/**
 * Schedule actions. Backed by a plain `String` column in the DB (no Prisma enum) —
 * the canonical set lives here as a const object so adding a new action needs no
 * migration. Mirrors the Service string-conversion pattern (DEV-10483). The
 * same-named derived union type below lets call sites use both `ScheduleAction.SYNC`
 * (value) and `action: ScheduleAction` (type).
 */
export const ScheduleAction = {
  /** @deprecated Equivalent to FULL_PULL. Retained for runtime tolerance. */
  PULL: 'PULL',
  FULL_PULL: 'FULL_PULL',
  INCREMENTAL_PULL: 'INCREMENTAL_PULL',
  /** Connection-wide full pull: entityId is a ConnectorAccountId; fans out to every linked table in the connection. */
  CONNECTION_FULL_PULL: 'CONNECTION_FULL_PULL',
  /** Connection-wide incremental pull: entityId is a ConnectorAccountId; fans out to every linked table in the connection. */
  CONNECTION_INCREMENTAL_PULL: 'CONNECTION_INCREMENTAL_PULL',
  PUBLISH: 'PUBLISH',
  SYNC: 'SYNC',
  /** Triggers a routine run. entityId is the routine file path. Execution lands in a later phase. */
  ROUTINE: 'ROUTINE',
} as const;

export type ScheduleAction = (typeof ScheduleAction)[keyof typeof ScheduleAction];

/** The action a single routine step performs. The wire values match the YAML `action:` field. */
export enum RoutineAction {
  /**
   * Pre-flight cleanup: discard any leftover working-set edits (the `dirty` branch) across the
   * workbook's connections so the run starts from the published baseline. Targets no folder/
   * connection — it always clears the whole workbook. Runs first in a generated sync routine so a
   * stray, never-published edit can't pollute the pull → sync → publish that follows.
   */
  DISCARD_PENDING_CHANGES = 'discard-pending-changes',
  PULL = 'pull',
  SYNC = 'sync',
  PUBLISH_PLAN = 'publish-plan',
  PUBLISH = 'publish',
}

/**
 * The high-level run-execution categories tracked per organization for monthly usage/billing
 * (see {@link OrganizationMonthlyRunCount} on the server and the Billing Usage panel). One bucket
 * per type per calendar month. Distinct from {@link RoutineAction}, which names a routine *step*:
 * a routine's pull/sync/publish steps are counted in BOTH their own type bucket and `ROUTINE`.
 */
export enum RunType {
  PULL = 'pull',
  PUBLISH = 'publish',
  SYNC = 'sync',
  ROUTINE = 'routine',
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
