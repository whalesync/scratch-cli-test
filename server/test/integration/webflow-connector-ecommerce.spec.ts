/**
 * Webflow **Ecommerce** connector live API integration test (DEV-10729).
 *
 * Exercises the real Webflow API for the ecommerce surface:
 *   - Products / SKUs / Categories — ordinary CMS collections routed under
 *     `/<Site>/Ecommerce/`, using the existing collection machinery (so their
 *     pull/schema/FK is the same as any collection, just in a different folder).
 *   - Orders — the dedicated Ecommerce Orders API (`GET /sites/{id}/orders`,
 *     `PATCH …/orders/{id}`): pull + a comment/shipping-only update, with a
 *     read-only-field guard.
 *
 * Webflow Ecommerce is a **paid** feature, so the shared integration test site
 * may not have it enabled. Every test therefore **gracefully no-ops** (warns +
 * returns) when the site exposes no ecommerce collections / Orders table — exactly
 * like the secondary-locales suite — so CI stays green. Point this at an
 * ecommerce-enabled site to get full live coverage.
 *
 * One test **mutates** real data — an order's `comment` (an internal merchant
 * note, not customer-facing). Orders can't be created via the API, so it edits an
 * existing order and restores the original value in a `finally`. This is safe and
 * consistent with the sibling suites, which already create/delete CMS items and
 * upload assets in this same store every run; it only runs when the store has ≥1
 * order (skips otherwise) and only touches `comment`. The read-only-field guard is
 * exercised unconditionally because it throws before any API call.
 *
 * Requires WEBFLOW_API_KEY in .env.integration.
 * Run via: cd server && yarn test:integration -- webflow-connector-ecommerce
 */

// Break the circular import chain: connector.ts → display-names.ts → all connectors → connector.ts
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { WebflowConnector } from 'src/remote-service/connectors/library/webflow/webflow-connector';
import { getForeignKeyOptions } from 'src/remote-service/connectors/library/webflow/webflow-json-schema';
import { WEBFLOW_ORDERS_TABLE_ID_PREFIX } from 'src/remote-service/connectors/library/webflow/webflow-types';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(120_000);

const API_KEY = process.env.WEBFLOW_API_KEY;

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

