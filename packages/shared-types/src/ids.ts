import findKey from 'lodash/findKey';
import { customAlphabet } from 'nanoid';

/**
 * The prefix at the front of a database ID.
 * Each will prefix a db id like: "usr_1hk6pq6rlq5ksyfh"
 * When adding a new one:
 *  - Add a new entry to this enum: 3 lowercase letters plus underscore
 *  - Add the type, is*Id(), and create*Id() functions below
 *  - Add the generator for it below
 */
export enum IdPrefixes {
  USER = 'usr_',
  API_TOKEN = 'atk_',
  CONNECTOR_ACCOUNT = 'coa_',
  WORKBOOK = 'wkb_',
  SNAPSHOT_RECORD = 'sre_',
  VIEW = 'vew_',
  AI_AGENT_CREDENTIAL = 'aac_',
  AI_AGENT_TOKEN_USAGE_EVENT = 'uev_',
  SUBSCRIPTION = 'sub_',
  INVOICE_RESULT = 'inv_',
  AUDIT_LOG_EVENT = 'ael_', // Audit log event
  ORGANIZATION = 'org_', // Organization
  JOB = 'job_', // Job
  ACTION = 'act_', // Action
  DATA_FOLDER = 'dfd_', // Data folder
  AUTHORIZATION_CODE = 'aut_', // Authorization code for CLI login
  SYNC = 'syn_', // Sync
  SYNC_TABLE_PAIR = 'stp_', // Pair of source=>destination tables in a Sync
  SCHEDULE = 'sch_', // Schedule
  SCRATCH_PENDING_PUBLISH = 'scratch_pending_publish_', // Temporary ID for sync-created records before publishing
  RUN = 'run_', // Run
  WORKSPACE_PERMISSION = 'wpe_', // Workspace permission
}

type PrefixedId<T extends IdPrefixes> = `${T}${string}`;

export type IdType = keyof typeof IdPrefixes;

export type AnyId = PrefixedId<IdPrefixes>;

const ID_RANDOM_LENGTH = 10;
const ID_LENGTH = ID_RANDOM_LENGTH + 4; /* prefix with underscore */

export function isId(id: unknown, prefix: IdPrefixes): boolean {
  return typeof id === 'string' && id.length === ID_LENGTH && id.startsWith(prefix);
}

// Normal alphabet without - or _ so it can be selected in text editors more easily.
const alphabet: string = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const nanoid = customAlphabet(alphabet, ID_RANDOM_LENGTH);

export function createId(prefix: IdPrefixes): string {
  return `${prefix}${nanoid()}`;
}

export function createPlainId(length?: number): string {
  return length ? nanoid(length) : nanoid();
}

export function typeForId(id: AnyId): IdType | null {
  return (findKey(IdPrefixes, (value) => id.startsWith(value)) as IdType) ?? null;
}

// ------- Users -------
export type UserId = PrefixedId<IdPrefixes.USER>;

export function isUserId(id: unknown): id is UserId {
  return isId(id, IdPrefixes.USER);
}

export function createUserId(): UserId {
  return createId(IdPrefixes.USER) as UserId;
}

// ------- API Tokens -------
export type ApiTokenId = PrefixedId<IdPrefixes.API_TOKEN>;

export function isApiTokenId(id: unknown): id is ApiTokenId {
  return isId(id, IdPrefixes.API_TOKEN);
}

export function createApiTokenId(): ApiTokenId {
  return createId(IdPrefixes.API_TOKEN) as ApiTokenId;
}

// ------- ConnectorAccount -------
export type ConnectorAccountId = PrefixedId<IdPrefixes.CONNECTOR_ACCOUNT>;

export function isConnectorAccountId(id: unknown): id is ConnectorAccountId {
  return isId(id, IdPrefixes.CONNECTOR_ACCOUNT);
}

export function createConnectorAccountId(): ConnectorAccountId {
  return createId(IdPrefixes.CONNECTOR_ACCOUNT) as ConnectorAccountId;
}

