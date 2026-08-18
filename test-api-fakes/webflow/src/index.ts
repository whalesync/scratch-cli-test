import express from "express";
import { authMiddleware } from "./middleware/auth";
import collectionsRouter from "./routes/collections";
import sitesRouter from "./routes/sites";
import testAdminRouter from "./routes/test-admin";
import { store } from "./store";

export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // Error simulation middleware — runs before auth and routes, but skips /test/.
  app.use((req, res, next) => {
    if (req.path.startsWith("/test/")) {
      next();
      return;
    }

    const retryAfter = store.checkRateLimit();
    if (retryAfter !== null) {
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({
        message: "Too many requests (simulated)",
        code: "too_many_requests",
        externalReference: null,
        details: [],
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

  // Test admin endpoints — unauthenticated, mounted under /test/*.
  app.use("/test", testAdminRouter);

  // Routes carry the real API's `/v2` prefix: the connector's baseURL is
  // `https://api.webflow.com/v2` and API_URL_OVERRIDES rewrites only the origin,
  // so paths arrive here exactly as Webflow would receive them.
  app.use(sitesRouter);
  app.use(collectionsRouter);

  return app;
}

// Start server when run directly (not imported by tests).
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4655;
  const app = createApp();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Fake Webflow API listening on port ${port}`);
  });
}
