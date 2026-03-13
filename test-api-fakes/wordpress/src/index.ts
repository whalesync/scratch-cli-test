import express from 'express';
import { store } from './store';
import { authMiddleware } from './middleware/auth';
import testAdminRouter from './routes/test-admin';
import discoveryRouter from './routes/discovery';
import recordsRouter from './routes/records';
import mediaRouter from './routes/media';
import batchRouter from './routes/batch';

export function createApp(): express.Express {
  const app = express();

  app.use(express.json());

  // Error simulation middleware — runs before auth and routes, but skips /test/ endpoints
  app.use((req, res, next) => {
    if (req.path.startsWith('/test/')) {
      next();
      return;
    }

    const retryAfter = store.checkRateLimit();
    if (retryAfter !== null) {
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        code: 'rest_rate_limit',
        message: 'Rate limit reached.',
        data: { status: 429 },
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

  app.use('/test', testAdminRouter);

  // Mount routes at both root and /wp-json/ prefix.
  // Real WordPress serves REST API under /wp-json/ (e.g. /wp-json/wp/v2/posts).
  // The connector stores endpoint as "https://host/wp-json/" and appends paths to it.
  // The Axios interceptor only rewrites the origin, so URLs arrive here as /wp-json/wp/v2/...
  for (const prefix of ['/', '/wp-json/']) {
    app.use(prefix, discoveryRouter);
    app.use(prefix, recordsRouter);
    app.use(prefix, mediaRouter);
    app.use(prefix, batchRouter);
  }

  return app;
}

// Start server when run directly (not imported by tests)
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4647;
  const app = createApp();
  app.listen(port, () => {
    console.log(`Fake WordPress API listening on port ${port}`);
  });
}
