import { Router } from 'express';
import { store } from '../store';

const router = Router();

const DEFAULT_PER_PAGE = 100;

// GET /wp/v2/:tableId — List records with offset-based pagination
router.get('/wp/v2/:tableId', (req, res) => {
  const { tableId } = req.params;
  const perPage = req.query.per_page ? parseInt(req.query.per_page as string, 10) : DEFAULT_PER_PAGE;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  const allRecords = store.listRecords(tableId);
  const page = allRecords.slice(offset, offset + perPage);
  const total = allRecords.length;
  const totalPages = Math.ceil(total / perPage);

  res.set('X-WP-Total', String(total));
  res.set('X-WP-TotalPages', String(totalPages));
  res.json(page);
});

// GET /wp/v2/:tableId/:recordId — Get single record
router.get('/wp/v2/:tableId/:recordId', (req, res) => {
  const { tableId, recordId } = req.params;
  const record = store.getRecord(tableId, recordId);

  if (!record) {
    res.status(404).json({
      code: 'rest_post_invalid_id',
      message: 'Invalid post ID.',
      data: { status: 404 },
    });
    return;
  }

  res.json(record);
});

// POST /wp/v2/:tableId — Create record
router.post('/wp/v2/:tableId', (req, res) => {
  const { tableId } = req.params;
  const fields = req.body;
  const record = store.addRecord(tableId, fields);
  res.status(201).json(record);
});

// PATCH /wp/v2/:tableId/:recordId — Update record
router.patch('/wp/v2/:tableId/:recordId', (req, res) => {
  const { tableId, recordId } = req.params;
  const fields = req.body;
  const record = store.updateRecord(tableId, recordId, fields);

  if (!record) {
    res.status(404).json({
      code: 'rest_post_invalid_id',
      message: 'Invalid post ID.',
      data: { status: 404 },
    });
    return;
  }

  res.json(record);
});

// DELETE /wp/v2/:tableId/:recordId — Delete record
router.delete('/wp/v2/:tableId/:recordId', (req, res) => {
  const { tableId, recordId } = req.params;
  const record = store.deleteRecord(tableId, recordId);

  if (!record) {
    res.status(404).json({
      code: 'rest_post_invalid_id',
      message: 'Invalid post ID.',
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
