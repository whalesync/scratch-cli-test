import { Router } from "express";
import { requireScope } from "../middleware/auth";
import { CollectionItem, store } from "../store";

const router = Router();

const DEFAULT_ITEM_PAGE_LIMIT = 100;

function notFound(res: Parameters<Parameters<typeof router.get>[1]>[1]): void {
  res.status(404).json({
    message: "Collection not found",
    code: "resource_not_found",
    externalReference: null,
    details: [],
  });
}

/** `GET /v2/collections/:collectionId` — the collection *with* its field definitions. */
router.get(
  "/v2/collections/:collectionId",
  requireScope("cms:read"),
  (req, res) => {
    const collection = store.collections.get(req.params.collectionId);
    if (!collection) {
      notFound(res);
      return;
    }
    res.json(collection);
  },
);

/**
 * `GET /v2/collections/:collectionId/items` — offset-paginated items.
 *
 * Supports the query params the connector actually sends: `offset`, `limit`,
 * `cmsLocaleId`, and the incremental trio (`lastUpdated[gte]`, `sortBy`,
 * `sortOrder`). `total` is the count *after* filtering, which is what the
 * connector's pagination loop compares its running offset against.
 */
router.get(
  "/v2/collections/:collectionId/items",
  requireScope("cms:read"),
  (req, res) => {
    const collection = store.collections.get(req.params.collectionId);
    if (!collection) {
      notFound(res);
      return;
    }

    const offset = Number(req.query.offset ?? 0);
    const limit = Number(req.query.limit ?? DEFAULT_ITEM_PAGE_LIMIT);
    const lastUpdatedSince = req.query["lastUpdated[gte]"];
    const cmsLocaleId = req.query.cmsLocaleId;

    let items: CollectionItem[] = store.items.get(collection.id) ?? [];

    if (typeof lastUpdatedSince === "string") {
      const since = new Date(lastUpdatedSince).getTime();
      items = items.filter(
        (item) => new Date(item.lastUpdated).getTime() >= since,
      );
    }

    if (req.query.sortBy === "lastUpdated") {
      const direction = req.query.sortOrder === "desc" ? -1 : 1;
      items = [...items].sort(
        (a, b) =>
          direction *
          (new Date(a.lastUpdated).getTime() -
            new Date(b.lastUpdated).getTime()),
      );
    }

    const page = items
      .slice(offset, offset + limit)
      .map((item) =>
        typeof cmsLocaleId === "string" ? { ...item, cmsLocaleId } : item,
      );

    res.json({
      items: page,
      pagination: { limit, offset, total: items.length },
    });
  },
);

export default router;
