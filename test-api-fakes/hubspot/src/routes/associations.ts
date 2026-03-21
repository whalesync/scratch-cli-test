import { Router } from "express";
import { store } from "../store";

const router = Router();

// Create association (v4 default)
router.put(
  "/objects/:fromObjectType/:fromId/associations/default/:toObjectType/:toId",
  (req, res) => {
    const { fromObjectType, fromId, toObjectType, toId } = req.params;

    const success = store.addAssociation(fromObjectType, fromId, toObjectType, toId);
    if (!success) {
      res.status(404).json({
        status: "error",
        message: "resource not found",
        correlationId: "fake-correlation-id",
        category: "OBJECT_NOT_FOUND",
      });
      return;
    }

    res.status(200).json({
      fromObjectTypeId: fromObjectType,
      fromObjectId: parseInt(fromId, 10),
      toObjectTypeId: toObjectType,
      toObjectId: parseInt(toId, 10),
      labels: [],
    });
  },
);

// Delete association (v4)
router.delete(
  "/objects/:fromObjectType/:fromId/associations/:toObjectType/:toId",
  (req, res) => {
    const { fromObjectType, fromId, toObjectType, toId } = req.params;

    const success = store.removeAssociation(fromObjectType, fromId, toObjectType, toId);
    if (!success) {
      // HubSpot returns 204 even if association didn't exist
      res.status(204).send();
      return;
    }

    res.status(204).send();
  },
);

export default router;
