import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * End-to-end test for foreign-key reference-name resolution in the grid (DEV-10530).
 *
 * It drives the REAL main-process pipeline — `window.scratchFiles.readDiffGridData`
 * → IPC → `readDiffGridDataPage` → the `scratchmd` CLI (`paginate-records`) →
 * schema + working-file reads → `resolveReferenceLabels` — against a fixture
 * workspace on disk, and asserts the returned `referenceLabels` map turns
 * referenced ids into the linked records' names.
 *
 * We assert the DATA the main process hands the grid (referenceLabels), not the
 * canvas-rendered cell text: glide-data-grid paints to a <canvas>, so there is
 * no DOM node to read a cell from. The renderer's id→name swap is covered by the
 * `reference-labels` unit suite (formatReferenceDisplay) instead; this test
 * proves the end-to-end resolution that feeds it.
 *
 * The fixture is deliberately git-less and marker-less: with no `.scratch/.scratchmd`
 * marker the CLI's folder_index treats every record as working/"added" (no master
 * tree), which is all we need to list records and read their working values.
 *
 * Requires the `scratchmd` CLI binary (the desktop shells out to it for record
 * pagination). If it hasn't been built, the test SKIPS with a hint rather than
 * failing — mirroring how the live suite skips without a token.
 */

// Built main-process entry produced by `yarn build` (electron-vite).
const MAIN_PROCESS_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// Dev binary path the app resolves at runtime (see getScratchmdBinaryPath in src/main/scratchmd.ts).
const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCHMD_BINARY = join(
  REPO_ROOT,
  'scratch-git-2',
  'target',
  'debug',
  process.platform === 'win32' ? 'scratchmd.exe' : 'scratchmd',
);

const USER_DATA_DIR_ENV_VAR = 'SCRATCH_DESKTOP_USER_DATA_DIR';

const CONNECTION_DIR_NAME = 'Webflow';

const launchedApps: ElectronApplication[] = [];
const createdDirs: string[] = [];

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/**
 * A Scratch table-wrapper schema.json. `idColumnRemoteId` / `titleColumnRemoteId`
 * tell the resolver where each record's id and display name live; the inner
 * `schema` carries the foreign-key annotations. `wsId` is what a FK's
 * `linkedTableId` matches against.
 */
function tableSchema(args: {
  wsId: string;
  slug: string;
  properties: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: { wsId: args.wsId, remoteId: ['site1', args.wsId] },
    slug: args.slug,
    name: args.slug,
    idColumnRemoteId: 'id',
    titleColumnRemoteId: ['fieldData', 'name'],
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        fieldData: { type: 'object', properties: args.properties },
      },
    },
  };
}

/**
 * Build a marker-less fixture workspace:
 *   Webflow/Authors  — single-reference target (wsId "authorsTable")
 *   Webflow/Tags     — multi-reference target  (wsId "tagsTable")
 *   Webflow/Posts    — source: fieldData.author → Authors, fieldData.tags → Tags
 * Returns the workspace root.
 */
function buildFixtureWorkspace(): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'scratch-desktop-reflabels-'));
  createdDirs.push(workspacePath);

  const recordPath = (folder: string, filename: string): string =>
    join(workspacePath, CONNECTION_DIR_NAME, folder, filename);
  const schemaPath = (folder: string): string =>
    join(workspacePath, '.scratch', 'connections', 'scratch', CONNECTION_DIR_NAME, folder, 'schema.json');

  // Authors (single-ref target).
  writeJsonFile(
    schemaPath('Authors'),
    tableSchema({ wsId: 'authorsTable', slug: 'Authors', properties: { name: { type: 'string' } } }),
  );
  writeJsonFile(recordPath('Authors', 'jane.json'), { id: 'author-1', fieldData: { name: 'Jane Doe' } });
  writeJsonFile(recordPath('Authors', 'john.json'), { id: 'author-2', fieldData: { name: 'John Smith' } });

  // Tags (multi-ref target).
  writeJsonFile(
    schemaPath('Tags'),
    tableSchema({ wsId: 'tagsTable', slug: 'Tags', properties: { name: { type: 'string' } } }),
  );
  writeJsonFile(recordPath('Tags', 'eng.json'), { id: 'tag-1', fieldData: { name: 'Engineering' } });
  writeJsonFile(recordPath('Tags', 'design.json'), { id: 'tag-2', fieldData: { name: 'Design' } });

  // Posts (source) — a single FK (author), a multi FK (tags), and a plain column (name).
  writeJsonFile(
    schemaPath('Posts'),
    tableSchema({
      wsId: 'postsTable',
      slug: 'Posts',
      properties: {
        name: { type: 'string' },
        author: { type: 'string', 'x-scratch-foreign-key': { linkedTableId: 'authorsTable' } },
        tags: { type: 'array', items: { type: 'string' }, 'x-scratch-foreign-key': { linkedTableId: 'tagsTable' } },
      },
    }),
  );
  writeJsonFile(recordPath('Posts', 'hello.json'), {
    id: 'post-1',
    fieldData: { name: 'Hello World', author: 'author-1', tags: ['tag-1', 'tag-2'] },
  });
  // post-2 references a non-existent author (dangling) and one tag.
  writeJsonFile(recordPath('Posts', 'world.json'), {
    id: 'post-2',
    fieldData: { name: 'Goodbye', author: 'missing-author', tags: ['tag-2'] },
  });

  return workspacePath;
}

