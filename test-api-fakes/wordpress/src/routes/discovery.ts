import { Router } from "express";
import { store } from "../store";

const router = Router();

// GET / — Discovery API
router.get("/", (_req, res) => {
  const routes: Record<string, unknown> = {};

  for (const [, postType] of store.postTypes) {
    routes[`/${postType.rest_namespace}/${postType.rest_base}`] = {
      namespace: postType.rest_namespace,
      methods: ["GET", "POST"],
      endpoints: [
        { methods: ["GET"], args: {} },
        { methods: ["POST"], args: {} },
      ],
    };
  }

  for (const [, taxonomy] of store.taxonomies) {
    routes[`/${taxonomy.rest_namespace}/${taxonomy.rest_base}`] = {
      namespace: taxonomy.rest_namespace,
      methods: ["GET", "POST"],
      endpoints: [
        { methods: ["GET"], args: {} },
        { methods: ["POST"], args: {} },
      ],
    };
  }

  res.json({
    name: store.siteInfo.name,
    url: store.siteInfo.url,
    routes,
  });
});

// GET /wp/v2/types — List post types
router.get("/wp/v2/types", (_req, res) => {
  const types: Record<string, unknown> = {};
  for (const [slug, postType] of store.postTypes) {
    types[slug] = postType;
  }
  res.json(types);
});

// GET /wp/v2/taxonomies — List taxonomies
router.get("/wp/v2/taxonomies", (_req, res) => {
  const taxonomies: Record<string, unknown> = {};
  for (const [slug, taxonomy] of store.taxonomies) {
    taxonomies[slug] = taxonomy;
  }
  res.json(taxonomies);
});

// OPTIONS /wp/v2/:tableId — Get endpoint schema
router.options("/wp/v2/:tableId", (req, res) => {
  const { tableId } = req.params;
  const schema = store.schemas.get(tableId);

  if (!schema) {
    res.status(404).json({
      code: "rest_no_route",
      message: `No route was found matching the URL and request method. tableId: ${tableId}`,
      data: { status: 404 },
    });
    return;
  }

  res.json(schema);
});

export default router;
