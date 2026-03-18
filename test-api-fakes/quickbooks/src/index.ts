import express from "express";
import { store } from "./store";
import { authMiddleware } from "./middleware/auth";
import testAdminRouter from "./routes/test-admin";
import queryRouter from "./routes/query";
import entityRouter from "./routes/entity";

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
        Fault: {
          type: "RateLimitFault",
          Error: [
            {
              Message: "Throttled",
              Detail: "Rate limit reached",
              code: "3001",
            },
          ],
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

  app.use(authMiddleware);

  app.use("/test", testAdminRouter);
  app.use("/", queryRouter);
  app.use("/", entityRouter);

  return app;
}

// Start server when run directly (not imported by tests)
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4648;
  const app = createApp();
  app.listen(port, () => {
    console.log(`Fake QuickBooks API listening on port ${port}`);
  });
}
