import express from "express";
import { authMiddleware } from "./middleware/auth";
import { store } from "./store";
import testAdminRouter from "./routes/test-admin";
import v2ListsRouter from "./routes/v2-lists";
import v1RateLimitRouter from "./routes/v1-rate-limit";

export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // Error simulation middleware — runs before auth and routes, but skips /test/.
  // This lets tests inject 429s and arbitrary errors via /test/simulate-* endpoints
  // without needing real time-window simulation.
  app.use((req, res, next) => {
    if (req.path.startsWith("/test/")) {
      next();
      return;
    }

    const retryAfter = store.checkRateLimit();
    if (retryAfter !== null) {
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({
        errors: [{ code: "rate_limited", message: "Too many requests (simulated)" }],
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

  // The connector hits a mix of v1 (just /rate-limit) and v2 paths. Both
  // accept the same Bearer token (Affinity has unified auth despite what
  // their docs claim). Mounting at the app root keeps the route definitions
  // matching the real API paths verbatim.
  app.use(v2ListsRouter);
  app.use(v1RateLimitRouter);

  return app;
}

// Start server when run directly (not imported by tests).
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4654;
  const app = createApp();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Fake Affinity API listening on port ${port}`);
  });
}