async function launchDesktopApp(): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scratch-desktop-e2e-'));
  createdDirs.push(userDataDir);
  const app = await electron.launch({
    args: [MAIN_PROCESS_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      [USER_DATA_DIR_ENV_VAR]: userDataDir,
      SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE: '1',
      // The app derives the CLI path from app.getAppPath(), which doesn't line up
      // with the repo checkout when Playwright launches out/main/index.js directly.
      // Point it straight at the built binary (honored only in unpackaged builds).
      SCRATCH_DESKTOP_SCRATCHMD_BINARY: SCRATCHMD_BINARY,
    },
  });
  launchedApps.push(app);
  return app;
}

interface ReadDiffGridDataResult {
  referenceLabels?: Record<string, Record<string, string>>;
}

test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) {
    await app.close().catch(() => undefined);
  }
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves foreign-key cells to the referenced records’ names', async () => {
  test.skip(
    !existsSync(SCRATCHMD_BINARY),
    `scratchmd CLI not built at ${SCRATCHMD_BINARY}. Run 'cargo build --bin scratchmd' in scratch-git-2/.`,
  );

  const workspacePath = buildFixtureWorkspace();
  const postsFolderPath = join(workspacePath, CONNECTION_DIR_NAME, 'Posts');

  const app = await launchDesktopApp();
  const window: Page = await app.firstWindow();

  // The preload exposes scratchFiles on every window regardless of auth state, but
  // wait until it's wired before invoking it.
  await window.waitForFunction(
    () =>
      typeof (window as unknown as { scratchFiles?: { readDiffGridData?: unknown } }).scratchFiles?.readDiffGridData ===
      'function',
  );

  const result = (await window.evaluate(
    ([folderPath, wsPath]) =>
      (
        window as unknown as {
          scratchFiles: {
            readDiffGridData: (
              folderPath: string,
              workspacePath: string,
              opts: { offset: number; limit: number },
            ) => Promise<unknown>;
          };
        }
      ).scratchFiles.readDiffGridData(folderPath, wsPath, { offset: 0, limit: 50 }),
    [postsFolderPath, workspacePath],
  )) as ReadDiffGridDataResult;

  const referenceLabels = result.referenceLabels ?? {};

  // Single-reference column: the referenced author id maps to its name; the
  // dangling id is omitted (cell would fall back to the raw id); an author that
  // isn't referenced on the page is not included.
  expect(referenceLabels['fieldData.author']).toBeDefined();
  expect(referenceLabels['fieldData.author']['author-1']).toBe('Jane Doe');
  expect(referenceLabels['fieldData.author']['missing-author']).toBeUndefined();
  expect(Object.keys(referenceLabels['fieldData.author'])).toEqual(['author-1']);

  // Multi-reference column: every referenced tag id maps to its name.
  expect(referenceLabels['fieldData.tags']).toBeDefined();
  expect(referenceLabels['fieldData.tags']['tag-1']).toBe('Engineering');
  expect(referenceLabels['fieldData.tags']['tag-2']).toBe('Design');

  // A plain (non-foreign-key) column never gets a reference-labels entry.
  expect(referenceLabels['fieldData.name']).toBeUndefined();
});
