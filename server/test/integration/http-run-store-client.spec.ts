/**
 * HttpRunStoreClient against a real scratch-git: the shared RunStoreClient contract suite (the same one
 * InMemoryRunStoreClient passes), plus the HTTP-only behaviour (507 budget error, bearer auth, the staging
 * listing).
 *
 * Starts its own scratch-git from the built binary on ephemeral ports with temp repos/staging/index dirs, so it
 * never touches a shared scratch-git on :3100. Build it first:
 *
 *   cd scratch-git-2 && cargo build --release
 *
 * Throughput benchmark (100k × ~4 KB entries, with and without gzip, sequential and 4-way parallel):
 *
 *   RUN_STORE_HTTP_BENCHMARK=1 npx jest --config ./test/integration/jest-integration.json \
 *     test/integration/http-run-store-client.spec.ts -t benchmark
 */
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeRunStoreClientContract } from 'src/live-export-run-store/__tests__/run-store-client.contract';
import { HttpRunStoreClient } from 'src/live-export-run-store/http-run-store-client';
import {
  putRunStoreEntriesInBatches,
  readAllRunStoreEntries,
  RunStoreBudgetExceededError,
  type RunStoreEntryToPut,
  type RunStoreKey,
} from 'src/live-export-run-store/run-store-client';

const SCRATCH_GIT_BINARY_CANDIDATES = [
  path.join(__dirname, '../../../scratch-git-2/target/release/scratch-git-2'),
  path.join(__dirname, '../../../scratch-git-2/target/debug/scratch-git-2'),
];
const scratchGitBinaryPath = SCRATCH_GIT_BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate));

const SCRATCH_GIT_AUTH_TOKEN = 'run-store-integration-token';

