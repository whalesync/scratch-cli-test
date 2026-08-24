import { RequestHandler, Router } from "express";
import { store } from "../store";

// The v4 and date-versioned (2026-03) association APIs share behavior and differ
// only in the URL prefix (/crm/v4/objects vs /crm/objects/2026-03 — DEV-10200),
// so both routers below reuse these handlers.

// Create association (default / unlabeled)
const createAssociation: RequestHandler = (req, res) => {
  const { fromObjectType, fromId, toObjectType, toId } = req.params;

  const success = store.addAssociation(
    fromObjectType,
    fromId,
    toObjectType,
    toId,
  );
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
};

// Delete association (removes all association types between the pair)
const deleteAssociation: RequestHandler = (req, res) => {
  const { fromObjectType, fromId, toObjectType, toId } = req.params;

  // HubSpot returns 204 even if the association didn't exist
  store.removeAssociation(fromObjectType, fromId, toObjectType, toId);
  res.status(204).send();
};

function buildRouter(pathPrefix: "" | "/objects"): Router {
  const router = Router();
  router.put(
    `${pathPrefix}/:fromObjectType/:fromId/associations/default/:toObjectType/:toId`,
    createAssociation,
  );
  router.delete(
    `${pathPrefix}/:fromObjectType/:fromId/associations/:toObjectType/:toId`,
    deleteAssociation,
  );
  return router;
}

// Mounted at /crm/v4 — paths look like /crm/v4/objects/{from}/{id}/associations/...
export const associationsV4Router = buildRouter("/objects");

// Mounted at /crm/objects/2026-03 — paths look like /crm/objects/2026-03/{from}/{id}/associations/...
export const associations202603Router = buildRouter("");

export default associationsV4Router;
