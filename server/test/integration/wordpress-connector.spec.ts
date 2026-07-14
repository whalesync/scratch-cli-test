/**
 * WordPress connector live API integration test (read-only).
 *
 * Exercises the real WordPress REST API end-to-end and, in particular, the
 * DEV-10786 page-based pagination rework: it runs a full paginated scan of a
 * post-type collection AND a taxonomy collection (the endpoint class that broke
 * under offset pagination) and asserts the scan enumerates every record with no
 * duplicates, in the deterministic `orderby=id&order=asc` order, and completes
 * cleanly (final cursor undefined — no WordPressPageIgnoredError / backstop).
 *
 * Strictly read-only: it never creates, updates, or deletes anything.
 *
 * Point it at any WordPress site — a throwaway test site is ideal — via
 * .env.integration:
 *   WORDPRESS_USERNAME              — a WordPress username
 *   WORDPRESS_APPLICATION_PASSWORD  — an Application Password for that user
 *                                     (WP admin → Users → Profile → Application Passwords)
 *   WORDPRESS_ENDPOINT              — the site URL; a bare domain (https://your-site.com)
 *                                     or the REST base (https://your-site.com/wp-json/) both
 *                                     work — the endpoint is resolved the same way production does.
 *
 * It also runs against the local fake (test-api-fakes/wordpress): set
 * WORDPRESS_ENDPOINT=http://localhost:4647/wp-json/ with any username/password
 * and seed the fake with >100 records to exercise the multi-page path.
 *
 * Run via: cd server && yarn test:integration -- wordpress-connector
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { WordPressConnector } from 'src/remote-service/connectors/library/wordpress/wordpress-connector';
import { WORDPRESS_POLLING_PAGE_SIZE } from 'src/remote-service/connectors/library/wordpress/wordpress-constants';
import { WordPressHttpClient } from 'src/remote-service/connectors/library/wordpress/wordpress-http-client';
import { WordPressDownloadProgress } from 'src/remote-service/connectors/library/wordpress/wordpress-types';
import {
  BaseJsonTableSpec,
  ConnectorFile,
  PullRecordFilesOptions,
  TablePreview,
} from 'src/remote-service/connectors/types';

// A large site can span many pages; a full scan proves completion, so give it room.
jest.setTimeout(120_000);

// Empty string when unset so the values are typed `string` (no non-null
// assertions needed) — the credential gate below keeps the suite skipped unless
// all three are actually provided.
const USERNAME = process.env.WORDPRESS_USERNAME ?? '';
const APPLICATION_PASSWORD = process.env.WORDPRESS_APPLICATION_PASSWORD ?? '';
const ENDPOINT = process.env.WORDPRESS_ENDPOINT ?? '';
const hasCreds = Boolean(USERNAME && APPLICATION_PASSWORD && ENDPOINT);

// Skip the entire suite if no credentials are configured (so CI stays green).
const describeIfCreds = hasCreds ? describe : describe.skip;

const FULL_PULL = { pullMode: 'full' } as PullRecordFilesOptions;

interface FullScanResult {
  ids: number[];
  pageCount: number;
  /** Whether the final callback signalled completion (`nextPage === undefined`). */
  completedCleanly: boolean;
}

/**
 * Drive a complete page-based paginated pull and collect every record id in the
 * order it was streamed, plus the page count and whether the last callback
 * signalled clean completion.
 */
async function fullPaginatedScan(connector: WordPressConnector, tableSpec: BaseJsonTableSpec): Promise<FullScanResult> {
  const ids: number[] = [];
  let pageCount = 0;
  let completedCleanly = false;

  await connector.pullRecordFiles(
    tableSpec,
    // eslint-disable-next-line @typescript-eslint/require-await
    async ({ files, connectorProgress }: { files: ConnectorFile[]; connectorProgress?: WordPressDownloadProgress }) => {
      pageCount += 1;
      for (const file of files) {
        const id = (file as { id?: unknown }).id;
        if (typeof id === 'number') {
          ids.push(id);
        }
      }
      completedCleanly = connectorProgress?.nextPage === undefined;
    },
    {},
    FULL_PULL,
  );

  return { ids, pageCount, completedCleanly };
}

