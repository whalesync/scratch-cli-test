import axios from "axios";
import { TestApiClient } from "./test-api-client";
import { waitForJob } from "./wait-for-job";

const SCRATCH_GIT_API_URL =
  process.env.SMOKE_TEST_SCRATCH_GIT_URL ?? "http://localhost:3110";

interface PlanFile {
  path: string;
  content: string;
}

interface PlanInputs {
  /**
   * Path of the data folder within the connector repo, with no leading slash.
   * For example, a data folder at "/Smoke Test Table" becomes "Smoke Test Table".
   */
  tablePath: string;
  /** Timestamp string used in the plan-folder name (e.g. "20260505-120000"). */
  planTimestamp: string;
  connectionName: string;
  connectionId: string;
  /**
   * Edit operations. `currentContent` should be the record's current content
   * (including its remote `id`), with the modifications applied. `changedFields`
   * carries the shape (keys) of the fields that changed — values are picked
   * from `currentContent` by the dispatcher.
   */
  edits?: Array<{
    filename: string;
    currentContent: Record<string, unknown>;
    changedFields: Record<string, unknown>;
  }>;
  /** Create operations. `content` is the new record (no `id` for fresh records). */
  creates?: Array<{
    filename: string;
    content: Record<string, unknown>;
  }>;
  /** Delete operations, each pointing at an existing remote record id. */
  deletes?: Array<{
    filename: string;
    remoteId: string;
  }>;
}

export interface BuiltPlan {
  /** Path the CLI run-from-git endpoint expects (e.g. `.scratch/.publish-plans/<timestamp>`). */
  planPath: string;
  /** All files to commit to the dirty branch — both `plan.json` and per-phase files. */
  files: PlanFile[];
}

/**
 * Build the file layout that `scratchmd plan-publish` would emit on disk:
 * - `.scratch/.publish-plans/<ts>/plan.json` (master plan metadata)
 * - `.scratch/<tablePath>/publish-plan-<ts>/<phase>/<file>` (per-phase operations)
 *
 * Mirrors the structure consumed by `PublishFromGitService.runFromGit` so we
 * can drive the CLI publish path without invoking the Rust CLI.
 */
export function buildPlanFiles(inputs: PlanInputs): BuiltPlan {
  const planFolder = `.scratch/.publish-plans/${inputs.planTimestamp}`;
  const phaseRoot = `.scratch/${inputs.tablePath}/publish-plan-${inputs.planTimestamp}`;
  const edits = inputs.edits ?? [];
  const creates = inputs.creates ?? [];
  const deletes = inputs.deletes ?? [];

  const planJson = {
    planId: `smoke-test-plan-${inputs.planTimestamp}`,
    createdAt: new Date().toISOString(),
    connectionName: inputs.connectionName,
    connectionId: inputs.connectionId,
    summary: {
      edit: edits.length,
      create: creates.length,
      delete: deletes.length,
      backfill: 0,
      rename: 0,
    },
    tablePaths: [inputs.tablePath],
  };

  const files: PlanFile[] = [
    { path: `${planFolder}/plan.json`, content: JSON.stringify(planJson) },
    ...edits.map((e) => ({
      path: `${phaseRoot}/edit/${e.filename}`,
      content: JSON.stringify({
        content: e.currentContent,
        changedFields: e.changedFields,
      }),
    })),
    ...creates.map((c) => ({
      path: `${phaseRoot}/create/${c.filename}`,
      content: JSON.stringify(c.content),
    })),
    ...deletes.map((d) => ({
      path: `${phaseRoot}/delete/${d.filename}`,
      content: JSON.stringify({ remoteId: d.remoteId }),
    })),
  ];

  return { planPath: planFolder, files };
}

/** Look up a connector account's repoPath via the CLI workbook GET endpoint. */
export async function getConnectorRepoPath(
  api: TestApiClient,
  workbookId: string,
  connectorAccountId: string,
): Promise<string> {
  const res = await api.get(`/cli/v1/workbooks/${workbookId}`);
  if (res.status !== 200) {
    throw new Error(
      `Failed to fetch CLI workbook: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
  const account = (res.data.connectorAccounts ?? []).find(
    (ca: { id: string }) => ca.id === connectorAccountId,
  );
  if (!account?.repoPath) {
    throw new Error(
      `Connector account ${connectorAccountId} has no repoPath (got ${JSON.stringify(account)})`,
    );
  }
  return account.repoPath as string;
}

/**
 * Commit a batch of files directly to the connector repo's dirty branch via
 * scratch-git's REST API. This stands in for `scratchmd files upload`, which
 * pushes plan files via git over HTTP.
 */
export async function commitFilesToScratchGit(
  repoPath: string,
  files: PlanFile[],
  message = "Smoke test publish-from-git plan",
): Promise<void> {
  const encoded = encodeURIComponent(repoPath);
  const url = `${SCRATCH_GIT_API_URL}/api/repo/write/${encoded}/files?branch=dirty`;
  const res = await axios.post(
    url,
    { files, message },
    { validateStatus: () => true },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `scratch-git commit failed: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
}

/**
 * Trigger the CLI publish-from-git endpoint and wait for the resulting job to
 * complete. Mirrors the call the Rust CLI makes after `scratchmd files upload`.
 */
export async function runPublishFromGit(
  api: TestApiClient,
  workbookId: string,
  connectorAccountId: string,
  planPath: string,
  timeoutMs = 60000,
): Promise<{ state: string; publicProgress?: any; failedReason?: string }> {
  const res = await api.post(
    `/cli/v1/workbooks/${workbookId}/publish-v2/run-from-git`,
    { connectorAccountId, planPath },
  );
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `Failed to trigger publish-from-git: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
  const jobId = res.data.jobId;
  if (!jobId) {
    throw new Error(
      `publish-from-git response missing jobId: ${JSON.stringify(res.data)}`,
    );
  }
  return waitForJob(api, jobId, timeoutMs);
}
