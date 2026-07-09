/**
 * Webflow connector live API ASSET integration test (DEV-10338).
 *
 * Exercises the real Webflow asset lifecycle that unit tests (mocked) can't cover, and
 * pins the write shapes Webflow actually accepts — the integration test that caught the
 * original bug (a bare { fileId } is rejected; Webflow requires { fileId, url }).
 *
 *   1. uploadFile()  — upload an in-memory PNG to a site; mint a real asset id + public URL.
 *   2. Assets table  — pull the site-level Assets table.
 *   3. resolveAssetReference output, written for real:
 *        a. non-pending asset → { fileId, url } → Webflow references the existing asset.
 *        b. pending asset     → { url }         → Webflow accepts it (stores the URL).
 *
 * Findings pinned here (observed against the live v2 API):
 *   - { fileId } ALONE is rejected: "Expected value to have a 'url' field". Webflow
 *     requires fileId AND url together to reference an asset.
 *   - { url } alone is accepted and stored, but does NOT synchronously mint a fileId
 *     (no CMS-write re-host). Cross-site re-hosting happens in the publish asset-upload
 *     phase via uploadFile(), and the edit phase then references it with { fileId, url }.
 *
 * Requires WEBFLOW_API_KEY in .env.integration. The Image-field tests need a CMS
 * collection with a single Image field — the suite uses WEBFLOW_IMAGE_COLLECTION_ID /
 * WEBFLOW_IMAGE_FIELD_SLUG if set, else auto-discovers one, else self-provisions a
 * temporary Image field on the first CMS collection (via the raw API) and deletes it
 * after. Schema management lives only here, not in the connector client.
 *
 * NOTE: uploaded assets (tiny 1x1 PNGs) linger on the site — the Webflow API exposes no
 * asset delete. CMS items and any self-provisioned field are cleaned up in afterAll.
 *
 * Run via: cd server && yarn test:integration -- webflow-connector-assets
 */

// Break the circular import chain: connector.ts → display-names.ts → all connectors → connector.ts
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { X_SCRATCH_ASSET_FIELD } from '@spinner/shared-types';
import axios from 'axios';
import { WebflowConnector } from 'src/remote-service/connectors/library/webflow/webflow-connector';
import { WEBFLOW_ASSETS_TABLE_ID_PREFIX } from 'src/remote-service/connectors/library/webflow/webflow-json-schema';
import {
  WEBFLOW_ORDERS_TABLE_ID_PREFIX,
  WEBFLOW_PAGES_TABLE_ID_PREFIX,
} from 'src/remote-service/connectors/library/webflow/webflow-types';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(120_000);

const API_KEY = process.env.WEBFLOW_API_KEY;
const IMAGE_COLLECTION_ID = process.env.WEBFLOW_IMAGE_COLLECTION_ID;
const IMAGE_FIELD_SLUG = process.env.WEBFLOW_IMAGE_FIELD_SLUG;
const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';

// Pending-publish id stands in for a not-yet-uploaded destination asset (re-host branch).
const PENDING_ASSET_ID = 'scratch_pending_publish_integration';

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

