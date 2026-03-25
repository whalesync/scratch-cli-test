import { AuditLogEvent } from '@spinner/shared-types';
import { User } from './users';

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
  connections: ConnectionSummary[];
  dataFolders: DataFolderSummary[];
}

/**
 * An admin view of a user for display in the developer tools
 */
export interface UserDetails {
  user: User;
  workbooks: WorkbookSummary[];
  auditLogs: AuditLogEvent[];
}
