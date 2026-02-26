/* eslint-disable @typescript-eslint/no-misused-promises */
import { Router } from 'express';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { RepoDiffService } from '../services/repo-diff.service';
import { RepoManageService } from '../services/repo-manage.service';
import { RepoWriteService } from '../services/repo-write.service';

export const repoManageRouter = Router({ mergeParams: true });

repoManageRouter.post('/init', async (req, res) => {
  const { id: repoId } = req.params as { id: string };
  console.log(`[API] Initializing repo: ${repoId}`);
  try {
    const gitService = new RepoManageService(repoId);
    await gitService.initRepo();
    const repoPath = gitService.getRepoPath();
    console.log(`[API] Repo initialized successfully: ${repoId} at ${repoPath}, exists: ${fs.existsSync(repoPath)}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[API] Failed to initialize repo ${repoId}:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});

repoManageRouter.delete('/', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const gitService = new RepoManageService(id);
    await gitService.deleteRepo();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoManageRouter.get('/exists', (req, res) => {
  const { id: repoId } = req.params as { id: string };
  const gitService = new RepoManageService(repoId);
  const repoPath = gitService.getRepoPath();
  const exists = fs.existsSync(repoPath);
  const hasHead = exists && fs.existsSync(resolve(repoPath, 'HEAD'));
  res.json({ repoId, repoPath, exists, hasHead });
});

repoManageRouter.post('/reset', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const { path } = req.body as { path?: string };
    if (path) {
      const diffService = new RepoDiffService(id);
      const changes = await diffService.getDirtyStatus();

      const writeService = new RepoWriteService(id);
      await writeService.discardChanges(path, changes);
    } else {
      const manageService = new RepoManageService(id);
      await manageService.resetToMain();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoManageRouter.post('/gc', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const gitService = new RepoManageService(id);
    const stats = await gitService.gc();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Archive endpoint removed, integrated into repo-read.ts
