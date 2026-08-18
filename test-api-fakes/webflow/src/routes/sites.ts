import { Router } from "express";
import { requireScope } from "../middleware/auth";
import { store } from "../store";

const router = Router();

/** `GET /v2/sites` — every site the token can see. Needs `sites:read`. */
router.get("/v2/sites", requireScope("sites:read"), (_req, res) => {
  res.json({ sites: Array.from(store.sites.values()) });
});

/** `GET /v2/sites/:siteId` — the authoritative single-site fetch (carries `locales`). */
router.get("/v2/sites/:siteId", requireScope("sites:read"), (req, res) => {
  const site = store.sites.get(req.params.siteId);
  if (!site) {
    res.status(404).json({
      message: "Site not found",
      code: "resource_not_found",
      externalReference: null,
      details: [],
    });
    return;
  }
  res.json(site);
});

/**
 * `GET /v2/sites/:siteId/collections` — needs **`cms:read`**, not `sites:read`.
 *
 * This scope split is the whole of DEV-11321: a token holding only `sites:read`
 * passes the route above (and so passed our connect-time check) and 403s here,
 * on the call the table picker depends on.
 */
router.get(
  "/v2/sites/:siteId/collections",
  requireScope("cms:read"),
  (req, res) => {
    if (!store.sites.has(req.params.siteId)) {
      res.status(404).json({
        message: "Site not found",
        code: "resource_not_found",
        externalReference: null,
        details: [],
      });
      return;
    }
    res.json({
      collections: store.collectionsForSite(req.params.siteId).map((c) => ({
        id: c.id,
        displayName: c.displayName,
        singularName: c.singularName,
        slug: c.slug,
        createdOn: c.createdOn,
        lastUpdated: c.lastUpdated,
      })),
    });
  },
);

export default router;
