import { Router } from 'express';
import { store } from '../store';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get('/dump', (req, res) => {
  const { baseId, tableId } = req.query;

  // Dump a specific table's records
  if (typeof baseId === 'string' && typeof tableId === 'string') {
    const records = store.listRecords(baseId, tableId);
    res.json({
      records: records.map((r) => ({ id: r.id, fields: r.fields, createdTime: r.createdTime })),
    });
    return;
  }

  // Dump everything
  const bases: Record<string, { tables: Record<string, { records: ReturnType<typeof store.listRecords> }> }> = {};
  for (const [baseId, base] of store.bases) {
    bases[baseId] = { tables: {} };
    const tables = store.listTables(baseId) ?? [];
    for (const table of tables) {
      const records = store.listRecords(baseId, table.id);
      bases[baseId].tables[table.id] = {
        records: records.map((r) => ({ id: r.id, fields: r.fields, createdTime: r.createdTime })),
      };
    }
  }
  res.json({ bases });
});

router.post('/reset', (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

router.post('/setup', (req, res) => {
  const { bases, tables, records } = req.body;

  if (bases) {
    for (const base of bases) {
      store.addBase(base);
    }
  }

  if (tables) {
    for (const entry of tables) {
      for (const table of entry.tables) {
        store.addTable(entry.baseId, table);
      }
    }
  }

  if (records) {
    for (const entry of records) {
      for (const record of entry.records) {
        store.addRecord(entry.baseId, entry.tableId, record.fields);
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
