import axios from "axios";
import * as http from "node:http";
import * as dns from "node:dns";
import { getAuthToken } from "@spinner/test-utils";
import { UploadPatchPayload } from "@spinner/shared-types";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { ConnectorFixture } from "../helpers/connector-fixtures/types";
import { TestApiClient } from "../helpers/test-api-client";
import { createTestWorkspace, pullAndWait } from "../helpers/test-fixtures";
import { waitForJob } from "../helpers/wait-for-job";

/**
 * End-to-end smoke test for the `/upload-patch` publish flow — the CLI/desktop
 * path now used by every caller (see
 * docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md, Phase 1).
 *
 * Drives the wire shape: `/upload-patch/init` → PUT to the presigned URL →
 * `/upload-patch/commit` → ApplyPatchesJob → `/publish-v2/plan-job` →
 * `/publish-v2/run-job` → assert fake-airtable state.
 *
 * The test goes via raw HTTP — no `scratchmd` binary dependency.
 * `scratch-cli-tests/tests/publish.spec.ts` (shells out to scratchmd against a
 * local server) covers the binary + unit invariants; this fills the per-deploy
 * Docker-isolated regression gap (plan follow-up F13).
 *
 * ── GCS dependency ───────────────────────────────────────────────────────
 * The flow requires `GCS_PATCH_UPLOAD_BUCKET` set on the server. The
 * smoke-test stack wires a `fake-gcs` service (`fsouza/fake-gcs-server`)
 * with a pre-created bucket, a mounted fake service-account JSON for V4 URL
 * signing, and `GCS_API_ENDPOINT=http://fake-gcs:4443` on the server.
 *
 * Host validation: fake-gcs is launched with `-public-host fake-gcs:4443`
 * and rejects V4-signed URLs whose Host header doesn't match. So the URL
 * stays untouched everywhere — we never rewrite it. CI's test-runner is
 * inside the docker network and resolves `fake-gcs:4443` natively. Local
 * host-side runs can't resolve `fake-gcs`, so the test installs a custom
 * axios http agent with a `lookup` function that maps `fake-gcs` →
 * `127.0.0.1` (which the docker-compose port mapping exposes as the
 * fake-gcs container). The URL host stays `fake-gcs:4443`, the Host header
 * stays `fake-gcs:4443`, and fake-gcs accepts both.
 */

/** Custom http.Agent that resolves `fake-gcs` to 127.0.0.1 (port-mapped to
 * the fake-gcs container). All other hostnames fall through to the default
 * resolver. Active only when running on the host (CI runs inside the docker
 * network and skips this). */
const FAKE_GCS_HOST_ALIAS = "fake-gcs";
function makeFakeGcsHostAgent(): http.Agent | undefined {
  // CI test-runner runs inside the docker network; SMOKE_TEST_SERVER_URL
  // points at `http://server:8080` and `fake-gcs` resolves via docker DNS.
  // Skip the agent override there.
  const serverUrl =
    process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";
  if (!serverUrl.includes("localhost")) return undefined;
  return new http.Agent({
    lookup: (hostname: string, options: any, cb: any) => {
      if (hostname === FAKE_GCS_HOST_ALIAS) {
        // Match dns.lookup's callback shape: (err, address, family) for
        // single result, (err, [{address, family}]) when `options.all`.
        if (options && options.all) {
          cb(null, [{ address: "127.0.0.1", family: 4 }]);
        } else {
          cb(null, "127.0.0.1", 4);
        }
        return;
      }
      dns.lookup(hostname, options, cb);
    },
  });
}
const fakeGcsAgent = makeFakeGcsHostAgent();

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

/** fake-gcs URL the test uses for the bucket-create call. Always the in-network
 * hostname — the agent above resolves it to localhost on the host. */
const FAKE_GCS_URL = process.env.FAKE_GCS_URL ?? "http://fake-gcs:4443";
const PATCH_UPLOAD_BUCKET = "upload-patches-smoke";

/**
 * Idempotently create the patch-upload bucket directly on fake-gcs. We do this
 * in the test instead of relying on the `fake-gcs-bucket-init` docker-compose
 * container because that container has proven unreliable on the GitLab runner
 * (it exits successfully but the bucket isn't present when the test runs —
 * suspected docker-compose recreate ordering / cached state on the local
 * runner). Doing the create from the test gives us a single deterministic
 * setup point and tolerates 409 ("bucket already exists") so reruns are safe.
 */
