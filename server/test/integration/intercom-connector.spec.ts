/**
 * Intercom connector live API integration test.
 *
 * Exercises the real Intercom API: validates credentials, discovers schema,
 * pulls articles and collections, creates/updates/deletes test records.
 *
 * Requires INTERCOM_ACCESS_TOKEN in .env.integration.
 * Run via: cd server && yarn test:integration -- intercom-connector
 */

// Break the circular import chain
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { IntercomConnector } from 'src/remote-service/connectors/library/intercom/intercom-connector';
import { BaseJsonTableSpec, ConnectorFile, EntityId } from 'src/remote-service/connectors/types';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = process.env.INTERCOM_ACCESS_TOKEN;

const ARTICLES_ID: EntityId = { wsId: 'articles', remoteId: ['articles'] };
const COLLECTIONS_ID: EntityId = { wsId: 'collections', remoteId: ['collections'] };
const CONVERSATIONS_ID: EntityId = { wsId: 'conversations', remoteId: ['conversations'] };

// Unique suffix to avoid collisions with real data
const TEST_SUFFIX = `scratch-test-${Date.now()}`;

/**
 * We need a valid author_id to create articles. This must be an admin
 * (teammate) in the Intercom workspace. We discover it via the API client.
 */
let testAuthorId: number | undefined;

function createConnector(): IntercomConnector {
  return new IntercomConnector(ACCESS_TOKEN!);
}

async function collectPulledFiles(
  connector: IntercomConnector,
  tableSpec: BaseJsonTableSpec,
): Promise<ConnectorFile[]> {
  const allFiles: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    tableSpec,
    async ({ files }) => {
      allFiles.push(...files);
    },
    {},
    { forceFull: false },
  );
  return allFiles;
}

/**
 * Discover the first admin ID from the workspace to use as author_id.
 * Uses a raw API call since the connector doesn't expose admin listing.
 */
async function discoverAuthorId(): Promise<number> {
  // Access the internal API client to call /me
  const connector = createConnector();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const client = (connector as unknown as { client: { validateCredentials: () => Promise<void> } }).client;

  // We can't easily call /me from the connector, so we'll use the first article's
  // author_id if any articles exist, or fall back to fetching /admins
  const articlesSpec = await connector.fetchJsonTableSpec(ARTICLES_ID);
  const files = await collectPulledFiles(connector, articlesSpec);
  if (files.length > 0) {
    return (files[0] as unknown as { author_id: number }).author_id;
  }

  // If no articles exist, we need to discover the admin ID another way.
  // For now, we'll validate credentials and assume admin ID 1 — this may need
  // to be configured per workspace.
  await client.validateCredentials();
  throw new Error(
    'No existing articles found to discover author_id. ' +
      'Please set INTERCOM_TEST_AUTHOR_ID in .env.integration or create at least one article.',
  );
}

