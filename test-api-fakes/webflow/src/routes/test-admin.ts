import { Router } from "express";
import {
  ALL_WEBFLOW_SCOPES,
  Collection,
  CollectionItem,
  Site,
  store,
  WebflowScope,
} from "../store";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get("/dump", (_req, res) => {
  res.json({
    sites: Array.from(store.sites.values()),
    collections: Array.from(store.collections.values()),
    items: Object.fromEntries(store.items),
  });
});

router.post("/reset", (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

/**
 * Seed sites, collections and items, and optionally register tokens with a
 * restricted scope set so a test can reproduce a scope-deficient token.
 */
router.post("/setup", (req, res) => {
  const { tokens, sites, collections, items } = req.body as {
    tokens?: Array<{ token: string; scopes?: WebflowScope[] }>;
    sites?: Array<Partial<Site> & { id: string }>;
    collections?: Array<Partial<Collection> & { id: string; siteId: string }>;
    items?: Array<{
      collectionId: string;
      items: Array<Partial<CollectionItem> & { id: string }>;
    }>;
  };

  for (const entry of tokens ?? []) {
    store.tokenScopes.set(entry.token, entry.scopes ?? [...ALL_WEBFLOW_SCOPES]);
  }

  for (const site of sites ?? []) {
    store.addSite(site);
  }

  for (const { siteId, ...collection } of collections ?? []) {
    store.addCollection(siteId, collection);
  }

  for (const entry of items ?? []) {
    for (const item of entry.items) {
      store.addItem(entry.collectionId, item);
    }
  }

  res.status(200).json({ ok: true });
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
