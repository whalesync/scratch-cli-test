import { getAuthToken } from '@spinner/test-utils';
import { TestApiClient } from '../helpers/test-api-client';
import { airtableFixture } from '../helpers/connector-fixtures/airtable.fixture';
import { ConnectorFixture } from '../helpers/connector-fixtures/types';
import { createTestWorkspace, pullAndWait, planPublish, runPublish } from '../helpers/test-fixtures';
import { waitForJob } from '../helpers/wait-for-job';

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? 'http://localhost:3020';

const fixtures: ConnectorFixture[] = [airtableFixture];

describe.each(fixtures)('Publish happy path: $displayName', (fixture) => {
  let api: TestApiClient;

  beforeAll(async () => {
    const { authToken } = await getAuthToken();
    api = new TestApiClient(SERVER_URL, authToken, async () => { const r = await getAuthToken(true); return r.authToken; });
  });

  afterAll(async () => {
    const admin = fixture.createAdminClient();
    await admin.reset();
  });

  describe('create, edit, delete, then publish', () => {
    let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;
    let admin: ReturnType<typeof fixture.createAdminClient>;
    let seed: Awaited<ReturnType<typeof fixture.seed>>;

    beforeAll(async () => {
      admin = fixture.createAdminClient();
      seed = await fixture.seed(admin, { recordCount: 5 });

      workspace = await createTestWorkspace(api, {
        service: fixture.service,
        credentials: fixture.createConnectionCredentials(),
        remoteTableId: seed.remoteTableId,
        tableName: seed.tableName,
      });

      // Pull initial data
      const pullJob = await pullAndWait(api, workspace.workbookId, [workspace.dataFolderId]);
      expect(pullJob.state).toBe('completed');
    });

    it('creates a new file on dirty branch', async () => {
      const createRes = await api.post(`/workbooks/${workspace.workbookId}/files`, {
        name: 'new-record.json',
        parentFolderId: workspace.dataFolderId,
        content: JSON.stringify({ fields: { Name: 'New Record', Status: 'Active', Count: 999 } }),
      });
      expect(createRes.status).toBe(201);
    });

    it('edits an existing file on dirty branch', async () => {
      // Get list of pulled files
      const filesRes = await api.get(`/workbooks/${workspace.workbookId}/files/list/by-folder`, {
        folderId: workspace.dataFolderId,
      });
      const files = filesRes.data.items.filter((item: any) => item.type === 'file' && item.name !== '.schema.json');
      expect(files.length).toBeGreaterThan(0);

      // Pick the first pulled file (not our newly created one)
      const existingFile = files.find((f: any) => f.name !== 'new-record.json');
      expect(existingFile).toBeDefined();

      // Read its current content and modify it
      const detailRes = await api.get(`/workbooks/${workspace.workbookId}/files/by-path`, {
        path: existingFile.path,
      });
      const content = JSON.parse(detailRes.data.file.content);
      content.fields.Status = 'Updated via smoke test';

      const editRes = await api.patch(
        `/workbooks/${workspace.workbookId}/files/by-path`,
        { content: JSON.stringify(content) },
        { path: existingFile.path },
      );
      expect(editRes.status).toBe(204);
    });

    it('deletes a file on dirty branch', async () => {
      const filesRes = await api.get(`/workbooks/${workspace.workbookId}/files/list/by-folder`, {
        folderId: workspace.dataFolderId,
      });
      const files = filesRes.data.items.filter((item: any) => item.type === 'file' && item.name !== '.schema.json');

      // Pick the last pulled file (not our new one, not the one we edited)
      const fileToDelete = files[files.length - 1];
      expect(fileToDelete).toBeDefined();

      const deleteRes = await api.delete(`/workbooks/${workspace.workbookId}/files/by-path`, {
        path: fileToDelete.path,
      });
      expect(deleteRes.status).toBe(204);
    });

    it('publishes all changes and verifies remote state', async () => {
      // Build publish plan
      const { jobId: planJobId, pipelineId } = await planPublish(
        api,
        workspace.workbookId,
        workspace.connectorAccountId,
      );

      // Wait for planning to complete
      expect(planJobId).not.toBeNull();
      expect(pipelineId).not.toBeNull();
      const planResult = await waitForJob(api, planJobId!);
      expect(planResult.state).toBe('completed');

      // Run the publish
      const publishResult = await runPublish(api, workspace.workbookId, pipelineId!);
      expect(publishResult.state).toBe('completed');

      // Verify remote state via /test/dump
      const remoteRecords = await fixture.dumpRecords(admin, seed);

      // Started with 5, created 1, deleted 1 → expect 5
      expect(remoteRecords).toHaveLength(5);

      // Verify the new record was created
      const newRecord = remoteRecords.find((r) => r.fields.Name === 'New Record');
      expect(newRecord).toBeDefined();
      expect(newRecord!.fields.Count).toBe(999);

      // Verify the edited record was updated
      const updatedRecord = remoteRecords.find((r) => r.fields.Status === 'Updated via smoke test');
      expect(updatedRecord).toBeDefined();
    });
  });
});
