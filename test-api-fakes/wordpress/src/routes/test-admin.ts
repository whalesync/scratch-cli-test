import { Router } from 'express';
import { store, PostType, Taxonomy, EndpointSchema } from '../store';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get('/dump', (_req, res) => {
  const tables: Record<string, unknown[]> = {};
  for (const [tableId, recordMap] of store.records) {
    tables[tableId] = Array.from(recordMap.values());
  }

  const mediaList: unknown[] = [];
  for (const [, media] of store.media) {
    mediaList.push(media);
  }

  res.json({
    siteInfo: store.siteInfo,
    postTypes: Object.fromEntries(store.postTypes),
    taxonomies: Object.fromEntries(store.taxonomies),
    schemas: Object.fromEntries(store.schemas),
    records: tables,
    media: mediaList,
  });
});

router.post('/reset', (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

router.post('/setup', (req, res) => {
  const { siteInfo, postTypes, taxonomies, schemas, records } = req.body;

  if (siteInfo) {
    store.siteInfo = { ...store.siteInfo, ...siteInfo };
  }

  if (postTypes) {
    for (const postType of postTypes as PostType[]) {
      store.postTypes.set(postType.slug, postType);
    }
  }

  if (taxonomies) {
    for (const taxonomy of taxonomies as Taxonomy[]) {
      store.taxonomies.set(taxonomy.slug, taxonomy);
    }
  }

  if (schemas) {
    for (const entry of schemas as Array<{ tableId: string; schema: EndpointSchema }>) {
      store.schemas.set(entry.tableId, entry.schema);
    }
  }

  if (records) {
    for (const entry of records as Array<{ tableId: string; records: Record<string, unknown>[] }>) {
      for (const recordFields of entry.records) {
        store.addRecord(entry.tableId, recordFields);
      }
    }
  }

  res.status(200).json({ ok: true });
});

router.post('/simulate-rate-limit', (req, res) => {
  const { count, retryAfterSeconds } = req.body;
  store.queueRateLimit(count, retryAfterSeconds);
  res.status(200).json({ ok: true });
});

router.post('/simulate-error', (req, res) => {
  const { statusCode, body } = req.body;
  store.queueError(statusCode, body);
  res.status(200).json({ ok: true });
});

export default router;
