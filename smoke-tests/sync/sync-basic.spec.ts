import { getAuthToken } from "@spinner/test-utils";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { hubspotFixture } from "../helpers/connector-fixtures/hubspot.fixture";
import { ConnectorFixture } from "../helpers/connector-fixtures/types";
import { TestApiClient } from "../helpers/test-api-client";
import {
  addLinkedDataFolder,
  commitPlaceholderToFolder,
  createTestWorkspace,
  pullAndWait,
  runSyncAndWait,
  SYNC_PLACEHOLDER_FILENAME,
} from "../helpers/test-fixtures";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

const fixtures: ConnectorFixture[] = [airtableFixture, hubspotFixture];

describe.each(fixtures)("Sync basic: $displayName", (fixture) => {
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

  it("syncs records from a source folder to a destination folder", async () => {
    if (!fixture.seedSyncPair) {
      // Skip connectors that don't expose a sync pair fixture
      return;
    }

    const admin = fixture.createAdminClient();
    const seed = await fixture.seedSyncPair(admin, { recordCount: 5 });

    // 1. Create the workbook + connector account + source folder
    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.source.remoteTableId,
      tableName: seed.source.tableName,
    });

    // 2. Add a destination folder linked to the dest table, sharing the same connector account
    const destFolder = await addLinkedDataFolder(api, {
      workbookId: workspace.workbookId,
      connectorAccountId: workspace.connectorAccountId,
      remoteTableId: seed.destination.remoteTableId,
      tableName: seed.destination.tableName,
    });

    // 3. Commit a placeholder record into the dest folder so it exists as a
    // directory in git — sync's destination iterator 404s otherwise on a
    // never-pulled folder. The placeholder has no nested fields so sync's
    // matching logic ignores it.
    await commitPlaceholderToFolder(
      api,
      workspace.workbookId,
      destFolder.dataFolderId,
    );

    // 4. Pull the source folder so its records exist as files in git
    const pullJob = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(pullJob.state).toBe("completed");

    // Sanity-check: source has the seeded records, destination is empty
    const sourceFiles = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: workspace.dataFolderId },
    );
    const sourceFileCount = sourceFiles.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    ).length;
    expect(sourceFileCount).toBe(seed.source.recordCount);

    const destFilesBefore = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: destFolder.dataFolderId },
    );
    expect(destFilesBefore.status).toBe(200);
    const destFileCountBefore = destFilesBefore.data.items.filter(
      (item: any) =>
        item.type === "file" &&
        item.name !== ".schema.json" &&
        item.name !== SYNC_PLACEHOLDER_FILENAME,
    ).length;
    expect(destFileCountBefore).toBe(0);

    // 4. Create a sync from source folder to destination folder
    const syncRes = await api.post(`/workbooks/${workspace.workbookId}/syncs`, {
      displayName: "Smoke Test Sync",
      validateMappings: false,
      mappings: {
        version: 1,
        tableMappings: [
          {
            sourceDataFolderId: workspace.dataFolderId,
            destinationDataFolderId: destFolder.dataFolderId,
            columnMappings: seed.columnMappings,
            recordMatching: seed.recordMatching,
          },
        ],
      },
      schedule: "",
    });
    expect(syncRes.status).toBe(201);
    const syncId = syncRes.data.id;
    expect(syncId).toBeDefined();

    // 5. Run the sync
    const syncJob = await runSyncAndWait(api, workspace.workbookId, syncId);
    expect(syncJob.state).toBe("completed");
    expect(syncJob.publicProgress).toBeDefined();
    expect(syncJob.publicProgress.totalFilesSynced).toBe(
      seed.source.recordCount,
    );
    expect(syncJob.publicProgress.tables).toHaveLength(1);
    const tableProgress = syncJob.publicProgress.tables[0];
    expect(tableProgress.status).toBe("completed");
    expect(tableProgress.creates).toBe(seed.source.recordCount);
    expect(tableProgress.updates).toBe(0);
    expect(tableProgress.errorCount).toBe(0);

    // 6. Verify destination folder now contains files
    const destFilesAfter = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: destFolder.dataFolderId },
    );
    const destFileCountAfter = destFilesAfter.data.items.filter(
      (item: any) =>
        item.type === "file" &&
        item.name !== ".schema.json" &&
        item.name !== SYNC_PLACEHOLDER_FILENAME,
    ).length;
    expect(destFileCountAfter).toBe(seed.source.recordCount);
  });
});