/**
 * Assert a scan is healthy for the DEV-10786 contract: no duplicate ids (page
 * pagination never repeats a page), strictly ascending ids (the live API
 * honored `orderby=id&order=asc`), and a clean completion. When the collection
 * exceeds one page, the multi-page path must actually have run.
 */
function assertHealthyScan(result: FullScanResult, label: string): void {
  const { ids, pageCount, completedCleanly } = result;

  // No duplicate ids across pages — a page-ignoring site would repeat page 1.
  expect(new Set(ids).size).toBe(ids.length);

  // Ascending — proves the live API applied orderby=id&order=asc. (Trivially
  // true for 0/1 records; meaningful once pagination is in play.)
  const ascending = [...ids].sort((a, b) => a - b);
  expect(ids).toEqual(ascending);

  // The final page signalled completion rather than a surfaced pagination failure.
  expect(completedCleanly).toBe(true);

  console.log(`WordPress ${label}: pulled ${ids.length} record(s) across ${pageCount} page(s).`);

  if (ids.length > WORDPRESS_POLLING_PAGE_SIZE) {
    // A collection larger than one page must have advanced past page 1.
    expect(pageCount).toBeGreaterThan(1);
  } else {
    console.warn(
      `WordPress ${label} has ${ids.length} ≤ ${WORDPRESS_POLLING_PAGE_SIZE} record(s) — single page; ` +
        `the multi-page pagination path was not exercised. Seed >${WORDPRESS_POLLING_PAGE_SIZE} records to cover it.`,
    );
  }
}

describeIfCreds('WordPressConnector — live API (pagination)', () => {
  let connector: WordPressConnector;
  let tables: TablePreview[];

  beforeAll(async () => {
    // Resolve the endpoint exactly as production does (accepts a bare domain or
    // a /wp-json/ base) so the test is forgiving about the URL form provided.
    const client = new WordPressHttpClient(ENDPOINT, USERNAME, APPLICATION_PASSWORD);
    const resolvedEndpoint = await client.discoverAndValidateEndpoint();
    connector = new WordPressConnector(USERNAME, APPLICATION_PASSWORD, resolvedEndpoint);
    tables = await connector.listTables();
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an invalid application password', async () => {
      const badConnector = new WordPressConnector(USERNAME, 'not-a-real-application-password', ENDPOINT);
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns the built-in posts post-type table', () => {
      const postsTable = tables.find((t) => t.id.remoteId[0] === 'posts');
      expect(postsTable).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Full page-based paginated scan — post type
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (posts, full paginated scan)', () => {
    let postsSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      const postsTable = tables.find((t) => t.id.remoteId[0] === 'posts');
      if (!postsTable) throw new Error('posts table not found on this site');
      postsSpec = await connector.fetchJsonTableSpec(postsTable.id);
    });

    it('builds a spec exposing the id column', () => {
      const props = (postsSpec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
    });

    it('enumerates every post with no duplicates, in id order, and completes', async () => {
      const result = await fullPaginatedScan(connector, postsSpec);
      assertHealthyScan(result, 'posts');
    });
  });

  // -------------------------------------------------------------------------
  // Full page-based paginated scan — taxonomy (the endpoint class DEV-10786 fixes)
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (taxonomy, full paginated scan)', () => {
    it('enumerates every taxonomy term with no duplicates, in id order, and completes', async () => {
      // Categories/tags are the offset-ignoring endpoint class from the customer
      // report; prefer them, else fall back to any non-posts/pages/media table.
      const taxonomyTable =
        tables.find((t) => ['categories', 'tags'].includes(t.id.remoteId[0])) ??
        tables.find((t) => !['posts', 'pages', 'media'].includes(t.id.remoteId[0]));

      if (!taxonomyTable) {
        console.warn('No taxonomy table found on this site — taxonomy pagination scan skipped.');
        return;
      }

      const taxonomySpec = await connector.fetchJsonTableSpec(taxonomyTable.id);
      const result = await fullPaginatedScan(connector, taxonomySpec);
      assertHealthyScan(result, `taxonomy "${taxonomyTable.id.remoteId[0]}"`);
    });
  });
});
