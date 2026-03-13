import { Router } from 'express';
import { store } from '../store';

const router = Router();

const PAGE_SIZE = 50;

router.get('/', (req, res) => {
  const people = store.listPeople();

  // Parse cursor for pagination
  let startIndex = 0;
  const cursorParam = req.query.cursor;
  if (typeof cursorParam === 'string') {
    try {
      startIndex = parseInt(Buffer.from(cursorParam, 'base64').toString('utf-8'), 10);
    } catch {
      startIndex = 0;
    }
  }

  const page = people.slice(startIndex, startIndex + PAGE_SIZE);
  const hasNext = startIndex + PAGE_SIZE < people.length;

  const protocol = req.protocol;
  const host = req.get('host');
  const basePath = '/api/people/';

  const nextCursor = hasNext ? Buffer.from(String(startIndex + PAGE_SIZE)).toString('base64') : null;

  res.json({
    next: nextCursor ? `${protocol}://${host}${basePath}?cursor=${nextCursor}` : null,
    previous: null,
    count: page.length,
    total: people.length,
    results: page,
  });
});

router.get('/:uid/', (req, res) => {
  const { uid } = req.params;
  const person = store.getPerson(uid);

  if (!person) {
    res.status(404).json({
      detail: 'Not found.',
    });
    return;
  }

  res.json(person);
});

router.post('/', (req, res) => {
  const { email, tags, notes, extra_data, ...customFields } = req.body;

  if (!email) {
    res.status(400).json({
      detail: 'email is required.',
    });
    return;
  }

  const person = store.addPerson({ email, tags, notes, extra_data, ...customFields });
  res.status(201).json(person);
});

router.put('/', (req, res) => {
  const { email, tags, notes, extra_data, ...customFields } = req.body;

  if (!email) {
    res.status(400).json({
      detail: 'email is required.',
    });
    return;
  }

  // If person doesn't exist, create them
  const existing = store.getPersonByEmail(email);
  if (!existing) {
    const person = store.addPerson({ email, tags, notes, extra_data, ...customFields });
    res.status(201).json(person);
    return;
  }

  const person = store.updatePerson(email, { tags, notes, extra_data, ...customFields });
  res.json(person);
});

router.delete('/', (req, res) => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({
      detail: 'email is required.',
    });
    return;
  }

  // Idempotent — 204 regardless of whether the person existed
  store.deletePerson(email);
  res.status(204).send();
});

export default router;
