import { AuditLogEvent } from '../../db/audit-log-event';
import { User } from '../../db/user';

/** Admin (dev-tools) summaries embedded in {@link UserDetails}. */
export interface DataFolderSummary {
  name: string;
  connectorService: string | null;
  path: string | null;
  lock: string | null;
  options: Record<string, unknown> | null;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  service: string;
  workbookId: string | null;
  createdAt: string;
}

export interface WorkbookSummary {
  id: string;
  name: string;
  numTables: number;
  isPendingDelete: boolean;
  /** True when the target user owns the workbook; false when they only have access via a shared workspace permission. */
  isOwnedByUser: boolean;
  /** Number of users the workbook is shared with beyond its owner (0 for a private, unshared workbook). */
  sharedWithUserCount: number;
  /** Of those shared-with users, how many are non-org (external) — their organization differs from the workbook's. */
  nonOrgUserCount: number;
  connections: ConnectionSummary[];
  dataFolders: DataFolderSummary[];
}

/** An admin view of a user for the developer tools (`GET /dev-tools/users/:id/details`). */
export interface UserDetails {
  user: User;
  workbooks: WorkbookSummary[];
  auditLogs: AuditLogEvent[];
  /**
   * Number of workspaces a hard-delete of this user would delete that are shared with external (non-org)
   * users who would therefore lose access. Non-zero only when the user is the sole member of their
   * organization (hard-delete then removes the whole org and every workbook it owns).
   */
  externallySharedWorkspaceCountLostOnHardDelete: number;
}