// Skip the entire suite if no access token is configured
const describeIfToken = ACCESS_TOKEN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfToken(
  'IntercomConnector — live API',
  () => {
    let connector: IntercomConnector;

    beforeAll(async () => {
      connector = createConnector();

      // Discover a valid author_id for creating articles
      if (process.env.INTERCOM_TEST_AUTHOR_ID) {
        testAuthorId = Number(process.env.INTERCOM_TEST_AUTHOR_ID);
      } else {
        testAuthorId = await discoverAuthorId();
      }
    });

    // Track IDs for cleanup
    let createdArticleId: string | undefined;
    let createdCollectionId: string | undefined;

    afterAll(async () => {
      // Best-effort cleanup of test data
      const cleanupConnector = createConnector();
      try {
        if (createdArticleId) {
          const spec = await cleanupConnector.fetchJsonTableSpec(ARTICLES_ID);
          await cleanupConnector.deleteRecords(spec, [{ id: createdArticleId } as ConnectorFile]);
        }
      } catch {
        // Ignore cleanup errors
      }
      try {
        if (createdCollectionId) {
          const spec = await cleanupConnector.fetchJsonTableSpec(COLLECTIONS_ID);
          await cleanupConnector.deleteRecords(spec, [{ id: createdCollectionId } as ConnectorFile]);
        }
      } catch {
        // Ignore cleanup errors
      }
    });

    // -------------------------------------------------------------------------
    // Connection
    // -------------------------------------------------------------------------

    describe('testConnection', () => {
      it('validates credentials against the live API', async () => {
        await expect(connector.testConnection()).resolves.toBeUndefined();
      });

      it('rejects invalid credentials', async () => {
        const badConnector = new IntercomConnector('invalid-token-12345');
        await expect(badConnector.testConnection()).rejects.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    // Table discovery
    // -------------------------------------------------------------------------

    describe('listTables', () => {
      it('returns articles and collections', async () => {
        const tables = await connector.listTables();
        const ids = tables.map((t) => t.id.wsId);
        expect(ids).toContain('articles');
        expect(ids).toContain('collections');
      });
    });

    // -------------------------------------------------------------------------
    // Collections
    // -------------------------------------------------------------------------

    describe('collections', () => {
      let collectionsSpec: BaseJsonTableSpec;

      beforeAll(async () => {
        collectionsSpec = await connector.fetchJsonTableSpec(COLLECTIONS_ID);
      });

      it('builds a schema with all collection fields', () => {
        expect(collectionsSpec.name).toBe('Collections');
        expect(collectionsSpec.idColumnRemoteId).toBe('id');
        expect(collectionsSpec.schema.properties).toHaveProperty('id');
        expect(collectionsSpec.schema.properties).toHaveProperty('name');
        expect(collectionsSpec.schema.properties).toHaveProperty('description');
      });

      it('creates a test collection', async () => {
        const files: ConnectorFile[] = [
          {
            name: `Test Collection ${TEST_SUFFIX}`,
            description: `Integration test collection created at ${new Date().toISOString()}`,
          } as unknown as ConnectorFile,
        ];

        const created = await connector.createRecords(collectionsSpec, files);

        expect(created).toHaveLength(1);
        const collection = created[0] as unknown as { id: string; name: string };
        expect(collection.id).toBeDefined();
        expect(collection.name).toBe(`Test Collection ${TEST_SUFFIX}`);
        createdCollectionId = collection.id;
      });

      it('pulls collections and finds the created one', async () => {
        expect(createdCollectionId).toBeDefined();

        const files = await collectPulledFiles(connector, collectionsSpec);
        const found = files.find(
          (f) => (f as unknown as { name: string }).name === `Test Collection ${TEST_SUFFIX}`,
        );
        expect(found).toBeDefined();
      });

      it('fetches the collection by ID', async () => {
        expect(createdCollectionId).toBeDefined();

        const files: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(collectionsSpec, [createdCollectionId!], async ({ files: batch }) => {
          files.push(...batch);
        });

        expect(files).toHaveLength(1);
        expect((files[0] as unknown as { name: string }).name).toBe(`Test Collection ${TEST_SUFFIX}`);
      });

      it('updates the test collection', async () => {
        expect(createdCollectionId).toBeDefined();

        const files: ConnectorFile[] = [
          {
            id: createdCollectionId,
            name: `Updated Collection ${TEST_SUFFIX}`,
          } as unknown as ConnectorFile,
        ];

        await expect(connector.updateRecords(collectionsSpec, files)).resolves.toBeUndefined();

        // Verify the update by fetching
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(collectionsSpec, [createdCollectionId!], async ({ files: batch }) => {
          fetched.push(...batch);
        });

        expect((fetched[0] as unknown as { name: string }).name).toBe(`Updated Collection ${TEST_SUFFIX}`);
      });

      it('deletes the test collection', async () => {
        expect(createdCollectionId).toBeDefined();

        await expect(
          connector.deleteRecords(collectionsSpec, [{ id: createdCollectionId } as ConnectorFile]),
        ).resolves.toBeUndefined();

        // Verify deletion — fetch should return empty
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(collectionsSpec, [createdCollectionId!], async ({ files: batch }) => {
          fetched.push(...batch);
        });
        expect(fetched).toHaveLength(0);

        // Clear so afterAll doesn't try to double-delete
        createdCollectionId = undefined;
      });
    });

    // -------------------------------------------------------------------------
    // Articles
    // -------------------------------------------------------------------------

    describe('articles', () => {
      let articlesSpec: BaseJsonTableSpec;

      beforeAll(async () => {
        articlesSpec = await connector.fetchJsonTableSpec(ARTICLES_ID);
      });

      it('builds a schema with all article fields', () => {
        expect(articlesSpec.name).toBe('Articles');
        expect(articlesSpec.idColumnRemoteId).toBe('id');
        expect(articlesSpec.schema.properties).toHaveProperty('id');
        expect(articlesSpec.schema.properties).toHaveProperty('title');
        expect(articlesSpec.schema.properties).toHaveProperty('body');
        expect(articlesSpec.schema.properties).toHaveProperty('author_id');
        expect(articlesSpec.schema.properties).toHaveProperty('state');
      });

      it('creates a test article', async () => {
        expect(testAuthorId).toBeDefined();

        const files: ConnectorFile[] = [
          {
            title: `Test Article ${TEST_SUFFIX}`,
            author_id: testAuthorId,
            body: `<p>Integration test article created at ${new Date().toISOString()}</p>`,
            state: 'draft',
          } as unknown as ConnectorFile,
        ];

        const created = await connector.createRecords(articlesSpec, files);

        expect(created).toHaveLength(1);
        const article = created[0] as unknown as { id: string; title: string };
        expect(article.id).toBeDefined();
        expect(article.title).toBe(`Test Article ${TEST_SUFFIX}`);
        createdArticleId = article.id;
      });

      it('pulls articles and finds the created one', async () => {
        expect(createdArticleId).toBeDefined();

        const files = await collectPulledFiles(connector, articlesSpec);
        const found = files.find(
          (f) => (f as unknown as { title: string }).title === `Test Article ${TEST_SUFFIX}`,
        );
        expect(found).toBeDefined();
      });

      it('fetches the article by ID', async () => {
        expect(createdArticleId).toBeDefined();

        const files: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(articlesSpec, [createdArticleId!], async ({ files: batch }) => {
          files.push(...batch);
        });

        expect(files).toHaveLength(1);
        expect((files[0] as unknown as { title: string }).title).toBe(`Test Article ${TEST_SUFFIX}`);
      });

      it('updates the test article', async () => {
        expect(createdArticleId).toBeDefined();

        const files: ConnectorFile[] = [
          {
            id: createdArticleId,
            title: `Updated Article ${TEST_SUFFIX}`,
            author_id: testAuthorId,
          } as unknown as ConnectorFile,
        ];

        await expect(connector.updateRecords(articlesSpec, files)).resolves.toBeUndefined();

        // Verify the update by fetching
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(articlesSpec, [createdArticleId!], async ({ files: batch }) => {
          fetched.push(...batch);
        });

        expect((fetched[0] as unknown as { title: string }).title).toBe(`Updated Article ${TEST_SUFFIX}`);
      });

      it('deletes the test article', async () => {
        expect(createdArticleId).toBeDefined();

        await expect(
          connector.deleteRecords(articlesSpec, [{ id: createdArticleId } as ConnectorFile]),
        ).resolves.toBeUndefined();

        // Verify deletion — fetch should return empty
        const fetched: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(articlesSpec, [createdArticleId!], async ({ files: batch }) => {
          fetched.push(...batch);
        });
        expect(fetched).toHaveLength(0);

        // Clear so afterAll doesn't try to double-delete
        createdArticleId = undefined;
      });

      it('handles deleting a non-existent article gracefully', async () => {
        await expect(
          connector.deleteRecords(articlesSpec, [{ id: '999999999' } as ConnectorFile]),
        ).resolves.toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------
    // Conversations (read-only)
    // -------------------------------------------------------------------------

    describe('conversations', () => {
      let conversationsSpec: BaseJsonTableSpec;

      beforeAll(async () => {
        conversationsSpec = await connector.fetchJsonTableSpec(CONVERSATIONS_ID);
      });

      it('builds a schema with all conversation fields', () => {
        expect(conversationsSpec.name).toBe('Conversations');
        expect(conversationsSpec.schema.properties).toHaveProperty('id');
        expect(conversationsSpec.schema.properties).toHaveProperty('state');
        expect(conversationsSpec.schema.properties).toHaveProperty('source');
        expect(conversationsSpec.schema.properties).toHaveProperty('conversation_parts');
      });

      it(
        'pulls a page of conversations without hydration',
        async () => {
          // Use the internal API client to list just one page (avoids pulling all 20k+ records)
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const apiClient = (connector as unknown as { client: { listConversations: (pageSize: number, hydrate: boolean) => AsyncGenerator<Record<string, unknown>[]> } }).client;

          let firstBatch: Record<string, unknown>[] = [];
          for await (const page of apiClient.listConversations(5, false)) {
            firstBatch = page;
            break; // Stop after first page
          }

          expect(firstBatch.length).toBeGreaterThan(0);

          const first = firstBatch[0] as { id: string; state: string; source: { body: string } };
          expect(first.id).toBeDefined();
          expect(first.state).toBeDefined();
          expect(first.source).toBeDefined();
        },
        30_000,
      );

      it(
        'fetches a single conversation by ID with full conversation_parts',
        async () => {
          // Get one conversation ID from a non-hydrated list call
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const apiClient = (connector as unknown as { client: { listConversations: (pageSize: number, hydrate: boolean) => AsyncGenerator<Record<string, unknown>[]> } }).client;

          let conversationId: string | undefined;
          for await (const page of apiClient.listConversations(1, false)) {
            conversationId = (page[0] as { id: string }).id;
            break;
          }

          if (!conversationId) return; // No conversations — skip

          // Fetch the full conversation via pullRecordFilesByIds (always hydrates)
          const fetched: ConnectorFile[] = [];
          await connector.pullRecordFilesByIds(conversationsSpec, [conversationId], async ({ files: batch }) => {
            fetched.push(...batch);
          });

          expect(fetched).toHaveLength(1);
          expect((fetched[0] as unknown as { id: string }).id).toBe(conversationId);
          expect(fetched[0]).toHaveProperty('conversation_parts');
        },
        30_000,
      );
    });
  },
  60_000,
); // 60s timeout for live API calls
