import * as crypto from 'crypto';
import { MAIN_BRANCH } from '../lib/constants';
import { RepoManageService } from '../src/services/repo-manage.service';
import { RepoReadService } from '../src/services/repo-read.service';
import { RepoWriteService } from '../src/services/repo-write.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublishPlanInfo {
  pipelineId: string;
  workbookId: string;
  userId: string;
  phases: Array<{ type: string; recordCount: number }>;
  branchName: string;
  status: string;
  successCount?: number;
  failedCount?: number;
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
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

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--repo') repoId = process.argv[++i]!;
  else if (arg === '--workbook-id') workbookId = process.argv[++i]!;
  else if (arg === '--server-url') serverUrl = process.argv[++i]!;
  else if (arg === '--api-token') apiToken = process.argv[++i]!;
  else if (arg === '--user-id') userId = process.argv[++i]!;
  else if (arg === '--connector-account-id') connectorAccountId = process.argv[++i]!;
  else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!repoId || !workbookId || !serverUrl || !apiToken || !userId || !connectorAccountId) {
  console.error(
    'Usage: npx ts-node test/publish-v2-e2e.ts ' +
      '--repo <repoId> --workbook-id <workbookId> --server-url <url> ' +
      '--api-token <token> --user-id <userId> --connector-account-id <connectorAccountId>',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${serverUrl}/workbook/${workbookId}/publish-v2${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `API-Token ${apiToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

async function plan(): Promise<PublishPlanInfo> {
  return apiRequest<PublishPlanInfo>('POST', '/plan', { userId, connectorAccountId });
}

async function run(pipelineId: string): Promise<PublishPlanInfo> {
  return apiRequest<PublishPlanInfo>('POST', '/run', { pipelineId });
}

async function getEntries(pipelineId: string): Promise<Array<{ phase: string; filePath: string; status: string }>> {
  return apiRequest('GET', `/${pipelineId}/entries`);
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
  const results = await readService.readFilesFromFolder(branch, folder, fileNames);
  return results
    .filter((r): r is { path: string; content: string } => r.content != null)
    .map((r) => ({ path: r.path, record: JSON.parse(r.content) as Record<string, unknown> }));
}

/** Ensure dirty branch is clean by resetting it to main. */
async function ensureClean(): Promise<void> {
  await manageService.resetToMain();
}

function recordId(record: Record<string, unknown>): string {
  return record['id'] as string;
}

/** Create a user record matching the Supabase `users` table schema. */
function makeUserRecord(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    username: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    email: `test_${Math.random().toString(36).slice(2, 8)}@example.com`,
    edit_me: `original_${Math.random().toString(36).slice(2, 6)}`,
    safe_to_delete: true,
  };
}

/** Create a micro_post record matching the Supabase `micro_posts` table schema. */
function makeMicroPostRecord(userRef: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    content: `Post content ${Math.random().toString(36).slice(2, 8)}`,
    user_id: userRef,
    edit_me: `original_${Math.random().toString(36).slice(2, 6)}`,
    safe_to_delete: true,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertPhaseExists(planInfo: PublishPlanInfo, phaseType: string, label: string): void {
  const phase = planInfo.phases.find((p) => p.type === phaseType);
  if (!phase) {
    const actual = planInfo.phases.map((p) => p.type).join(', ');
    throw new Error(`${label}: Expected '${phaseType}' phase but plan has: [${actual}]`);
  }
}

function assertPhaseNotExists(planInfo: PublishPlanInfo, phaseType: string, label: string): void {
  const phase = planInfo.phases.find((p) => p.type === phaseType);
  if (phase) {
    throw new Error(`${label}: Did NOT expect '${phaseType}' phase but found it with ${phase.recordCount} records`);
  }
}

function assertPhaseCount(planInfo: PublishPlanInfo, phaseType: string, expected: number, label: string): void {
  const phase = planInfo.phases.find((p) => p.type === phaseType);
  if (!phase) {
    throw new Error(`${label}: Expected '${phaseType}' phase with ${expected} records but phase is missing`);
  }
  if (phase.recordCount !== expected) {
    throw new Error(`${label}: Expected '${phaseType}' phase with ${expected} records but got ${phase.recordCount}`);
  }
}

function assertZeroFailures(result: PublishPlanInfo, label: string): void {
  if ((result.failedCount ?? 0) > 0) {
    throw new Error(`${label}: Expected 0 failures but got ${result.failedCount}`);
  }
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log('='.repeat(60));
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(`  PASSED (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: message, duration });
    console.error(`  FAILED: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Test Scenarios
// ---------------------------------------------------------------------------

async function test1_CreateParentAndChildWithPseudoRefs(): Promise<void> {
  await ensureClean();

  // Create 3 users
  const users = Array.from({ length: 3 }, () => makeUserRecord());
  const userFiles = users.map((u) => ({
    path: `users/${recordId(u)}.json`,
    content: JSON.stringify(u, null, 2),
  }));
  await writeService.commitFiles('dirty', userFiles, 'Test 1: Create users');

  // Create 5 micro_posts with pseudo-ref FKs
  const posts = Array.from({ length: 5 }, (_, i) => {
    const userRef = `@/users/${recordId(users[i % users.length])}.json`;
    return makeMicroPostRecord(userRef);
  });
  const postFiles = posts.map((p) => ({
    path: `micro_posts/${recordId(p)}.json`,
    content: JSON.stringify(p, null, 2),
  }));
  await writeService.commitFiles('dirty', postFiles, 'Test 1: Create micro_posts');

  // Plan
  const planInfo = await plan();
  console.log(`  Plan phases: ${JSON.stringify(planInfo.phases)}`);

  assertPhaseExists(planInfo, 'create', 'Test 1');
  assertPhaseCount(planInfo, 'create', 8, 'Test 1');

  // Run
  const result = await run(planInfo.pipelineId);
  console.log(`  Run result: status=${result.status}, success=${result.successCount}, failed=${result.failedCount}`);
  assertZeroFailures(result, 'Test 1');

  // Cleanup pipeline
  await deletePipeline(planInfo.pipelineId);
}

async function test2_EditNonFkFields(): Promise<void> {
  await ensureClean();

  // Read existing micro_posts from main
  const posts = await readAllRecords(MAIN_BRANCH, 'micro_posts');
  if (posts.length < 3) {
    throw new Error(`Test 2: Need at least 3 micro_posts on main, found ${posts.length}`);
  }

  // Modify edit_me on 3 micro_posts on dirty
  const toEdit = posts.slice(0, 3);
  const editFiles = toEdit.map(({ path, record }) => {
    record.edit_me = `edited_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return { path, content: JSON.stringify(record, null, 2) };
  });
  await writeService.commitFiles('dirty', editFiles, 'Test 2: Edit micro_posts');

  // Plan
  const planInfo = await plan();
  console.log(`  Plan phases: ${JSON.stringify(planInfo.phases)}`);

  assertPhaseExists(planInfo, 'edit', 'Test 2');
  assertPhaseCount(planInfo, 'edit', 3, 'Test 2');
  assertPhaseNotExists(planInfo, 'create', 'Test 2');
  assertPhaseNotExists(planInfo, 'delete', 'Test 2');

  // Run
  const result = await run(planInfo.pipelineId);
  console.log(`  Run result: status=${result.status}, success=${result.successCount}, failed=${result.failedCount}`);
  assertZeroFailures(result, 'Test 2');

  await deletePipeline(planInfo.pipelineId);
}

