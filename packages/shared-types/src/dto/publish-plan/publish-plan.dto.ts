// ── Request DTOs ──────────────────────────────────────────────────────────────

export interface PublishPlanBuildDto {
  connectorAccountId?: string;
  runAfterPlan?: boolean;
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
  status: string;
  branchName: string;
  result: unknown;
  activeJobId: string | null;
  connectorAccountId: string | null;
  _count: { operations: number };
  dbJob: { status: string; type: string; progress: unknown } | null;
  bullJob: Record<string, unknown> | null;
  job: PublishPlanJobEntity | null;
}

///
/// End "keep in sync" section
///
