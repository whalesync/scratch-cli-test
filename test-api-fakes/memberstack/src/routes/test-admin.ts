import { Router } from "express";
import { store, Member } from "../store";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get("/dump", (_req, res) => {
  const members = store.listMembers();
  res.json({ members });
});

router.post("/reset", (_req, res) => {
  store.reset();
  res.status(200).json({ ok: true });
});

router.post("/setup", (req, res) => {
  const { members } = req.body;

  if (members) {
    for (const member of members) {
      if (member.id) {
        // Seed with explicit ID
        const seeded: Member = {
          id: member.id,
          auth: member.auth ?? { email: member.email },
          customFields: member.customFields ?? {},
          metaData: member.metaData ?? {},
          json: member.json ?? {},
          planConnections: member.planConnections ?? [],
          loginRedirect: member.loginRedirect ?? "",
          permissions: member.permissions ?? [],
          verified: member.verified ?? false,
          createdAt: member.createdAt ?? new Date().toISOString(),
          lastLogin: member.lastLogin ?? null,
        };
        store.addMemberWithId(seeded);
      } else {
        store.addMember({
          email: member.auth?.email ?? member.email,
          customFields: member.customFields,
          metaData: member.metaData,
          json: member.json,
          loginRedirect: member.loginRedirect,
          plans: member.plans,
        });
      }
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