// ------- Workbook -------
export type WorkbookId = PrefixedId<IdPrefixes.WORKBOOK>;

export function isWorkbookId(id: unknown): id is WorkbookId {
  return isId(id, IdPrefixes.WORKBOOK) || isId(id, 'sna_' as IdPrefixes /* Legacy migration */);
}

export function createWorkbookId(): WorkbookId {
  return createId(IdPrefixes.WORKBOOK) as WorkbookId;
}

// ------- SnapshotRecord -------
/**
 * @deprecated
 */
export type SnapshotRecordId = PrefixedId<IdPrefixes.SNAPSHOT_RECORD>;

/**
 * @deprecated
 */
export function isSnapshotRecordId(id: unknown): id is SnapshotRecordId {
  return isId(id, IdPrefixes.SNAPSHOT_RECORD);
}

/**
 * @deprecated
 */
export function createSnapshotRecordId(): SnapshotRecordId {
  return createId(IdPrefixes.SNAPSHOT_RECORD) as SnapshotRecordId;
}

// ------- AiAgentCredential -------
export type AiAgentCredentialId = PrefixedId<IdPrefixes.AI_AGENT_CREDENTIAL>;

export function isAiAgentCredentialId(id: unknown): id is AiAgentCredentialId {
  return isId(id, IdPrefixes.AI_AGENT_CREDENTIAL);
}

export function createAiAgentCredentialId(): AiAgentCredentialId {
  return createId(IdPrefixes.AI_AGENT_CREDENTIAL) as AiAgentCredentialId;
}

// ------- AiAgentTokenUsageEvent -------
export type AiAgentTokenUsageEventId = PrefixedId<IdPrefixes.AI_AGENT_TOKEN_USAGE_EVENT>;

export function isAiAgentTokenUsageEventId(id: unknown): id is AiAgentTokenUsageEventId {
  return isId(id, IdPrefixes.AI_AGENT_TOKEN_USAGE_EVENT);
}

export function createAiAgentTokenUsageEventId(): AiAgentTokenUsageEventId {
  return createId(IdPrefixes.AI_AGENT_TOKEN_USAGE_EVENT) as AiAgentTokenUsageEventId;
}

// ------- Subscription -------
export type SubscriptionId = PrefixedId<IdPrefixes.SUBSCRIPTION>;

export function isSubscriptionId(id: unknown): id is SubscriptionId {
  return isId(id, IdPrefixes.SUBSCRIPTION);
}

export function createSubscriptionId(): SubscriptionId {
  return createId(IdPrefixes.SUBSCRIPTION) as SubscriptionId;
}

// ------- InvoiceResult -------
export type InvoiceResultId = PrefixedId<IdPrefixes.INVOICE_RESULT>;

export function isInvoiceResultId(id: unknown): id is InvoiceResultId {
  return isId(id, IdPrefixes.INVOICE_RESULT);
}

export function createInvoiceResultId(): InvoiceResultId {
  return createId(IdPrefixes.INVOICE_RESULT) as InvoiceResultId;
}

// ------- AuditLogEvent -------
export type AuditLogEventId = PrefixedId<IdPrefixes.AUDIT_LOG_EVENT>;

export function isAuditLogEventId(id: unknown): id is AuditLogEventId {
  return isId(id, IdPrefixes.AUDIT_LOG_EVENT);
}

export function createAuditLogEventId(): AuditLogEventId {
  return createId(IdPrefixes.AUDIT_LOG_EVENT) as AuditLogEventId;
}

// ------- Organization -------
export type OrganizationId = PrefixedId<IdPrefixes.ORGANIZATION>;

export function isOrganizationId(id: unknown): id is OrganizationId {
  return isId(id, IdPrefixes.ORGANIZATION);
}

export function createOrganizationId(): OrganizationId {
  return createId(IdPrefixes.ORGANIZATION) as OrganizationId;
}

// ------- Job -------
export type JobId = PrefixedId<IdPrefixes.JOB>;

export function isJobId(id: unknown): id is JobId {
  return isId(id, IdPrefixes.JOB);
}

