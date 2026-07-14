import { Router } from "express";
import { store } from "../store";

const router = Router();

const DEFAULT_PER_PAGE = 100;

// GET /wp/v2/:tableId — List records with page-based pagination
router.get("/wp/v2/:tableId", (req, res) => {
  const { tableId } = req.params;
  const perPageRaw = parseInt(req.query.per_page as string, 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : DEFAULT_PER_PAGE;

  // WordPress paginates by `page` (1-based); an explicit `offset` overrides it,
  // mirroring real WP (a plugin-supplied offset wins over page). The Scratch
  // connector switched to `page` in DEV-10786 — it no longer sends `offset` —
  // because offset is the param broken sites drop. Honor `page` as the primary
  // cursor so a multi-page pull actually advances instead of re-reading page 1.
  const pageRaw = parseInt(req.query.page as string, 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const hasExplicitOffset = req.query.offset !== undefined;
  const offset = hasExplicitOffset
    ? parseInt(req.query.offset as string, 10)
    : (page - 1) * perPage;

  // Deterministic scan order so page pagination can't skip/duplicate records;
  // the connector requests `orderby=id&order=asc`. Sort by id ascending (or
  // descending when `order=desc` is asked), independent of insertion order.
  const order = req.query.order === "desc" ? "desc" : "asc";
  const allRecords = [...store.listRecords(tableId)].sort((a, b) =>
    order === "desc" ? b.id - a.id : a.id - b.id,
  );
  const total = allRecords.length;
  const totalPages = Math.ceil(total / perPage);

  res.set("X-WP-Total", String(total));
  res.set("X-WP-TotalPages", String(totalPages));

  // A page-based read past the last page is stock WordPress's
  // `400 rest_post_invalid_page_number` (the exact-multiple boundary the
  // connector treats as clean completion). An offset-based over-read stays
  // lenient and returns an empty page, also matching real WP.
  if (!hasExplicitOffset && total > 0 && page > totalPages) {
    res.status(400).json({
      code: "rest_post_invalid_page_number",
      message: "The page number requested is larger than the number of pages available.",
      data: { status: 400 },
    });
    return;
  }

  res.json(allRecords.slice(offset, offset + perPage));
});

// GET /wp/v2/:tableId/:recordId — Get single record
router.get("/wp/v2/:tableId/:recordId", (req, res) => {
  const { tableId, recordId } = req.params;
  const record = store.getRecord(tableId, recordId);

  if (!record) {
    res.status(404).json({
      code: "rest_post_invalid_id",
      message: "Invalid post ID.",
      data: { status: 404 },
    });
    return;
  }

  res.json(record);
});

// POST /wp/v2/:tableId — Create record
router.post("/wp/v2/:tableId", (req, res) => {
  const { tableId } = req.params;
  const fields = req.body;
  const record = store.addRecord(tableId, fields);
  res.status(201).json(record);
});

// PATCH /wp/v2/:tableId/:recordId — Update record
router.patch("/wp/v2/:tableId/:recordId", (req, res) => {
  const { tableId, recordId } = req.params;
  const fields = req.body;
  const record = store.updateRecord(tableId, recordId, fields);

  if (!record) {
    res.status(404).json({
      code: "rest_post_invalid_id",
      message: "Invalid post ID.",
      data: { status: 404 },
    });
    return;
  }

  res.json(record);
});

// DELETE /wp/v2/:tableId/:recordId — Delete record
router.delete("/wp/v2/:tableId/:recordId", (req, res) => {
  const { tableId, recordId } = req.params;
  const record = store.deleteRecord(tableId, recordId);

  if (!record) {
    res.status(404).json({
      code: "rest_post_invalid_id",
      message: "Invalid post ID.",
      data: { status: 404 },
    });
    return;
  }

  res.json({
    deleted: true,
    previous: record,
  });
});

export default router;
