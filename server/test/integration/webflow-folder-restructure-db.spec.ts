/**
 * DB-backed integration test for the Webflow folder-restructure migration's
 * atomic path rewrite (DEV-9698, T2).
 *
 * The unit spec (`server/src/code-migrations/__tests__/webflow-folder-restructure-backfill.spec.ts`)
 * exercises the pure decision core against in-memory stubs, and the controller
 * spec mocks `$transaction` with a tx stub. Neither can validate the actual SQL:
 * the seven-column rewrite leans on raw boundary-prefix `UPDATE`s
 * (`left(col, char_length(old)+1) = old || '/'`) plus the no-leading-slash slash
 * convention and the destination-side `SyncTablePair` resolution (#9) — semantics
 * only a real Postgres can confirm. This spec seeds every affected table with
 * both target rows and deliberate decoys, runs the REAL
 * `applyWebflowFolderMovePathRewrite` the migration ships, and asserts each
 * column moved (or stayed) exactly as intended.
 *
 * Pins, beyond the happy path:
 *   - #10 boundary-prefix safety: moving `My Site/Blog` never touches `My Site/Blog Posts`.
 *   - #9 destination-side resolution: `SyncRemoteIdMapping.destinationFilePath` is
 *     rewritten only for rows keyed by the SOURCE folder id of a pair whose
 *     destination is the migrated folder — NOT for arbitrary rows mentioning it.
 *   - scoping: `SyncMatchKeys` by `dataFolderId`; `RecreatedIdMap` / `UploadPatchMeta`
 *     by `connectorAccountId`.
 *   - the leading-slash convention: only `DataFolder.path` keeps the slash; every
 *     record/file-path column matches on the no-leading-slash form.
 *   - atomicity: a mid-transaction failure rolls back the `DataFolder` row too.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import {
  ConnectorAccountId,
  createConnectorAccountId,
  createDataFolderId,
  createOrganizationId,
  createSyncId,
  createWorkbookId,
  DataFolderId,
  SyncId,
  WorkbookId,
} from '@spinner/shared-types';
import { applyWebflowFolderMovePathRewrite } from 'src/code-migrations/webflow-folder-restructure-path-rewrite';
import {
  WEBFLOW_FLAT_STRUCTURE_VERSION,
  WEBFLOW_NESTED_STRUCTURE_VERSION,
} from 'src/remote-service/connectors/library/webflow/webflow-folder-paths';

const OLD_FOLDER_PATH_WITH_SLASH = '/My Site/Blog';
const NEW_FOLDER_PATH_WITH_SLASH = '/My Site/Collections/Blog';
const OLD_FOLDER_PATH_NO_SLASH = 'My Site/Blog';
const NEW_FOLDER_PATH_NO_SLASH = 'My Site/Collections/Blog';
// A sibling whose name has the migrated folder's name as a string prefix — the
// boundary-prefix SQL must never rewrite anything under it (#10).
const SIBLING_FOLDER_PATH_NO_SLASH = 'My Site/Blog Posts';

interface SeededFixture {
  organizationId: string;
  workbookId: WorkbookId;
  connectorAccountId: ConnectorAccountId;
  otherConnectorAccountId: ConnectorAccountId;
  migratedFolderId: DataFolderId;
  sourceFolderId: DataFolderId;
  siblingFolderId: DataFolderId;
  syncId: SyncId;
}

describe('webflow-folder-restructure path rewrite (DB-backed atomic SQL)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Seed the full FK chain (org → workbook → connector account → data folders →
   * sync → table pair) and a row in each of the seven rewritten tables, with
   * decoys. Returns the ids so the caller can assert and clean up.
   */
  const seedFullFixture = async (): Promise<SeededFixture> => {
    const organizationId = createOrganizationId();
    const workbookId = createWorkbookId();
    const connectorAccountId = createConnectorAccountId();
    const otherConnectorAccountId = createConnectorAccountId();
    const migratedFolderId = createDataFolderId();
    const sourceFolderId = createDataFolderId();
    const siblingFolderId = createDataFolderId();
    const syncId = createSyncId();

    await prisma.organization.create({
      data: { id: organizationId, name: 'WF Restructure Org', clerkId: `clerk_wf_${organizationId}` },
    });
    await prisma.workbook.create({ data: { id: workbookId, name: 'WF Restructure WB', organizationId } });
    await prisma.connectorAccount.create({
      data: { id: connectorAccountId, workbookId, service: 'webflow', displayName: 'WF' },
    });

    // The folder being migrated (the destination of the sync pair below).
    await prisma.dataFolder.create({
      data: {
        id: migratedFolderId,
        name: 'Blog',
        workbookId,
        connectorAccountId,
        connectorService: 'webflow',
        path: OLD_FOLDER_PATH_WITH_SLASH,
        version: 1,
        tableId: ['site-1', 'collection-blog'],
      },
    });
    // A second folder that acts as the sync SOURCE — `SyncRemoteIdMapping` rows
    // are keyed by THIS folder's id even though their `destinationFilePath` points
    // into the migrated (destination) folder (#9).
    await prisma.dataFolder.create({
      data: { id: sourceFolderId, name: 'Source', workbookId, connectorAccountId, path: '/Other Site/Source' },
    });
    // A sibling with a string-prefix-colliding name. Its own row is never touched
    // (the rewrite matches by id), but its file rows test boundary-prefix safety.
    await prisma.dataFolder.create({
      data: {
        id: siblingFolderId,
        name: 'Blog Posts',
        workbookId,
        connectorAccountId,
        path: `/${SIBLING_FOLDER_PATH_NO_SLASH}`,
        version: 1,
      },
    });

    await prisma.sync.create({ data: { id: syncId, displayName: 'WF Sync', mappings: [], workbookId } });
    await prisma.syncTablePair.create({
      data: {
        id: createSyncId(),
        syncId,
        sourceDataFolderId: sourceFolderId,
        destinationDataFolderId: migratedFolderId,
      },
    });

    // --- FileIndex (exact folderPath match, no leading slash) ---
    await prisma.fileIndex.createMany({
      data: [
        { workbookId, folderPath: OLD_FOLDER_PATH_NO_SLASH, recordId: 'r1', filename: 'r1.json' },
        // Decoy: sibling folder — exact match must not catch it.
        { workbookId, folderPath: SIBLING_FOLDER_PATH_NO_SLASH, recordId: 'r2', filename: 'r2.json' },
      ],
    });

    // --- FileReference (boundary-prefix, all branches, workbook-scoped) ---
    await prisma.fileReference.createMany({
      data: [
        { workbookId, sourceFilePath: `${OLD_FOLDER_PATH_NO_SLASH}/r1.json`, branch: 'main' },
        { workbookId, sourceFilePath: `${OLD_FOLDER_PATH_NO_SLASH}/r2.json`, branch: 'dirty/abc' },
        // Decoy: sibling path — boundary-prefix (#10) must not match.
        { workbookId, sourceFilePath: `${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`, branch: 'main' },
      ],
    });

    // --- SyncMatchKeys (boundary-prefix, scoped by dataFolderId) ---
    await prisma.syncMatchKeys.createMany({
      data: [
        {
          syncId,
          dataFolderId: migratedFolderId,
          matchId: 'm1',
          remoteId: 'rm1',
          filePath: `${OLD_FOLDER_PATH_NO_SLASH}/r1.json`,
        },
        // Decoy: a key in a DIFFERENT folder whose filePath would match the
        // boundary-prefix — dataFolderId scoping must exclude it.
        {
          syncId,
          dataFolderId: sourceFolderId,
          matchId: 'm2',
          remoteId: 'rm2',
          filePath: `${OLD_FOLDER_PATH_NO_SLASH}/should-not-change.json`,
        },
        // Decoy: a key in the migrated folder but under the sibling path (#10).
        {
          syncId,
          dataFolderId: migratedFolderId,
          matchId: 'm3',
          remoteId: 'rm3',
          filePath: `${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`,
        },
      ],
    });

    // --- SyncRemoteIdMapping (destination side, resolved via SyncTablePair, #9) ---
    await prisma.syncRemoteIdMapping.createMany({
      data: [
        // The real dest-side row: keyed by the SOURCE folder id, points into the
        // migrated (destination) folder → must be rewritten.
        {
          syncId,
          dataFolderId: sourceFolderId,
          sourceRemoteId: 'src1',
          destinationRemoteId: 'dst1',
          destinationFilePath: `${OLD_FOLDER_PATH_NO_SLASH}/r1.json`,
        },
        // Decoy: sibling path under the same (syncId, sourceFolder) — #10.
        {
          syncId,
          dataFolderId: sourceFolderId,
          sourceRemoteId: 'src2',
          destinationFilePath: `${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`,
        },
        // Decoy: unmatched source record (null destinationFilePath) — must survive.
        { syncId, dataFolderId: sourceFolderId, sourceRemoteId: 'src3', destinationFilePath: null },
        // Decoy (#9 crux): a row keyed by the MIGRATED folder id (folder as a
        // sync SOURCE), whose destinationFilePath happens to sit under the old
        // path. The rewrite resolves dest-side rows via the pair's
        // sourceDataFolderId (= sourceFolderId), so this row must NOT be touched.
        {
          syncId,
          dataFolderId: migratedFolderId,
          sourceRemoteId: 'src4',
          destinationFilePath: `${OLD_FOLDER_PATH_NO_SLASH}/elsewhere.json`,
        },
      ],
    });

    // --- RecreatedIdMap (exact folder match, scoped by workbook + account) ---
    await prisma.recreatedIdMap.createMany({
      data: [
        { workbookId, connectorAccountId, folder: OLD_FOLDER_PATH_NO_SLASH, priorRemoteId: 'p1', newRemoteId: 'n1' },
        // Decoy: sibling folder — exact match must not catch it.
        {
          workbookId,
          connectorAccountId,
          folder: SIBLING_FOLDER_PATH_NO_SLASH,
          priorRemoteId: 'p2',
          newRemoteId: 'n2',
        },
        // Decoy: same folder, different account — account scoping must exclude it.
        {
          workbookId,
          connectorAccountId: otherConnectorAccountId,
          folder: OLD_FOLDER_PATH_NO_SLASH,
          priorRemoteId: 'p3',
          newRemoteId: 'n3',
        },
      ],
    });

    // --- UploadPatchMeta (boundary-prefix, scoped by workbook + account) ---
    await prisma.uploadPatchMeta.createMany({
      data: [
        { workbookId, connectorAccountId, filePath: `${OLD_FOLDER_PATH_NO_SLASH}/r1.json` },
        // Decoy: sibling path (#10).
        { workbookId, connectorAccountId, filePath: `${SIBLING_FOLDER_PATH_NO_SLASH}/r.json` },
        // Decoy: same path, different account — account scoping must exclude it.
        { workbookId, connectorAccountId: otherConnectorAccountId, filePath: `${OLD_FOLDER_PATH_NO_SLASH}/r1.json` },
      ],
    });

    return {
      organizationId,
      workbookId,
      connectorAccountId,
      otherConnectorAccountId,
      migratedFolderId,
      sourceFolderId,
      siblingFolderId,
      syncId,
    };
  };

  const cleanUpFixture = async (fixture: SeededFixture): Promise<void> => {
    // FK-less tables aren't reached by the org cascade — delete them explicitly.
    await prisma.fileIndex.deleteMany({ where: { workbookId: fixture.workbookId } });
    await prisma.fileReference.deleteMany({ where: { workbookId: fixture.workbookId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId: fixture.syncId } });
    await prisma.recreatedIdMap.deleteMany({ where: { workbookId: fixture.workbookId } });
    await prisma.uploadPatchMeta.deleteMany({ where: { workbookId: fixture.workbookId } });
    // Cascades: workbook → connectorAccount + dataFolders; sync → syncTablePair + syncRemoteIdMapping.
    await prisma.organization.deleteMany({ where: { id: fixture.organizationId } });
  };

  const rewriteInput = (fixture: SeededFixture) => ({
    folderId: fixture.migratedFolderId,
    workbookId: fixture.workbookId,
    connectorAccountId: fixture.connectorAccountId,
    oldFolderPath: OLD_FOLDER_PATH_WITH_SLASH,
    newFolderPath: NEW_FOLDER_PATH_WITH_SLASH,
  });

  it('rewrites all seven path columns for the move and leaves every decoy untouched', async () => {
    const fixture = await seedFullFixture();
    try {
      await applyWebflowFolderMovePathRewrite(prisma, rewriteInput(fixture), WEBFLOW_NESTED_STRUCTURE_VERSION);

      // 1. DataFolder.path (leading slash) + version flipped; sibling row untouched.
      const migratedFolder = await prisma.dataFolder.findUniqueOrThrow({ where: { id: fixture.migratedFolderId } });
      expect(migratedFolder.path).toBe(NEW_FOLDER_PATH_WITH_SLASH);
      expect(migratedFolder.version).toBe(2);
      const siblingFolder = await prisma.dataFolder.findUniqueOrThrow({ where: { id: fixture.siblingFolderId } });
      expect(siblingFolder.path).toBe(`/${SIBLING_FOLDER_PATH_NO_SLASH}`);
      expect(siblingFolder.version).toBe(1);

      // 2. FileIndex.folderPath (exact, no leading slash).
      const fileIndexRows = await prisma.fileIndex.findMany({
        where: { workbookId: fixture.workbookId },
        orderBy: { recordId: 'asc' },
      });
      expect(fileIndexRows.map((r) => [r.recordId, r.folderPath])).toEqual([
        ['r1', NEW_FOLDER_PATH_NO_SLASH],
        ['r2', SIBLING_FOLDER_PATH_NO_SLASH], // decoy unchanged
      ]);

      // 3. FileReference.sourceFilePath (boundary-prefix, both branches; sibling untouched).
      const fileRefRows = await prisma.fileReference.findMany({
        where: { workbookId: fixture.workbookId },
        orderBy: { sourceFilePath: 'asc' },
      });
      expect(fileRefRows.map((r) => r.sourceFilePath).sort()).toEqual(
        [
          `${NEW_FOLDER_PATH_NO_SLASH}/r1.json`,
          `${NEW_FOLDER_PATH_NO_SLASH}/r2.json`,
          `${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`, // decoy unchanged
        ].sort(),
      );

      // 4. SyncMatchKeys.filePath (scoped by dataFolderId; sibling-path + other-folder decoys untouched).
      const matchKeyByMatchId = new Map(
        (await prisma.syncMatchKeys.findMany({ where: { syncId: fixture.syncId } })).map((k) => [
          k.matchId,
          k.filePath,
        ]),
      );
      expect(matchKeyByMatchId.get('m1')).toBe(`${NEW_FOLDER_PATH_NO_SLASH}/r1.json`);
      expect(matchKeyByMatchId.get('m2')).toBe(`${OLD_FOLDER_PATH_NO_SLASH}/should-not-change.json`); // other folder
      expect(matchKeyByMatchId.get('m3')).toBe(`${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`); // sibling path

      // 5. SyncRemoteIdMapping.destinationFilePath (dest side via the pair, #9).
      const mappingBySource = new Map(
        (await prisma.syncRemoteIdMapping.findMany({ where: { syncId: fixture.syncId } })).map((m) => [
          m.sourceRemoteId,
          m.destinationFilePath,
        ]),
      );
      expect(mappingBySource.get('src1')).toBe(`${NEW_FOLDER_PATH_NO_SLASH}/r1.json`); // rewritten
      expect(mappingBySource.get('src2')).toBe(`${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`); // sibling decoy
      expect(mappingBySource.get('src3')).toBeNull(); // unmatched survives
      expect(mappingBySource.get('src4')).toBe(`${OLD_FOLDER_PATH_NO_SLASH}/elsewhere.json`); // #9: folder-as-source untouched

      // 6. RecreatedIdMap.folder (exact; sibling + other-account decoys untouched).
      const recreatedByPrior = new Map(
        (await prisma.recreatedIdMap.findMany({ where: { workbookId: fixture.workbookId } })).map((r) => [
          r.priorRemoteId,
          r.folder,
        ]),
      );
      expect(recreatedByPrior.get('p1')).toBe(NEW_FOLDER_PATH_NO_SLASH);
      expect(recreatedByPrior.get('p2')).toBe(SIBLING_FOLDER_PATH_NO_SLASH); // sibling
      expect(recreatedByPrior.get('p3')).toBe(OLD_FOLDER_PATH_NO_SLASH); // other account

      // 7. UploadPatchMeta.filePath (boundary-prefix; sibling + other-account decoys untouched).
      const uploadMetaRows = await prisma.uploadPatchMeta.findMany({ where: { workbookId: fixture.workbookId } });
      const uploadByAccountAndPath = uploadMetaRows.map((r) => `${r.connectorAccountId}:${r.filePath}`).sort();
      expect(uploadByAccountAndPath).toEqual(
        [
          `${fixture.connectorAccountId}:${NEW_FOLDER_PATH_NO_SLASH}/r1.json`, // rewritten
          `${fixture.connectorAccountId}:${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`, // sibling decoy
          `${fixture.otherConnectorAccountId}:${OLD_FOLDER_PATH_NO_SLASH}/r1.json`, // other account decoy
        ].sort(),
      );
    } finally {
      await cleanUpFixture(fixture);
    }
  });

  it('is a no-op on a second application — already-moved paths no longer match (no double rewrite)', async () => {
    const fixture = await seedFullFixture();
    try {
      await applyWebflowFolderMovePathRewrite(prisma, rewriteInput(fixture), WEBFLOW_NESTED_STRUCTURE_VERSION);
      // Re-run with the same (old → new): the source paths are gone, so nothing
      // under the old prefix should match and no path should double-nest.
      await applyWebflowFolderMovePathRewrite(prisma, rewriteInput(fixture), WEBFLOW_NESTED_STRUCTURE_VERSION);

      const migratedFolder = await prisma.dataFolder.findUniqueOrThrow({ where: { id: fixture.migratedFolderId } });
      expect(migratedFolder.path).toBe(NEW_FOLDER_PATH_WITH_SLASH);
      expect(migratedFolder.version).toBe(2);

      const fileRefRows = await prisma.fileReference.findMany({ where: { workbookId: fixture.workbookId } });
      // No path contains the doubled `Collections/Collections` or `Blog/.../Blog` artifact.
      for (const row of fileRefRows) {
        expect(row.sourceFilePath).not.toContain('Collections/Blog/Collections');
        expect(
          row.sourceFilePath.startsWith(`${NEW_FOLDER_PATH_NO_SLASH}/`) ||
            row.sourceFilePath.startsWith(SIBLING_FOLDER_PATH_NO_SLASH),
        ).toBe(true);
      }
    } finally {
      await cleanUpFixture(fixture);
    }
  });

  it('is atomic — a mid-transaction failure rolls back the DataFolder row too', async () => {
    const fixture = await seedFullFixture();
    try {
      // Force a unique-constraint violation on the FileIndex updateMany (the 2nd
      // statement, AFTER DataFolder.update has set path+version): seed a row
      // ALREADY at the new folderPath with the SAME recordId 'r1' as the to-be-
      // moved row, so moving old→new collides on @@unique([workbookId, folderPath, recordId]).
      await prisma.fileIndex.create({
        data: {
          workbookId: fixture.workbookId,
          folderPath: NEW_FOLDER_PATH_NO_SLASH,
          recordId: 'r1',
          filename: 'pre.json',
        },
      });

      await expect(
        applyWebflowFolderMovePathRewrite(prisma, rewriteInput(fixture), WEBFLOW_NESTED_STRUCTURE_VERSION),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

      // The DataFolder.update in the same transaction must have rolled back.
      const migratedFolder = await prisma.dataFolder.findUniqueOrThrow({ where: { id: fixture.migratedFolderId } });
      expect(migratedFolder.path).toBe(OLD_FOLDER_PATH_WITH_SLASH);
      expect(migratedFolder.version).toBe(1);

      // And the original FileIndex row is still at the old path (nothing moved).
      const movedRow = await prisma.fileIndex.findFirst({
        where: { workbookId: fixture.workbookId, recordId: 'r1', folderPath: OLD_FOLDER_PATH_NO_SLASH },
      });
      expect(movedRow).not.toBeNull();
    } finally {
      await cleanUpFixture(fixture);
    }
  });

  it('round-trips — the inverse rewrite (new→old, version 1) restores the flat layout exactly (T6)', async () => {
    const fixture = await seedFullFixture();
    try {
      // Forward: flat → nested, DataFolder.version → 2.
      await applyWebflowFolderMovePathRewrite(prisma, rewriteInput(fixture), WEBFLOW_NESTED_STRUCTURE_VERSION);
      // Inverse (rollback): nested → flat with old/new swapped, DataFolder.version → 1. Same shipped
      // SQL, opposite direction — confirms the rewrite is direction-agnostic against real Postgres.
      await applyWebflowFolderMovePathRewrite(
        prisma,
        {
          ...rewriteInput(fixture),
          oldFolderPath: NEW_FOLDER_PATH_WITH_SLASH,
          newFolderPath: OLD_FOLDER_PATH_WITH_SLASH,
        },
        WEBFLOW_FLAT_STRUCTURE_VERSION,
      );

      // DataFolder.path + version restored to the original flat layout.
      const migratedFolder = await prisma.dataFolder.findUniqueOrThrow({ where: { id: fixture.migratedFolderId } });
      expect(migratedFolder.path).toBe(OLD_FOLDER_PATH_WITH_SLASH);
      expect(migratedFolder.version).toBe(1);

      // FileIndex back to the flat path; sibling decoy untouched throughout.
      const fileIndexRows = await prisma.fileIndex.findMany({
        where: { workbookId: fixture.workbookId },
        orderBy: { recordId: 'asc' },
      });
      expect(fileIndexRows.map((r) => [r.recordId, r.folderPath])).toEqual([
        ['r1', OLD_FOLDER_PATH_NO_SLASH],
        ['r2', SIBLING_FOLDER_PATH_NO_SLASH],
      ]);

      // FileReference back to flat on both branches; sibling untouched.
      const fileRefRows = await prisma.fileReference.findMany({ where: { workbookId: fixture.workbookId } });
      expect(fileRefRows.map((r) => r.sourceFilePath).sort()).toEqual(
        [
          `${OLD_FOLDER_PATH_NO_SLASH}/r1.json`,
          `${OLD_FOLDER_PATH_NO_SLASH}/r2.json`,
          `${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`,
        ].sort(),
      );

      // SyncMatchKeys restored; decoys preserved.
      const matchKeyByMatchId = new Map(
        (await prisma.syncMatchKeys.findMany({ where: { syncId: fixture.syncId } })).map((k) => [
          k.matchId,
          k.filePath,
        ]),
      );
      expect(matchKeyByMatchId.get('m1')).toBe(`${OLD_FOLDER_PATH_NO_SLASH}/r1.json`);
      expect(matchKeyByMatchId.get('m2')).toBe(`${OLD_FOLDER_PATH_NO_SLASH}/should-not-change.json`);
      expect(matchKeyByMatchId.get('m3')).toBe(`${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`);

      // SyncRemoteIdMapping dest-side restored; #9 folder-as-source row never moved either way.
      const mappingBySource = new Map(
        (await prisma.syncRemoteIdMapping.findMany({ where: { syncId: fixture.syncId } })).map((m) => [
          m.sourceRemoteId,
          m.destinationFilePath,
        ]),
      );
      expect(mappingBySource.get('src1')).toBe(`${OLD_FOLDER_PATH_NO_SLASH}/r1.json`);
      expect(mappingBySource.get('src3')).toBeNull();
      expect(mappingBySource.get('src4')).toBe(`${OLD_FOLDER_PATH_NO_SLASH}/elsewhere.json`);

      // RecreatedIdMap + UploadPatchMeta restored; account-scoped decoys preserved.
      const recreatedByPrior = new Map(
        (await prisma.recreatedIdMap.findMany({ where: { workbookId: fixture.workbookId } })).map((r) => [
          r.priorRemoteId,
          r.folder,
        ]),
      );
      expect(recreatedByPrior.get('p1')).toBe(OLD_FOLDER_PATH_NO_SLASH);
      expect(recreatedByPrior.get('p3')).toBe(OLD_FOLDER_PATH_NO_SLASH); // other account, never touched
      const uploadByAccountAndPath = (
        await prisma.uploadPatchMeta.findMany({ where: { workbookId: fixture.workbookId } })
      )
        .map((r) => `${r.connectorAccountId}:${r.filePath}`)
        .sort();
      expect(uploadByAccountAndPath).toEqual(
        [
          `${fixture.connectorAccountId}:${OLD_FOLDER_PATH_NO_SLASH}/r1.json`,
          `${fixture.connectorAccountId}:${SIBLING_FOLDER_PATH_NO_SLASH}/r.json`,
          `${fixture.otherConnectorAccountId}:${OLD_FOLDER_PATH_NO_SLASH}/r1.json`,
        ].sort(),
      );
    } finally {
      await cleanUpFixture(fixture);
    }
  });
});
