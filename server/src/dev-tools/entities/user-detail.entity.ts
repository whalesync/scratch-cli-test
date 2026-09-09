import { AuditLogEvent } from '@prisma/client';
import { AuditLogEventEntity } from 'src/audit/entities/audit-log-event.entity';
import { UserCluster, WorkbookCluster } from 'src/db/cluster-types';
import { ConnectorAccount } from 'src/remote-service/connector-account/entities/connector-account.entity';
import { User } from 'src/users/entities/user.entity';

export class DataFolderSummary {
  name: string;
  connectorService: string | null;
  path: string | null;
  lock: string | null;
  options: Record<string, unknown> | null;

  constructor(dataFolder: WorkbookCluster.DataFolder) {
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
