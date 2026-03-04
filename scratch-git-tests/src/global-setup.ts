import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const STATE_FILE = path.join(os.tmpdir(), 'scratch-git-tests-state.json');
const TEST_PORT = 13100;
const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_POLL_MS = 200;

function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server did not become healthy within ${timeoutMs}ms`));
      }
      const req = http.get(`http://localhost:${port}/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(check, HEALTH_POLL_MS);
        }
      });
      req.on('error', () => {
        setTimeout(check, HEALTH_POLL_MS);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        setTimeout(check, HEALTH_POLL_MS);
      });
    };
    check();
  });
}

export default async function globalSetup() {
  // Allow pointing tests at an already-running server
  const externalUrl = process.env.SCRATCH_GIT_URL;
  if (externalUrl) {
    const url = new URL(externalUrl);
    const port = parseInt(url.port || '3100', 10);
    await waitForHealth(port, HEALTH_TIMEOUT_MS);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ port, pid: null, reposDir: null }));
    return;
  }

  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), `scratch-git-test-${process.pid}-`));
  const scratchGitBinary = path.resolve(__dirname, '../../scratch-git-2/target/debug/scratch-git-2');

  const child: ChildProcess = spawn(scratchGitBinary, [], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      GIT_BACKEND_PORT: String(TEST_PORT + 1),
      GIT_REPOS_DIR: reposDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    if (process.env.DEBUG) {
      process.stdout.write(`[scratch-git] ${data.toString()}`);
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    if (process.env.DEBUG) {
      process.stderr.write(`[scratch-git:err] ${data.toString()}`);
    }
  });

  child.on('error', (err) => {
    console.error('Failed to start scratch-git server:', err);
  });

  fs.writeFileSync(STATE_FILE, JSON.stringify({ port: TEST_PORT, pid: child.pid, reposDir }));

  try {
    await waitForHealth(TEST_PORT, HEALTH_TIMEOUT_MS);
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
}
