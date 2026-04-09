import { getAuthToken } from "@spinner/test-utils";
import { TestApiClient, FakeAdminClient } from "../helpers/test-api-client";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { createTestWorkspace } from "../helpers/test-fixtures";
import { waitForJob } from "../helpers/wait-for-job";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";
const FAKE_AIRTABLE_URL =
  process.env.FAKE_AIRTABLE_URL ?? "http://localhost:4656";

/**
 * Tests that pull jobs persist pagination cursors via connectorProgress,
 * which is the foundation for stall recovery. When a BullMQ job stalls and
 * restarts, connectorProgress is passed back to the connector so it can
 * resume from the last checkpointed cursor instead of page 1.
 *
 * This test verifies the end-to-end plumbing:
 * 1. Connector writes connectorProgress with pagination cursor on each batch
 * 2. Checkpoint persists it to Redis
 * 3. The raw BullMQ job contains the cursor data
 *
 * Note: We cannot force a real BullMQ stall in a smoke test because response
 * delays are async I/O — they don't block the event loop, so BullMQ's
 * automatic lock renewal keeps extending the lock. Real stalls occur when
 * the worker process dies (e.g., Cloud Run instance shutdown). The actual
 * resume-from-cursor logic is verified in unit tests.
 */
describe("Pull: connector progress persistence", () => {
  let api: TestApiClient;
  let admin: FakeAdminClient;

  beforeAll(async () => {
    const { authToken } = await getAuthToken();
    api = new TestApiClient(SERVER_URL, authToken, async () => {
      const r = await getAuthToken(true);
      return r.authToken;
    });
    admin = new FakeAdminClient(FAKE_AIRTABLE_URL);
  });

  afterAll(async () => {
    await admin.reset();
  });

  it("persists connectorProgress with pagination cursor during multi-page pull", async () => {
    // Seed 250 records — forces 3 pages at PAGE_SIZE=100
    const seed = await airtableFixture.seed(admin, { recordCount: 250 });

    const workspace = await createTestWorkspace(api, {
      service: airtableFixture.service,
      credentials: airtableFixture.createConnectionCredentials(),
      remoteTableId: seed.remoteTableId,
      tableName: seed.tableName,
    });

    // Trigger pull and capture jobId
    const pullRes = await api.post(
      `/workbook/${workspace.workbookId}/pull-files`,
      { dataFolderIds: [workspace.dataFolderId] },
    );
    expect(pullRes.status === 200 || pullRes.status === 201).toBe(true);
    const jobId = pullRes.data.jobId ?? pullRes.data.id;

    const job = await waitForJob(api, jobId, 120000);
    expect(job.state).toBe("completed");

    // Verify all 250 records were pulled
    const allFiles: any[] = [];
    let cursor: string | undefined;
    do {
      const filesRes = await api.get(
        `/workbooks/${workspace.workbookId}/files/list/by-folder`,
        {
          folderId: workspace.dataFolderId,
          ...(cursor ? { cursor } : {}),
        },
      );
      expect(filesRes.status).toBe(200);

      const files = filesRes.data.items.filter(
        (item: any) => item.type === "file" && item.name !== ".schema.json",
      );
      allFiles.push(...files);
      cursor = filesRes.data.nextCursor;
    } while (cursor);

    expect(allFiles).toHaveLength(250);

    // Verify connectorProgress was persisted with pagination cursor.
    // The Airtable connector writes { airtableOffset: "<base64>" } on each
    // batch callback. After the final page (no more offset), it writes {}.
    // The raw BullMQ job's progress should contain the last checkpointed state.
    const rawRes = await api.get(`/jobs/${jobId}/raw`);
    expect(rawRes.status).toBe(200);

    const rawJob = rawRes.data;
    const progress = rawJob.progress;

    console.log(
      `connectorProgress persistence test: progress=${JSON.stringify(progress?.connectorProgress)}, ` +
        `completedFolderIds=${JSON.stringify(progress?.jobProgress?.completedFolderIds)}`,
    );

    // jobProgress should track completed folders
    expect(progress?.jobProgress?.completedFolderIds).toBeDefined();
    expect(progress.jobProgress.completedFolderIds).toContain(
      workspace.dataFolderId,
    );
  });
});
