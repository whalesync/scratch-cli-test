/**
 * Webflow connector live API integration test.
 *
 * Exercises the real Webflow API: validates credentials, discovers sites and
 * collections, builds a schema, pulls records, and runs a create → update →
 * archive → unarchive → delete round-trip (cleaning up after itself).
 *
 * The archive/unarchive coverage exists because top-level `isArchived` /
 * `isDraft` flags used to be dropped from the bulk update payload, surfacing
 * as a confusing 400 "Missing fields" only at runtime against the real API.
 *
 * Requires WEBFLOW_API_KEY in .env.integration.
 * Run via: cd server && yarn test:integration -- webflow-connector
 */

// Break the circular import chain: connector.ts → display-names.ts → all connectors → connector.ts
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { WebflowApiClient } from 'src/remote-service/connectors/library/webflow/webflow-api-client';
import { WebflowConnector } from 'src/remote-service/connectors/library/webflow/webflow-connector';
import { WEBFLOW_ASSETS_TABLE_ID_PREFIX } from 'src/remote-service/connectors/library/webflow/webflow-json-schema';
import {
  WEBFLOW_ORDERS_TABLE_ID_PREFIX,
  WEBFLOW_PAGES_TABLE_ID_PREFIX,
} from 'src/remote-service/connectors/library/webflow/webflow-types';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(120_000);

const API_KEY = process.env.WEBFLOW_API_KEY;

function createConnector(): WebflowConnector {
  return new WebflowConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

// Pick a plain, writable CMS collection for the full create/update/delete
// round-trip. Excludes the synthetic Assets/Pages/Orders tables, and — since
// DEV-10729 stopped excluding them — the ecommerce collections (Products/SKUs/
// Categories, grouped under /<Site>/Ecommerce), whose items Webflow may refuse to
// create/edit/delete via the CMS items API. Secondary-locale tables (3-element
// remoteId) are skipped too — their creates/deletes are disabled.
function pickCmsCollection(tables: TablePreview[]): TablePreview {
  const cms = tables.find(
    (t) =>
      t.id.remoteId.length === 2 &&
      !t.id.wsId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX) &&
      !t.id.wsId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX) &&
      !t.id.wsId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX) &&
      !(t.parentPath ?? '').endsWith('/Ecommerce'),
  );
  if (!cms) throw new Error('No plain CMS collection found on the test Webflow site');
  return cms;
}

