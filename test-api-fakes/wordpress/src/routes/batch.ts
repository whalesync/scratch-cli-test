import { Router } from "express";
import { store } from "../store";

const router = Router();

interface BatchRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface BatchResponse {
  body: unknown;
  status: number;
  headers: Record<string, string>;
}

function processBatchRequest(request: BatchRequest): BatchResponse {
  const { method, path, body } = request;

  // Parse path: expected format /wp/v2/:tableId[/:recordId]
  const wpMatch = path.match(/^\/wp\/v2\/([^/]+)(?:\/([^/]+))?$/);
  if (!wpMatch) {
    return {
      body: {
        code: "rest_no_route",
        message: "No route was found matching the URL and request method.",
        data: { status: 404 },
      },
      status: 404,
      headers: {},
    };
  }

  const tableId = wpMatch[1];
  const recordId = wpMatch[2];

  switch (method.toUpperCase()) {
    case "POST": {
      if (recordId) {
        // POST to a specific record ID is not standard; treat as error
        return {
          body: {
            code: "rest_no_route",
            message: "No route was found matching the URL and request method.",
            data: { status: 404 },
          },
          status: 404,
          headers: {},
        };
      }
      const record = store.addRecord(tableId, body ?? {});
      return { body: record, status: 201, headers: {} };
    }

    case "PUT":
    case "PATCH": {
      if (!recordId) {
        return {
          body: {
            code: "rest_no_route",
            message: "No route was found matching the URL and request method.",
            data: { status: 404 },
          },
          status: 404,
          headers: {},
        };
      }
      const updated = store.updateRecord(tableId, recordId, body ?? {});
      if (!updated) {
        return {
          body: {
            code: "rest_post_invalid_id",
            message: "Invalid post ID.",
            data: { status: 404 },
          },
          status: 404,
          headers: {},
        };
      }
      return { body: updated, status: 200, headers: {} };
    }

    case "DELETE": {
      if (!recordId) {
        return {
          body: {
            code: "rest_no_route",
            message: "No route was found matching the URL and request method.",
            data: { status: 404 },
          },
          status: 404,
          headers: {},
        };
      }
      const deleted = store.deleteRecord(tableId, recordId);
      if (!deleted) {
        return {
          body: {
            code: "rest_post_invalid_id",
            message: "Invalid post ID.",
            data: { status: 404 },
          },
          status: 404,
          headers: {},
        };
      }
      return {
        body: { deleted: true, previous: deleted },
        status: 200,
        headers: {},
      };
    }

    case "GET": {
      if (recordId) {
        const record = store.getRecord(tableId, recordId);
        if (!record) {
          return {
            body: {
              code: "rest_post_invalid_id",
              message: "Invalid post ID.",
              data: { status: 404 },
            },
            status: 404,
            headers: {},
          };
        }
        return { body: record, status: 200, headers: {} };
      }
      const records = store.listRecords(tableId);
      return { body: records, status: 200, headers: {} };
    }

    default:
      return {
        body: {
          code: "rest_no_route",
          message: "No route was found matching the URL and request method.",
          data: { status: 404 },
        },
        status: 404,
        headers: {},
      };
  }
}

// POST /batch/v1 — Batch operations
router.post("/batch/v1", (req, res) => {
  const { requests } = req.body as {
    validation?: string;
    requests: BatchRequest[];
  };

  if (!requests || !Array.isArray(requests)) {
    res.status(400).json({
      code: "rest_invalid_json",
      message: "Invalid JSON body.",
      data: { status: 400 },
    });
    return;
  }

  const responses: BatchResponse[] = requests.map(processBatchRequest);

  const hasFailed = responses.some((r) => r.status >= 400);

  res.status(207).json({
    failed: hasFailed ? "some" : "none",
    responses,
  });
});

export default router;