export function createJobId(): JobId {
  return createId(IdPrefixes.JOB) as JobId;
}

// ------- Action -------
export type ActionId = PrefixedId<IdPrefixes.ACTION>;

export function isActionId(id: unknown): id is ActionId {
  return isId(id, IdPrefixes.ACTION);
}

export function createActionId(): ActionId {
  return createId(IdPrefixes.ACTION) as ActionId;
}

// ------- DataFolder -------
export type DataFolderId = PrefixedId<IdPrefixes.DATA_FOLDER>;

export function isDataFolderId(id: unknown): id is DataFolderId {
  return isId(id, IdPrefixes.DATA_FOLDER);
}

export function createDataFolderId(): DataFolderId {
  return createId(IdPrefixes.DATA_FOLDER) as DataFolderId;
}

// ------- AuthorizationCode -------
export type AuthorizationCodeId = PrefixedId<IdPrefixes.AUTHORIZATION_CODE>;

export function isAuthorizationCodeId(id: unknown): id is AuthorizationCodeId {
  return isId(id, IdPrefixes.AUTHORIZATION_CODE);
}

export function createAuthorizationCodeId(): AuthorizationCodeId {
  return createId(IdPrefixes.AUTHORIZATION_CODE) as AuthorizationCodeId;
}

// ------- Sync -------
export type SyncId = PrefixedId<IdPrefixes.SYNC>;

export function isSyncId(id: unknown): id is SyncId {
  return isId(id, IdPrefixes.SYNC);
}

export function createSyncId(): SyncId {
  return createId(IdPrefixes.SYNC) as SyncId;
}

// ------- Sync Table Pairs -------
export type SyncTablePairId = PrefixedId<IdPrefixes.SYNC_TABLE_PAIR>;

export function isSyncTablePairId(id: unknown): id is SyncTablePairId {
  return isId(id, IdPrefixes.SYNC_TABLE_PAIR);
}

export function createSyncTablePairId(): SyncTablePairId {
  return createId(IdPrefixes.SYNC_TABLE_PAIR) as SyncTablePairId;
}

// ------- Schedule -------
export type ScheduleId = PrefixedId<IdPrefixes.SCHEDULE>;

export function isScheduleId(id: unknown): id is ScheduleId {
  return isId(id, IdPrefixes.SCHEDULE);
}

export function createScheduleId(): ScheduleId {
  return createId(IdPrefixes.SCHEDULE) as ScheduleId;
}

// ------- Scratch Pending Publish -------
// Temporary ID for sync-created destination records before they are published to a connector.
// The connector will assign a real ID when the record is published.
export type ScratchPendingPublishId = PrefixedId<IdPrefixes.SCRATCH_PENDING_PUBLISH>;

export function isScratchPendingPublishId(id: unknown): id is ScratchPendingPublishId {
  // Can't use isId() since length differs from standard IDs due to longer prefix
  return typeof id === 'string' && id.startsWith(IdPrefixes.SCRATCH_PENDING_PUBLISH);
}

export function createScratchPendingPublishId(): ScratchPendingPublishId {
  return createId(IdPrefixes.SCRATCH_PENDING_PUBLISH) as ScratchPendingPublishId;
}

// ------- Run -------
export type RunId = PrefixedId<IdPrefixes.RUN>;

export function isRunId(id: unknown): id is RunId {
  return isId(id, IdPrefixes.RUN);
}

export function createRunId(): RunId {
  return createId(IdPrefixes.RUN) as RunId;
}

// ------- WorkspacePermission -------
export type WorkspacePermissionId = PrefixedId<IdPrefixes.WORKSPACE_PERMISSION>;

export function isWorkspacePermissionId(id: unknown): id is WorkspacePermissionId {
  return isId(id, IdPrefixes.WORKSPACE_PERMISSION);
}

export function createWorkspacePermissionId(): WorkspacePermissionId {
  return createId(IdPrefixes.WORKSPACE_PERMISSION) as WorkspacePermissionId;
}