/** Log a no-op skip reason without failing the test (paid-feature-absent path). */
function skipWarn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[webflow ecommerce] ${message}`);
}

/** Read an arbitrary field off a ConnectorFile (records are open JSON objects). */
function field<T = unknown>(file: ConnectorFile, key: string): T {
  return (file as Record<string, unknown>)[key] as T;
}

/** The fieldData property slugs of a CMS-collection spec. */
function fieldDataSlugs(spec: BaseJsonTableSpec): string[] {
  const properties = (
    spec.schema as unknown as { properties?: Record<string, { properties?: Record<string, unknown> }> }
  ).properties;
  return Object.keys(properties?.fieldData?.properties ?? {});
}

describeIfKey('WebflowConnector — Ecommerce live API (DEV-10729)', () => {
  let connector: WebflowConnector;
  let allTables: TablePreview[];
  // Products / SKUs / Categories: CMS collections routed under /<Site>/Ecommerce.
  let ecommerceCollectionTables: TablePreview[];
  // The synthetic Orders table (one per ecommerce-enabled site).
  let ordersTable: TablePreview | undefined;

  beforeAll(async () => {
    connector = new WebflowConnector(API_KEY as string);
    allTables = await connector.listTables();
    ordersTable = allTables.find((t) => t.id.wsId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX));
    ecommerceCollectionTables = allTables.filter(
      (t) => !t.id.wsId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX) && (t.parentPath ?? '').endsWith('/Ecommerce'),
    );

    if (ecommerceCollectionTables.length === 0 && !ordersTable) {
      skipWarn('test site has no ecommerce collections / Orders table — ecommerce assertions will no-op');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Discovery + folder routing
  // ─────────────────────────────────────────────────────────────────────────

  describe('table discovery', () => {
    it('routes Products/SKUs/Categories under /<Site>/Ecommerce (or no-ops)', () => {
      if (ecommerceCollectionTables.length === 0) {
        skipWarn('no ecommerce collections — skipping routing assertions');
        return;
      }
      for (const table of ecommerceCollectionTables) {
        expect((table.parentPath ?? '').endsWith('/Ecommerce')).toBe(true);
      }
      // eslint-disable-next-line no-console
      console.log(
        `\nWebflow ecommerce collections: ${ecommerceCollectionTables.map((t) => t.displayName).join(', ')}\n`,
      );
    });

    it('exposes an Orders table under /Ecommerce with creates/deletes disabled (or no-ops)', () => {
      if (!ordersTable) {
        skipWarn('no Orders table (site not ecommerce-enabled) — skipping Orders discovery assertions');
        return;
      }
      expect((ordersTable.parentPath ?? '').endsWith('/Ecommerce')).toBe(true);
      expect(ordersTable.displayName).toBe('Orders');
      expect(ordersTable.disabledCreates).toBe(true);
      expect(ordersTable.disabledDeletes).toBe(true);
      // Editing (comment + shipping) IS allowed.
      expect(ordersTable.disabledUpdates).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Schema
  // ─────────────────────────────────────────────────────────────────────────

  describe('schema', () => {
    it('builds ecommerce collection specs rooted at /Ecommerce (or no-ops)', async () => {
      if (ecommerceCollectionTables.length === 0) {
        skipWarn('no ecommerce collections — skipping collection schema assertions');
        return;
      }
      for (const table of ecommerceCollectionTables) {
        const spec = await connector.fetchJsonTableSpec(table.id);
        expect((spec.basePath ?? []).slice(-1)[0]).toBe('Ecommerce');
        const props = (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
        expect(props).toHaveProperty('id');
        expect(props).toHaveProperty('fieldData');
      }
    });

    it('wires foreign keys between ecommerce collections (Products↔SKUs↔Categories) (or no-ops)', async () => {
      if (ecommerceCollectionTables.length < 2) {
        skipWarn('fewer than two ecommerce collections — cannot assert cross-collection FK wiring');
        return;
      }
      const ecommerceCollectionIds = new Set(ecommerceCollectionTables.map((t) => t.id.remoteId[1]));
      let foundCrossCollectionLink = false;
      for (const table of ecommerceCollectionTables) {
        const spec = await connector.fetchJsonTableSpec(table.id);
        for (const slug of fieldDataSlugs(spec)) {
          const foreignKeyOptions = getForeignKeyOptions(slug, spec);
          if (foreignKeyOptions?.linkedTableId && ecommerceCollectionIds.has(foreignKeyOptions.linkedTableId)) {
            foundCrossCollectionLink = true;
          }
        }
      }
      // Products reference their Category (and default SKU); SKUs reference their
      // Product — so at least one ecommerce collection must link to a sibling.
      expect(foundCrossCollectionLink).toBe(true);
    });

    it('builds an Orders spec: permissive, orderId identity, comment+shipping fields (or no-ops)', async () => {
      if (!ordersTable) {
        skipWarn('no Orders table — skipping Orders schema assertions');
        return;
      }
      const spec = await connector.fetchJsonTableSpec(ordersTable.id);
      expect(spec.idPath).toBe('orderId');
      expect((spec.basePath ?? []).slice(-1)[0]).toBe('Ecommerce');

      const schema = spec.schema as unknown as {
        additionalProperties?: unknown;
        properties: Record<string, Record<string, unknown>>;
      };
      // Permissive so a verbatim order (addresses, purchasedItems, stripeDetails, …)
      // validates without enforce_schema noise.
      expect(schema.additionalProperties).toBe(true);
      expect(schema.properties.orderId[X_SCRATCH_READONLY]).toBe(true);
      for (const writable of ['comment', 'shippingProvider', 'shippingTracking', 'shippingTrackingURL']) {
        expect(schema.properties).toHaveProperty(writable);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Pull
  // ─────────────────────────────────────────────────────────────────────────

  describe('pullRecordFiles', () => {
    it('pulls each ecommerce collection verbatim (id + fieldData) (or no-ops)', async () => {
      if (ecommerceCollectionTables.length === 0) {
        skipWarn('no ecommerce collections — skipping collection pull');
        return;
      }
      for (const table of ecommerceCollectionTables) {
        const spec = await connector.fetchJsonTableSpec(table.id);
        const pulled: ConnectorFile[] = [];
        await connector.pullRecordFiles(spec, async ({ files }) => void pulled.push(...files), {}, {});
        for (const file of pulled) {
          expect(field(file, 'id')).toBeDefined();
          expect(field(file, 'fieldData')).toBeDefined();
        }
        // eslint-disable-next-line no-console
        console.log(`Webflow ecommerce pull: ${pulled.length} items from "${spec.name}"`);
      }
    });

    it('pulls orders verbatim (orderId present) (or no-ops)', async () => {
      if (!ordersTable) {
        skipWarn('no Orders table — skipping orders pull');
        return;
      }
      const spec = await connector.fetchJsonTableSpec(ordersTable.id);
      const pulled: ConnectorFile[] = [];
      await connector.pullRecordFiles(spec, async ({ files }) => void pulled.push(...files), {}, {});
      for (const order of pulled) {
        // Identity: every order carries a non-empty string orderId.
        expect(typeof field(order, 'orderId')).toBe('string');
        expect(field(order, 'orderId')).toBeTruthy();
      }
      if (pulled.length > 0) {
        // Verbatim fidelity (Prime Directive): the order is stored exactly as
        // Webflow returned it — the permissive schema (additionalProperties) keeps
        // every field the schema does NOT enumerate (totals, purchasedItems,
        // stripeDetails, addresses, …). A placed order has ~30 top-level keys vs.
        // the ~10 the schema names, so a healthy key count proves nothing was
        // dropped or reshaped on the way in.
        const first = pulled[0] as Record<string, unknown>;
        expect(field(first, 'status')).toBeDefined();
        expect(Object.keys(first).length).toBeGreaterThan(12);
      }
      // eslint-disable-next-line no-console
      console.log(`Webflow ecommerce pull: ${pulled.length} orders`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Orders write
  // ─────────────────────────────────────────────────────────────────────────

  describe('order update', () => {
    it('rejects an edit to a read-only order field without hitting the write API (or no-ops)', async () => {
      if (!ordersTable) {
        skipWarn('no Orders table — skipping read-only-field guard');
        return;
      }
      const spec = await connector.fetchJsonTableSpec(ordersTable.id);
      // The read-only guard throws before any order API call, so a dummy id is
      // safe here — nothing is fetched or mutated.
      await expect(
        connector.updateRecords(
          spec,
          [{ orderId: 'dummy-order' } as unknown as ConnectorFile],
          [{ status: 'refunded' }],
        ),
      ).rejects.toThrow(/is read-only/);
    });

    it('round-trips an order comment edit and restores it (or no-ops if no orders)', async () => {
      if (!ordersTable) {
        skipWarn('no Orders table — skipping order comment round-trip');
        return;
      }
      const spec = await connector.fetchJsonTableSpec(ordersTable.id);

      // Grab the first order (orders can't be created via the API, so we edit an
      // existing one and restore it — see the file header on why this is safe).
      const firstPage: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        spec,
        async ({ files }) => {
          if (firstPage.length === 0) firstPage.push(...files);
        },
        {},
        {},
      );
      if (firstPage.length === 0) {
        skipWarn('ecommerce site has no orders to edit — skipping comment round-trip');
        return;
      }

      const order = firstPage[0];
      const orderId = field<string>(order, 'orderId');
      const originalComment = field<string | null | undefined>(order, 'comment');
      const restoreComment = typeof originalComment === 'string' ? originalComment : '';
      const testComment = `scratch-int-test comment ${Date.now()}`;

      try {
        await connector.updateRecords(
          spec,
          [{ orderId, comment: testComment } as unknown as ConnectorFile],
          [{ comment: testComment }],
        );

        const after: ConnectorFile[] = [];
        await connector.pullRecordFilesByIds(spec, [orderId], async ({ files }) => void after.push(...files));
        expect(after).toHaveLength(1);
        expect(field(after[0], 'comment')).toBe(testComment);
      } finally {
        // Restore the original comment so the store is left as we found it.
        await connector.updateRecords(
          spec,
          [{ orderId, comment: restoreComment } as unknown as ConnectorFile],
          [{ comment: restoreComment }],
        );
      }
    });
  });
});
