import * as crypto from 'crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import { MAIN_BRANCH } from '../lib/constants';
import { RepoManageService } from '../src/services/repo-manage.service';
import { RepoReadService } from '../src/services/repo-read.service';
import { RepoWriteService } from '../src/services/repo-write.service';

// Custom dispatcher with extended timeouts for long-running server operations
const longTimeoutAgent = new Agent({ headersTimeout: 20 * 60 * 1000, bodyTimeout: 20 * 60 * 1000 });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw shape returned by the list pipelines endpoint (Prisma model). */
interface PipelineListItem {
  id: string;
  status: string;
  result: { successCount: number; failedCount: number } | null;
  _count: { entries: number };
}

/** Entry from the entries endpoint. */
interface PipelineEntry {
  phase: string;
  filePath: string;
  status: string;
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

let repoId = '';
let workbookId = '';
let serverUrl = '';
let apiToken = '';
let userId = '';
let connectorAccountId = '';
let batchSize = 500;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--repo') repoId = process.argv[++i]!;
  else if (arg === '--workbook-id') workbookId = process.argv[++i]!;
  else if (arg === '--server-url') serverUrl = process.argv[++i]!;
  else if (arg === '--api-token') apiToken = process.argv[++i]!;
  else if (arg === '--user-id') userId = process.argv[++i]!;
  else if (arg === '--connector-account-id') connectorAccountId = process.argv[++i]!;
  else if (arg === '-b') batchSize = parseInt(process.argv[++i], 10);
  else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!repoId || !workbookId || !serverUrl || !apiToken || !userId || !connectorAccountId) {
  console.error(
    'Usage: npx ts-node test/publish-v2-stress.ts ' +
      '--repo <repoId> --workbook-id <workbookId> --server-url <url> ' +
      '--api-token <token> --user-id <userId> --connector-account-id <connectorAccountId> ' +
      '[-b <batchSize>]',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${serverUrl}/workbook/${workbookId}/publish-v2${path}`;
  const res = await undiciFetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `API-Token ${apiToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    dispatcher: longTimeoutAgent,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll pipeline list until the given pipeline reaches a target status. Retries on transient errors. */
async function pollPipeline(pipelineId: string, targetStatuses: string[]): Promise<PipelineListItem> {
  let consecutiveErrors = 0;
  for (;;) {
    await sleep(3000);
    let pipelines: PipelineListItem[];
    try {
      pipelines = await apiRequest<PipelineListItem[]>('GET', `?connectorAccountId=${connectorAccountId}`);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) throw err;
      process.stdout.write('!');
      continue;
    }
    const pipeline = pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);
    if (targetStatuses.includes(pipeline.status)) return pipeline;
    if (pipeline.status === 'failed') throw new Error(`Pipeline ${pipelineId} failed`);
    process.stdout.write('.');
  }
}

/** Submit an async plan job and poll until it completes. */
async function planAsync(): Promise<{ pipelineId: string; entryCount: number }> {
  const { pipelineId } = await apiRequest<{ jobId: string | null; pipelineId: string | null }>('POST', '/plan-job', {
    userId,
    connectorAccountId,
  });
  if (!pipelineId) throw new Error('No diffs to plan');

  const pipeline = await pollPipeline(pipelineId, ['planned']);
  return { pipelineId, entryCount: pipeline._count.entries };
}

/** Submit an async run job and poll until it completes. */
async function runAsync(pipelineId: string): Promise<{ status: string; successCount: number; failedCount: number }> {
  await apiRequest('POST', '/run-job', { pipelineId });

  const pipeline = await pollPipeline(pipelineId, ['completed', 'completed-with-errors']);
  return {
    status: pipeline.status,
    successCount: pipeline.result?.successCount ?? 0,
    failedCount: pipeline.result?.failedCount ?? 0,
  };
}

async function getEntries(pipelineId: string): Promise<PipelineEntry[]> {
  return apiRequest('GET', `/${pipelineId}/entries`);
}

/** Compute phase summary from entries. */
async function computePhases(pipelineId: string): Promise<Array<{ type: string; count: number }>> {
  const entries = await getEntries(pipelineId);
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.phase, (counts.get(e.phase) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
}

async function deletePipeline(pipelineId: string): Promise<void> {
  await apiRequest('DELETE', `/${pipelineId}`);
}

// ---------------------------------------------------------------------------
// Git Helpers
// ---------------------------------------------------------------------------

const readService = new RepoReadService(repoId);
const writeService = new RepoWriteService(repoId);
const manageService = new RepoManageService(repoId);

/** Read all records from a folder on a given branch. */
async function readAllRecords(
  branch: string,
  folder: string,
): Promise<Array<{ path: string; record: Record<string, unknown> }>> {
  const files = await readService.list(branch, folder);
  const fileNames = files.filter((f) => f.type === 'file').map((f) => f.name);
  if (fileNames.length === 0) return [];

  const results: Array<{ path: string; record: Record<string, unknown> }> = [];
  for (let i = 0; i < fileNames.length; i += batchSize) {
    const batch = fileNames.slice(i, i + batchSize);
    const batchResults = await readService.readFilesFromFolder(branch, folder, batch);
    for (const r of batchResults) {
      if (r.content) {
        results.push({ path: r.path, record: JSON.parse(r.content) as Record<string, unknown> });
      }
    }
  }
  return results;
}

/** Ensure dirty branch is clean by resetting it to main. */
async function ensureClean(): Promise<void> {
  console.log('  [setup] Resetting dirty branch to main...');
  await manageService.resetToMain();
}

// ---------------------------------------------------------------------------
// Stress Test
// ---------------------------------------------------------------------------

const USER_COUNT = 5_000;
const POST_COUNT = 45_000;
const TOTAL_COUNT = USER_COUNT + POST_COUNT;

async function phase1_Create(): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Phase 1: Create ${TOTAL_COUNT.toLocaleString()} records`);
  console.log(`  ${USER_COUNT.toLocaleString()} users + ${POST_COUNT.toLocaleString()} micro_posts`);
  console.log('='.repeat(60));

  await ensureClean();

  // Create users in batches
  console.log(`\n  Creating ${USER_COUNT.toLocaleString()} users...`);
  console.time('  Users created');

  const userIds: string[] = [];

  for (let i = 0; i < USER_COUNT; i += batchSize) {
    const end = Math.min(i + batchSize, USER_COUNT);
    const files: Array<{ path: string; content: string }> = [];

    for (let j = i; j < end; j++) {
      const id = crypto.randomUUID();
      userIds.push(id);
      const record = {
        id,
        username: `stress_user_${j}`,
        email: `stress_${j}@example.com`,
        edit_me: `original_${j}`,
        safe_to_delete: true,
      };
      files.push({
        path: `users/${id}.json`,
        content: JSON.stringify(record, null, 2),
      });
    }

    await writeService.commitFiles('dirty', files, `Stress create users batch ${Math.floor(i / batchSize) + 1}`);
    process.stdout.write('.');
  }
  console.log('');
  console.timeEnd('  Users created');

  // Create micro_posts in batches with pseudo-ref FKs
  console.log(`\n  Creating ${POST_COUNT.toLocaleString()} micro_posts...`);
  console.time('  Posts created');

  for (let i = 0; i < POST_COUNT; i += batchSize) {
    const end = Math.min(i + batchSize, POST_COUNT);
    const files: Array<{ path: string; content: string }> = [];

    for (let j = i; j < end; j++) {
      const id = crypto.randomUUID();
      const userRef = `@/users/${userIds[j % userIds.length]}.json`;
      const record = {
        id,
        content: `Stress test content ${j}`,
        user_id: userRef,
        edit_me: `original_${j}`,
        safe_to_delete: true,
      };
      files.push({
        path: `micro_posts/${id}.json`,
        content: JSON.stringify(record, null, 2),
      });
    }

    await writeService.commitFiles('dirty', files, `Stress create posts batch ${Math.floor(i / batchSize) + 1}`);
    process.stdout.write('.');
  }
  console.log('');
  console.timeEnd('  Posts created');

  // Plan
  console.log('\n  Planning...');
  console.time('  Plan');
  const { pipelineId, entryCount } = await planAsync();
  console.timeEnd('  Plan');
  console.log(`  Planned ${entryCount.toLocaleString()} entries`);

  if (entryCount === 0) throw new Error('Phase 1: Expected entries but got 0');

  // Fetch phase breakdown from entries
  console.log('  Computing phases from entries...');
  const phases = await computePhases(pipelineId);
  for (const p of phases) {
    console.log(`    ${p.type}: ${p.count.toLocaleString()} records`);
  }

  const createPhase = phases.find((p) => p.type === 'create');
  if (!createPhase) throw new Error('Phase 1: Expected create phase');

  // Run
  console.log('\n  Running pipeline...');
  console.time('  Run');
  const result = await runAsync(pipelineId);
  console.timeEnd('  Run');
  console.log(
    `  Result: status=${result.status}, success=${result.successCount.toLocaleString()}, failed=${result.failedCount}`,
  );

  if (result.failedCount > 0) {
    throw new Error(`Phase 1: Expected 0 failures but got ${result.failedCount}`);
  }

  await deletePipeline(pipelineId);
  console.log('\n  Phase 1 PASSED');
}

async function phase2_DeleteAll(): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Phase 2: Delete all records`);
  console.log('='.repeat(60));

  await ensureClean();

  // Read all records from main
  console.log('\n  Reading records from main...');
  console.time('  Read');
  const users = await readAllRecords(MAIN_BRANCH, 'users');
  const posts = await readAllRecords(MAIN_BRANCH, 'micro_posts');
  console.timeEnd('  Read');
  console.log(`  Found ${users.length} users + ${posts.length} micro_posts = ${users.length + posts.length} total`);

  if (users.length + posts.length === 0) {
    throw new Error('Phase 2: No records on main to delete');
  }

  // Delete all records from dirty in batches
  console.log('\n  Deleting records from dirty...');
  console.time('  Delete');

  const allPaths = [...posts.map((p) => p.path), ...users.map((u) => u.path)];

  for (let i = 0; i < allPaths.length; i += batchSize) {
    const batch = allPaths.slice(i, i + batchSize);
    await writeService.deleteFiles('dirty', batch, `Stress delete batch ${Math.floor(i / batchSize) + 1}`);
    process.stdout.write('.');
  }
  console.log('');
  console.timeEnd('  Delete');

  // Plan
  console.log('\n  Planning...');
  console.time('  Plan');
  const { pipelineId, entryCount } = await planAsync();
  console.timeEnd('  Plan');
  console.log(`  Planned ${entryCount.toLocaleString()} entries`);

  if (entryCount === 0) throw new Error('Phase 2: Expected entries but got 0');

  // Fetch phase breakdown from entries
  console.log('  Computing phases from entries...');
  const phases = await computePhases(pipelineId);
  for (const p of phases) {
    console.log(`    ${p.type}: ${p.count.toLocaleString()} records`);
  }

  const deletePhase = phases.find((p) => p.type === 'delete');
  if (!deletePhase) throw new Error('Phase 2: Expected delete phase');

  // Run
  console.log('\n  Running pipeline...');
  console.time('  Run');
  const result = await runAsync(pipelineId);
  console.timeEnd('  Run');
  console.log(
    `  Result: status=${result.status}, success=${result.successCount.toLocaleString()}, failed=${result.failedCount}`,
  );

  if (result.failedCount > 0) {
    throw new Error(`Phase 2: Expected 0 failures but got ${result.failedCount}`);
  }

  await deletePipeline(pipelineId);
  console.log('\n  Phase 2 PASSED');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Publish V2 Stress Test');
  console.log(`  Repo: ${repoId}`);
  console.log(`  Workbook: ${workbookId}`);
  console.log(`  Server: ${serverUrl}`);
  console.log(`  Batch size: ${batchSize}`);
  console.log(`  Total records: ${TOTAL_COUNT.toLocaleString()}`);

  console.time('Total');

  await phase1_Create();
  await phase2_DeleteAll();

  console.log(`\n${'='.repeat(60)}`);
  console.log('ALL PHASES PASSED');
  console.timeEnd('Total');
}

void main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
