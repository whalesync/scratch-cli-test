/** Mirrors the server's Workbook entity, using "workspace" as the UI term. */
export interface Workspace {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  userId: string | null;
  organizationId: string;
  dataFolders?: DataFolder[];
}

/**
 * Per-folder incremental-pull capability returned by the server REST API.
 * Mirrors the server's `IncrementalPullSupport` enum (@spinner/shared-types).
 */
export enum IncrementalPullSupport {
  SUPPORTED = 'SUPPORTED',
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  NEEDS_CONFIGURATION = 'NEEDS_CONFIGURATION',
}

export interface DataFolder {
  id: string;
  name: string;
  path: string | null;
  connectorAccountId: string | null;
  connectorService: string | null;
  connectorDisplayName: string | null;
  lock: string | null;
  options: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  isAssetTable: boolean;
  lastFullPullAt: string | null;
  lastIncrementalPullAt: string | null;
  incrementalPullSupport: IncrementalPullSupport;
}
