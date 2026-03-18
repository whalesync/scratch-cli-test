import { Router } from "express";
import { store } from "../store";

const router = Router();

router.get("/bases", (_req, res) => {
  res.json({ bases: store.listBases() });
});

router.get("/bases/:baseId/tables", (req, res) => {
  const { baseId } = req.params;
  const tables = store.listTables(baseId);

  if (tables === undefined) {
    res.status(404).json({
      error: {
        type: "NOT_FOUND",
        message: "Could not find base",
      },
    });
    return;
  }

  res.json({ tables });
});

export default router;
