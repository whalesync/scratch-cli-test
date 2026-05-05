import { getAuthToken } from "@spinner/test-utils";
import { airtableFixture } from "../helpers/connector-fixtures/airtable.fixture";
import { ConnectorFixture } from "../helpers/connector-fixtures/types";
import {
  buildPlanFiles,
  commitFilesToScratchGit,
  getConnectorRepoPath,
  runPublishFromGit,
} from "../helpers/cli-publish-fixtures";
import { TestApiClient } from "../helpers/test-api-client";
import { createTestWorkspace, pullAndWait } from "../helpers/test-fixtures";

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? "http://localhost:3020";

// The CLI/desktop publish path is connector-agnostic — exercising it against
// a single fixture is enough for smoke coverage. Add more here if a connector
// has divergent CLI publish behavior.
const fixtures: ConnectorFixture[] = [airtableFixture];

describe.each(fixtures)(
  "Publish-from-git happy path (CLI): $displayName",
  (fixture) => {
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

    it("creates, edits, and deletes records via a CLI-style plan", async () => {
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

      // Discover the pulled record files. We need their on-disk filenames and
      // current content to build phase files the same way the CLI would.
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
      const editContent = JSON.parse(editDetail.data.file.content) as {
        id?: string;
        fields?: Record<string, unknown>;
      };
      expect(typeof editContent.id).toBe("string"); // remote ID needed for edit

      const deleteDetail = await api.get(
        `/workbooks/${workspace.workbookId}/files/by-path`,
        { path: deleteTarget.path },
      );
      const deleteContent = JSON.parse(deleteDetail.data.file.content) as {
        id?: string;
      };
      expect(typeof deleteContent.id).toBe("string");

      // Apply the edit to the in-memory copy. The dispatcher uses
      // `pickByShape(content, changedFields)` to pull the actual values, so we
      // mutate `currentContent` and pass `changedFields` as a shape map.
      const updatedFields = {
        ...(editContent.fields ?? {}),
        Status: "Updated via CLI smoke test",
      };
      const editCurrentContent = {
        ...editContent,
        fields: updatedFields,
      };

      const planTimestamp = `smoketest-${Date.now()}`;
      const tablePath = workspace.dataFolderPath.replace(/^\//, "");

      const { planPath, files } = buildPlanFiles({
        tablePath,
        planTimestamp,
        connectionName: `smoke-test-${fixture.displayName}`,
        connectionId: workspace.connectorAccountId,
        edits: [
          {
            filename: editTarget.name,
            currentContent: editCurrentContent,
            changedFields: { fields: { Status: "" } },
          },
        ],
        creates: [
          {
            filename: "new-record-from-cli.json",
            content: {
              fields: {
                Name: "New Record from CLI",
                Status: "Active",
                Count: 999,
              },
            },
          },
        ],
        deletes: [
          {
            filename: deleteTarget.name,
            remoteId: deleteContent.id!,
          },
        ],
      });

      // Commit the plan to the dirty branch the same way `scratchmd files
      // upload` would, then trigger the CLI run-from-git endpoint.
      const repoPath = await getConnectorRepoPath(
        api,
        workspace.workbookId,
        workspace.connectorAccountId,
      );
      await commitFilesToScratchGit(repoPath, files);

      const publishResult = await runPublishFromGit(
        api,
        workspace.workbookId,
        workspace.connectorAccountId,
        planPath,
      );
      expect(publishResult.state).toBe("completed");

      // Verify remote state: started with 5, +1 created, -1 deleted → 5.
      const remoteRecords = await fixture.dumpRecords(admin, seed);
      expect(remoteRecords).toHaveLength(5);

      const newRecord = remoteRecords.find(
        (r) => r.fields.Name === "New Record from CLI",
      );
      expect(newRecord).toBeDefined();
      expect(newRecord!.fields.Count).toBe(999);

      const editedRecord = remoteRecords.find(
        (r) => r.fields.Status === "Updated via CLI smoke test",
      );
      expect(editedRecord).toBeDefined();
      expect(editedRecord!.id).toBe(editContent.id);

      const deletedRecord = remoteRecords.find(
        (r) => r.id === deleteContent.id,
      );
      expect(deletedRecord).toBeUndefined();
    });
  },
);
