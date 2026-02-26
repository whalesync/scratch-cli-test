import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { repoCheckpointRouter } from './src/routes/repo-checkpoint';
import { repoDebugRouter } from './src/routes/repo-debug';
import { repoDiffRouter } from './src/routes/repo-diff';
import { repoManageRouter } from './src/routes/repo-manage';
import { repoReadRouter } from './src/routes/repo-read';
import { repoWriteRouter } from './src/routes/repo-write';
import { systemRouter } from './src/routes/system';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

import { gcState } from './src/services/gc-state';

app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function (body) {
    if (body && typeof body === 'object' && 'data' in body && 'status' in body) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return originalJson.call(this, body);
    }

    let repoId: string | null = null;
    const regex = new RegExp('^/api/repo/(?:manage|read|write|diff|checkpoint|debug)/([^/?]+)');
    const match = req.originalUrl.match(regex);
    if (match) {
      repoId = match[1];
    }

    const status = {
      gcInProgress: repoId ? gcState.get(repoId) || null : null,
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment
    return originalJson.call(this, { data: body, status });
  };
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[API] ${req.method} ${req.url}`);
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`(${duration}ms) [API] ${req.method} ${req.url} - ${res.statusCode} `);
  });
  next();
});

const port = process.env.PORT || 3100;
const buildVersion = process.env.BUILD_VERSION || '0.0.0-local';
const reposDir = resolve(process.env.GIT_REPOS_DIR || 'repos');

// Startup diagnostics
console.log(`[API] Repos directory: ${reposDir}`);
console.log(`[API] Repos directory exists: ${fs.existsSync(reposDir)}`);
if (fs.existsSync(reposDir)) {
  try {
    const entries = fs.readdirSync(reposDir);
    console.log(
      `[API] Repos directory contains ${entries.length} entries: ${entries.slice(0, 20).join(', ')}${entries.length > 20 ? '...' : ''}`,
    );
  } catch (err) {
    console.error(`[API] Failed to read repos directory: ${err}`);
  }
} else {
  console.warn(`[API] Repos directory does not exist, will be created on first init`);
}

// Mount routers
app.use('/', systemRouter);
app.use('/api/repo/manage/:id', repoManageRouter);
app.use('/api/repo/read/:id', repoReadRouter);
app.use('/api/repo/write/:id', repoWriteRouter);
app.use('/api/repo/diff/:id', repoDiffRouter);
app.use('/api/repo/checkpoint/:id', repoCheckpointRouter);
app.use('/api/repo/debug/:id', repoDebugRouter);

app.listen(port, () => {
  console.log(
    `ScratchGit API listening at http://localhost:${port} (build: ${buildVersion}, repos: ${reposDir}, env: ${process.env.NODE_ENV || 'development'})`,
  );
});
