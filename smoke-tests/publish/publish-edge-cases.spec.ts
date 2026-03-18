import { getAuthToken } from "@spinner/test-utils";
import { TestApiClient } from "../helpers/test-api-client";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { ConnectorFixture } from "../helpers/connector-fixtures/types";
import {
  createTestWorkspace,
  pullAndWait,
  planPublish,
  runPublish,
} from "../helpers/test-fixtures";
import { waitForJob } from "../helpers/wait-for-job";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

const fixtures: ConnectorFixture[] = [airtableFixture];

describe.each(fixtures)("Publish edge cases: $displayName", (fixture) => {
  let api: TestApiClient;

  beforeAll(async () => {
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

  it("large batch: creates 25+ records (exercises batch splitting)", async () => {
    const admin = fixture.createAdminClient();
    const seed = await fixture.seed(admin, { recordCount: 1 });

    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.remoteTableId,
      tableName: seed.tableName,
    });

    // Pull the initial record
    const pullJob = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(pullJob.state).toBe("completed");

    // Create 25 new files
    for (let i = 0; i < 25; i++) {
      const res = await api.post(`/workbooks/${workspace.workbookId}/files`, {
        name: `batch-record-${i}.json`,
        parentFolderId: workspace.dataFolderId,
        content: JSON.stringify({
          fields: { Name: `Batch Record ${i}`, Status: "New", Count: i },
        }),
      });
      expect(res.status).toBe(201);
    }

    // Publish
    const { jobId: planJobId, pipelineId } = await planPublish(
      api,
      workspace.workbookId,
      workspace.connectorAccountId,
    );
    expect(planJobId).not.toBeNull();
    expect(pipelineId).not.toBeNull();
    const planResult = await waitForJob(api, planJobId!);
    expect(planResult.state).toBe("completed");

    const publishResult = await runPublish(
      api,
      workspace.workbookId,
      pipelineId!,
      120000,
    );
    expect(publishResult.state).toBe("completed");

    // Verify all 26 records exist in the fake (1 original + 25 new)
    const remoteRecords = await fixture.dumpRecords(admin, seed);
    expect(remoteRecords).toHaveLength(26);

    // Verify all batch records were created
    const batchRecords = remoteRecords.filter((r) =>
      String(r.fields.Name).startsWith("Batch Record"),
    );
    expect(batchRecords).toHaveLength(25);
  });

  it("publish is a no-op when there are no changes", async () => {
    const admin = fixture.createAdminClient();
    const seed = await fixture.seed(admin, { recordCount: 3 });

    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.remoteTableId,
      tableName: seed.tableName,
    });

    // Pull
    const pullJob = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(pullJob.state).toBe("completed");

    // Publish without making any changes — server should return null jobId/pipelineId
    const { jobId: planJobId, pipelineId } = await planPublish(
      api,
      workspace.workbookId,
      workspace.connectorAccountId,
    );
    // When there are no diffs, the server returns null for both
    expect(planJobId).toBeNull();
    expect(pipelineId).toBeNull();

    // Remote state unchanged
    const remoteRecords = await fixture.dumpRecords(admin, seed);
    expect(remoteRecords).toHaveLength(3);
  });
});
