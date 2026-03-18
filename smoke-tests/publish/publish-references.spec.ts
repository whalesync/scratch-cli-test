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

describe.each(fixtures)("Publish with references: $displayName", (fixture) => {
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

  it("resolves circular foreign key references via BACKFILL phase", async () => {
    if (!fixture.seedWithReferences) {
      // Skip connectors that don't support linked records
      return;
    }

    const admin = fixture.createAdminClient();
    const seed = await fixture.seedWithReferences(admin);

    const workspace = await createTestWorkspace(api, {
      service: fixture.service,
      credentials: fixture.createConnectionCredentials(),
      remoteTableId: seed.remoteTableId,
      tableName: seed.tableName,
    });

    // Pull existing data
    const pullJob = await pullAndWait(api, workspace.workbookId, [
      workspace.dataFolderId,
    ]);
    expect(pullJob.state).toBe("completed");

    // Get the data folder path for reference in new files
    const filesRes = await api.get(
      `/workbooks/${workspace.workbookId}/files/list/by-folder`,
      {
        folderId: workspace.dataFolderId,
      },
    );
    const pulledFiles = filesRes.data.items.filter(
      (item: any) => item.type === "file" && item.name !== ".schema.json",
    );
    expect(pulledFiles.length).toBeGreaterThanOrEqual(2);

    // Create two new files that reference each other using @/ pseudo-refs
    // File A: new author referencing new book
    // File B: new book referencing new author
    const newAuthorContent = {
      fields: {
        Name: "New Author",
        Books: [`@${workspace.dataFolderPath}/new-book.json`],
      },
    };
    const newBookContent = {
      fields: {
        Title: "New Book",
        Author: [`@${workspace.dataFolderPath}/new-author.json`],
      },
    };

    const createAuthor = await api.post(
      `/workbooks/${workspace.workbookId}/files`,
      {
        name: "new-author.json",
        parentFolderId: workspace.dataFolderId,
        content: JSON.stringify(newAuthorContent),
      },
    );
    expect(createAuthor.status).toBe(201);

    const createBook = await api.post(
      `/workbooks/${workspace.workbookId}/files`,
      {
        name: "new-book.json",
        parentFolderId: workspace.dataFolderId,
        content: JSON.stringify(newBookContent),
      },
    );
    expect(createBook.status).toBe(201);

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
    );
    expect(publishResult.state).toBe("completed");

    // Verify remote state: both new records should exist with real IDs (not @/ pseudo-refs)
    const remoteRecords = await fixture.dumpRecords(admin, seed);
    const newAuthor = remoteRecords.find((r) => r.fields.Name === "New Author");
    const newBook = remoteRecords.find(
      (r) => (r.fields as any).Title === "New Book",
    );

    expect(newAuthor).toBeDefined();
    expect(newBook).toBeDefined();

    // After BACKFILL, the linked fields should contain real record IDs (not @/ paths)
    if (newAuthor && newBook) {
      const authorBooks = newAuthor.fields.Books as string[];
      const bookAuthors = (newBook.fields as any).Author as string[];

      if (authorBooks && authorBooks.length > 0) {
        expect(authorBooks[0]).toMatch(/^rec/); // Should be a real Airtable record ID
        expect(authorBooks[0]).toBe(newBook.id);
      }
      if (bookAuthors && bookAuthors.length > 0) {
        expect(bookAuthors[0]).toMatch(/^rec/);
        expect(bookAuthors[0]).toBe(newAuthor.id);
      }
    }
  });
});