describeIfKey('WebflowConnector — live API', () => {
  let connector: WebflowConnector;
  let allTables: TablePreview[];
  let cmsTable: TablePreview;
  let cmsSpec: BaseJsonTableSpec;

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    cmsTable = pickCmsCollection(allTables);
    cmsSpec = await connector.fetchJsonTableSpec(cmsTable.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Connection
  // ─────────────────────────────────────────────────────────────────────────

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an obviously invalid key', async () => {
      const badConnector = new WebflowConnector('not-a-real-webflow-token');
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Table discovery
  // ─────────────────────────────────────────────────────────────────────────

  describe('listTables', () => {
    it('returns at least one table', () => {
      expect(allTables.length).toBeGreaterThan(0);
    });

    it('includes a site-level Assets table', () => {
      const assets = allTables.find((t) => t.id.wsId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX));
      expect(assets).toBeDefined();
      expect(assets?.disabledCreates).toBe(true);
      expect(assets?.disabledUpdates).toBe(true);
      expect(assets?.disabledDeletes).toBe(true);
    });

    it('includes a site-level Pages table', () => {
      const pages = allTables.find((t) => t.id.wsId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX));
      expect(pages).toBeDefined();
      expect(pages?.disabledCreates).toBe(true);
      expect(pages?.disabledDeletes).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Schema discovery
  // ─────────────────────────────────────────────────────────────────────────

  describe('fetchJsonTableSpec — CMS collection', () => {
    it('builds a spec with the expected top-level structure', () => {
      expect(cmsSpec.id).toEqual(cmsTable.id);
      const props = (cmsSpec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('fieldData');
      expect(props).toHaveProperty('isArchived');
      expect(props).toHaveProperty('isDraft');
    });

    it('marks isArchived and isDraft as writable (not readonly)', () => {
      // Regression guard: these were marked X_SCRATCH_READONLY=true, which both
      // hid them from the sync editor and matched a connector that silently
      // dropped them. Both are now writable end-to-end.
      const props = (cmsSpec.schema as unknown as { properties: Record<string, { [k: string]: unknown }> }).properties;
      expect(props['isArchived'][X_SCRATCH_READONLY]).not.toBe(true);
      expect(props['isDraft'][X_SCRATCH_READONLY]).not.toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Pull records
  // ─────────────────────────────────────────────────────────────────────────

  describe('pullRecordFiles', () => {
    it('pulls items from the CMS collection without error', async () => {
      const allFiles: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        cmsSpec,
        async ({ files }) => {
          allFiles.push(...files);
        },
        {},
        {},
      );
      for (const file of allFiles) {
        expect((file as Record<string, unknown>).id).toBeDefined();
      }
      // eslint-disable-next-line no-console
      console.log(`\nWebflow pull: ${allFiles.length} items from "${cmsSpec.name}"\n`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Create → Update → Archive → Unarchive → Delete round-trip
  // ─────────────────────────────────────────────────────────────────────────

  describe('create → update → archive → unarchive → delete round-trip', () => {
    let createdRecordId: string | undefined;

    afterAll(async () => {
      // Best-effort cleanup if a test threw mid-flight
      if (createdRecordId) {
        try {
          await connector.deleteRecords(cmsSpec, [{ id: createdRecordId } as ConnectorFile]);
        } catch {
          // ignore
        }
      }
    });

    it('exercises the full lifecycle including archive flip', async () => {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const initialName = `Scratch integration test ${suffix}`;
      const updatedName = `${initialName} (updated)`;
      const slug = `scratch-integration-test-${suffix}`;

      // ── Create ────────────────────────────────────────────────────────────
      const created = await connector.createRecords(cmsSpec, [
        { fieldData: { name: initialName, slug } } as ConnectorFile,
      ]);

      expect(created).toHaveLength(1);
      const recordId = (created[0] as Record<string, unknown>).id as string;
      expect(recordId).toBeDefined();
      createdRecordId = recordId;

      // Regression guard: Scratch publish must == Webflow live publish.
      // A staged-only create leaves `lastPublished` null and `isDraft` true.
      expect((created[0] as { lastPublished?: string | null }).lastPublished).toBeTruthy();
      expect((created[0] as { isDraft?: boolean }).isDraft).toBeFalsy();

      // ── Update fieldData only ─────────────────────────────────────────────
      await connector.updateRecords(
        cmsSpec,
        [{ id: recordId, fieldData: { name: updatedName, slug } } as unknown as ConnectorFile],
        [{ fieldData: { name: updatedName } }],
      );

      const afterUpdate: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(cmsSpec, [recordId], async ({ files }) => {
        afterUpdate.push(...files);
      });
      expect(afterUpdate).toHaveLength(1);
      expect((afterUpdate[0] as { fieldData: { name: string } }).fieldData.name).toBe(updatedName);
      expect((afterUpdate[0] as { isArchived?: boolean }).isArchived).toBeFalsy();

      // ── Archive (the regression we just fixed) ────────────────────────────
      // changedFields contains only the top-level flag — fieldData stays out.
      await connector.updateRecords(
        cmsSpec,
        [{ id: recordId, isArchived: true, fieldData: { name: updatedName, slug } } as unknown as ConnectorFile],
        [{ isArchived: true }],
      );

      const afterArchive: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(cmsSpec, [recordId], async ({ files }) => {
        afterArchive.push(...files);
      });
      expect(afterArchive).toHaveLength(1);
      expect((afterArchive[0] as { isArchived?: boolean }).isArchived).toBe(true);

      // ── Unarchive ─────────────────────────────────────────────────────────
      await connector.updateRecords(
        cmsSpec,
        [{ id: recordId, isArchived: false, fieldData: { name: updatedName, slug } } as unknown as ConnectorFile],
        [{ isArchived: false }],
      );

      const afterUnarchive: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(cmsSpec, [recordId], async ({ files }) => {
        afterUnarchive.push(...files);
      });
      expect(afterUnarchive).toHaveLength(1);
      expect((afterUnarchive[0] as { isArchived?: boolean }).isArchived).toBeFalsy();

      // ── Delete (cleanup) ──────────────────────────────────────────────────
      await connector.deleteRecords(cmsSpec, [{ id: recordId } as ConnectorFile]);
      createdRecordId = undefined;

      const afterDelete: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(cmsSpec, [recordId], async ({ files }) => {
        afterDelete.push(...files);
      });
      expect(afterDelete).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Publishing an edit to a never-published item (DEV-10642)
  //
  // A CMS item created via the STAGED endpoint (or authored as a draft in
  // Webflow) has `lastPublished: null`. The bulk live PATCH is atomic and 409s
  // ("Live PATCH updates can't be applied to items that have never been
  // published") if ANY item in the batch was never published — so one draft item
  // used to sink the whole batch (the reported bug: ~30 records "failed"). The
  // connector now catches that 409 and retries per-record, falling back to the
  // staged endpoint for the never-published ones.
  //
  // This exercises the exact repro: a mixed batch of one published + one
  // never-published item, published together in a single `updateRecords` call.
  // ─────────────────────────────────────────────────────────────────────────

  describe('never-published edit falls back to staged in a mixed batch (DEV-10642)', () => {
    // The connector's createRecords always publishes live, so we reach past it to
    // the api-client's staged create to manufacture the never-published item.
    const apiClient = new WebflowApiClient(API_KEY as string);
    let publishedId: string | undefined;
    let neverPublishedId: string | undefined;

    afterAll(async () => {
      const ids = [publishedId, neverPublishedId].filter((id): id is string => Boolean(id));
      if (ids.length > 0) {
        try {
          await connector.deleteRecords(
            cmsSpec,
            ids.map((id) => ({ id }) as ConnectorFile),
          );
        } catch {
          // ignore — deleteRecords already tolerates never-published (live-delete 404)
        }
      }
    });

    it('publishes edits to both a published and a never-published item in one batch', async () => {
      const collectionId = cmsSpec.id.remoteId[1];
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      // ── Seed A: a normally-published item (connector create == live publish) ─
      const publishedName = `Scratch neverpub published ${suffix}`;
      const publishedSlug = `scratch-neverpub-published-${suffix}`;
      const createdPublished = await connector.createRecords(cmsSpec, [
        { fieldData: { name: publishedName, slug: publishedSlug } } as ConnectorFile,
      ]);
      publishedId = (createdPublished[0] as Record<string, unknown>).id as string;
      expect(publishedId).toBeDefined();
      expect((createdPublished[0] as { lastPublished?: string | null }).lastPublished).toBeTruthy();

      // ── Seed B: a never-published item (staged create → lastPublished null) ──
      const draftName = `Scratch neverpub draft ${suffix}`;
      const draftSlug = `scratch-neverpub-draft-${suffix}`;
      const stagedCreate = await apiClient.createItemsStaged(collectionId, {
        skipInvalidFiles: false,
        items: [{ fieldData: { name: draftName, slug: draftSlug } }],
      });
      neverPublishedId = stagedCreate.items?.[0]?.id;
      expect(neverPublishedId).toBeDefined();
      // Precondition: it genuinely was never published.
      expect(stagedCreate.items?.[0]?.lastPublished).toBeFalsy();

      // Narrow both ids to `string` for the rest of the test (they are the outer
      // `let`s that afterAll uses for cleanup).
      if (!publishedId || !neverPublishedId) throw new Error('Test seed failed to produce both record ids');

      // ── Act: publish an edit to BOTH in a single batch ──────────────────────
      // Before the fix, the atomic bulk live PATCH rejected with 409 because of
      // item B and failed the whole batch (item A included).
      const publishedUpdatedName = `${publishedName} (updated)`;
      const draftUpdatedName = `${draftName} (updated)`;
      await expect(
        connector.updateRecords(
          cmsSpec,
          [
            {
              id: publishedId,
              fieldData: { name: publishedUpdatedName, slug: publishedSlug },
            } as unknown as ConnectorFile,
            {
              id: neverPublishedId,
              fieldData: { name: draftUpdatedName, slug: draftSlug },
            } as unknown as ConnectorFile,
          ],
          [{ fieldData: { name: publishedUpdatedName } }, { fieldData: { name: draftUpdatedName } }],
        ),
      ).resolves.toBeDefined();

      // ── Assert: both edits landed ───────────────────────────────────────────
      const refetched: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(cmsSpec, [publishedId, neverPublishedId], async ({ files }) => {
        refetched.push(...files);
      });
      const byId = new Map<string, ConnectorFile>();
      for (const f of refetched) byId.set((f as Record<string, unknown>).id as string, f);

      const publishedAfter = byId.get(publishedId) as
        | { fieldData: { name: string }; lastPublished?: string | null }
        | undefined;
      const draftAfter = byId.get(neverPublishedId) as
        | { fieldData: { name: string }; lastPublished?: string | null }
        | undefined;

      // The published item updated live and stays published.
      expect(publishedAfter?.fieldData.name).toBe(publishedUpdatedName);
      expect(publishedAfter?.lastPublished).toBeTruthy();

      // The never-published item's edit landed via the staged endpoint, and it was
      // NOT auto-published — `lastPublished` is still null. (Prime Directive: we
      // only changed the endpoint, never the data, and never published for the user.)
      expect(draftAfter?.fieldData.name).toBe(draftUpdatedName);
      expect(draftAfter?.lastPublished).toBeFalsy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bulk create with per-item isArchived / isDraft
  // ─────────────────────────────────────────────────────────────────────────

  describe('createRecords with per-item isArchived / isDraft', () => {
    let createdIds: string[] = [];

    afterAll(async () => {
      if (createdIds.length > 0) {
        try {
          await connector.deleteRecords(
            cmsSpec,
            createdIds.map((id) => ({ id }) as ConnectorFile),
          );
        } catch {
          // ignore
        }
      }
    });

    it('preserves per-item flag values across a single mixed batch', async () => {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const combos: Array<{ isArchived: boolean; isDraft: boolean; tag: string }> = [
        { isArchived: false, isDraft: false, tag: 'live' },
        { isArchived: true, isDraft: false, tag: 'archived' },
        { isArchived: false, isDraft: true, tag: 'draft' },
        { isArchived: true, isDraft: true, tag: 'archived-draft' },
      ];

      const files: ConnectorFile[] = combos.map((c, i) => ({
        isArchived: c.isArchived,
        isDraft: c.isDraft,
        fieldData: {
          name: `Scratch mixed-flags test ${c.tag} ${suffix}-${i}`,
          slug: `scratch-mixed-flags-${c.tag}-${suffix}-${i}`,
        },
      })) as ConnectorFile[];

      const created = await connector.createRecords(cmsSpec, files);
      expect(created).toHaveLength(combos.length);
      createdIds = created.map((f) => (f as Record<string, unknown>).id as string);
      for (const id of createdIds) expect(id).toBeDefined();

      // Re-fetch and assert each record came back with the flags we sent —
      // this is the regression guard for "per-item flags don't get coerced
      // into a shared bulk-create flag."
      const refetched: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(cmsSpec, createdIds, async ({ files: f }) => {
        refetched.push(...f);
      });
      expect(refetched).toHaveLength(combos.length);

      const byId = new Map<string, ConnectorFile>();
      for (const f of refetched) byId.set((f as Record<string, unknown>).id as string, f);

      for (let i = 0; i < combos.length; i++) {
        const id = createdIds[i];
        const got = byId.get(id) as { isArchived?: boolean; isDraft?: boolean } | undefined;
        expect(got).toBeDefined();
        expect(Boolean(got?.isArchived)).toBe(combos[i].isArchived);
        expect(Boolean(got?.isDraft)).toBe(combos[i].isDraft);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Secondary locales (DEV-10529)
  //
  // Read-only: asserts the locale table shape and that pulling a locale table
  // scopes items to that locale. Gracefully no-ops when the test site has no
  // secondary locale enabled (localization is a paid Webflow feature), so CI
  // stays green. The edit→publish write path is covered by unit tests
  // (webflow-connector-locales.spec.ts) and deliberately not exercised live
  // here — we won't mutate data on a site whose localization state we don't
  // control or can't reliably restore.
  // ─────────────────────────────────────────────────────────────────────────

  describe('secondary locales', () => {
    // A locale table carries a 3-element remoteId: [siteId, collectionId, cmsLocaleId].
    const localeTables = (): TablePreview[] => allTables.filter((t) => t.id.remoteId.length === 3);

    it('surfaces an opt-in, creates/deletes-disabled table per secondary locale (or no-ops if none)', () => {
      const tables = localeTables();
      if (tables.length === 0) {
        // eslint-disable-next-line no-console
        console.warn('[webflow locales] test site has no secondary locale enabled — skipping locale assertions');
        return;
      }
      for (const localeTable of tables) {
        expect(localeTable.id.remoteId[2]).toBeTruthy(); // cmsLocaleId
        expect(localeTable.disabledCreates).toBe(true);
        expect(localeTable.disabledDeletes).toBe(true);
        expect(localeTable.disabledUpdates).toBeUndefined(); // editing localized values IS allowed
        expect(localeTable.parentPath).toBeTruthy();
      }
    });

    it('pulls a locale table scoped to its cmsLocaleId', async () => {
      const localeTable = localeTables()[0];
      if (!localeTable) {
        // eslint-disable-next-line no-console
        console.warn('[webflow locales] no secondary locale — skipping locale pull');
        return;
      }
      const cmsLocaleId = localeTable.id.remoteId[2];
      const localeSpec = await connector.fetchJsonTableSpec(localeTable.id);

      const pulled: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        localeSpec,
        async ({ files }) => {
          pulled.push(...files);
        },
        {},
        { pullMode: 'full' } as never,
      );

      // Every item Webflow returns for a locale-scoped list reports that locale.
      for (const file of pulled) {
        if (file.cmsLocaleId !== undefined) {
          expect(file.cmsLocaleId).toBe(cmsLocaleId);
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Connector properties
  // ─────────────────────────────────────────────────────────────────────────

  describe('connector properties', () => {
    it('getBatchSize is sensible (≤100 per Webflow bulk limit)', () => {
      const size = connector.getBatchSize();
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(100);
    });
  });
});
