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
  connections: ConnectionSummary[];
  dataFolders: DataFolderSummary[];
}

/** An admin view of a user for the developer tools (`GET /dev-tools/users/:id/details`). */
export interface UserDetails {
  user: User;
  workbooks: WorkbookSummary[];
  auditLogs: AuditLogEvent[];
}
