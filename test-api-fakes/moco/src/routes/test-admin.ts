import { Router } from "express";
import { store } from "../store";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get("/dump", (_req, res) => {
  res.json({
    companies: store.listCompanies(),
    contacts: store.listContacts(),
    projects: store.listProjects(),
  });
});

router.post("/reset", (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

router.post("/setup", (req, res) => {
  const { companies, contacts, projects } = req.body;

  if (companies) {
    for (const company of companies) {
      store.addCompany(company);
    }
  }

  if (contacts) {
    for (const contact of contacts) {
      store.addContact(contact);
    }
  }

  if (projects) {
    for (const project of projects) {
      store.addProject(project);
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
