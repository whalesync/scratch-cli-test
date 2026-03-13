import { Router } from 'express';
import { store } from '../store';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get('/dump', (_req, res) => {
  const entities: Record<string, unknown[]> = {};
  for (const [entityType, entityMap] of store.entities) {
    entities[entityType] = Array.from(entityMap.values());
  }
  res.json({
    companyInfo: store.companyInfo,
    entities,
  });
});

router.post('/reset', (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

router.post('/setup', (req, res) => {
  const { companyInfo, entities } = req.body;

  if (companyInfo) {
    store.companyInfo = { ...store.companyInfo, ...companyInfo };
  }

  if (entities) {
    for (const entry of entities) {
      const { entityType, entities: entityList } = entry;
      for (const entity of entityList) {
        store.addEntity(entityType, { ...entity });
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
