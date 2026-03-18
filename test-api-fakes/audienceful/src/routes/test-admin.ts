import { Router } from "express";
import { store, Person } from "../store";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get("/dump", (_req, res) => {
  const people = store.listPeople();
  res.json({
    people,
    fields: store.fields,
  });
});

router.post("/reset", (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

router.post("/setup", (req, res) => {
  const { people, fields } = req.body;

  if (people) {
    for (const person of people) {
      if (person.uid) {
        // Seed with explicit UID
        const seeded: Person = {
          uid: person.uid,
          email: person.email,
          tags: person.tags ?? [],
          notes: person.notes ?? "",
          extra_data: person.extra_data ?? {},
          created: person.created ?? new Date().toISOString(),
          updated: person.updated ?? new Date().toISOString(),
        };
        // Copy custom fields
        for (const [key, value] of Object.entries(person)) {
          if (
            ![
              "uid",
              "email",
              "tags",
              "notes",
              "extra_data",
              "created",
              "updated",
            ].includes(key)
          ) {
            seeded[key] = value;
          }
        }
        store.addPersonWithUid(seeded);
      } else {
        store.addPerson(person);
      }
    }
  }

  if (fields) {
    store.fields = fields;
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
