import { Router } from "express";
import { store, MemberstackStoreError } from "../store";

const router = Router();

// GET /members — list members with cursor-based pagination
router.get("/", (req, res) => {
  const members = store.listMembers();

  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const order =
    (req.query.order as string)?.toUpperCase() === "DESC" ? "DESC" : "ASC";
  const afterCursor = req.query.after as string | undefined;

  // Sort by creation time
  const sorted = order === "DESC" ? [...members].reverse() : [...members];

  // Find start index from cursor
  let startIndex = 0;
  if (afterCursor) {
    const cursorIndex = sorted.findIndex((m) => m.id === afterCursor);
    if (cursorIndex >= 0) {
      startIndex = cursorIndex + 1;
    }
  }

  const page = sorted.slice(startIndex, startIndex + limit);
  const hasNextPage = startIndex + limit < sorted.length;
  const endCursor = page.length > 0 ? page[page.length - 1].id : null;

  res.json({
    totalCount: members.length,
    endCursor,
    hasNextPage,
    data: page,
  });
});

// GET /members/:idOrEmail — get a single member
router.get("/:idOrEmail", (req, res) => {
  const { idOrEmail } = req.params;
  const member = store.getMemberByIdOrEmail(decodeURIComponent(idOrEmail));

  if (!member) {
    res.status(404).json({ message: "Member not found" });
    return;
  }

  res.json({ data: member });
});

// POST /members — create a member
router.post("/", (req, res) => {
  const {
    email,
    password,
    plans,
    customFields,
    metaData,
    json,
    loginRedirect,
  } = req.body;

  if (!email) {
    res.status(400).json({ message: "email is required" });
    return;
  }
  if (!password) {
    res.status(400).json({ message: "password is required" });
    return;
  }

  try {
    const member = store.addMember({
      email,
      password,
      plans,
      customFields,
      metaData,
      json,
      loginRedirect,
    });
    res.status(201).json({ data: member });
  } catch (error) {
    if (error instanceof MemberstackStoreError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }
    throw error;
  }
});

// PATCH /members/:id — update a member
router.patch("/:id", (req, res) => {
  const { id } = req.params;
  const { email, customFields, metaData, json, loginRedirect } = req.body;

  try {
    const member = store.updateMember(id, {
      email,
      customFields,
      metaData,
      json,
      loginRedirect,
    });

    if (!member) {
      res.status(404).json({ message: "Member not found" });
      return;
    }

    res.json({ data: member });
  } catch (error) {
    if (error instanceof MemberstackStoreError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }
    throw error;
  }
});

// DELETE /members/:id — delete a member
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  const deleted = store.deleteMember(id);

  if (!deleted) {
    res.status(404).json({ message: "Member not found" });
    return;
  }

  res.json({ data: { id } });
});

// POST /members/:id/add-plan — add a free plan
router.post("/:id/add-plan", (req, res) => {
  const { id } = req.params;
  const { planId } = req.body;

  if (!planId) {
    res.status(400).json({ message: "planId is required" });
    return;
  }

  const success = store.addPlanToMember(id, planId);
  if (!success) {
    res.status(404).json({ message: "Member not found" });
    return;
  }

  res.status(200).send();
});

// POST /members/:id/remove-plan — remove a free plan
router.post("/:id/remove-plan", (req, res) => {
  const { id } = req.params;
  const { planId } = req.body;

  if (!planId) {
    res.status(400).json({ message: "planId is required" });
    return;
  }

  const success = store.removePlanFromMember(id, planId);
  if (!success) {
    res.status(404).json({ message: "Member not found" });
    return;
  }

  res.status(200).send();
});

export default router;
