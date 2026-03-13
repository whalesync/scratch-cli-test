import { Router } from 'express';
import { store } from '../store';

const router = Router();

const DEFAULT_PER_PAGE = 100;

router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const perPage = Math.max(1, parseInt(req.query.per_page as string, 10) || DEFAULT_PER_PAGE);

  const all = store.listContacts();
  const total = all.length;
  const startIndex = (page - 1) * perPage;
  const pageItems = all.slice(startIndex, startIndex + perPage);

  res.set('x-page', String(page));
  res.set('x-per-page', String(perPage));
  res.set('x-total', String(total));
  res.json(pageItems);
});

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const contact = store.getContact(id);
  if (!contact) {
    res.status(404).json({ message: 'not found' });
    return;
  }
  res.json(contact);
});

router.post('/', (req, res) => {
  const contact = store.addContact(req.body);
  res.status(201).json(contact);
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const contact = store.updateContact(id, req.body);
  if (!contact) {
    res.status(404).json({ message: 'not found' });
    return;
  }
  res.json(contact);
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = store.deleteContact(id);
  if (!deleted) {
    res.status(404).json({ message: 'not found' });
    return;
  }
  res.status(204).send();
});

export default router;
