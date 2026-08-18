import { getAuthToken } from "@spinner/test-utils";
import { TestApiClient } from "../helpers/test-api-client";
import { affinityFixture } from "../helpers/connector-fixtures/affinity.fixture";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { hubspotFixture } from "../helpers/connector-fixtures/hubspot.fixture";
import { ConnectorFixture } from "../helpers/connector-fixtures/types";
import { webflowFixture } from "../helpers/connector-fixtures/webflow.fixture";
import { createTestWorkspace, pullAndWait } from "../helpers/test-fixtures";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

const fixtures: ConnectorFixture[] = [
  airtableFixture,
  hubspotFixture,
  affinityFixture,
  // Webflow had no smoke fixture at all until DEV-11321 — its pull path went
  // unexercised through the refactor that the outage was initially blamed on.
  webflowFixture,
];

describe.each(fixtures)("Pull: $displayName", (fixture) => {
  let api: TestApiClient;

  beforeAll(async () => {
    const { authToken } = await getAuthToken();
    api = new TestApiClient(SERVER_URL, authToken, async () => {
      const r = await getAuthToken(true);
      return r.authToken;
    });
  });

  afterAll(async () => {
    // Cleanup: reset fake state
    const admin = fixture.createAdminClient();
    await admin.reset();
  });

  describe("basic pull", () => {
    it("pulls records into git and lists them as files", async () => {
      const admin = fixture.createAdminClient();
      const seed = await fixture.seed(admin, { recordCount: 10 });

      const workspace = await createTestWorkspace(api, {
        service: fixture.service,
        credentials: fixture.createConnectionCredentials(),
        remoteTableId: seed.remoteTableId,
        tableName: seed.tableName,
      });

      // Trigger pull and wait for completion
      const job = await pullAndWait(api, workspace.workbookId, [
        workspace.dataFolderId,
      ]);
      expect(job.state).toBe("completed");

      // List files in the data folder
      const filesRes = await api.get(
        `/workbooks/${workspace.workbookId}/files/list/by-folder`,
        {
          folderId: workspace.dataFolderId,
        },
      );
      expect(filesRes.status).toBe(200);

      const files = filesRes.data.items.filter(
        (item: any) => item.type === "file" && item.name !== ".schema.json",
      );
      expect(files).toHaveLength(seed.recordCount);
    });
  });

  describe("pagination", () => {
    it("pulls all records across multiple pages (250+)", async () => {
      const admin = fixture.createAdminClient();
      const seed = await fixture.seed(admin, { recordCount: 250 });

      const workspace = await createTestWorkspace(api, {
        service: fixture.service,
        credentials: fixture.createConnectionCredentials(),
        remoteTableId: seed.remoteTableId,
        tableName: seed.tableName,
      });

      const job = await pullAndWait(
        api,
        workspace.workbookId,
        [workspace.dataFolderId],
        120000,
      );
      expect(job.state).toBe("completed");

      // Paginate through all pages to collect every file
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
    });
  });

  describe("file content", () => {
    it("pulled files contain valid JSON with data", async () => {
      const admin = fixture.createAdminClient();
      const seed = await fixture.seed(admin, { recordCount: 3 });

      const workspace = await createTestWorkspace(api, {
        service: fixture.service,
        credentials: fixture.createConnectionCredentials(),
        remoteTableId: seed.remoteTableId,
        tableName: seed.tableName,
      });

      const job = await pullAndWait(api, workspace.workbookId, [
        workspace.dataFolderId,
      ]);
      expect(job.state).toBe("completed");

      // List files
      const filesRes = await api.get(
        `/workbooks/${workspace.workbookId}/files/list/by-folder`,
        {
          folderId: workspace.dataFolderId,
        },
      );
      const files = filesRes.data.items.filter(
        (item: any) => item.type === "file" && item.name !== ".schema.json",
      );
      expect(files.length).toBeGreaterThan(0);

      // Read the first file and verify it's valid JSON with properties
      const fileDetail = await api.get(
        `/workbooks/${workspace.workbookId}/files/by-path`,
        {
          path: files[0].path,
        },
      );
      expect(fileDetail.status).toBe(200);

      const content = JSON.parse(fileDetail.data.file.content);
      expect(typeof content).toBe("object");
      expect(content).not.toBeNull();
      expect(Object.keys(content).length).toBeGreaterThan(0);
    });
  });
});
