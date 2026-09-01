import { expect, test } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  buildReviewSurfaceWorkspace,
  reviewWorkspaceDetailMock,
  reviewWorkspaceRegistryYaml,
  type ReviewRecordSpec,
} from './fixtures/review-surface-workspace';
import { closeLaunchedResources, launchReviewApp, SCRATCHMD_BINARY } from './support/review-app-harness';

/**
 * DEV-10626 / DEV-10649 — the new `ReviewTableGrid` renders to a `<canvas>`, so its cell pixels (inline
 * `del → ins` diffs, solid change-type fills, the status-pill column) can't be read from the DOM. This
 * spec instead asserts the DATA CONTRACT the main process hands the grid — `readDiffGridData`'s
 * de-duplicated `filterCounts` and per-row review-state model (`__rowStatus`) — which is exactly what
 * drives that rendering. Pixel fidelity stays owned by the pure-function unit tests
 * (`review-table-cell-drawing.spec.ts`, `build-review-table-columns.spec.ts`) and Storybook.
 *
 * Mirrors `reference-labels.spec.ts`: it drives the real `window.scratchFiles.readDiffGridData` →
 * IPC → `scratchmd` CLI pipeline via `page.evaluate` (no folder selection / no canvas needed), and
 * `test.skip`s when the CLI binary isn't built. Uses a two-record fixture — `Uno` (an unreviewed edit)
 * and `Dos` (approved) — so the counts must partition to `{ unreviewed: 1, unpublished: 1, pending: 2 }`:
 * the union never double-counts, and one record sits on each side of the review ladder. This partition
 * is the DEV-10687 counts contract the review banner + pills bind to.
 *
 * NOTE: the desktop reads the published + approved snapshots straight from the bare repo's
 * `refs/heads/main` + `accepted-patches.json` (Slice F.5 — `readDiffGridDataPage`), NOT from the SQLite
 * folder index, so records classify correctly WITHOUT a pull: `Uno` (a `modified` edit against main)
 * lands on `modified`, and `Dos` (an approved create) on `addedUnpublished`. This is also reflected in
 * the partitioned `filterCounts` (Uno → `unreviewed`, Dos → `unpublished`).
 */

const FIXTURE_RECORDS: ReviewRecordSpec[] = [
  { id: 'Uno', name: 'Uno', state: 'modified' },
  { id: 'Dos', name: 'Dos', state: 'approved' },
];

interface DiffRowLite {
  __filename: string;
  __rowStatus: string;
  __changedFields: string[];
  __unpublishedFields: string[];
}
interface ReadDiffGridDataResult {
  rows: DiffRowLite[];
  filterCounts: { unreviewed: number; unpublished: number; pending: number; errors: number };
}

test.afterEach(closeLaunchedResources);

test('readDiffGridData hands the grid partitioned counts and per-row review state (DEV-10649)', async () => {
  test.skip(
    !existsSync(SCRATCHMD_BINARY),
    `scratchmd CLI not built at ${SCRATCHMD_BINARY}. Run 'cargo build --bin scratchmd' in scratch-git-2/.`,
  );
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);

  const { window, workspace } = await launchReviewApp({
    flag: true,
    build: (rootDir) => buildReviewSurfaceWorkspace(rootDir, FIXTURE_RECORDS),
    registryYaml: reviewWorkspaceRegistryYaml,
    detailMock: reviewWorkspaceDetailMock,
  });
  const folderPath = join(workspace.workspacePath, workspace.connectionDirName, workspace.folderName);

  // The preload exposes scratchFiles on every window regardless of auth state; wait until it's wired.
  await window.waitForFunction(
    () =>
      typeof (window as unknown as { scratchFiles?: { readDiffGridData?: unknown } }).scratchFiles?.readDiffGridData ===
      'function',
  );

  const result = (await window.evaluate(
    ([folder, wsPath]) =>
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
      ).scratchFiles.readDiffGridData(folder, wsPath, { offset: 0, limit: 50 }),
    [folderPath, workspace.workspacePath],
  )) as ReadDiffGridDataResult;

  // Counts partition the pending set (DEV-10687): the union (pending) never double-counts a record —
  // Uno lands in `unreviewed`, Dos in `unpublished`, so pending = 2 with no overlap. This is the core
  // review-state contract the new banner + pills consume.
  expect(result.filterCounts).toEqual({ unreviewed: 1, unpublished: 1, pending: 2, errors: 0 });

  // Both rows are present and carry their real row-status (published/approved read from the bare repo):
  // Uno is a `modified` edit against main; Dos is an approved create (`addedUnpublished`).
  const uno = result.rows.find((row) => row.__filename.endsWith('Uno.json'));
  const dos = result.rows.find((row) => row.__filename.endsWith('Dos.json'));
  if (!uno || !dos) throw new Error(`expected Uno + Dos rows, got ${result.rows.map((r) => r.__filename)}`);
  expect(uno.__rowStatus).toBe('modified');
  expect(dos.__rowStatus).toBe('addedUnpublished');
});