interface StartedScratchGit {
  apiUrl: string;
  rootDir: string;
  stagingDir: string;
  stop: () => Promise<void>;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startScratchGit(binaryPath: string, extraEnv: Record<string, string> = {}): Promise<StartedScratchGit> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-it-'));
  const stagingDir = path.join(rootDir, 'staging');
  const apiPort = await findFreePort();
  const gitBackendPort = await findFreePort();
  // A clean env (not process.env): .env.integration may carry e.g. a Slack webhook.
  const scratchGitProcess: ChildProcess = spawn(binaryPath, [], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? rootDir,
      PORT: String(apiPort),
      GIT_BACKEND_PORT: String(gitBackendPort),
      GIT_REPOS_DIR: path.join(rootDir, 'repos'),
      GIT_INDEX_DIR: path.join(rootDir, 'index'),
      GIT_STAGING_DIR: stagingDir,
      SCRATCH_GIT_AUTH_TOKEN,
      RUST_LOG: 'warn',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  scratchGitProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (scratchGitProcess.exitCode !== null) {
      throw new Error(`scratch-git exited with ${scratchGitProcess.exitCode} before becoming healthy:\n${stderr}`);
    }
    try {
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      scratchGitProcess.kill('SIGKILL');
      throw new Error(`scratch-git did not become healthy within 30 s:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    apiUrl,
    rootDir,
    stagingDir,
    stop: async () => {
      if (scratchGitProcess.exitCode === null) {
        const exited = new Promise((resolve) => scratchGitProcess.once('exit', resolve));
        scratchGitProcess.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        if (scratchGitProcess.exitCode === null) scratchGitProcess.kill('SIGKILL');
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

if (!scratchGitBinaryPath) {
  console.warn(
    'Skipping http-run-store-client integration spec: no scratch-git binary. Build it with ' +
      '`cd scratch-git-2 && cargo build --release`.',
  );
}

const describeWhenScratchGitIsBuilt = scratchGitBinaryPath ? describe : describe.skip;

describeWhenScratchGitIsBuilt('HttpRunStoreClient against a real scratch-git', () => {
  let scratchGit: StartedScratchGit;

  beforeAll(async () => {
    if (!scratchGitBinaryPath) throw new Error('unreachable: suite is skipped without a binary');
    scratchGit = await startScratchGit(scratchGitBinaryPath);
  }, 60_000);

  afterAll(async () => {
    await scratchGit?.stop();
  });

  function createClient(options: { gzip?: boolean; authToken?: string } = {}): HttpRunStoreClient {
    return new HttpRunStoreClient({
      scratchGitApiUrl: scratchGit.apiUrl,
      scratchGitAuthToken: options.authToken ?? SCRATCH_GIT_AUTH_TOKEN,
      gzipRequestAndResponseBodies: options.gzip ?? true,
    });
  }

  describeRunStoreClientContract('HttpRunStoreClient (gzip)', () => createClient());
  describeRunStoreClientContract('HttpRunStoreClient (no compression)', () => createClient({ gzip: false }));

  describe('HTTP-only behaviour', () => {
    it('stores each run store as one SQLite file inside the staging dir, listed by GET /api/staging', async () => {
      const client = createClient();
      const runStoreKey: RunStoreKey = 'le-rrn_Listing001';
      await client.createOrClearRunStore(runStoreKey);
      await client.putEntries(runStoreKey, 'records', [{ key: 'a', body: 'x'.repeat(10_000) }]);

      expect(fs.readdirSync(path.join(scratchGit.stagingDir, runStoreKey))).toContain('run.db');
      const response = await fetch(`${scratchGit.apiUrl}/api/staging`, {
        headers: { Authorization: `Bearer ${SCRATCH_GIT_AUTH_TOKEN}` },
      });
      const listing = (await response.json()) as {
        data: { stagingDirs: Array<{ jobId: string; sizeBytes: number }>; runStoreMaxBytes: number };
      };
      expect(listing.data.runStoreMaxBytes).toBe(5 * 1024 * 1024 * 1024);
      const listedRunStore = listing.data.stagingDirs.find((dir) => dir.jobId === runStoreKey);
      expect(listedRunStore?.sizeBytes).toBeGreaterThan(10_000);

      await client.deleteRunStore(runStoreKey);
      expect(fs.existsSync(path.join(scratchGit.stagingDir, runStoreKey))).toBe(false);
    });

    it('rejects a wrong bearer token', async () => {
      await expect(createClient({ authToken: 'wrong' }).createOrClearRunStore('le-rrn_AuthFail01')).rejects.toThrow(
        /HTTP 401/,
      );
    });

    it('refuses a malformed run store key with a 400 (not a not-found)', async () => {
      await expect(createClient().createOrClearRunStore('le-bad.key' as RunStoreKey)).rejects.toThrow(/HTTP 400/);
    });
  });

  describe('byte budget', () => {
    let tinyBudgetScratchGit: StartedScratchGit;

    beforeAll(async () => {
      if (!scratchGitBinaryPath) throw new Error('unreachable: suite is skipped without a binary');
      tinyBudgetScratchGit = await startScratchGit(scratchGitBinaryPath, { GIT_LE_RUN_STORE_MAX_BYTES: '1' });
    }, 60_000);

    afterAll(async () => {
      await tinyBudgetScratchGit?.stop();
    });

    it('throws RunStoreBudgetExceededError with the server message once other run stores use the budget', async () => {
      const client = new HttpRunStoreClient({
        scratchGitApiUrl: tinyBudgetScratchGit.apiUrl,
        scratchGitAuthToken: SCRATCH_GIT_AUTH_TOKEN,
      });
      await client.createOrClearRunStore('le-rrn_BudgetOne1');

      const rejection = client.createOrClearRunStore('le-rrn_BudgetTwo1');

      await expect(rejection).rejects.toBeInstanceOf(RunStoreBudgetExceededError);
      await expect(rejection).rejects.toMatchObject({
        runStoreKey: 'le-rrn_BudgetTwo1',
        serverMessage: expect.stringContaining('GIT_LE_RUN_STORE_MAX_BYTES') as unknown,
      });
      // Clearing the store that holds the budget is still allowed.
      await expect(client.createOrClearRunStore('le-rrn_BudgetOne1')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Benchmark (opt-in): RUN_STORE_HTTP_BENCHMARK=1
  // -------------------------------------------------------------------------

  const itWhenBenchmarking = process.env.RUN_STORE_HTTP_BENCHMARK ? it : it.skip;

  /** A ~4 KB record body shaped like connector JSON (repeated field names, varied values). */
  function benchmarkRecordBody(recordIndex: number): string {
    const words = ['invoice', 'customer', 'amount', 'pending', 'shipped', 'priority', 'north', 'south'];
    const fields: Record<string, unknown> = { id: `rec${String(recordIndex).padStart(8, '0')}` };
    let fieldIndex = 0;
    let pseudoRandom = recordIndex * 2654435761;
    while (JSON.stringify(fields).length < 4000) {
      const text: string[] = [];
      for (let wordIndex = 0; wordIndex < 8; wordIndex += 1) {
        pseudoRandom = (pseudoRandom * 1103515245 + 12345) % 2147483648;
        text.push(words[pseudoRandom % words.length] ?? 'x');
      }
      fields[`field_${String(fieldIndex).padStart(3, '0')}`] = {
        text: text.join(' '),
        n: recordIndex * 31 + fieldIndex,
      };
      fieldIndex += 1;
    }
    return JSON.stringify(fields);
  }

  itWhenBenchmarking(
    'benchmark: 100k × ~4 KB entries, write + read, with and without gzip',
    async () => {
      const entryCount = 100_000;
      const entries: RunStoreEntryToPut[] = Array.from({ length: entryCount }, (_, index) => ({
        key: `rec${String(index).padStart(8, '0')}`,
        meta: { op: 'create', sourceId: index },
        body: benchmarkRecordBody(index),
      }));
      const totalBodyMegabytes = entries.reduce((total, entry) => total + (entry.body?.length ?? 0), 0) / 1e6;
      const results: string[] = [`${entryCount} entries, ${totalBodyMegabytes.toFixed(1)} MB of bodies`];

      async function timed(label: string, operation: () => Promise<void>): Promise<void> {
        const startMs = Date.now();
        await operation();
        const elapsedMs = Date.now() - startMs;
        results.push(
          `${label.padEnd(44)} ${String(elapsedMs).padStart(6)} ms  ${Math.round(entryCount / (elapsedMs / 1000))
            .toString()
            .padStart(7)} entries/s`,
        );
      }

      async function readEverything(
        client: HttpRunStoreClient,
        runStoreKey: RunStoreKey,
        collection: string,
        includeBodies: boolean,
      ): Promise<number> {
        let read = 0;
        for await (const page of readAllRunStoreEntries(client, runStoreKey, collection, { includeBodies })) {
          read += page.length;
        }
        return read;
      }

      for (const gzip of [false, true]) {
        const client = createClient({ gzip });
        const runStoreKey: RunStoreKey = `le-rrn_Bench${gzip ? 'Gzip' : 'Plain'}`;
        await client.createOrClearRunStore(runStoreKey);

        await timed(`write sequential (5000/req)   gzip=${gzip}`, () =>
          putRunStoreEntriesInBatches(client, runStoreKey, 'sequential', entries),
        );
        await timed(`read  sequential bodies       gzip=${gzip}`, async () => {
          expect(await readEverything(client, runStoreKey, 'sequential', true)).toBe(entryCount);
        });
        await timed(`read  sequential keys+meta    gzip=${gzip}`, async () => {
          expect(await readEverything(client, runStoreKey, 'sequential', false)).toBe(entryCount);
        });

        const parallelStreams = 4;
        const entriesPerStream = entryCount / parallelStreams;
        await timed(`write ${parallelStreams} parallel collections  gzip=${gzip}`, async () => {
          await Promise.all(
            Array.from({ length: parallelStreams }, (_, stream) =>
              putRunStoreEntriesInBatches(
                client,
                runStoreKey,
                `parallel-${stream}`,
                entries.slice(stream * entriesPerStream, (stream + 1) * entriesPerStream),
              ),
            ),
          );
        });
        await timed(`read  ${parallelStreams} parallel bodies       gzip=${gzip}`, async () => {
          const counts = await Promise.all(
            Array.from({ length: parallelStreams }, (_, stream) =>
              readEverything(client, runStoreKey, `parallel-${stream}`, true),
            ),
          );
          expect(counts.reduce((total, count) => total + count, 0)).toBe(entryCount);
        });

        const deleteStartMs = Date.now();
        await client.deleteRunStore(runStoreKey);
        results.push(`delete run store (2 × ${entryCount})              ${Date.now() - deleteStartMs} ms`);
      }

      console.log(`Run store HTTP benchmark\n${results.join('\n')}`);
    },
    600_000,
  );
});
