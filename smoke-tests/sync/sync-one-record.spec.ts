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
  SYNC_PLACEHOLDER_FILENAME,
} from "../helpers/test-fixtures";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

const fixtures: ConnectorFixture[] = [airtableFixture, hubspotFixture];

interface FileListItem {
  type: string;
  name: string;
  path: string;
}

function listRecordFiles(items: FileListItem[]): FileListItem[] {
  return items.filter(
    (i) =>
      i.type === "file" &&
      i.name !== ".schema.json" &&
      i.name !== SYNC_PLACEHOLDER_FILENAME,
  );
}

describe.each(fixtures)("Sync one record: $displayName", (fixture) => {
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

  it("syncs a single source record and leaves the rest of the destination alone", async () => {
    if (!fixture.seedSyncPair) {
      // Skip connectors that don't expose a sync pair fixture
      return;
    }

    const admin = fixture.createAdminClient();
    const seed = await fixture.seedSyncPair(admin, { recordCount: 5 });

    // 1. Standard setup: workspace + source folder + dest folder
    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.source.remoteTableId,
      tableName: seed.source.tableName,
    });

    const destFolder = await addLinkedDataFolder(api, {
      workbookId: workspace.workbookId,
      connectorAccountId: workspace.connectorAccountId,
      remoteTableId: seed.destination.remoteTableId,
      tableName: seed.destination.tableName,
    });

    // 2. Commit a placeholder record into the dest folder so it exists as a
    // directory in git — sync's destination iterator 404s otherwise on a
    // never-pulled folder. The placeholder has no nested fields so sync's
    // matching logic ignores it.
    await commitPlaceholderToFolder(
      api,
      workspace.workbookId,
      destFolder.dataFolderId,
    );

    // 3. Pull source so its files exist in git
    const pullJob = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(pullJob.state).toBe("completed");

    // 4. Create the sync
    const syncRes = await api.post(
      `/workbooks/${workspace.workbookId}/syncs`,
      {
        displayName: "Smoke Test Sync One Record",
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
      },
    );
    expect(syncRes.status).toBe(201);
    const syncId = syncRes.data.id;

    // 5. Pick one source file to sync
    const sourceListRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: workspace.dataFolderId },
    );
    const sourceFiles = listRecordFiles(sourceListRes.data.items);
    expect(sourceFiles.length).toBe(seed.source.recordCount);
    const targetFile = sourceFiles[0];

    // 6. Call sync-one-record for that single file
    const firstCallRes = await api.post(
      `/workbooks/${workspace.workbookId}/syncs/${syncId}/sync-one-record`,
      {
        sourceFilePath: targetFile.path,
        sourceDataFolderId: workspace.dataFolderId,
      },
    );
    expect(firstCallRes.status).toBe(201);
    expect(firstCallRes.data.success).toBe(true);
    expect(firstCallRes.data.result.created).toBe(true);
    expect(firstCallRes.data.result.updated).toBe(false);
    expect(firstCallRes.data.result.error).toBeNull();
    expect(firstCallRes.data.result.destinationPath).toBeTruthy();

    // 7. Verify destination has exactly ONE real record (the other 4 source
    // records were NOT synced because we scoped to a single file)
    const destFilesAfterFirst = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: destFolder.dataFolderId },
    );
    const destFilesAfterFirstCount = listRecordFiles(
      destFilesAfterFirst.data.items,
    ).length;
    expect(destFilesAfterFirstCount).toBe(1);

    // 8. Call again with the same record — should be a no-op since the
    // destination record is already in sync with the source.
    const secondCallRes = await api.post(
      `/workbooks/${workspace.workbookId}/syncs/${syncId}/sync-one-record`,
      {
        sourceFilePath: targetFile.path,
        sourceDataFolderId: workspace.dataFolderId,
      },
    );
    expect(secondCallRes.status).toBe(201);
    expect(secondCallRes.data.success).toBe(true);
    expect(secondCallRes.data.result.created).toBe(false);
    expect(secondCallRes.data.result.updated).toBe(false);
    expect(secondCallRes.data.result.error).toBeNull();

    // 9. Destination should still have exactly one real record
    const destFilesAfterSecond = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: destFolder.dataFolderId },
    );
    const destFilesAfterSecondCount = listRecordFiles(
      destFilesAfterSecond.data.items,
    ).length;
    expect(destFilesAfterSecondCount).toBe(1);

    // 10. Sync a different source file — should create a second dest record
    // without touching the first one.
    const secondTargetFile = sourceFiles[1];
    const thirdCallRes = await api.post(
      `/workbooks/${workspace.workbookId}/syncs/${syncId}/sync-one-record`,
      {
        sourceFilePath: secondTargetFile.path,
        sourceDataFolderId: workspace.dataFolderId,
      },
    );
    expect(thirdCallRes.status).toBe(201);
    expect(thirdCallRes.data.success).toBe(true);
    expect(thirdCallRes.data.result.created).toBe(true);
    expect(thirdCallRes.data.result.updated).toBe(false);

    const destFilesFinal = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: destFolder.dataFolderId },
    );
    const destFilesFinalCount = listRecordFiles(destFilesFinal.data.items)
      .length;
    expect(destFilesFinalCount).toBe(2);
  });
});
