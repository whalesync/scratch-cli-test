import { TestApiClient } from "./test-api-client";
import { waitForJob } from "./wait-for-job";

export interface TestWorkspace {
  workbookId: string;
  connectorAccountId: string;
  dataFolderId: string;
  dataFolderPath: string;
}

export interface CreateWorkspaceOpts {
  service: string;
  credentials: Record<string, string>;
  remoteTableId: string[];
  tableName: string;
  triggerPull?: boolean;
}

/**
 * Create a fully-linked workspace: workbook -> connector account -> data folder.
 * Optionally triggers an initial pull.
 */
export async function createTestWorkspace(
  api: TestApiClient,
  opts: CreateWorkspaceOpts,
): Promise<TestWorkspace> {
  // 1. Create workbook
  const workbookRes = await api.post("/workbook", {
    name: `smoke-test-${Date.now()}`,
  });
  if (workbookRes.status !== 201) {
    throw new Error(
      `Failed to create workbook: ${workbookRes.status} ${JSON.stringify(workbookRes.data)}`,
    );
  }
  const workbookId = workbookRes.data.id;

  // 2. Create connector account
  const connRes = await api.post(`/workbooks/${workbookId}/connections`, {
    service: opts.service,
    authType: "API_KEY",
    userProvidedParams: opts.credentials,
  });
  if (connRes.status !== 201) {
    throw new Error(
      `Failed to create connector account: ${connRes.status} ${JSON.stringify(connRes.data)}`,
    );
  }
  const connectorAccountId = connRes.data.id;

  // 3. Link data folder to remote table
  const folderRes = await api.post("/data-folder/create", {
    name: opts.tableName,
    workbookId,
    connectorAccountId,
    tableId: opts.remoteTableId,
    triggerPull: opts.triggerPull ?? false,
  });
  if (folderRes.status !== 201) {
    throw new Error(
      `Failed to create data folder: ${folderRes.status} ${JSON.stringify(folderRes.data)}`,
    );
  }
  const dataFolderId = folderRes.data.id;
  const dataFolderPath = folderRes.data.path;

  return { workbookId, connectorAccountId, dataFolderId, dataFolderPath };
}

/**
 * Add a second linked data folder to an existing workspace, reusing the same connector account.
 * Useful for sync tests that need both a source and a destination folder in one workbook.
 */
export async function addLinkedDataFolder(
  api: TestApiClient,
  opts: {
    workbookId: string;
    connectorAccountId: string;
    remoteTableId: string[];
    tableName: string;
    triggerPull?: boolean;
  },
): Promise<{ dataFolderId: string; dataFolderPath: string }> {
  const folderRes = await api.post("/data-folder/create", {
    name: opts.tableName,
    workbookId: opts.workbookId,
    connectorAccountId: opts.connectorAccountId,
    tableId: opts.remoteTableId,
    triggerPull: opts.triggerPull ?? false,
  });
  if (folderRes.status !== 201) {
    throw new Error(
      `Failed to add linked data folder: ${folderRes.status} ${JSON.stringify(folderRes.data)}`,
    );
  }
  return {
    dataFolderId: folderRes.data.id,
    dataFolderPath: folderRes.data.path,
  };
}

/** Filename used by `commitPlaceholderToFolder`. Tests filter this out of file counts. */
export const SYNC_PLACEHOLDER_FILENAME = "_sync_smoke_placeholder.json";

/**
 * Commit a placeholder JSON record into a data folder so the folder exists
 * as a directory in git. Required for sync to be able to enumerate destination
 * folders that have no records yet — without a backing directory, scratch-git
 * returns 404 on the folder listing call.
 *
 * The placeholder is a minimal valid record (just an `id` field) so that
 * `parseFileToRecord` succeeds when sync iterates the destination folder.
 * Sync extracts the destination match-key value via `lodash.get` on a nested
 * path, which returns `undefined` for this minimal shape, so the placeholder
 * never matches any source record and is left untouched by sync.
 *
 * Note: We can't use a `.gitkeep` dotfile here because dotfiles are silently
 * dropped on the createFile -> commit path.
 */
export async function commitPlaceholderToFolder(
  api: TestApiClient,
  workbookId: string,
  dataFolderId: string,
): Promise<void> {
  const res = await api.post(`/workbooks/${workbookId}/files`, {
    name: SYNC_PLACEHOLDER_FILENAME,
    parentFolderId: dataFolderId,
    content: JSON.stringify({ id: "sync_smoke_placeholder" }),
  });
  if (res.status !== 201) {
    throw new Error(
      `Failed to commit sync placeholder: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
}

/**
 * Trigger a pull and wait for it to complete.
 */
export async function pullAndWait(
  api: TestApiClient,
  workbookId: string,
  dataFolderIds: string[],
  timeoutMs = 60000,
): Promise<{ state: string; publicProgress?: any; failedReason?: string }> {
  const pullRes = await api.post(`/workbook/${workbookId}/pull-files`, {
    dataFolderIds,
  });
  if (pullRes.status !== 201 && pullRes.status !== 200) {
    throw new Error(
      `Failed to trigger pull: ${pullRes.status} ${JSON.stringify(pullRes.data)}`,
    );
  }
  const jobId = pullRes.data.jobId ?? pullRes.data.id;
  return waitForJob(api, jobId, timeoutMs);
}

/**
 * Plan a publish and wait for planning to complete.
 */
export async function planPublish(
  api: TestApiClient,
  workbookId: string,
  connectorAccountId: string,
): Promise<{ jobId: string | null; pipelineId: string | null }> {
  const res = await api.post(`/workbook/${workbookId}/publish-v2/plan-job`, {
    connectorAccountId,
    runAfterPlan: false,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `Failed to create publish plan: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
  return res.data;
}

/**
 * Run a publish plan and wait for it to complete.
 */
export async function runPublish(
  api: TestApiClient,
  workbookId: string,
  pipelineId: string,
  timeoutMs = 60000,
): Promise<{ state: string; publicProgress?: any; failedReason?: string }> {
  const res = await api.post(`/workbook/${workbookId}/publish-v2/run-job`, {
    pipelineId,
    executeSinglePhase: false,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `Failed to run publish: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
  const jobId = res.data.jobId ?? res.data.id;
  return waitForJob(api, jobId, timeoutMs);
}

/**
 * Trigger a sync run and wait for it to complete.
 */
export async function runSyncAndWait(
  api: TestApiClient,
  workbookId: string,
  syncId: string,
  timeoutMs = 60000,
): Promise<{ state: string; publicProgress?: any; failedReason?: string }> {
  const res = await api.post(
    `/workbooks/${workbookId}/syncs/${syncId}/run`,
    {},
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `Failed to run sync: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
  const jobId = res.data.jobId;
  if (!jobId) {
    throw new Error(
      `Sync run did not return a jobId: ${JSON.stringify(res.data)}`,
    );
  }
  return waitForJob(api, jobId, timeoutMs);
}
