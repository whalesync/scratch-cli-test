import { Router } from "express";
import { store } from "../store";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

router.post("/reset", (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

router.post("/setup", (req, res) => {
  const { objectTypes, customObjectSchemas } = req.body;

  // objectTypes: Array<{ objectType: string, properties?: [...], records?: [...] }>
  if (objectTypes) {
    for (const entry of objectTypes) {
      if (entry.properties) {
        store.setProperties(entry.objectType, entry.properties);
      }
      if (entry.records) {
        for (const record of entry.records) {
          store.addRecord(entry.objectType, record.properties ?? record);
        }
      }
    }
  }

  if (customObjectSchemas) {
    store.customObjectSchemas = customObjectSchemas;
  }

  res.status(200).json({ ok: true });
});

router.get("/dump", (req, res) => {
  const { objectType } = req.query;

  if (typeof objectType === "string") {
    const records = store.listRecords(objectType);
    res.json({ records });
    return;
  }

  // Dump everything
  const result: Record<
    string,
    { records: ReturnType<typeof store.listRecords> }
  > = {};
  for (const [objType] of store.records) {
    result[objType] = { records: store.listRecords(objType) };
  }
  res.json(result);
});

router.post("/simulate-rate-limit", (req, res) => {
  const { count, retryAfterSeconds } = req.body;
  store.queueRateLimit(count, retryAfterSeconds);
  res.status(200).json({ ok: true });
});

router.post("/simulate-error", (req, res) => {
  const { statusCode, body } = req.body;
  store.queueError(statusCode, body);
  res.status(200).json({ ok: true });
});

export default router;