async function test3_CreateChildrenReferencingExistingParents(): Promise<void> {
  await ensureClean();

  // Read existing user UUIDs from main (these have real remote IDs, not pseudo-refs)
  const users = await readAllRecords(MAIN_BRANCH, 'users');
  if (users.length < 1) {
    throw new Error(`Test 3: Need at least 1 user on main, found ${users.length}`);
  }

  // Create 3 new micro_posts with real UUID user_id values (not pseudo-refs)
  const posts = Array.from({ length: 3 }, (_, i) => {
    const uid = recordId(users[i % users.length].record);
    return makeMicroPostRecord(uid);
  });
  const postFiles = posts.map((p) => ({
    path: `micro_posts/${recordId(p)}.json`,
    content: JSON.stringify(p, null, 2),
  }));
  await writeService.commitFiles('dirty', postFiles, 'Test 3: Create micro_posts with real UUIDs');

  // Plan
  const planInfo = await plan();
  console.log(`  Plan phases: ${JSON.stringify(planInfo.phases)}`);

  assertPhaseExists(planInfo, 'create', 'Test 3');
  assertPhaseCount(planInfo, 'create', 3, 'Test 3');
  assertPhaseNotExists(planInfo, 'backfill', 'Test 3');

  // Run
  const result = await run(planInfo.pipelineId);
  console.log(`  Run result: status=${result.status}, success=${result.successCount}, failed=${result.failedCount}`);
  assertZeroFailures(result, 'Test 3');

  await deletePipeline(planInfo.pipelineId);
}

