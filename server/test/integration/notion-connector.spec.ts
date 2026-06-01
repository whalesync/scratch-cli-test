/**
 * Notion connector live API integration test.
 *
 * Phase 1 of the @notionhq/client 3.x → 5.x upgrade (DEV-8910): land a real-API
 * regression backstop BEFORE touching any source. The 11 existing Notion unit
 * specs all `jest.mock('@notionhq/client')` and assume v3 response shapes, so
 * they will silently keep passing through the upgrade. This suite is the
 * contract between the v3 era and everything that comes next.
 *
 * Two suites:
 *
 *   1. Read-only smoke: validates credentials, discovers the seed database,
 *      builds a schema, and pulls records. Captures a `fetchJsonTableSpec`
 *      snapshot — the diff against the v5 SDK output is the gate for
 *      Phase 3 / Phase 4.
 *   2. CRUD round-trip: create → update → delete (archive) one page, and
 *      confirm `updateRecords` silently strips read-only properties.
 *
 * Requires NOTION_API_KEY in .env.integration. See
 * `server/test/integration/notion-setup.md` for the one-time Notion workspace
 * setup (free workspace + internal integration + two shared databases).
 *
 * Run via: cd server && yarn test:integration -- notion-connector
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { NotionConnector } from 'src/remote-service/connectors/library/notion/notion-connector';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

// Notion is slower than most APIs (3 req/s integration limit + recursive block
// fetches per page) — give the suite a generous budget.
jest.setTimeout(120_000);

const API_KEY = process.env.NOTION_API_KEY;

/**
 * Name of the primary test database in the Notion workspace. Must contain the
 * property types listed in `notion-setup.md`. The test discovers the database
 * by exact title match — no UUID needed in env.
 */
const PRIMARY_DB_NAME = 'Scratch Integration Test';

const ROUND_TRIP_TITLE_PREFIX = 'Spinner Roundtrip';

