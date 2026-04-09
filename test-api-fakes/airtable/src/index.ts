import express from "express";
import { store } from "./store";
import { authMiddleware } from "./middleware/auth";
import testAdminRouter from "./routes/test-admin";
import metaRouter from "./routes/meta";
import recordsRouter from "./routes/records";

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
        error: {
          type: "RATE_LIMIT_REACHED",
          message: "Rate limit reached",
        },
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

  // Response delay middleware — adds artificial latency to simulate slow APIs
  app.use((req, res, next) => {
    if (req.path.startsWith("/test/") || store.responseDelayMs <= 0) {
      next();
      return;
    }
    setTimeout(next, store.responseDelayMs);
  });

  app.use(authMiddleware);

  app.use("/test", testAdminRouter);
  app.use("/v0/meta", metaRouter);
  app.use("/v0", recordsRouter);

  return app;
}

// Start server when run directly (not imported by tests)
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4646;
  const app = createApp();
  app.listen(port, () => {
    console.log(`Fake Airtable API listening on port ${port}`);
  });
}
