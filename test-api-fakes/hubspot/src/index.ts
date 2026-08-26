import express from "express";
import { store } from "./store";
import { authMiddleware } from "./middleware/auth";
import testAdminRouter from "./routes/test-admin";
import crmRouter from "./routes/crm";
import {
  associations202603Router,
  associationsBatch202603Router,
  associationsV4Router,
} from "./routes/associations";

export function createApp(): express.Express {
  const app = express();

  app.use(express.json());

  // Error simulation middleware — runs before auth and routes, but skips /test/ endpoints
  app.use((req, res, next) => {
    if (req.path.startsWith("/test/")) {
      next();
      return;
    }

    const retryAfter = store.checkRateLimit();
    if (retryAfter !== null) {
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({
        status: "error",
        message: "You have reached your secondly limit.",
        correlationId: "fake-correlation-id",
        category: "RATE_LIMITS",
      });
      return;
    }

    const queuedError = store.checkErrorQueue();
    if (queuedError !== null) {
      res.status(queuedError.statusCode).json(queuedError.body);
      return;
    }

    next();
  });

  app.use(authMiddleware);

  app.use("/test", testAdminRouter);
  // CRM v3 routes: /crm/v3/properties/:objectType, /crm/v3/objects/:objectType, /crm/v3/schemas
  app.use("/crm/v3", crmRouter);
  // Associations v4 routes: /crm/v4/objects/:fromObjectType/:fromId/associations/...
  app.use("/crm/v4", associationsV4Router);
  // Date-versioned associations routes (DEV-10200):
  // /crm/objects/2026-03/:fromObjectType/:fromId/associations/...
  app.use("/crm/objects/2026-03", associations202603Router);
  // Batch association writes, 2026-03 only (DEV-10200):
  // /crm/associations/2026-03/:fromObjectType/:toObjectType/batch/{associate/default,archive}
  app.use("/crm/associations/2026-03", associationsBatch202603Router);

  return app;
}

// Start server when run directly (not imported by tests)
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4653;
  const app = createApp();
  app.listen(port, () => {
    console.log(`Fake HubSpot API listening on port ${port}`);
  });
}
