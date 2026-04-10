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

describe.each(fixtures)("Sync incremental: $displayName", (fixture) => {
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

  it("re-running a sync after editing/adding/deleting source files reflects the changes in destination", async () => {
    if (!fixture.seedSyncPair) {
      // Skip connectors that don't expose a sync pair fixture
      return;
    }

    const admin = fixture.createAdminClient();
    const seed = await fixture.seedSyncPair(admin, { recordCount: 3 });

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

    // 3. Create the sync
    const syncRes = await api.post(
      `/workbooks/${workspace.workbookId}/syncs`,
      {
        displayName: "Smoke Test Incremental Sync",
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

    // 4. First run — all creates
    const firstRun = await runSyncAndWait(api, workspace.workbookId, syncId);
    expect(firstRun.state).toBe("completed");
    expect(firstRun.publicProgress.tables[0].creates).toBe(
      seed.source.recordCount,
    );
    expect(firstRun.publicProgress.tables[0].updates).toBe(0);
    expect(firstRun.publicProgress.tables[0].deletes).toBe(0);

    // 5. Mutate source: edit one existing file, add one new file, delete one file
    const sourceListRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: workspace.dataFolderId },
    );
    const sourceFiles = listRecordFiles(sourceListRes.data.items);
    expect(sourceFiles.length).toBe(seed.source.recordCount);

    // Edit the first source file: bump the value at a non-matching column so
    // the sync sees an update without losing the record's identity.
    const editableMapping = seed.columnMappings.find(
      (m) =>
        m.sourceColumnId !== seed.recordMatching.sourceColumnId ||
        m.destinationColumnId !== seed.recordMatching.destinationColumnId,
    );
    if (!editableMapping) {
      throw new Error(
        "Sync fixture must define at least one column mapping outside of recordMatching for incremental update tests",
      );
    }
    const fileToEdit = sourceFiles[0];
    const detailRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/by-path`,
      { path: fileToEdit.path },
    );
    const editedContent = JSON.parse(detailRes.data.file.content);
    setAtPath(
      editedContent,
      editableMapping.sourceColumnId,
      "edited-by-smoke-test",
    );
    const editRes = await api.patch(
      `/workbooks/${workspace.workbookId}/files/by-path`,
      { content: JSON.stringify(editedContent) },
      { path: fileToEdit.path },
    );
    expect(editRes.status).toBe(204);

    // Delete the last source file
    const fileToDelete = sourceFiles[sourceFiles.length - 1];
    const deleteRes = await api.delete(
      `/workbooks/${workspace.workbookId}/files/by-path`,
      { path: fileToDelete.path },
    );
    expect(deleteRes.status).toBe(204);

    // Add a brand-new source file by cloning a remaining file's structure and
    // giving it a unique top-level id and a unique value at the record-matching
    // column. Cloning means we don't need to know the schema's required fields.
    const templatePath = sourceFiles[1].path;
    const templateDetailRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/by-path`,
      { path: templatePath },
    );
    const newContent = JSON.parse(templateDetailRes.data.file.content);
    const newRecordKey = "smoke-test-new-record";
    // Override the top-level id so it doesn't collide with the template's id
    newContent.id = newRecordKey;
    setAtPath(newContent, seed.recordMatching.sourceColumnId, newRecordKey);
    const createRes = await api.post(
      `/workbooks/${workspace.workbookId}/files`,
      {
        name: "smoke-test-new-record.json",
        parentFolderId: workspace.dataFolderId,
        content: JSON.stringify(newContent),
      },
    );
    expect(createRes.status).toBe(201);

    // 6. Re-run sync — expect 1 update (the edited record), 1 create (the
    // new source record). Sync does NOT propagate source deletions to the
    // destination (the deleted source record's dest counterpart simply
    // becomes an orphan), so deletes is always 0 here.
    const secondRun = await runSyncAndWait(api, workspace.workbookId, syncId);
    expect(secondRun.state).toBe("completed");
    const tableProgress = secondRun.publicProgress.tables[0];
    expect(tableProgress.status).toBe("completed");
    expect(tableProgress.errorCount).toBe(0);
    expect(tableProgress.creates).toBe(1);
    expect(tableProgress.updates).toBe(1);
    expect(tableProgress.deletes).toBe(0);

    // 7. Final destination file count: 3 original creates + 1 new create +
    // 1 orphan (the dest counterpart of the deleted source record) = 4.
    const destListRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      { folderId: destFolder.dataFolderId },
    );
    const destFiles = listRecordFiles(destListRes.data.items);
    expect(destFiles.length).toBe(seed.source.recordCount + 1);
  });
});

/**
 * Set a value at a dot-notation path inside a nested object, creating intermediate
 * objects as needed. Mirrors the lodash `set` semantics used by the sync transformer
 * pipeline so the test mutations land at the same paths the sync reads from.
 */
function setAtPath(
  target: Record<string, any>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let current: Record<string, any> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === undefined || current[key] === null) {
      current[key] = {};
    }
    current = current[key];
  }
  current[parts[parts.length - 1]] = value;
}
