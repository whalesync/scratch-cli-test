import { Router } from "express";
import {
  AffinityFieldMetadata,
  AffinityList,
  AffinityListEntry,
  store,
} from "../store";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get("/dump", (_req, res) => {
  const lists = store.listLists().map((list) => ({
    list,
    fields: store.getFieldsForList(list.id),
    entries: store.getEntries(list.id),
  }));
  res.json({
    lists,
    quota: {
      userMinuteUsed: store.userMinuteUsed,
      orgMonthlyUsed: store.orgMonthlyUsed,
    },
  });
});

router.post("/reset", (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

/**
 * Seed the fake with lists, per-list fields, and per-list entries.
 *
 * Body shape:
 * ```
 * {
 *   "lists": [{ id, name, type, isPublic?, ownerId?, creatorId? }, ...],
 *   "fieldsByList": { "<listId>": [{ id, name, type, valueType, enrichmentSource? }, ...] },
 *   "entriesByList": { "<listId>": [{ id, type, listId, createdAt?, creatorId?, entity }, ...] }
 * }
 * ```
 */
router.post("/setup", (req, res) => {
  const body = req.body as {
    lists?: Array<
      Partial<AffinityList> & {
        id: number;
        name: string;
        type: AffinityList["type"];
      }
    >;
    fieldsByList?: Record<string, AffinityFieldMetadata[]>;
    entriesByList?: Record<string, AffinityListEntry[]>;
  };

  if (body.lists) {
    for (const partial of body.lists) {
      store.addList({
        id: partial.id,
        name: partial.name,
        type: partial.type,
        isPublic: partial.isPublic ?? false,
        ownerId: partial.ownerId ?? 1,
        creatorId: partial.creatorId ?? 1,
      });
    }
  }

  if (body.fieldsByList) {
    for (const [listIdStr, fields] of Object.entries(body.fieldsByList)) {
      store.setFieldsForList(parseInt(listIdStr, 10), fields);
    }
  }

  if (body.entriesByList) {
    for (const [listIdStr, entries] of Object.entries(body.entriesByList)) {
      const listId = parseInt(listIdStr, 10);
      // Apply defaults for createdAt/creatorId if seed omitted them.
      const normalized = entries.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt ?? new Date().toISOString(),
        creatorId: entry.creatorId ?? 1,
      }));
      store.setEntriesForList(listId, normalized);
    }
  }

  res.status(200).json({ ok: true });
});

router.post("/simulate-rate-limit", (req, res) => {
  const { count, retryAfterSeconds } = req.body as {
    count: number;
    retryAfterSeconds?: number;
  };
  store.queueRateLimit(count, retryAfterSeconds ?? 30);
  res.status(200).json({ ok: true });
});

router.post("/simulate-error", (req, res) => {
  const { statusCode, body } = req.body as {
    statusCode: number;
    body: unknown;
  };
  store.queueError(statusCode, body);
  res.status(200).json({ ok: true });
});

export default router;
