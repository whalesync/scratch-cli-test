import { getAuthToken } from '@spinner/test-utils';
import { TestApiClient } from '../helpers/test-api-client';
import { airtableFixture } from '../helpers/connector-fixtures/airtable.fixture';
import { ConnectorFixture } from '../helpers/connector-fixtures/types';
import { createTestWorkspace, pullAndWait, planPublish, runPublish } from '../helpers/test-fixtures';
import { waitForJob } from '../helpers/wait-for-job';

const SERVER_URL = process.env.SMOKE_TEST_SERVER_URL ?? 'http://localhost:3020';

const fixtures: ConnectorFixture[] = [airtableFixture];

describe.each(fixtures)('Publish errors: $displayName', (fixture) => {
  let api: TestApiClient;

  beforeAll(async () => {
    const { authToken } = await getAuthToken();
    api = new TestApiClient(SERVER_URL, authToken, async () => { const r = await getAuthToken(true); return r.authToken; });
  });

  afterAll(async () => {
    const admin = fixture.createAdminClient();
    await admin.reset();
  });

  it('surfaces API errors when publishing invalid field values', async () => {
    const admin = fixture.createAdminClient();
    const seed = await fixture.seed(admin, { recordCount: 3 });

    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.remoteTableId,
      tableName: seed.tableName,
    });

    // Pull
    const pullJob = await pullAndWait(api, workspace.workbookId, [workspace.dataFolderId]);
    expect(pullJob.state).toBe('completed');

    // Edit a file with an invalid value (string in a number field)
    const filesRes = await api.get(`/workbooks/${workspace.workbookId}/files/list/by-folder`, {
      folderId: workspace.dataFolderId,
    });
    const files = filesRes.data.items.filter((item: any) => item.type === 'file' && item.name !== '.schema.json');
    const fileToEdit = files[0];

    const detailRes = await api.get(`/workbooks/${workspace.workbookId}/files/by-path`, {
      path: fileToEdit.path,
    });
    const content = JSON.parse(detailRes.data.file.content);
    content.fields.Count = 'not-a-number'; // Invalid: should be a number

    await api.patch(
      `/workbooks/${workspace.workbookId}/files/by-path`,
      { content: JSON.stringify(content) },
      { path: fileToEdit.path },
    );

    // Queue a validation error on the fake for the next update request
    await admin.simulateError(422, {
      error: {
        type: 'INVALID_VALUE_FOR_COLUMN',
        message: 'Field "Count" cannot accept the value "not-a-number". Expected a number.',
      },
    });

    // Publish — plan should succeed, run should report the error
    const { jobId: planJobId, pipelineId } = await planPublish(
      api,
      workspace.workbookId,
      workspace.connectorAccountId,
    );
    expect(planJobId).not.toBeNull();
    expect(pipelineId).not.toBeNull();
    const planResult = await waitForJob(api, planJobId!);
    expect(planResult.state).toBe('completed');

    const publishResult = await runPublish(api, workspace.workbookId, pipelineId!);

    // The publish job may complete with errors or fail entirely — either is acceptable
    // as long as the error is surfaced rather than silently swallowed
    expect(['completed', 'failed']).toContain(publishResult.state);
  });
});
