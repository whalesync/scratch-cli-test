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
import { WebflowConnector } from 'src/remote-service/connectors/library/webflow/webflow-connector';
import { WEBFLOW_ASSETS_TABLE_ID_PREFIX } from 'src/remote-service/connectors/library/webflow/webflow-json-schema';
import { WEBFLOW_PAGES_TABLE_ID_PREFIX } from 'src/remote-service/connectors/library/webflow/webflow-types';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(120_000);

const API_KEY = process.env.WEBFLOW_API_KEY;

function createConnector(): WebflowConnector {
  return new WebflowConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

// Pick a CMS collection (not Assets, not Pages) — those are the only tables that
// support the full create/update/delete round-trip.
function pickCmsCollection(tables: TablePreview[]): TablePreview {
  const cms = tables.find(
    (t) =>
      !t.id.wsId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX) && !t.id.wsId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX),
  );
  if (!cms) throw new Error('No CMS collection found on the test Webflow site');
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
