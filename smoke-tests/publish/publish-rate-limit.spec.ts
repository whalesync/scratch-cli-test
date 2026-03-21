import { getAuthToken } from "@spinner/test-utils";
import { TestApiClient } from "../helpers/test-api-client";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { hubspotFixture } from "../helpers/connector-fixtures/hubspot.fixture";
import { ConnectorFixture } from "../helpers/connector-fixtures/types";
import { createTestWorkspace, pullAndWait } from "../helpers/test-fixtures";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

const fixtures: ConnectorFixture[] = [airtableFixture, hubspotFixture];

describe.each(fixtures)("Rate limit recovery: $displayName", (fixture) => {
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

  it("pull succeeds after retrying past rate-limited requests", async () => {
    const admin = fixture.createAdminClient();
    const seed = await fixture.seed(admin, { recordCount: 5 });

    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.remoteTableId,
      tableName: seed.tableName,
    });

    // Queue rate limits: next 2 API requests will return 429
    await admin.simulateRateLimit(2, 1);

    // Pull should retry and eventually succeed
    const job = await pullAndWait(
      api,
      workspace.workbookId,
      [workspace.dataFolderId],
      120000,
    );
    expect(job.state).toBe("completed");

    // Verify all files were pulled despite rate limiting
    const filesRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      {
        folderId: workspace.dataFolderId,
      },
    );
    const files = filesRes.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    );
    expect(files).toHaveLength(5);
  });
});
