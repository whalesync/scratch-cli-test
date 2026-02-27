import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_FILE = path.join(os.tmpdir(), 'scratch-git-tests-state.json');

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  fs.unlinkSync(STATE_FILE);

  if (state.pid) {
    try {
      process.kill(state.pid, 'SIGTERM');
      // Give it a moment to shut down gracefully
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        process.kill(state.pid, 0); // Check if still alive
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // Already dead, good
      }
    } catch {
      // Process already gone
    }
  }

  if (state.reposDir) {
    try {
      fs.rmSync(state.reposDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
