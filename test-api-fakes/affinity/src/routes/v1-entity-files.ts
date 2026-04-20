import { Router } from "express";
import { store } from "../store";

const router = Router();

const V1_PAGE_SIZE = 500;

// ---- GET /entity-files ----
//
// v1 API endpoint. Uses token-based pagination (`page_token` / `next_page_token`)
// instead of v2's cursor-based pagination. The token is a base64-encoded offset,
// matching the v2 fake's approach.

router.get("/entity-files", (req, res) => {
  const items = store.listTenantEntityFiles();

  let startIndex = 0;
  const pageToken = req.query.page_token;
  if (typeof pageToken === "string") {
    try {
      startIndex = parseInt(
        Buffer.from(pageToken, "base64").toString("utf-8"),
        10,
      );
      if (isNaN(startIndex) || startIndex < 0) startIndex = 0;
    } catch {
      startIndex = 0;
    }
  }

  const requestedSize = parseInt(String(req.query.page_size ?? V1_PAGE_SIZE), 10);
  const pageSize = Math.min(
    isNaN(requestedSize) ? V1_PAGE_SIZE : requestedSize,
    V1_PAGE_SIZE,
  );

  const page = items.slice(startIndex, startIndex + pageSize);
  const nextStart = startIndex + pageSize;
  const hasNext = nextStart < items.length;

  res.json({
    entity_files: page,
    next_page_token: hasNext
      ? Buffer.from(String(nextStart)).toString("base64")
      : null,
  });
});

// ---- GET /entity-files/{id} ----

router.get("/entity-files/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const file = store.getTenantEntityFile(id);
  if (!file) {
    res.status(404).json({
      errors: [{ code: "not_found", message: `Entity file ${id} not found` }],
    });
    return;
  }
  res.json(file);
});

export default router;
