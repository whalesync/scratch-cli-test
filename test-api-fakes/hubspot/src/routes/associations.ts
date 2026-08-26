import { RequestHandler, Router } from "express";
import { store } from "../store";

// The v4 and date-versioned (2026-03) association APIs share behavior and differ
// only in the URL prefix (/crm/v4/objects vs /crm/objects/2026-03 — DEV-10200),
// so both routers below reuse these handlers.

// Create association (default / unlabeled)
const createAssociation: RequestHandler = (req, res) => {
  const { fromObjectType, fromId, toObjectType, toId } = req.params;

  // Like HubSpot, both ends must exist: a link to an unknown `to` record is a 404.
  const toRecord = store.getRecord(toObjectType, toId);
  const toExists = !!toRecord && !toRecord.archived;
  const success =
    toExists &&
    store.addAssociation(fromObjectType, fromId, toObjectType, toId);
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

// --- Batch association writes (2026-03 only, DEV-10200) ---
//
// Mounted at /crm/associations/2026-03 — paths look like
// /crm/associations/2026-03/{from}/{to}/batch/associate/default and
// /crm/associations/2026-03/{from}/{to}/batch/archive. These endpoints exist
// only on the date-versioned API. The associate route models HubSpot's
// multi-status contract: every pair whose records exist is linked and echoed in
// `results`; a pair naming a missing record lands in `errors` and the status is
// 207. The error `context` keys below are the fake's model — HubSpot documents
// `context` only as a map of string arrays; the live spec prints the real shape.

const BATCH_ASSOCIATE_MAX_INPUTS = 2000;
const BATCH_ARCHIVE_MAX_UNIQUE_FROM_IDS = 100;

function batchLimitExceeded(
  res: Parameters<RequestHandler>[1],
  count: number,
  max: number,
  what: string,
): boolean {
  if (count <= max) return false;
  res.status(400).json({
    status: "error",
    message: `${count} ${what} exceeds the maximum of ${max} per request`,
    correlationId: "fake-correlation-id",
    category: "VALIDATION_ERROR",
  });
  return true;
}

const batchAssociateDefault: RequestHandler = (req, res) => {
  const { fromObjectType, toObjectType } = req.params;
  const inputs: Array<{ from?: { id?: string }; to?: { id?: string } }> =
    req.body?.inputs ?? [];
  store.recordBatchRequest(req.originalUrl, req.body);
  if (
    batchLimitExceeded(res, inputs.length, BATCH_ASSOCIATE_MAX_INPUTS, "inputs")
  )
    return;

  const results: unknown[] = [];
  const errors: unknown[] = [];
  for (const input of inputs) {
    const fromId = String(input.from?.id ?? "");
    const toId = String(input.to?.id ?? "");
    const fromRecord = store.getRecord(fromObjectType, fromId);
    const toRecord = store.getRecord(toObjectType, toId);
    const fromExists = !!fromRecord && !fromRecord.archived;
    const toExists = !!toRecord && !toRecord.archived;
    if (!fromExists || !toExists) {
      errors.push({
        status: "error",
        category: "OBJECT_NOT_FOUND",
        message: `Could not associate ${fromObjectType}/${fromId} with ${toObjectType}/${toId}: ${
          fromExists ? `${toObjectType} ${toId}` : `${fromObjectType} ${fromId}`
        } does not exist`,
        context: { fromObjectId: [fromId], toObjectId: [toId] },
      });
      continue;
    }
    store.addAssociation(fromObjectType, fromId, toObjectType, toId);
    results.push({
      from: { id: fromId },
      to: { id: toId },
      labels: [],
    });
  }

  const body: Record<string, unknown> = {
    status: "COMPLETE",
    results,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  if (errors.length > 0) {
    body.numErrors = errors.length;
    body.errors = errors;
  }
  res.status(errors.length > 0 ? 207 : 201).json(body);
};

// Removes every association type between each `from` and each of its `to`s;
// a pair that isn't associated is a no-op. 204 like the single DELETE.
const batchArchive: RequestHandler = (req, res) => {
  const { fromObjectType, toObjectType } = req.params;
  const inputs: Array<{ from?: { id?: string }; to?: Array<{ id?: string }> }> =
    req.body?.inputs ?? [];
  store.recordBatchRequest(req.originalUrl, req.body);
  const uniqueFromIds = new Set(
    inputs.map((input) => String(input.from?.id ?? "")),
  );
  if (
    batchLimitExceeded(
      res,
      uniqueFromIds.size,
      BATCH_ARCHIVE_MAX_UNIQUE_FROM_IDS,
      "unique from ids",
    )
  ) {
    return;
  }

  for (const input of inputs) {
    const fromId = String(input.from?.id ?? "");
    for (const to of input.to ?? []) {
      store.removeAssociation(
        fromObjectType,
        fromId,
        toObjectType,
        String(to.id ?? ""),
      );
    }
  }
  res.status(204).send();
};

export const associationsBatch202603Router = Router();
associationsBatch202603Router.post(
  "/:fromObjectType/:toObjectType/batch/associate/default",
  batchAssociateDefault,
);
associationsBatch202603Router.post(
  "/:fromObjectType/:toObjectType/batch/archive",
  batchArchive,
);

export default associationsV4Router;
