import { AuditLogEvent, Subscription } from '@prisma/client';
import { SubscriptionAdminDetails } from '@spinner/shared-types';
import { AuditLogEventEntity } from 'src/audit/entities/audit-log-event.entity';
import { UserCluster, WorkbookCluster } from 'src/db/cluster-types';
import { getLastestExpiringSubscription } from 'src/payment/helpers';
import { ConnectorAccount } from 'src/remote-service/connector-account/entities/connector-account.entity';
import { User } from 'src/users/entities/user.entity';

export class DataFolderSummary {
  id: string;
  name: string;
  connectorService: string | null;
  path: string | null;
  lock: string | null;
  options: Record<string, unknown> | null;

  constructor(dataFolder: WorkbookCluster.DataFolder) {
    this.id = dataFolder.id;
    this.name = dataFolder.name;
    this.connectorService = dataFolder.connectorAccount?.service?.toString() ?? null;
    this.path = dataFolder.path;
    this.lock = dataFolder.lock;
    this.options = dataFolder.options as Record<string, unknown> | null;
  }
}

export class WorkbookSummary {
  id: string;
  name: string;
  numTables: number;
  isPendingDelete: boolean;
  /** True when the target user is the workbook's creator/owner; false when they only have access via a shared workspace permission. */
  isOwnedByUser: boolean;
  /** Number of users the workbook is shared with beyond its owner (0 for a private, unshared workbook). */
  sharedWithUserCount: number;
  /** Of those shared-with users, how many are non-org (external) — their organization differs from the workbook's. */
  nonOrgUserCount: number;
  connections: ConnectionSummary[];
  dataFolders: DataFolderSummary[];

  constructor(
    workbook: WorkbookCluster.Workbook,
    connections: ConnectorAccount[],
    isOwnedByUser: boolean,
    sharedAccessCounts: { sharedWithUserCount: number; nonOrgUserCount: number },
  ) {
    this.id = workbook.id;
    this.name = workbook.name ?? 'Unnamed snapshot';
    this.numTables = workbook.dataFolders.length;
    this.isPendingDelete = workbook.isPendingDelete;
    this.isOwnedByUser = isOwnedByUser;
    this.sharedWithUserCount = sharedAccessCounts.sharedWithUserCount;
    this.nonOrgUserCount = sharedAccessCounts.nonOrgUserCount;
    this.connections = connections.map((c) => new ConnectionSummary(c));
    this.dataFolders = workbook.dataFolders.map((df) => new DataFolderSummary(df));
  }
}

export class ConnectionSummary {
  id: string;
  name: string;
  service: string;
  workbookId: string | null;
  createdAt: Date;

  constructor(connectorAccount: ConnectorAccount) {
    this.id = connectorAccount.id;
    this.name = connectorAccount.displayName;
    this.service = connectorAccount.service.toString();
    this.workbookId = connectorAccount.workbookId;
    this.createdAt = connectorAccount.createdAt;
  }
}

/**
 * An admin view of a user for display in the developer tools
 */
export class UserDetail {
  user: User;
  workbooks: WorkbookSummary[];
  auditLogs: AuditLogEventEntity[];
  /**
   * Number of workspaces a hard-delete of this user would delete that are shared with external (non-org)
   * users who would therefore lose access. Non-zero only when the user is the sole member of their
   * organization (hard-delete then removes the whole org and every workbook it owns).
   */
  externallySharedWorkspaceCountLostOnHardDelete: number;
  subscriptionDetails: SubscriptionAdminDetails | null;

  constructor(
    user: UserCluster.User,
    workspaces: WorkbookCluster.Workbook[],
    connectors: ConnectorAccount[],
    auditLogs: AuditLogEvent[],
    sharedAccessCountsByWorkbookId: Map<string, { sharedWithUserCount: number; nonOrgUserCount: number }>,
    externallySharedWorkspaceCountLostOnHardDelete: number,
  ) {
    this.user = new User(user);
    this.externallySharedWorkspaceCountLostOnHardDelete = externallySharedWorkspaceCountLostOnHardDelete;
    this.subscriptionDetails = toSubscriptionAdminDetails(user.organization?.subscriptions ?? []);

    const connectionsByWorkbook = new Map<string, ConnectorAccount[]>();
    for (const connector of connectors) {
      const list = connectionsByWorkbook.get(connector.workbookId) ?? [];
      list.push(connector);
      connectionsByWorkbook.set(connector.workbookId, list);
    }

    this.workbooks = workspaces.map((workbook) => {
      const isOwnedByUser = workbook.userId === user.id;
      const sharedAccessCounts = sharedAccessCountsByWorkbookId.get(workbook.id) ?? {
        sharedWithUserCount: 0,
        nonOrgUserCount: 0,
      };
      return new WorkbookSummary(
        workbook,
        connectionsByWorkbook.get(workbook.id) ?? [],
        isOwnedByUser,
        sharedAccessCounts,
      );
    });
    this.auditLogs = auditLogs.map((auditLog) => new AuditLogEventEntity(auditLog));
  }
}

/**
 * Admin-only extra subscription detail for the dev-tools User Details panel. Maps the user's
 * latest-expiring raw subscription row straight through — this is deliberately kept off the shared
 * `SubscriptionInfo` (built in the `User` constructor and sent on every user payload). Returns
 * `null` when the user has no real subscription (the synthetic Free plan has no backing row).
 */
function toSubscriptionAdminDetails(subscriptions: Subscription[]): SubscriptionAdminDetails | null {
  const latestExpiringSubscription = getLastestExpiringSubscription(subscriptions);
  if (!latestExpiringSubscription) {
    return null;
  }
  return {
    createdAt: latestExpiringSubscription.createdAt.toISOString(),
    updatedAt: latestExpiringSubscription.updatedAt.toISOString(),
    stripeStatus: latestExpiringSubscription.stripeStatus,
    expiration: latestExpiringSubscription.expiration.toISOString(),
    cancelAt: latestExpiringSubscription.cancelAt ? latestExpiringSubscription.cancelAt.toISOString() : null,
    metadata: (latestExpiringSubscription.metadata ?? null) as Record<string, unknown> | null,
  };
}
