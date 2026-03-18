import { Router } from "express";
import { store } from "../store";

const router = Router();

router.get("/", (_req, res) => {
  res.json(store.fields);
});

export default router;
