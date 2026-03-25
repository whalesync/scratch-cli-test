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
  connections: ConnectionSummary[];
  dataFolders: DataFolderSummary[];

  constructor(workbook: WorkbookCluster.Workbook, connections: ConnectorAccount[]) {
    this.id = workbook.id;
    this.name = workbook.name ?? 'Unnamed snapshot';
    this.numTables = workbook.dataFolders.length;
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

  constructor(
    user: UserCluster.User,
    workspaces: WorkbookCluster.Workbook[],
    connectors: ConnectorAccount[],
    auditLogs: AuditLogEvent[],
  ) {
    this.user = new User(user);

    const connectionsByWorkbook = new Map<string, ConnectorAccount[]>();
    for (const connector of connectors) {
      const list = connectionsByWorkbook.get(connector.workbookId) ?? [];
      list.push(connector);
      connectionsByWorkbook.set(connector.workbookId, list);
    }

    this.workbooks = workspaces.map(
      (workbook) => new WorkbookSummary(workbook, connectionsByWorkbook.get(workbook.id) ?? []),
    );
    this.auditLogs = auditLogs.map((auditLog) => new AuditLogEventEntity(auditLog));
  }
}