async function test4_DeleteParentOnlyKeepChildren(): Promise<void> {
  await ensureClean();

  // Read users and posts from main
  const users = await readAllRecords(MAIN_BRANCH, 'users');
  const posts = await readAllRecords(MAIN_BRANCH, 'micro_posts');
  if (users.length < 2) {
    throw new Error(`Test 4: Need at least 2 users on main, found ${users.length}`);
  }

  // Pick 1 user to delete (keep at least 1 for future tests)
  const userToDelete = users[0];
  console.log(`  Deleting user: ${userToDelete.path}`);

  // Delete the user from dirty
  await writeService.deleteFiles('dirty', [userToDelete.path], 'Test 4: Delete user');

  // Plan
  const planInfo = await plan();
  console.log(`  Plan phases: ${JSON.stringify(planInfo.phases)}`);

  assertPhaseExists(planInfo, 'delete', 'Test 4');
  assertPhaseCount(planInfo, 'delete', 1, 'Test 4');

  // There should be an edit phase if any micro_posts reference the deleted user
  const deletedUserId = recordId(userToDelete.record);
  const referencingPosts = posts.filter((p) => {
    const uid = p.record.user_id;
    return uid === deletedUserId || uid === `@/users/${deletedUserId}.json`;
  });

  if (referencingPosts.length > 0) {
    assertPhaseExists(planInfo, 'edit', 'Test 4');
    console.log(`  ${referencingPosts.length} micro_posts reference deleted user → expect edit phase for FK clearing`);
  }

  // Run
  const result = await run(planInfo.pipelineId);
  console.log(`  Run result: status=${result.status}, success=${result.successCount}, failed=${result.failedCount}`);
  assertZeroFailures(result, 'Test 4');

  await deletePipeline(planInfo.pipelineId);
}

async function test5_MixedOperations(): Promise<void> {
  await ensureClean();

  // Read existing data
  const users = await readAllRecords(MAIN_BRANCH, 'users');
  const posts = await readAllRecords(MAIN_BRANCH, 'micro_posts');
  if (users.length < 1) {
    throw new Error(`Test 5: Need at least 1 user on main, found ${users.length}`);
  }
  if (posts.length < 2) {
    throw new Error(`Test 5: Need at least 2 micro_posts on main, found ${posts.length}`);
  }

  // 1. Add 1 user + 1 micro_post (pseudo-ref)
  const newUser = makeUserRecord();
  const newUserId = recordId(newUser);
  await writeService.commitFiles(
    'dirty',
    [{ path: `users/${newUserId}.json`, content: JSON.stringify(newUser, null, 2) }],
    'Test 5: Add user',
  );

  const newPost = makeMicroPostRecord(`@/users/${newUserId}.json`);
  const newPostId = recordId(newPost);
  await writeService.commitFiles(
    'dirty',
    [{ path: `micro_posts/${newPostId}.json`, content: JSON.stringify(newPost, null, 2) }],
    'Test 5: Add micro_post',
  );

  // 2. Edit 1 existing micro_post
  const postToEdit = posts[0];
  postToEdit.record.edit_me = `edited_test5_${Date.now()}`;
  await writeService.commitFiles(
    'dirty',
    [{ path: postToEdit.path, content: JSON.stringify(postToEdit.record, null, 2) }],
    'Test 5: Edit micro_post',
  );

  // 3. Delete 1 existing micro_post
  const postToDelete = posts[posts.length - 1];
  await writeService.deleteFiles('dirty', [postToDelete.path], 'Test 5: Delete micro_post');

  // Plan
  const planInfo = await plan();
  console.log(`  Plan phases: ${JSON.stringify(planInfo.phases)}`);

  assertPhaseExists(planInfo, 'create', 'Test 5');
  assertPhaseExists(planInfo, 'edit', 'Test 5');
  assertPhaseExists(planInfo, 'delete', 'Test 5');

  // Run
  const result = await run(planInfo.pipelineId);
  console.log(`  Run result: status=${result.status}, success=${result.successCount}, failed=${result.failedCount}`);
  assertZeroFailures(result, 'Test 5');

  await deletePipeline(planInfo.pipelineId);
}

