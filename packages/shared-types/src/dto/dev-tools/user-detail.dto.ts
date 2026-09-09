import { AuditLogEvent } from '../../db/audit-log-event';
import { User } from '../../db/user';

/** Admin (dev-tools) summaries embedded in {@link UserDetails}. */
export interface DataFolderSummary {
  id: string;
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

/**
 * Admin-only extra detail about a user's current subscription row, populated ONLY by
 * `GET /dev-tools/users/:id/details`. Deliberately NOT part of the shared `SubscriptionInfo`,
 * which rides the general `User` payload (`/me`, auth, desktop) and must not expose this.
 * `null` when the user has no real subscription (the synthetic Free plan).
 */
export interface SubscriptionAdminDetails {
  /** ISO-8601 when the subscription row was created. */
  createdAt: string;
  /** ISO-8601 of the subscription row's last update. */
  updatedAt: string;
  /** Raw Stripe subscription status, e.g. "trialing", "active", "past_due". Null when unknown. */
  stripeStatus: string | null;
  /** ISO-8601 expiration / current-period-end of the subscription. */
  expiration: string;
  /** ISO-8601 date the cancellation takes effect, when the subscription is set to cancel; null otherwise. */
  cancelAt: string | null;
  /** Ad-hoc key-value metadata stored on the subscription (e.g. the Whalesync shadow-subscription blob). */
  metadata: Record<string, unknown> | null;
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
  subscriptionDetails: SubscriptionAdminDetails | null;
}
