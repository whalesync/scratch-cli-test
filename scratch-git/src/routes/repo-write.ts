/* eslint-disable @typescript-eslint/no-misused-promises */
import { Router } from 'express';
import { RepoDiffService } from '../services/repo-diff.service';
import { RepoWriteService } from '../services/repo-write.service';

export const repoWriteRouter = Router({ mergeParams: true });

repoWriteRouter.post('/files', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const branch = (req.query.branch as string) || 'main';
    const { files, message } = req.body as { files: { path: string; content: string }[]; message?: string };
    if (!files || !Array.isArray(files)) {
      throw new Error('files array is required');
    }
    const gitService = new RepoWriteService(id);
    await gitService.commitFiles(
      branch,
      files.map((f: { path: string; content: string }) => ({
        ...f,
        path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
      })),
      message || 'Update files',
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoWriteRouter.delete('/files', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const branch = (req.query.branch as string) || 'main';
    const { files, message } = req.body as { files: string[]; message?: string }; // files is array of paths
    if (!files || !Array.isArray(files)) {
      throw new Error('files array is required');
    }
    const gitService = new RepoWriteService(id);
    await gitService.deleteFiles(branch, files, message || 'Delete files');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoWriteRouter.delete('/folder', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const folder = req.query.folder as string;
    const branch = (req.query.branch as string) || 'dirty';
    if (!folder) throw new Error('Query param folder is required');
    const { message } = req.body as { message?: string };
    const gitService = new RepoWriteService(id);
    await gitService.deleteFolder(folder, message || 'Delete folder', branch);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoWriteRouter.delete('/data-folder', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const body = req.body as { path?: string };
    const folderPath = body.path || (req.query.path as string);
    if (!folderPath) {
      throw new Error('Path is required');
    }
    const gitService = new RepoWriteService(id);
    await gitService.removeDataFolder(folderPath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoWriteRouter.post('/publish', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const { file, message } = req.body as { file: { path: string; content: string }; message?: string };
    if (!file) {
      throw new Error('file object is required');
    }
    const gitService = new RepoWriteService(id);
    await gitService.publishFile(file, message || 'Publish file');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoWriteRouter.post('/discard-changes', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const { path } = req.body as { path: string };
    if (!path) throw new Error('path is required');

    const diffService = new RepoDiffService(id);
    const changes = await diffService.getDirtyStatus();

    const gitService = new RepoWriteService(id);
    await gitService.discardChanges(path, changes);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoWriteRouter.post('/rebase', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const body = req.body as { strategy?: string };
    const strategy = body.strategy;
    const gitService = new RepoWriteService(id);
    const result = await gitService.rebaseDirty(strategy as 'ours' | 'diff3');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

repoWriteRouter.post('/rename', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const { folderPath, renames, message } = req.body as {
      folderPath: string;
      renames: { oldName: string; newName: string }[];
      message?: string;
    };
    if (folderPath === undefined || !renames || !Array.isArray(renames)) {
      throw new Error('folderPath and renames are required');
    }
    const gitService = new RepoWriteService(id);
    await gitService.renameFiles(folderPath, renames, message || `Rename batch in ${folderPath}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