async function test6_DeleteBothParentAndChildren(): Promise<void> {
  await ensureClean();

  // Read existing data from main
  const users = await readAllRecords(MAIN_BRANCH, 'users');
  const posts = await readAllRecords(MAIN_BRANCH, 'micro_posts');
  if (users.length < 1) {
    throw new Error(`Test 6: Need at least 1 user on main, found ${users.length}`);
  }

  // Pick a user that has child micro_posts
  let targetUser: { path: string; record: Record<string, unknown> } | null = null;
  let childPosts: Array<{ path: string; record: Record<string, unknown> }> = [];

  for (const user of users) {
    const uid = recordId(user.record);
    const children = posts.filter((p) => {
      const ref = p.record.user_id;
      return ref === uid || ref === `@/users/${uid}.json`;
    });
    if (children.length > 0) {
      targetUser = user;
      childPosts = children;
      break;
    }
  }

  if (!targetUser || childPosts.length === 0) {
    // If no user has children, create a parent + child first, publish, then delete both
    console.log('  [setup] No user with children found. Creating parent + child first...');
    const setupUser = makeUserRecord();
    const setupUserId = recordId(setupUser);
    const setupPost = makeMicroPostRecord(`@/users/${setupUserId}.json`);
    const setupPostId = recordId(setupPost);

    await writeService.commitFiles(
      'dirty',
      [
        { path: `users/${setupUserId}.json`, content: JSON.stringify(setupUser, null, 2) },
        { path: `micro_posts/${setupPostId}.json`, content: JSON.stringify(setupPost, null, 2) },
      ],
      'Test 6 setup: Create parent + child',
    );

    const setupPlan = await plan();
    const setupResult = await run(setupPlan.pipelineId);
    assertZeroFailures(setupResult, 'Test 6 setup');
    await deletePipeline(setupPlan.pipelineId);

    // Re-read from main
    const freshUsers = await readAllRecords(MAIN_BRANCH, 'users');
    const freshPosts = await readAllRecords(MAIN_BRANCH, 'micro_posts');

    // Find the user we just created
    targetUser = freshUsers.find((u) => u.record.id === setupUser.id) ?? null;
    if (!targetUser) throw new Error('Test 6: Could not find setup user on main after publish');

    childPosts = freshPosts.filter((p) => {
      const ref = p.record.user_id;
      return ref === setupUser.id || ref === `@/users/${setupUserId}.json`;
    });
    if (childPosts.length === 0) {
      throw new Error('Test 6: Could not find child posts on main after publish');
    }
  }

  console.log(`  Deleting user ${targetUser.path} and ${childPosts.length} child micro_post(s)`);

  // Delete both parent and children from dirty
  const pathsToDelete = [targetUser.path, ...childPosts.map((p) => p.path)];
  await writeService.deleteFiles('dirty', pathsToDelete, 'Test 6: Delete parent + children');

  // Plan
  const planInfo = await plan();
  console.log(`  Plan phases: ${JSON.stringify(planInfo.phases)}`);

  // REGRESSION CHECK: Edit phase should be present for FK clearing
  // Even though children are also being deleted, their FK refs must be cleared
  // before the delete phase runs (since delete ordering is not guaranteed).
  assertPhaseExists(planInfo, 'edit', 'Test 6 (regression: FK clearing before delete)');
  assertPhaseExists(planInfo, 'delete', 'Test 6');

  // Verify the edit entries are for the child micro_posts (FK clearing)
  const entries = await getEntries(planInfo.pipelineId);
  const editEntries = entries.filter((e) => e.phase === 'edit');
  const deleteEntries = entries.filter((e) => e.phase === 'delete');

  console.log(`  Edit entries: ${editEntries.length}, Delete entries: ${deleteEntries.length}`);

  const childPaths = new Set(childPosts.map((p) => p.path));
  const editPathsForChildren = editEntries.filter((e) => childPaths.has(e.filePath));
  console.log(`  Edit entries for child micro_posts: ${editPathsForChildren.length}`);

  if (editPathsForChildren.length === 0) {
    throw new Error(
      'Test 6 (regression): Expected edit entries for child micro_posts to clear FK refs, but found none',
    );
  }

  // Run
  const result = await run(planInfo.pipelineId);
  console.log(`  Run result: status=${result.status}, success=${result.successCount}, failed=${result.failedCount}`);
  assertZeroFailures(result, 'Test 6');

  await deletePipeline(planInfo.pipelineId);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Publish V2 E2E Tests');
  console.log(`  Repo: ${repoId}`);
  console.log(`  Workbook: ${workbookId}`);
  console.log(`  Server: ${serverUrl}`);
  console.log(`  User: ${userId}`);
  console.log(`  Connector Account: ${connectorAccountId}`);

  await runTest('Test 1: Create parent + child with pseudo-refs', test1_CreateParentAndChildWithPseudoRefs);
  await runTest('Test 2: Edit non-FK fields', test2_EditNonFkFields);
  await runTest('Test 3: Create children referencing existing parents', test3_CreateChildrenReferencingExistingParents);
  await runTest('Test 4: Delete parent only, keep children', test4_DeleteParentOnlyKeepChildren);
  await runTest('Test 5: Mixed operations', test5_MixedOperations);
  await runTest('Test 6: Delete both parent and children (regression)', test6_DeleteBothParentAndChildren);

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    const detail = r.error ? ` — ${r.error}` : '';
    console.log(`  [${status}] ${r.name} (${r.duration}ms)${detail}`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed (${totalTime}ms total)`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
