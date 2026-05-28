import { PublishPlanStatus } from '../../enums/enums';

export { PublishPlanStatus };

// ── Request DTOs ──────────────────────────────────────────────────────────────

export interface PublishPlanBuildDto {
  connectorAccountId?: string;
  runAfterPlan?: boolean;
  folderPath?: string;
  filePath?: string;
}

export interface PublishPlanRunDto {
  pipelineId: string;
  executeSinglePhase?: boolean;
}

// ── Response Entities ─────────────────────────────────────────────────────────

///
/// NOTE: Keep these in sync with server/prisma/schema.prisma
/// Begin "keep in sync" section
///

export interface PublishPlanOperationEntity {
  id: string;
  planId: string;
  filePath: string;
  phase: string; // "create" | "edit" | "delete" | "backfill"
  content: unknown;
  changedFields?: unknown;
  remoteRecordId: string | null;
  remoteTableId: string | null;
  dataFolderId: string | null;
  status: string; // "pending" | "success" | "failed-batch"
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishPlanJobEntity {
  id: string | number | null;
  name?: string;
  status: string; // normalized from bullJob.state or dbJob.status
  progress?: unknown;
  data?: unknown;
  state?: string;
  failedReason?: string;
  stacktrace?: string[];
  type?: string;
}

export interface PublishPlanEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
  workbookId: string;
  userId: string;
  status: PublishPlanStatus;
  branchName: string;
  preDirtyCommitSha: string | null;
  preMainCommitSha: string | null;
  postMainCommitSha: string | null;
  result: unknown;
  activeJobId: string | null;
  connectorAccountId: string | null;
  connectorAccount?: { id: string; displayName: string; service: string } | null;
  authorId: string | null;
  author?: { id: string; name: string | null; email: string | null } | null;
  _count: { operations: number };
  dbJob: { status: string; type: string; progress: unknown } | null;
  bullJob: Record<string, unknown> | null;
  job: PublishPlanJobEntity | null;
}

export interface PublishPlanRecordRow {
  filePath: string;
  dataFolderId: string | null;
  phases: string[];
  hasError: boolean;
}

export interface PublishPlanRecordsResponse {
  data: PublishPlanRecordRow[];
  total: number;
  page: number;
  pageSize: number;
  filters: {
    folders: { id: string; path: string; count: number }[];
    phases: { phase: string; count: number }[];
  };
}

///
/// End "keep in sync" section
///