async function ensureFakeGcsBucket(): Promise<void> {
  let lastStatus: number | string | undefined;
  let lastBody: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.post(
        `${FAKE_GCS_URL}/storage/v1/b`,
        { name: PATCH_UPLOAD_BUCKET },
        {
          validateStatus: () => true,
          timeout: 5000,
          httpAgent: fakeGcsAgent,
        },
      );
      if (res.status === 200 || res.status === 409) {
        return;
      }
      lastStatus = res.status;
      lastBody = res.data;
      console.warn(
        `[fake-gcs ensureBucket] attempt ${attempt}: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`,
      );
    } catch (err: any) {
      lastStatus = err.code ?? "transport-error";
      lastBody = err.message ?? String(err);
      console.warn(
        `[fake-gcs ensureBucket] attempt ${attempt}: ${err.message ?? err}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `[fake-gcs ensureBucket] failed after 5 attempts to create '${PATCH_UPLOAD_BUCKET}' at ${FAKE_GCS_URL}: last status ${lastStatus}, body ${JSON.stringify(lastBody).slice(0, 200)}`,
  );
}

const fixtures: ConnectorFixture[] = [airtableFixture];

describe.each(fixtures)(
  "Publish-upload-patch happy path: $displayName",
  (fixture) => {
    let api: TestApiClient;

    beforeAll(async () => {
      await ensureFakeGcsBucket();
      const { authToken } = await getAuthToken();
      api = new TestApiClient(SERVER_URL, authToken, async () => {
        const r = await getAuthToken(true);
        return r.authToken;
      });
    });

    afterAll(async () => {
      const admin = fixture.createAdminClient();
      await admin.reset();
    });

    it("creates, edits, and deletes records via /upload-patch round-trip", async () => {
      const admin = fixture.createAdminClient();
      const seed = await fixture.seed(admin, { recordCount: 5 });

      const workspace = await createTestWorkspace(api, {
        service: fixture.service,
        credentials: fixture.createConnectionCredentials(),
        remoteTableId: seed.remoteTableId,
        tableName: seed.tableName,
      });

      const pullJob = await pullAndWait(api, workspace.workbookId, [
        workspace.dataFolderId,
      ]);
      expect(pullJob.state).toBe("completed");

      // Discover pulled records. We need filenames + current content so we
      // can build patches that mirror what `scratchmd files upload` would
      // ship from a real workspace.
      const filesRes = await api.get(
        `/workbooks/${workspace.workbookId}/files/list/by-folder`,
        { folderId: workspace.dataFolderId },
      );
      const records = filesRes.data.items.filter(
        (item: any) => item.type === "file" && item.name !== ".schema.json",
      );
      expect(records.length).toBeGreaterThanOrEqual(2);

      const editTarget = records[0];
      const deleteTarget = records[records.length - 1];

      const editDetail = await api.get(
        `/workbooks/${workspace.workbookId}/files/by-path`,
        { path: editTarget.path },
      );
      const editCurrent = JSON.parse(editDetail.data.file.content) as {
        id?: string;
        fields?: Record<string, unknown>;
      };
      expect(typeof editCurrent.id).toBe("string");

      const deleteDetail = await api.get(
        `/workbooks/${workspace.workbookId}/files/by-path`,
        { path: deleteTarget.path },
      );
      const deleteCurrent = JSON.parse(deleteDetail.data.file.content) as {
        id?: string;
      };
      expect(typeof deleteCurrent.id).toBe("string");

      // ── Step 1: /upload-patch/init ────────────────────────────────────
      const initRes = await api.post(
        `/cli/v1/workbooks/${workspace.workbookId}/upload-patch/init`,
        { connectorAccountId: workspace.connectorAccountId },
      );
      expect(initRes.status).toBe(201);
      const { uploadId, presignedUrl } = initRes.data as {
        uploadId: string;
        presignedUrl: string;
      };
      expect(typeof uploadId).toBe("string");
      expect(typeof presignedUrl).toBe("string");

      // ── Step 2: build the RFC 7396 patch payload ──────────────────────
      // Path is connection-relative (DataFolder.path with leading slash
      // stripped), per server/src/utils/path-validation.ts.
      const tablePath = workspace.dataFolderPath.replace(/^\//, "");
      const editPath = `${tablePath}/${editTarget.name}`;
      const createPath = `${tablePath}/new-record-from-upload-patch.json`;
      const deletePath = `${tablePath}/${deleteTarget.name}`;

      const payload: UploadPatchPayload = {
        patches: [
          {
            // RFC 7396 update — only changed keys appear in the patch.
            // The server reads the current dirty-branch file as the base.
            path: editPath,
            patch: {
              fields: { Status: "Updated via /upload-patch smoke" },
            },
          },
          {
            // Create — full file content.
            path: createPath,
            patch: {
              fields: {
                Name: "Record from upload-patch",
                Status: "Active",
                Count: 999,
              },
            },
          },
          {
            // Delete — RFC 7396 sentinel for "remove this file."
            path: deletePath,
            patch: null,
          },
        ],
      };

      // ── Step 3: PUT to the presigned URL ──────────────────────────────
      // Bypasses the auth-gated server API entirely — the URL is the auth.
      // Content-Type is fixed by `signPutUrlForPatchUpload` server-side.
      // URL is untouched (host stays `fake-gcs:4443`). On the host we route
      // via `fakeGcsAgent`, which resolves `fake-gcs` to 127.0.0.1; HTTP Host
      // header stays as `fake-gcs:4443` so fake-gcs's `-public-host` check
      // passes.
      const putRes = await axios.put(presignedUrl, JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
        validateStatus: () => true,
        httpAgent: fakeGcsAgent,
      });
      if (putRes.status < 200 || putRes.status >= 300) {
        throw new Error(
          `Presigned PUT failed: ${putRes.status} ${JSON.stringify(putRes.data).slice(0, 500)}`,
        );
      }

      // ── Step 4: /upload-patch/commit → ApplyPatchesJob ────────────────
      const commitRes = await api.post(
        `/cli/v1/workbooks/${workspace.workbookId}/upload-patch/commit`,
        {
          uploadId,
          connectorAccountId: workspace.connectorAccountId,
          // No `baseHead` — soft-warning path. The fresh-init flow has nothing
          // to compare against and refuseIfStale would require us to look up
          // refs/heads/main first; not worth the round-trip in the smoke.
        },
      );
      expect(commitRes.status).toBe(201);
      expect(commitRes.data.jobId).toBeTruthy();

      const applyJob = await waitForJob(api, String(commitRes.data.jobId));
      expect(applyJob.state).toBe("completed");

      // ── Step 5: /publish-v2/plan-job → wait → run-job → wait ─────────
      // CLI shim that `scratchmd files publish` drives. Mirrors the two-call
      // sequence the desktop's PublishChangesModal makes via the renderer.
      const planRes = await api.post(
        `/cli/v1/workbooks/${workspace.workbookId}/publish-v2/plan-job`,
        {
          connectorAccountId: workspace.connectorAccountId,
          runAfterPlan: false,
        },
      );
      expect(planRes.status).toBe(201);
      const { jobId: planJobId, pipelineId } = planRes.data as {
        jobId: string | null;
        pipelineId: string | null;
      };
      expect(planJobId).toBeTruthy();
      expect(pipelineId).toBeTruthy();

      const planResult = await waitForJob(api, String(planJobId));
      expect(planResult.state).toBe("completed");

      const runRes = await api.post(
        `/cli/v1/workbooks/${workspace.workbookId}/publish-v2/run-job`,
        { pipelineId, executeSinglePhase: false },
      );
      expect(runRes.status).toBe(201);
      expect(runRes.data.jobId).toBeTruthy();

      const runResult = await waitForJob(api, String(runRes.data.jobId));
      expect(runResult.state).toBe("completed");

      // ── Step 6: assert fake-airtable state ────────────────────────────
      // Started with 5, +1 create, -1 delete → 5.
      const remoteRecords = await fixture.dumpRecords(admin, seed);
      expect(remoteRecords).toHaveLength(5);

      const newRecord = remoteRecords.find(
        (r) => r.fields.Name === "Record from upload-patch",
      );
      expect(newRecord).toBeDefined();
      expect(newRecord!.fields.Count).toBe(999);

      const editedRecord = remoteRecords.find(
        (r) => r.fields.Status === "Updated via /upload-patch smoke",
      );
      expect(editedRecord).toBeDefined();
      expect(editedRecord!.id).toBe(editCurrent.id);

      const deletedRecord = remoteRecords.find(
        (r) => r.id === deleteCurrent.id,
      );
      expect(deletedRecord).toBeUndefined();
    }, 180_000);
  },
);