// A valid 1x1 transparent PNG — uploaded so the test owns a real, content-stable asset
// without depending on any external URL.
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY ?? ''}`, accept: 'application/json' };
}

// A plain, schema-mutable CMS collection: not one of the synthetic Assets/Pages/
// Orders tables, and (since DEV-10729) not an ecommerce collection under
// /<Site>/Ecommerce — Webflow may refuse to add a temporary Image field to a
// Products/SKUs/Categories collection, and secondary-locale tables (3-element
// remoteId) aren't real collections either.
function isCmsCollection(table: TablePreview): boolean {
  return (
    table.id.remoteId.length === 2 &&
    !table.id.wsId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX) &&
    !table.id.wsId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX) &&
    !table.id.wsId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX) &&
    !(table.parentPath ?? '').endsWith('/Ecommerce')
  );
}

/** Find a single-Image field slug — an Image field carries `x-scratch-asset-field` on an object schema. */
function findSingleImageFieldSlug(spec: BaseJsonTableSpec): string | undefined {
  const fieldDataProperties = (
    spec.schema as unknown as {
      properties?: { fieldData?: { properties?: Record<string, Record<string, unknown>> } };
    }
  ).properties?.fieldData?.properties;
  if (!fieldDataProperties) return undefined;

  if (IMAGE_FIELD_SLUG) {
    return fieldDataProperties[IMAGE_FIELD_SLUG] ? IMAGE_FIELD_SLUG : undefined;
  }
  for (const [slug, fieldSchema] of Object.entries(fieldDataProperties)) {
    if (fieldSchema[X_SCRATCH_ASSET_FIELD] !== undefined && fieldSchema['type'] === 'object') return slug;
  }
  return undefined;
}

function readImageField(file: ConnectorFile, fieldSlug: string): { fileId?: string; url?: string } | undefined {
  const fieldData = (file as { fieldData?: Record<string, unknown> }).fieldData;
  return fieldData?.[fieldSlug] as { fileId?: string; url?: string } | undefined;
}

async function fetchById(connector: WebflowConnector, spec: BaseJsonTableSpec, id: string): Promise<ConnectorFile> {
  const files: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(spec, [id], async ({ files: f }) => {
    files.push(...f);
  });
  if (files.length !== 1) throw new Error(`Expected exactly 1 record for id=${id}, got ${files.length}`);
  return files[0];
}

/** Create a temporary single Image field on a collection. Returns its id, or null on failure. */
async function provisionImageField(collectionId: string): Promise<{ fieldId: string } | null> {
  try {
    const res = await axios.post(
      `${WEBFLOW_API_BASE}/collections/${collectionId}/fields`,
      { type: 'Image', displayName: `Scratch Int Image ${Date.now()}`, isRequired: false },
      { headers: authHeaders() },
    );
    const data = res.data as { id?: string; field?: { id?: string } };
    const fieldId = data.id ?? data.field?.id;
    return fieldId ? { fieldId } : null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[asset test] could not provision an Image field:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function deleteImageField(collectionId: string, fieldId: string): Promise<void> {
  await axios.delete(`${WEBFLOW_API_BASE}/collections/${collectionId}/fields/${fieldId}`, { headers: authHeaders() });
}

describeIfKey('WebflowConnector — live API assets (DEV-10338)', () => {
  let connector: WebflowConnector;
  let allTables: TablePreview[];
  let siteId: string;

  let imageSpec: BaseJsonTableSpec | undefined;
  let imageFieldSlug: string | undefined;
  let provisionedCollectionId: string | undefined;
  let provisionedFieldId: string | undefined;

  let uploadedAssetId: string | undefined;
  let uploadedAssetUrl: string | undefined;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    connector = new WebflowConnector(API_KEY!);
    allTables = await connector.listTables();

    const cmsTables = allTables.filter(isCmsCollection);
    const candidateTables = IMAGE_COLLECTION_ID
      ? cmsTables.filter((t) => t.id.remoteId[1] === IMAGE_COLLECTION_ID)
      : cmsTables;

    // 1. Use an existing Image field if one is present.
    for (const table of candidateTables) {
      const spec = await connector.fetchJsonTableSpec(table.id);
      const slug = findSingleImageFieldSlug(spec);
      if (slug) {
        imageSpec = spec;
        imageFieldSlug = slug;
        break;
      }
    }

    // 2. Otherwise self-provision a temporary Image field on the first CMS collection.
    if (!imageSpec && !IMAGE_COLLECTION_ID && cmsTables.length > 0) {
      const collectionId = cmsTables[0].id.remoteId[1];
      const provisioned = await provisionImageField(collectionId);
      if (provisioned) {
        provisionedCollectionId = collectionId;
        provisionedFieldId = provisioned.fieldId;
        const spec = await connector.fetchJsonTableSpec(cmsTables[0].id);
        const slug = findSingleImageFieldSlug(spec);
        if (slug) {
          imageSpec = spec;
          imageFieldSlug = slug;
          // eslint-disable-next-line no-console
          console.log(`[asset test] provisioned temp Image field "${slug}" on collection ${collectionId}`);
        }
      }
    }

    siteId = imageSpec?.id.remoteId[0] ?? allTables[0]?.id.remoteId[0];
  });

  afterAll(async () => {
    if (provisionedCollectionId && provisionedFieldId) {
      try {
        await deleteImageField(provisionedCollectionId, provisionedFieldId);
        // eslint-disable-next-line no-console
        console.log(`[asset test] deleted temp Image field ${provisionedFieldId}`);
      } catch {
        // best-effort cleanup
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // uploadFile + Assets table pull (needs only a siteId)
  // ─────────────────────────────────────────────────────────────────────────

  describe('uploadFile + Assets table', () => {
    it('uploads an in-memory PNG and returns a real asset id + public url', async () => {
      const filename = `scratch-int-asset-${Date.now()}-${Math.floor(Math.random() * 1000)}.png`;
      const result = await connector.uploadFile(ONE_BY_ONE_PNG, filename, 'image/png', { siteId });

      expect(result.remoteAssetId).toBeTruthy();
      expect(typeof result.url).toBe('string');
      expect(result.url).toMatch(/^https?:\/\//);

      uploadedAssetId = result.remoteAssetId;
      uploadedAssetUrl = result.url ?? undefined;
    });

    it('pulls the site-level Assets table', async () => {
      const assetsTable = allTables.find((t) => t.id.wsId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX));
      expect(assetsTable).toBeDefined();
      if (!assetsTable) return;

      const assetsSpec = await connector.fetchJsonTableSpec(assetsTable.id);
      const assets: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        assetsSpec,
        async ({ files }) => {
          assets.push(...files);
        },
        {},
        {},
      );

      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) expect((asset as Record<string, unknown>).id).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // resolveAssetReference output, written against the live API
  // ─────────────────────────────────────────────────────────────────────────

  describe('resolveAssetReference write shapes', () => {
    let createdRecordId: string | undefined;

    afterAll(async () => {
      if (imageSpec && createdRecordId) {
        try {
          await connector.deleteRecords(imageSpec, [{ id: createdRecordId } as ConnectorFile]);
        } catch {
          // best-effort cleanup
        }
      }
    });

    it('references an asset with { fileId, url } and accepts a { url }-only re-host', async () => {
      if (!imageSpec || !imageFieldSlug || !uploadedAssetUrl || !uploadedAssetId) {
        // eslint-disable-next-line no-console
        console.warn('\n[skip] No writable single-Image collection available (or upload failed).\n');
        return;
      }
      const spec = imageSpec;
      const slug = imageFieldSlug;
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      // ── (a) non-pending asset → resolveAssetReference returns { fileId, url } ──
      // This is exactly what the publish edit phase writes after the asset-upload phase
      // pre-uploads the asset. Webflow must accept it and reference the existing asset.
      const referenceValue = connector.resolveAssetReference({
        remoteAssetId: uploadedAssetId,
        rehostedUrl: null,
        url: uploadedAssetUrl,
      });
      expect(referenceValue).toEqual({ fileId: uploadedAssetId, url: uploadedAssetUrl });

      const created = await connector.createRecords(spec, [
        {
          fieldData: {
            name: `Scratch asset int ${suffix}`,
            slug: `scratch-asset-int-${suffix}`,
            [slug]: referenceValue,
          },
        } as unknown as ConnectorFile,
      ]);
      expect(created).toHaveLength(1);
      createdRecordId = (created[0] as Record<string, unknown>).id as string;
      expect(createdRecordId).toBeTruthy();

      const afterReference = readImageField(await fetchById(connector, spec, createdRecordId), slug);
      expect(afterReference?.fileId).toBe(uploadedAssetId);
      expect(typeof afterReference?.url).toBe('string');

      // ── (b) pending asset → resolveAssetReference returns { url } (re-host fallback) ──
      // Webflow accepts a { url }-only write (it stores the URL). It does not mint a
      // fileId synchronously on the CMS write — re-hosting is the asset-upload phase's job.
      const rehostValue = connector.resolveAssetReference({
        remoteAssetId: PENDING_ASSET_ID,
        rehostedUrl: uploadedAssetUrl,
        url: null,
      });
      expect(rehostValue).toEqual({ url: uploadedAssetUrl });

      await connector.updateRecords(
        spec,
        [{ id: createdRecordId, fieldData: { [slug]: rehostValue } } as unknown as ConnectorFile],
        [{ fieldData: { [slug]: rehostValue } }],
      );
      const afterRehost = readImageField(await fetchById(connector, spec, createdRecordId), slug);
      expect(typeof afterRehost?.url).toBe('string');
    });
  });
});