function createConnector(): NotionConnector {
  return new NotionConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

// ===========================================================================
// Read-only smoke
// ===========================================================================

describeIfKey('NotionConnector — live API', () => {
  let connector: NotionConnector;
  let allTables: TablePreview[];
  let primaryTable: TablePreview;
  let primarySpec: BaseJsonTableSpec;

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    const found = allTables.find((t) => t.displayName === PRIMARY_DB_NAME);
    if (!found) {
      throw new Error(
        `Notion test database "${PRIMARY_DB_NAME}" not found. ` +
          `Run the setup in server/test/integration/notion-setup.md — the integration must be ` +
          `shared to a database with that exact title.`,
      );
    }
    primaryTable = found;
    primarySpec = await connector.fetchJsonTableSpec(primaryTable.id);
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an obviously invalid token', async () => {
      const badConnector = new NotionConnector('ntn_not_a_real_notion_token');
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  describe('listTables', () => {
    it('includes the seed database', () => {
      expect(allTables.length).toBeGreaterThan(0);
      const names = allTables.map((t) => t.displayName);
      expect(names).toContain(PRIMARY_DB_NAME);
    });

    it('every table has a valid Notion-shaped EntityId', () => {
      for (const table of allTables) {
        expect(table.id.wsId.length).toBeGreaterThan(0);
        // Under 2025-09-03 every table is a data source, surfaced as
        // `remoteId = [databaseId, dataSourceId]` to match the Phase 2 backfill
        // shape. Both elements must be valid Notion IDs (32 hex chars with
        // optional dashes).
        expect(table.id.remoteId).toHaveLength(2);
        for (const id of table.id.remoteId) {
          expect(id).toMatch(/^[0-9a-f-]{32,36}$/i);
        }
        expect(table.displayName.length).toBeGreaterThan(0);
        expect((table.metadata as { notionType?: string } | undefined)?.notionType).toBe('data_source');
      }
    });
  });

  describe('searchTables', () => {
    it('finds the seed database by partial title match', async () => {
      const { tables, hasMore } = await connector.searchTables('Scratch Integration');
      expect(typeof hasMore).toBe('boolean');
      expect(tables.map((t) => t.displayName)).toContain(PRIMARY_DB_NAME);
    });

    it('returns an empty result for a nonsense query', async () => {
      const { tables } = await connector.searchTables(`zz-no-such-db-${Date.now()}`);
      // The seed database title doesn't contain the timestamp suffix, so the
      // result set should be empty (or at worst, exclude PRIMARY_DB_NAME).
      expect(tables.find((t) => t.displayName === PRIMARY_DB_NAME)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Schema discovery — the highest-risk surface for the v5 upgrade.
  // -------------------------------------------------------------------------

  describe('fetchJsonTableSpec', () => {
    it('builds a spec with the expected top-level structure', () => {
      expect(primarySpec.id).toEqual(primaryTable.id);
      // `name` is the wsId-sanitized form (lowercase + underscores), not the
      // display title — see buildNotionJsonTableSpec at notion-json-schema.ts.
      expect(primarySpec.name).toBe(primarySpec.id.wsId);
      expect(primarySpec.idColumnRemoteId).toBe('id');
      expect(primarySpec.schema).toBeDefined();

      const props = (primarySpec.schema as unknown as { properties: Record<string, unknown> }).properties;
      // Top-level page fields the schema always exposes.
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('properties');
      expect(props).toHaveProperty('created_time');
      expect(props).toHaveProperty('last_edited_time');
    });

    it('schema covers every property type configured in the seed database', () => {
      const propsBag = (primarySpec.schema as unknown as { properties: Record<string, unknown> }).properties;
      const propertyTypes = (propsBag.properties as { properties: Record<string, unknown> }).properties;
      const typeKeys = Object.keys(propertyTypes);

      // These are the property types the setup guide tells the user to create.
      // If a user misses one, the failing assertion below tells them which.
      const required = [
        'Name', // title
        'Description', // rich_text
        'Status', // status
        'Priority', // select
        'Tags', // multi_select
        'Estimate', // number
        'Due Date', // date
        'Done', // checkbox
        'Owner Email', // email
        'Link', // url
        'Attachments', // files
        'Linked Items', // relation
        'Linked Count', // rollup over the relation
        'Score', // formula
      ];

      for (const fieldName of required) {
        expect(typeKeys).toContain(fieldName);
      }
    });

    it('snapshot — captures the v3 fetchJsonTableSpec shape as the upgrade contract', () => {
      // This snapshot is the "v3 baseline" referenced in the upgrade plan
      // (docs/plans/2026-05-25-notion-client-v5-upgrade.md, Phase 1 → 3 → 4).
      // Strip volatile fields so the snapshot is reproducible.
      const snapshot = redactForSnapshot(primarySpec);
      expect(snapshot).toMatchSnapshot();
    });

    it('throws for a non-existent database id', async () => {
      const badId = { wsId: 'nope', remoteId: ['00000000000000000000000000000000'] };
      await expect(connector.fetchJsonTableSpec(badId)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Filename suggestion
  // -------------------------------------------------------------------------

  describe('getSuggestedRecordFileNames', () => {
    it('derives filenames from the title property', async () => {
      const sample = await pullFirstPage(connector, primarySpec);
      if (sample.length === 0) {
        throw new Error(
          `Seed database "${PRIMARY_DB_NAME}" has no pages — add a couple seed pages (see notion-setup.md).`,
        );
      }
      const names = connector.getSuggestedRecordFileNames(sample, primarySpec);
      expect(names).toHaveLength(sample.length);
      // At least one seed page must have a non-empty title; otherwise the
      // setup guide isn't being followed.
      expect(names.some((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pull — full
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (full)', () => {
    it('streams pages with page_content populated', async () => {
      const files = await pullAll(connector, primarySpec, {});

      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.id).toMatch(/^[0-9a-f-]{32,36}$/i);
        expect(file.object).toBe('page');
        expect(file).toHaveProperty('properties');
        // page_content is fetched in-line for every page on a default pull.
        expect(file).toHaveProperty('page_content');
        expect(Array.isArray(file.page_content)).toBe(true);
      }
    });

    it('respects excludePageContent: page_content is absent when opted out', async () => {
      const files = await pullAll(connector, primarySpec, { excludePageContent: true });
      for (const file of files) {
        expect(file).not.toHaveProperty('page_content');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Pull — incremental
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (incremental)', () => {
    it('honors `since`: only pages last-edited at or after the watermark are returned', async () => {
      // Touch a seed page so we have a known recent edit, then pull from a
      // watermark just before the touch and assert that page is in the result.
      const before = new Date(Date.now() - 1000);

      const allPages = await pullAll(connector, primarySpec, { excludePageContent: true });
      if (allPages.length === 0) {
        throw new Error(`Seed database "${PRIMARY_DB_NAME}" must contain at least one page.`);
      }
      const touchTargetId = allPages[0].id as string;

      // Touch by writing the same title back via an empty-but-valid update.
      // (Notion bumps last_edited_time on any successful update call.)
      const touchTime = new Date();
      await touchPage(connector, primarySpec, allPages[0]);

      const incremental = await pullAll(connector, primarySpec, {
        pullMode: 'incremental',
        since: before,
        excludePageContent: true,
      });

      const incrementalIds = new Set(incremental.map((f) => f.id as string));
      expect(incrementalIds.has(touchTargetId)).toBe(true);

      // Sanity: every record returned by an incremental pull from `before`
      // should have a `last_edited_time` near or after `before`. Catches the
      // gross failure where the filter is missing entirely and every page
      // comes back.
      //
      // Slack: Notion truncates `last_edited_time` to the minute on the read
      // side even though the filter on the write side honors sub-second
      // precision (so a page edited at 12:00:42 with a watermark of 12:00:41
      // is matched, but its returned timestamp is 12:00:00). The 75s margin
      // covers that truncation plus a second of clock skew.
      const SLACK_MS = 75_000;
      for (const file of incremental) {
        const editedAt = new Date(file.last_edited_time as string);
        expect(editedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - SLACK_MS);
      }

      // Watermark sanity for the debugger.

      console.log(
        `\nNotion incremental: ${incremental.length}/${allPages.length} pages changed since ${before.toISOString()} (touched at ${touchTime.toISOString()})\n`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Filters
  //
  // The connector parses `options.filter` (JSON string) and forwards it to
  // databases.query. Three branches matter:
  //
  //   (a) Simple user filter, no incremental → filter sent verbatim.
  //   (b) Simple user filter + incremental → wrapped in `{ and: [user, ts] }`
  //       by combineNotionFilters. Notion accepts one level of compound
  //       nesting; this is the limit.
  //   (c) Compound user filter + incremental → combineNotionFilters returns
  //       `demoteToFull` rather than nesting two compounds (which Notion 400s).
  //       The connector then runs the user filter alone, no timestamp clause,
  //       and returns no watermark.
  //
  // Branch (c) is the trickiest custom logic in the connector — easy to break
  // in the v5 migration. The test below proves the demotion happened by
  // observing pages older than the would-be watermark in the result set.
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (filter)', () => {
    it('(a) simple filter pass-through restricts results', async () => {
      const unfiltered = await pullAll(connector, primarySpec, { excludePageContent: true });
      expect(unfiltered.length).toBeGreaterThan(0);

      const filter = JSON.stringify({ property: 'Done', checkbox: { equals: true } });
      const filtered = await pullAll(connector, primarySpec, {
        excludePageContent: true,
        filter,
      });

      // Setup guide has at least one Done=true and at least one Done=false seed
      // page, so the filter must strictly shrink the result set.
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.length).toBeLessThan(unfiltered.length);

      // Every returned page must satisfy the predicate.
      for (const file of filtered) {
        const doneProp = (file.properties as Record<string, { checkbox?: boolean }>)['Done'];
        expect(doneProp.checkbox).toBe(true);
      }
    });

    it('(b) simple filter combined with incremental sends a valid `{ and: [...] }` request', async () => {
      // Epoch-old `since` ⇒ the timestamp clause matches everything, so the
      // observable behavior is identical to (a). What we're really proving
      // here is that combineNotionFilters' compound wrapper produces a request
      // body Notion accepts. If the v5 migration breaks the wrapper shape,
      // this is where it surfaces.
      const epoch = new Date(0);
      const filter = JSON.stringify({ property: 'Done', checkbox: { equals: true } });

      const filesAndResult = await pullAllWithResult(connector, primarySpec, {
        excludePageContent: true,
        filter,
        pullMode: 'incremental',
        since: epoch,
      });

      expect(filesAndResult.files.length).toBeGreaterThan(0);
      // A non-demoted incremental returns a fresh watermark.
      expect(filesAndResult.result.newWatermark).toBeInstanceOf(Date);

      for (const file of filesAndResult.files) {
        const doneProp = (file.properties as Record<string, { checkbox?: boolean }>)['Done'];
        expect(doneProp.checkbox).toBe(true);
      }
    });

    it('(c) compound user filter + incremental demotes to full and drops the timestamp clause', async () => {
      // 1 second ago — restrictive enough that almost no page would qualify if
      // the timestamp filter were actually applied.
      const justNow = new Date(Date.now() - 1000);
      const compoundFilter = JSON.stringify({
        and: [
          { property: 'Done', checkbox: { equals: true } },
          { property: 'Priority', select: { does_not_equal: 'Low' } },
        ],
      });

      const filesAndResult = await pullAllWithResult(connector, primarySpec, {
        excludePageContent: true,
        filter: compoundFilter,
        pullMode: 'incremental',
        since: justNow,
      });

      // Demoted runs return no new watermark (see notion-connector.ts —
      // newWatermark is only set when combined.demoteToFull is false). This
      // is the proof the demotion code path ran: had `combineNotionFilters`
      // produced a `{ demoteToFull: false, filter: ... }` envelope, the
      // wrapping `and` would have nested two compounds and Notion would have
      // 400'd before we got here.
      expect(filesAndResult.result.newWatermark).toBeUndefined();

      // Every returned page must satisfy the user's compound predicate (the
      // user filter is preserved; only the timestamp clause is dropped).
      for (const file of filesAndResult.files) {
        const props = file.properties as Record<string, { checkbox?: boolean; select?: { name?: string } | null }>;
        expect(props['Done'].checkbox).toBe(true);
        expect(props['Priority'].select?.name).not.toBe('Low');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Pull by IDs
  // -------------------------------------------------------------------------

  describe('pullRecordFilesByIds', () => {
    it('fetches the requested pages and silently skips unknown ones', async () => {
      const all = await pullAll(connector, primarySpec, { excludePageContent: true });
      expect(all.length).toBeGreaterThan(0);

      const realId = all[0].id as string;
      const fakeId = '00000000000000000000000000000000';

      const fetched: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(primarySpec, [realId, fakeId], async ({ files }) => {
        fetched.push(...files);
        return Promise.resolve();
      });

      // The real ID comes back; the fake ID is logged-and-skipped (per the
      // ObjectNotFound branch in pullRecordFilesByIds).
      expect(fetched.map((f) => f.id)).toEqual([realId]);
    });
  });

  // -------------------------------------------------------------------------
  // Connector properties
  // -------------------------------------------------------------------------

  describe('connector properties', () => {
    it('supportsFilters returns true', () => {
      expect(connector.supportsFilters()).toBe(true);
    });

    it('supportsIncrementalPull returns true', () => {
      expect(connector.supportsIncrementalPull()).toBe(true);
    });

    it('getBatchSize returns 1', () => {
      expect(connector.getBatchSize()).toBe(1);
    });
  });
});

// ===========================================================================
// CRUD round-trip
// ===========================================================================

describeIfKey('NotionConnector — CRUD round-trip', () => {
  let connector: NotionConnector;
  let tableSpec: BaseJsonTableSpec;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    connector = createConnector();
    const tables = await connector.listTables();
    const found = tables.find((t) => t.displayName === PRIMARY_DB_NAME);
    if (!found) throw new Error(`Test database "${PRIMARY_DB_NAME}" not found.`);
    tableSpec = await connector.fetchJsonTableSpec(found.id);
  });

  afterAll(async () => {
    // Best-effort cleanup; swallow individual failures so one bad delete
    // doesn't block the others. Leftovers are findable in Notion by the
    // ROUND_TRIP_TITLE_PREFIX.
    await Promise.allSettled(cleanups.map((fn) => fn()));
  });

  it('creates a page, updates a writable property, then archives it', async () => {
    const titlePropName = findTitlePropertyName(tableSpec);
    const initialTitle = `${ROUND_TRIP_TITLE_PREFIX} ${Date.now()}`;
    const updatedDescription = `Updated at ${new Date().toISOString()}`;

    // ── Create ──
    const created = await connector.createRecords(tableSpec, [
      {
        properties: {
          [titlePropName]: { title: [{ text: { content: initialTitle } }] },
        },
      },
    ]);
    expect(created).toHaveLength(1);
    const pageId = (created[0] as Record<string, unknown>).id as string;
    expect(pageId).toMatch(/^[0-9a-f-]{32,36}$/i);
    cleanups.push(async () => {
      await connector.deleteRecords(tableSpec, [{ id: pageId }]);
    });

    // Verify create via pullRecordFilesByIds.
    const afterCreate = await fetchById(connector, tableSpec, pageId);
    expect(afterCreate).not.toBeNull();
    expect(readTitle(afterCreate!, titlePropName)).toBe(initialTitle);

    // ── Update — Description (rich_text) — passes through transformPropertiesForUpdate ──
    const richTextChange = {
      properties: {
        Description: { rich_text: [{ text: { content: updatedDescription } }] },
      },
    };
    // Pass the full file as `files[i]` so the connector can look up types when
    // filtering read-only props, and the sparse change as `changedFields[i]`.
    await connector.updateRecords(tableSpec, [{ ...(afterCreate as Record<string, unknown>) }], [richTextChange]);

    const afterUpdate = await fetchById(connector, tableSpec, pageId);
    expect(afterUpdate).not.toBeNull();
    expect(readRichText(afterUpdate!, 'Description')).toBe(updatedDescription);

    // ── Delete (archive) ──
    await connector.deleteRecords(tableSpec, [{ id: pageId }]);

    const afterDelete = await fetchById(connector, tableSpec, pageId);
    // Archived pages remain readable but carry archived: true.
    expect(afterDelete).not.toBeNull();
    expect((afterDelete as Record<string, unknown>).archived).toBe(true);
  });

  it('updateRecords silently strips read-only property changes (formula, rollup, created_time)', async () => {
    const titlePropName = findTitlePropertyName(tableSpec);
    const title = `${ROUND_TRIP_TITLE_PREFIX} readonly-filter ${Date.now()}`;

    const [created] = await connector.createRecords(tableSpec, [
      { properties: { [titlePropName]: { title: [{ text: { content: title } }] } } },
    ]);
    const pageId = (created as Record<string, unknown>).id as string;
    cleanups.push(async () => {
      await connector.deleteRecords(tableSpec, [{ id: pageId }]);
    });

    const fullPage = await fetchById(connector, tableSpec, pageId);
    expect(fullPage).not.toBeNull();

    // Build a `changedFields` bag that ONLY mutates read-only props. The
    // connector should resolve to a no-op call and not throw a 400 from
    // Notion. `updateRecords` returns `ConnectorFile[]` (currently the input
    // files, per commit 072bb2c2's placeholder return) — the assertion is on
    // "resolves successfully", not on the returned shape.
    const readOnlyChange = {
      properties: {
        Score: { formula: { type: 'number', number: 999 } }, // formula — read-only
        'Linked Count': { rollup: { type: 'number', number: 5, function: 'count' } }, // rollup — read-only
      },
    };
    await expect(
      connector.updateRecords(tableSpec, [{ ...(fullPage as Record<string, unknown>) }], [readOnlyChange]),
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Strip volatile fields from a TableSpec so it can be snapshotted reproducibly.
 * `generatedAt` and any property `id` UUIDs (which Notion regenerates if the
 * schema is recreated) are the only varying parts.
 */
function redactForSnapshot(spec: BaseJsonTableSpec): unknown {
  const cloned = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  delete cloned.generatedAt;
  return cloned;
}

/**
 * Drive `pullRecordFiles` to exhaustion and return everything in a flat array.
 * Use when total volume is bounded (seed databases are small by design).
 */
async function pullAll(
  connector: NotionConnector,
  spec: BaseJsonTableSpec,
  options: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  return (await pullAllWithResult(connector, spec, options)).files;
}

/**
 * Like `pullAll` but also surfaces the `PullRecordFilesResult` (newWatermark /
 * newCursor). Use when a test needs to assert on the result envelope — e.g.,
 * the compound-filter demotion test confirms `newWatermark` is *not* set.
 */
async function pullAllWithResult(
  connector: NotionConnector,
  spec: BaseJsonTableSpec,
  options: Record<string, unknown>,
): Promise<{ files: Array<Record<string, unknown>>; result: { newWatermark?: Date } }> {
  const files: Array<Record<string, unknown>> = [];
  const result = await connector.pullRecordFiles(
    spec,
    async ({ files: batch }) => {
      files.push(...(batch as Array<Record<string, unknown>>));
      return Promise.resolve();
    },
    { nextCursor: undefined },
    options as Parameters<typeof connector.pullRecordFiles>[3],
  );
  return { files, result };
}

/**
 * Drive a single callback out of `pullRecordFiles`, then bail. Lets us assert
 * on first-page shape without paying for a full pull.
 */
async function pullFirstPage(connector: NotionConnector, spec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
  const files: ConnectorFile[] = [];
  try {
    await connector.pullRecordFiles(
      spec,
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files: batch }) => {
        files.push(...batch);
        throw new EarlyExit();
      },
      { nextCursor: undefined },
      { excludePageContent: true } as Parameters<typeof connector.pullRecordFiles>[3],
    );
  } catch (error) {
    if (!(error instanceof EarlyExit)) throw error;
  }
  return files;
}

class EarlyExit extends Error {
  constructor() {
    super('EarlyExit');
    this.name = 'EarlyExit';
  }
}

/**
 * Look up a single page by ID. Returns `null` if pullRecordFilesByIds yields
 * nothing (the connector silently skips ObjectNotFound).
 */
async function fetchById(
  connector: NotionConnector,
  spec: BaseJsonTableSpec,
  id: string,
): Promise<Record<string, unknown> | null> {
  const got: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(spec, [id], async ({ files }) => {
    got.push(...files);
    return Promise.resolve();
  });
  return (got[0] as Record<string, unknown> | undefined) ?? null;
}

/** Find the Notion title property name (every database has exactly one). */
function findTitlePropertyName(spec: BaseJsonTableSpec): string {
  const remoteId = spec.titleColumnRemoteId;
  if (!remoteId || remoteId.length < 2) {
    throw new Error('Spec is missing titleColumnRemoteId — seed database must have a title-typed property.');
  }
  return remoteId[1];
}

function readTitle(page: Record<string, unknown>, propName: string): string {
  const prop = (page.properties as Record<string, unknown>)[propName] as { title?: Array<{ plain_text?: string }> };
  return (prop.title ?? []).map((t) => t.plain_text ?? '').join('');
}

function readRichText(page: Record<string, unknown>, propName: string): string {
  const prop = (page.properties as Record<string, unknown>)[propName] as {
    rich_text?: Array<{ plain_text?: string }>;
  };
  return (prop.rich_text ?? []).map((t) => t.plain_text ?? '').join('');
}

/**
 * "Touch" a page so its `last_edited_time` bumps to ~now. The simplest write
 * Notion will accept is re-setting the title to its current value — produces
 * a fresh `last_edited_time` without changing user-visible content.
 */
async function touchPage(
  connector: NotionConnector,
  spec: BaseJsonTableSpec,
  page: Record<string, unknown>,
): Promise<void> {
  const titlePropName = findTitlePropertyName(spec);
  const currentTitle = readTitle(page, titlePropName);
  const change = {
    properties: {
      [titlePropName]: { title: [{ text: { content: currentTitle || 'untitled' } }] },
    },
  };
  await connector.updateRecords(spec, [{ ...page }], [change]);
}
