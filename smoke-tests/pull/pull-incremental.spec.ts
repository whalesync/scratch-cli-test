import { getAuthToken } from "@spinner/test-utils";
import { TestApiClient } from "../helpers/test-api-client";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { ConnectorFixture } from "../helpers/connector-fixtures/types";
import { createTestWorkspace, pullAndWait } from "../helpers/test-fixtures";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

const fixtures: ConnectorFixture[] = [airtableFixture];

describe.each(fixtures)("Pull incremental: $displayName", (fixture) => {
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

  it("detects new and removed records on re-pull", async () => {
    const admin = fixture.createAdminClient();

    // First pull: 10 records
    const seed = await fixture.seed(admin, { recordCount: 10 });
    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.remoteTableId,
      tableName: seed.tableName,
    });

    const job1 = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(job1.state).toBe("completed");

    const files1 = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      {
        folderId: workspace.dataFolderId,
      },
    );
    const fileCount1 = files1.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    ).length;
    expect(fileCount1).toBe(10);

    // Mutate fake: re-seed with 9 records (removes some, adds new ones)
    // Reset and re-seed to simulate remote changes
    const seed2 = await fixture.seed(admin, { recordCount: 9 });

    // Re-pull
    const job2 = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(job2.state).toBe("completed");

    // Verify updated file count
    const files2 = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      {
        folderId: workspace.dataFolderId,
      },
    );
    const fileCount2 = files2.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    ).length;
    expect(fileCount2).toBe(9);
  });
});
